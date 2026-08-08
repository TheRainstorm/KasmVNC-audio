(function () {
  if (window.__kasmAudioStarted) return;
  window.__kasmAudioStarted = true;
  window.__kasmAudioVer = '8c5c4f4-dbg1';

  var Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;

  var ctx = null;
  try { ctx = new Ctx({ sampleRate: 48000, latencyHint: 'interactive' }); }
  catch (e) {
    try { ctx = new Ctx({ latencyHint: 'interactive' }); }
    catch (e2) { ctx = new Ctx(); }
  }

  // ---- state ----
  var pc = null, ws = null, sp = null, analyser = null, mediaSrc = null;
  var mode = 'none';          // whep | ws | mp3
  var starting = false, running = false, userStopped = false, fallingBack = false, noMediaTicks = 0;
  var remoteTrack = null, mediaWired = false, silentTicks = 0, rewireCount = 0;
  var bytes = 0, lastMsgAt = 0, pending = new Float32Array(0);
  var latMs = null, startTs = 0, statsTimer = null, whepTimer = null, whepLoc = null;
  var lastStats = null, decodeOk = false, decodeOkLogged = false, noDecodeTicks = 0, zeroEnergyTicks = 0;

  // ---- UI ----
  var widget, statusEl, btn, dotEl;
  var collapsed = true, hideTimer = null;

  function setStatus(t) {
    if (statusEl) statusEl.textContent = t;
  }

  function uiText() {
    var parts = [mode === 'none' ? '就绪' : (mode === 'whep' ? 'WHEP' : mode === 'ws' ? 'WS' : 'MP3')];
    parts.push(running ? '播放中' : '未播放');
    if (ctx) parts.push('ctx=' + ctx.state);
    if (bytes > 0) parts.push((bytes / 1048576).toFixed(1) + 'MB');
    if (latMs !== null) parts.push('延迟≈' + latMs + 'ms');
    if (mode === 'whep' && lastStats) {
      parts.push('pkts=' + lastStats.packetsReceived);
      parts.push('dec=' + lastStats.framesDecoded);
    }
    if (lastMsgAt && (Date.now() - lastMsgAt > 3000)) parts.push('⚠️数据停');
    var db = levelDb();
    if (db !== null) parts.push(db + 'dB');
    return parts.join(' | ');
  }

  function expand() {
    collapsed = false;
    statusEl.style.display = 'block';
    btn.style.width = 'auto';
    btn.style.height = '32px';
    btn.style.borderRadius = '16px';
    btn.style.padding = '0 14px';
    btn.style.fontSize = '13px';
    btn.textContent = running ? ('🔊 ' + (latMs !== null ? latMs + 'ms' : '播放中')) : '🔊 开启声音';
    if (dotEl) dotEl.style.display = 'none';
  }

  function collapse() {
    collapsed = true;
    statusEl.style.display = 'none';
    btn.style.width = '44px';
    btn.style.height = '44px';
    btn.style.borderRadius = '22px';
    btn.style.padding = '0';
    btn.style.fontSize = '20px';
    btn.textContent = '🔊';
  }

  function reveal() {
    widget.style.opacity = '1';
    widget.style.pointerEvents = 'auto';
    if (dotEl) dotEl.style.display = 'none';
    armAutoHide();
  }

  function armAutoHide() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      widget.style.opacity = '0';
      widget.style.pointerEvents = 'none';
      if (running && mode !== 'none' && dotEl) dotEl.style.display = 'block';
    }, 5000);
  }

  function buildUI() {
    widget = document.createElement('div');
    widget.id = 'kasmAudioWidget';
    widget.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-end;gap:6px;font:12px/1.3 sans-serif;opacity:1;transition:opacity .35s;';

    statusEl = document.createElement('div');
    statusEl.id = 'kasmAudioStatus';
    statusEl.style.cssText = 'padding:4px 10px;border-radius:4px;background:rgba(0,0,0,.65);color:#9fe6a0;white-space:nowrap;pointer-events:none;display:none;';

    btn = document.createElement('button');
    btn.id = 'kasmAudioBtn';
    btn.type = 'button';
    btn.title = '远程音频 v8c5c4f4（WHEP/WebRTC 优先）';
    btn.style.cssText = 'width:44px;height:44px;border-radius:22px;border:none;background:rgba(26,155,215,.92);color:#fff;font-size:20px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;transition:all .2s;';

    dotEl = document.createElement('div');
    dotEl.id = 'kasmAudioDot';
    dotEl.style.cssText = 'position:fixed;right:14px;bottom:14px;width:10px;height:10px;border-radius:50%;background:#3ddc74;box-shadow:0 0 6px rgba(61,220,116,.9);z-index:2147483647;pointer-events:none;display:none;';

    widget.appendChild(statusEl);
    widget.appendChild(btn);
    document.body.appendChild(widget);
    document.body.appendChild(dotEl);

    widget.addEventListener('mouseenter', function () { clearTimeout(hideTimer); expand(); });
    widget.addEventListener('mouseleave', function () { collapse(); armAutoHide(); });
    btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); toggle(); });

    ['mousemove', 'touchstart', 'pointerdown', 'keydown'].forEach(function (ev) {
      window.addEventListener(ev, function () {
        if (widget.style.opacity !== '1') reveal();
        else armAutoHide();
      }, { passive: true });
    });
    collapse();
    armAutoHide();
  }

  function levelDb() {
    try {
      if (!analyser) return null;
      var buf = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(buf);
      var sum = 0;
      for (var i = 0; i < buf.length; i++) {
        var v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      var rms = Math.sqrt(sum / buf.length);
      return rms > 0.0001 ? Math.round(20 * Math.log10(rms)) : -999;
    } catch (e) { return null; }
  }

  // ---- WS PCM fallback ----
  function pushPCM(f) {
    if (pending.length > 96000) { pending = f; return; }
    var nb = new Float32Array(pending.length + f.length);
    nb.set(pending);
    nb.set(f, pending.length);
    pending = nb;
  }

  function wireWs() {
    sp = ctx.createScriptProcessor(1024, 0, 2);
    sp.onaudioprocess = function (e) {
      var c0 = e.outputBuffer.getChannelData(0);
      var c1 = e.outputBuffer.getChannelData(1);
      var n = c0.length;
      if (pending.length >= n * 2) {
        var pi = 0;
        for (var j = 0; j < n; j++) {
          c0[j] = pending[pi];
          c1[j] = pending[pi + 1];
          pi += 2;
        }
        pending = pending.subarray(n * 2);
      } else {
        c0.fill(0); c1.fill(0);
      }
    };
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    sp.connect(analyser);
    analyser.connect(ctx.destination);
  }

  function startWs() {
    if (mode !== 'none' && mode !== 'whep') return;
    mode = 'ws';
    wireWs();
    var wsUrl = window.KASM_AUDIO_WS || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws-audio');
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = function (e) {
      bytes += e.data.byteLength;
      lastMsgAt = Date.now();
      pushPCM(new Float32Array(e.data));
    };
    ws.onerror = function () { setStatus('WS 错误，切兜底 MP3'); useFallback(); };
    ws.onclose = function () { if (!running) setStatus('WS 已断开'); };
    running = true;
  }

  // ---- MP3 last resort ----
  function useFallback() {
    if (mode === 'mp3') return;
    mode = 'mp3';
    try {
      var a = new Audio('/audio/live.mp3');
      a.play().then(function () {
        running = true;
        latMs = null;
        setStatus('兜底 MP3 播放中');
      }, function () { setStatus('兜底被拦截，请点按钮'); });
    } catch (e) { setStatus('音频初始化失败'); }
  }

  // ---- WHEP / WebRTC primary ----
  function whepStats(cb) {
    if (!pc) return;
    pc.getStats().then(function (stats) {
      var pkts = 0;
      stats.forEach(function (r) {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          pkts = r.packetsReceived || 0;
          var out = (typeof ctx.outputLatency === 'number' ? ctx.outputLatency * 1000 : 0);
          var base = (typeof ctx.baseLatency === 'number' ? ctx.baseLatency * 1000 : 0);
          var pd = (typeof r.playoutDelay === 'number' ? r.playoutDelay * 1000 : (r.jitter || 0) * 1000 * 1.5);
          if (pkts > 0) latMs = Math.round(pd + out + base);
          lastStats = {
            packetsReceived: r.packetsReceived || 0,
            packetsLost: r.packetsLost || 0,
            bytesReceived: r.bytesReceived || 0,
            headerBytesReceived: r.headerBytesReceived || 0,
            framesDecoded: r.framesDecoded || 0,
            framesReceived: r.framesReceived || 0,
            framesDiscarded: r.framesDiscarded || 0,
            packetsDiscarded: r.packetsDiscarded || 0,
            totalAudioEnergy: r.totalAudioEnergy || 0,
            totalSamplesDuration: r.totalSamplesDuration || 0,
            concealedSamples: r.concealedSamples || 0,
            silentConcealedSamples: r.silentConcealedSamples || 0,
            jitter: r.jitter || 0,
            playoutDelay: r.playoutDelay || 0,
            jitterBufferDelay: r.jitterBufferDelay || 0,
            jitterBufferEmittedCount: r.jitterBufferEmittedCount || 0,
            nackCount: r.nackCount || 0,
            pliCount: r.pliCount || 0,
            fractionLost: r.fractionLost || 0,
            roundTripTime: r.roundTripTime || 0,
            decoderImplementation: r.decoderImplementation || null,
            codecId: r.codecId || null,
            trackMuted: remoteTrack ? remoteTrack.muted : null,
            trackEnabled: remoteTrack ? remoteTrack.enabled : null
          };
          if (pkts > 0 && !decodeOk && (r.framesDecoded || 0) > 0) {
            decodeOk = true;
            if (!decodeOkLogged) {
              decodeOkLogged = true;
              console.log('[kasm-audio] WHEP 解码成功: frames=' + r.framesDecoded + ' energy=' + r.totalAudioEnergy);
            }
          }
        }
      });
      if (cb) cb(pkts);
    }).catch(function () {});
  }

  function armWatchdog() {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = setInterval(function () {
      whepStats(function (pkts) {
        if (pkts > 0 && lastStats) {
          if (lastStats.framesDecoded === 0) {
            noDecodeTicks++;
            if (noDecodeTicks === 3) console.warn('[kasm-audio] WHEP 收到 RTP 但 framesDecoded=0（解码失败/不兼容），pkts=' + lastStats.packetsReceived + ' lost=' + lastStats.packetsLost + ' dec=' + lastStats.decoderImplementation);
          } else {
            noDecodeTicks = 0;
            if (lastStats.totalAudioEnergy === 0 && lastStats.totalSamplesDuration > 1) {
              zeroEnergyTicks++;
              if (zeroEnergyTicks === 3) console.warn('[kasm-audio] WHEP 解码成功但能量=0（静音帧），concealed=' + lastStats.concealedSamples);
            } else zeroEnergyTicks = 0;
          }
        }
        if (pkts > 0) {
          noMediaTicks = 0;
          if (remoteTrack && mediaWired && levelDb() === -999) {
            silentTicks++;
            if (silentTicks >= 4) {
              silentTicks = 0;
              rewireCount++;
              if (rewireCount >= 2) {
                console.warn('[kasm-audio] 重连 2 次仍静音，降级 WS');
                failWhep(new Error('输出持续静音'));
              } else {
                console.warn('[kasm-audio] 收到媒体但输出静音，重连媒体源');
                rewireMedia();
              }
            }
          } else {
            silentTicks = 0;
          }
          return;
        }
        noMediaTicks++;
        if (noMediaTicks >= 5) failWhep(new Error('5s 内未收到媒体包'));
      });
    }, 1000);
  }

  function teardownWhep() {
    if (statsTimer) clearInterval(statsTimer);
    if (whepTimer) clearTimeout(whepTimer);
    try { if (mediaSrc) mediaSrc.disconnect(); } catch (e) {}
    try { if (analyser) analyser.disconnect(); } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
    pc = null; mediaSrc = null; whepLoc = null; statsTimer = null;
    remoteTrack = null; mediaWired = false; silentTicks = 0; rewireCount = 0;
  }

  function failWhep(err) {
    if (fallingBack || mode === 'ws' || mode === 'mp3') return;
    fallingBack = true;
    console.warn('[kasm-audio] WHEP 失败，切 WS 兜底:', err);
    teardownWhep();
    startWs();
    setStatus('WHEP 无媒体，WS 兜底');
  }

  function wireMedia(track) {
    if (!track || mediaWired) return;
    mediaWired = true;
    try {
      var stream = new MediaStream([track]);
      mediaSrc = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      mediaSrc.connect(analyser);
      analyser.connect(ctx.destination);
    } catch (e) { console.error('[kasm-audio] wireMedia failed:', e); }
  }

  function rewireMedia() {
    try { if (mediaSrc) mediaSrc.disconnect(); } catch (e) {}
    try { if (analyser) analyser.disconnect(); } catch (e) {}
    mediaSrc = null; analyser = null; mediaWired = false;
    wireMedia(remoteTrack);
  }

  function startWhep() {
    return new Promise(function (resolve, reject) {
      try {
        pc = new RTCPeerConnection({ iceServers: [] });
        var gotTrack = false, settled = false;
        pc.onicecandidate = function (ev) {
          if (ev.candidate && whepLoc) {
            var ufrag = '', pwd = '';
            var m = /a=ice-ufrag:(\S+)/.exec(pc.localDescription.sdp);
            if (m) ufrag = m[1];
            m = /a=ice-pwd:(\S+)/.exec(pc.localDescription.sdp);
            if (m) pwd = m[1];
            var mid = ev.candidate.sdpMid || '0';
            var frag = 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' +
              'a=mid:' + mid + '\r\n' +
              'a=ice-ufrag:' + ufrag + '\r\n' +
              'a=ice-pwd:' + pwd + '\r\n' +
              'a=' + ev.candidate.candidate + '\r\n';
            fetch(whepLoc, { method: 'PATCH', headers: { 'Content-Type': 'application/trickle-ice-sdpfrag' }, body: frag }).catch(function () {});
          }
        };
        function done(ok, err) {
          if (settled) return;
          settled = true;
          if (whepTimer) clearTimeout(whepTimer);
          if (ok) { running = true; armWatchdog(); resolve(true); }
          else { try { pc.close(); } catch (e) {} reject(err || new Error('whep failed')); }
        }
        pc.ontrack = function (ev) {
          gotTrack = true;
          remoteTrack = ev.track;
          wireMedia(ev.track);
          done(true);
        };
        pc.onconnectionstatechange = function () {
          if (pc.connectionState === 'failed') {
            if (!gotTrack) done(false, new Error('pc ' + pc.connectionState));
            else failWhep(new Error('pc ' + pc.connectionState));
          } else if (pc.connectionState === 'disconnected' && !gotTrack) {
            done(false, new Error('pc ' + pc.connectionState));
          }
        };
        pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false }).then(function (o) {
          return pc.setLocalDescription(o);
        }).then(function () {
          var posted = false;
          function post() {
            if (posted) return;
            posted = true;
            fetch('/stream/whep', {
              method: 'POST',
              headers: { 'Content-Type': 'application/sdp' },
              body: pc.localDescription.sdp
            }).then(function (r) {
              if (!r.ok) throw new Error('WHEP HTTP ' + r.status);
              whepLoc = r.headers.get('Location');
              return r.text();
            }).then(function (answer) {
              // 过滤 IPv6 候选：Windows 到 ares 的 IPv6 路由不可靠，强制走 IPv4 LAN
              var sdp = answer.split(/\r?\n/).filter(function (line) {
                if (!/^a=candidate:/.test(line)) return true;
                var parts = line.split(/\s+/);
                return !(parts[4] && parts[4].indexOf(':') !== -1);
              }).join('\r\n');
              return pc.setRemoteDescription({ type: 'answer', sdp: sdp });
            }).catch(function (err) { done(false, err); });
          }
          if (pc.iceGatheringState === 'complete') post();
          else {
            var t = setTimeout(post, 900);
            pc.onicegatheringstatechange = function () {
              if (pc.iceGatheringState === 'complete') { clearTimeout(t); post(); }
            };
          }
        }).catch(function (err) { done(false, err); });
        whepTimer = setTimeout(function () { if (!gotTrack) done(false, new Error('WHEP 5s 超时')); }, 5000);
      } catch (err) { reject(err); }
    });
  }

  // ---- start / toggle ----
  function toggle() {
    if (running && mode !== 'none') {
      stop();
      return;
    }
    start();
  }

  function stop() {
    userStopped = true;
    try { if (pc) pc.close(); } catch (e) {}
    try { if (ws) ws.close(); } catch (e) {}
    if (statsTimer) clearInterval(statsTimer);
    if (whepTimer) clearTimeout(whepTimer);
    try { if (sp) sp.disconnect(); } catch (e) {}
    try { if (mediaSrc) mediaSrc.disconnect(); } catch (e) {}
    if (ctx && ctx.state === 'running') ctx.suspend().catch(function () {});
    pc = null; ws = null; sp = null; mediaSrc = null; analyser = null;
    pending = new Float32Array(0);
    running = false; mode = 'none'; latMs = null; bytes = 0;
    fallingBack = false; noMediaTicks = 0;
    remoteTrack = null; mediaWired = false; silentTicks = 0; rewireCount = 0;
    setStatus('已停止，点击开启');
    collapse();
  }

  function start() {
    if (starting || running) return;
    starting = true;
    userStopped = false;
    fallingBack = false; noMediaTicks = 0;
    if (ctx.state !== 'running') {
      ctx.resume().then(go).catch(function () { starting = false; setStatus('ctx 启动失败，切兜底'); useFallback(); });
    } else go();

    function go() {
      startWhep().then(function () {
        mode = 'whep';
        setStatus('WHEP 已连接');
      }).catch(function (err) {
        console.warn('[kasm-audio] WHEP failed, fallback WS:', err);
        startWs();
        setStatus('WHEP 失败，WS 兜底');
      }).then(function () { starting = false; });
    }
  }

  // ---- debug API ----
  window.__kasmAudioDebug = function () {
    return {
      ctxState: ctx ? ctx.state : null,
      mode: mode,
      running: running,
      pcState: pc ? pc.connectionState : null,
      iceState: pc ? pc.iceConnectionState : null,
      wsState: ws ? ws.readyState : null,
      bytes: bytes,
      latMs: latMs,
      pendingSamples: pending.length,
      lastMsgAgo: lastMsgAt ? (Date.now() - lastMsgAt) : null,
      stats: lastStats,
      levelDb: levelDb()
    };
  };
  window.__kasmAudioLevel = function () { return levelDb(); };
  window.__kasmAudioSdp = function () {
    if (!pc) return { err: 'no pc' };
    var out = { remote: pc.remoteDescription ? pc.remoteDescription.sdp : null, local: pc.localDescription ? pc.localDescription.sdp : null };
    try {
      out.transceivers = pc.getTransceivers().map(function (t) {
        var p = t.receiver ? t.receiver.getParameters() : null;
        return {
          mid: t.mid, direction: t.direction, currentDirection: t.currentDirection,
          codecs: p ? p.codecs.map(function (c) { return c.mimeType + ' pt=' + c.payloadType + ' ' + (c.sdpFmtpLine || ''); }) : [],
          encodings: p ? p.encodings.map(function (e) { return JSON.stringify(e); }) : [],
          track: t.receiver && t.receiver.track ? { kind: t.receiver.track.kind, muted: t.receiver.track.muted, enabled: t.receiver.track.enabled } : null
        };
      });
    } catch (e) { out.tErr = String(e); }
    return out;
  };
  window.__kasmAudioSpectrum = function () {
    try {
      if (!analyser) return { err: 'no analyser' };
      var freq = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(freq);
      var sum = 0, peak = 0, peakBin = -1;
      for (var i = 0; i < freq.length; i++) {
        sum += freq[i];
        if (freq[i] > peak) { peak = freq[i]; peakBin = i; }
      }
      var mean = sum / freq.length;
      var logSum = 0, nz = 0;
      for (var j = 0; j < freq.length; j++) {
        var v = freq[j] || 1;
        logSum += Math.log(v);
        if (freq[j] > 0) nz++;
      }
      return {
        sampleRate: ctx.sampleRate,
        dominantHz: Math.round(peakBin * (ctx.sampleRate / analyser.fftSize)),
        peakLevel: peak,
        flatness: Math.round(Math.exp(logSum / freq.length) / (mean || 1) * 100) / 100,
        nonzeroBins: nz
      };
    } catch (e) { return { err: String(e) }; }
  };

  // ---- init ----
  try {
    buildUI();
    setStatus('音频初始化中…');
    ['pointerdown', 'keydown', 'touchstart', 'click'].forEach(function (ev) {
      window.addEventListener(ev, function () { if (!starting && !running && !userStopped) start(); }, { capture: true, passive: true });
    });
    setInterval(function () {
      if (!statusEl) return;
      if (!collapsed) setStatus(uiText());
    }, 500);
    if (/[?&]kasm_audio_autostart=1/.test(location.search)) {
      setTimeout(start, 800);
    }
  } catch (err) {
    console.error('[kasm-audio] init failed:', err);
  }
})();
