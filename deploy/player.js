(function () {
  if (window.__kasmAudioStarted) return;
  window.__kasmAudioStarted = true;

  var ctx = null, node = null, analyser = null, ws = null;
  var running = false, bytes = 0, lastMsgAt = 0, mode = 'none';
  var pending = new Float32Array(0);

  function setStatus(t) {
    var el = document.getElementById('kasmAudioStatus');
    if (el) el.textContent = t;
  }

  function pushPCM(f) {
    if (pending.length > 96000) {
      pending = f;
      return;
    }
    var nb = new Float32Array(pending.length + f.length);
    nb.set(pending);
    nb.set(f, pending.length);
    pending = nb;
  }

  function useFallback() {
    if (mode === 'mp3') return;
    mode = 'mp3';
    try {
      var a = new Audio('/audio/live.mp3');
      a.play().then(function () {
        setStatus('兜底 MP3 播放中 | 延迟约10s');
      }, function () {
        setStatus('兜底被拦截，请点按钮');
      });
    } catch (e) {
      setStatus('音频初始化失败');
    }
  }

  function start() {
    if (!ctx) return;
    if (ctx.state !== 'running') {
      ctx.resume().then(function () {
        if (ctx.state === 'running') running = true;
      }).catch(function () {
        setStatus('ctx 启动失败，切兜底');
        useFallback();
      });
    } else {
      running = true;
    }
    setTimeout(function () {
      if (ctx && ctx.state !== 'running' && mode !== 'mp3') {
        setStatus('ctx 未运行，切兜底');
        useFallback();
      }
    }, 700);
  }

  function wire(n) {
    node = n;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    node.connect(analyser);
    analyser.connect(ctx.destination);
    if (ctx.state === 'running') running = true;
    setInterval(function () {
      if (!analyser) return;
      var buf = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(buf);
      var sum = 0;
      for (var i = 0; i < buf.length; i++) {
        var v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      var rms = Math.sqrt(sum / buf.length);
      var db = rms > 0.0001 ? Math.round(20 * Math.log10(rms)) : -999;
      var stalled = lastMsgAt && (Date.now() - lastMsgAt > 3000);
      setStatus((running ? '播放中' : '就绪，点击开启') + ' | ' + mode + ' | ctx=' + ctx.state + ' | ' + (bytes / 1048576).toFixed(1) + 'MB' + (stalled ? ' | ⚠️数据停' : '') + ' | ' + db + 'dB');
    }, 1000);
    setStatus('就绪，点击任意处开启');
  }

  function setupScript() {
    if (mode !== 'none') return;
    mode = 'script';
    try {
      var sp = ctx.createScriptProcessor(1024, 0, 2);
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
          c0.fill(0);
          c1.fill(0);
        }
      };
      wire(sp);
    } catch (err) {
      console.error('kasm ScriptProcessor failed:', err);
      mode = 'none';
      useFallback();
    }
  }

  window.__kasmAudioDebug = function () {
    return {
      ctxState: ctx ? ctx.state : null,
      wsState: ws ? ws.readyState : null,
      mode: mode,
      nodeMade: !!node,
      bytes: bytes,
      pendingSamples: pending.length,
      running: running,
      lastMsgAgo: lastMsgAt ? (Date.now() - lastMsgAt) : null
    };
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
      var flatness = Math.exp(logSum / freq.length) / (mean || 1);
      var binHz = ctx.sampleRate / analyser.fftSize;
      return {
        sampleRate: ctx.sampleRate,
        dominantHz: Math.round(peakBin * binHz),
        peakLevel: peak,
        flatness: Math.round(flatness * 100) / 100,
        nonzeroBins: nz
      };
    } catch (e) {
      return { err: String(e) };
    }
  };

  window.__kasmAudioLevel = function () {
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
    } catch (e) {
      return null;
    }
  };

  try {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('no AudioContext');
    try { ctx = new Ctx({ sampleRate: 48000 }); } catch (e) { ctx = new Ctx(); }

    var wsUrl = window.KASM_AUDIO_WS || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws-audio');
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = function (e) {
      bytes += e.data.byteLength;
      lastMsgAt = Date.now();
      var f = new Float32Array(e.data);
      if (!node) { pushPCM(f); return; }
      pushPCM(f);
    };
    ws.onerror = function () { setStatus('WS 错误，切兜底'); useFallback(); };
    ws.onclose = function () { if (!running) setStatus('WS 已断开'); };

    setupScript();

    ['pointerdown', 'keydown', 'touchstart', 'click'].forEach(function (ev) {
      window.addEventListener(ev, start, { capture: true, passive: true });
    });

    var b = document.createElement('button');
    b.type = 'button';
    b.id = 'kasmAudioBtn';
    b.textContent = '🔊 开启声音';
    b.title = '点击开启远程桌面音频';
    b.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647;padding:8px 14px;border:none;border-radius:6px;background:#1a9bd7;color:#fff;font:600 13px/1.2 sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35)';
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); start(); });
    document.body.appendChild(b);

    var s = document.createElement('span');
    s.id = 'kasmAudioStatus';
    s.textContent = '音频初始化中…';
    s.style.cssText = 'position:fixed;right:14px;bottom:52px;z-index:2147483647;padding:4px 10px;border-radius:4px;background:rgba(0,0,0,.55);color:#9fe6a0;font:12px/1.2 sans-serif;pointer-events:none';
    document.body.appendChild(s);
  } catch (err) {
    console.error('kasm audio init failed:', err);
    useFallback();
  }
})();
