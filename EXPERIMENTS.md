# 实验记录

所有测量在同一台机器（ares, 127.0.0.1）完成：paplay 启动测试音 → 检测信号到达。测试音为 ffmpeg 生成的 440Hz 立体声正弦波。

## E0 基线（v3 AudioWorklet 播放器）

- 无头 Chrome 中 AudioWorklet 的 `process()` 从不执行（已注册、端口消息可达，但输出恒静音 -999dB），而 ScriptProcessorNode 正常出信号。
- 结论：默认路径必须用 ScriptProcessorNode；AudioWorklet 仅作真实浏览器可行性候选（见 E4）。

## E1 声道去交织 bug（“慢放/降八度”）

- 现象：浏览器听到的声音频率减半、像慢放。状态栏 `93MB | -22dB`。
- 根因：交织立体声 `[L,R,L,R,...]` 被错误地按“前一半=左、后一半=右”拆分，等于每个采样播放时长翻倍。
- 验证：440Hz 测试音，旧拆分主频 220Hz，正确去交织后 445Hz。
- 修复：`c0[j]=pending[2j]; c1[j]=pending[2j+1]`。

## E2 源端延迟优化（ffmpeg / relay）

| 配置 | 源端延迟 |
|---|---|
| ffmpeg 默认 + relay 读 65536B | 81ms |
| ffmpeg `-fflags nobuffer -fragment_size 4096` + relay 读 8192B | 28ms |

## E3 浏览器端缓冲优化

| ScriptProcessor bufferSize | 端到端 |
|---|---|
| 4096 | ~200ms |
| 2048 | - |
| 1024 | ~162ms |

1024 帧 = 21.3ms @48kHz。更小会加剧主线程（VNC 视频解码）繁忙时的丢帧。

## E4（进行中）AudioWorklet 128-quantum 可行性

- 目标：把浏览器缓冲从 21ms 降到 2.7ms。
- 无头 Chrome 不可行；需在真实 X 会话 Chrome 中验证 `process()` 是否执行。

## 延迟预算（当前，实测）

```
源端（pulse→ffmpeg→relay→WS）  ~28ms
浏览器端（WS→JS→SP1024→输出）  ~130ms（含 ~60ms 检测/测量开销，真实可听约 ~70-90ms）
端到端实测                     ~162ms
```

用户体感 ~500ms，与实测差距待查：怀疑为浏览器主线程繁忙导致 ScriptProcessor 回调饥饿、待处理缓冲堆积，或视频与音频的相对延迟。

## E5 WebRTC / WHIP-WHEP（2026-08-08，目标 <60ms 的主路线）

背景：WS PCM 管线端到端 ~162ms，用户体感 ~500ms（主线程饥饿/缓冲堆积）。改走 WebRTC：
PulseAudio → Opus(10ms 帧) → WHIP → MediaMTX → WHEP → 浏览器 RTCPeerConnection。

| 项 | 结果 |
|---|---|
| WHIP 发布端 | ffmpeg-whip (master N-125990) `-f pulse -fragment_size 512 -i vsink.monitor -c:a libopus -b:a 96k -ar 48000 -ac 2 -frame_duration 10 -f whip http://127.0.0.1:8889/stream/whip` |
| MediaMTX | v1.20.0，仅 WebRTC（rtsp/rtmp/hls/srt/moq 全关），`paths.all_others: source: publisher`，监听 :8889(TCP) / :8189(UDP/ICE) |
| WHEP 拉流 | 浏览器 `fetch POST /stream/whep`（application/sdp offer）→ 201 + answer（含局域网 IP 候选）+ `Location` 做 trickle |
| 音频-only 发布 | ✅ MediaMTX v1.20 接受纯音频 WHIP（FFmpeg 8.0 的「必须音视频并存」问题未出现，我们用 ffmpeg master） |
| RTP 实测（werift 拉流 8s） | 697 包 ≈ 100 包/s（10ms 帧）；RTP 时钟 6960ms vs 墙钟 6964ms，时钟同步 4ms 误差；环回抖动 0.00ms |
| ICE 候选 | answer 含 127.0.0.1 / 127.0.0.1（LAN）/ docker 网桥 / IPv6，客户端可直连 :8189 UDP；ufw inactive |
| 常驻化 | `kasm-audio-whep.service`（发布端）+ `kasm-audio-webrtc.service`（MediaMTX）均为 systemd user 服务，Restart=always |
| nginx | `location /stream/ → http://127.0.0.1:8889`（proxy_buffering off），8444 经 TLS 可达 |

### 延迟预算（WHEP 路径，预期）

```
源端 PulseAudio 采集        ~2.7-15ms（fragment 512B=2.7ms + Pulse 内部缓冲）
Opus 编码                   10ms 帧 + 算法前向延迟 ~6.5ms
MediaMTX 转发               <5ms（同机）
局域网 UDP 传输              <1ms
浏览器 jitter buffer        Chrome playoutDelay（UI 实时显示，通常 30-60ms）
Chrome 输出                 ~10-20ms（outputLatency + baseLatency）
─────────────────────────────
预期端到端                  ~60-110ms；配合远程 Chrome --audio-buffer-size=128 再省 ~20ms
```

### 待复测（浏览器侧）

- [ ] 用户在 Windows Chrome 硬刷新后确认 WHEP 出声、状态栏 `WHEP | 播放中 | 延迟≈Nms`
- [ ] 与旧 WS 路径对比延迟（状态栏切 WS 兜底时显示缓冲 ms）
- [ ] 如 >60ms：重启远程 Chrome 加 `--audio-buffer-size=128`（会断桌面页面，需用户同意）

### 坑记录

- werift `track.onReceiveRtp` 是 Event 对象，必须 `.subscribe(fn)`，直接赋值会导致 0 包（静默失败）。
- WHIP 发布端 MediaMTX 连接是「HTTP 建连后媒体走 UDP」：`ss` 看不到 8889 的 TCP 长连接是正常的，看 UDP :8189。
- nginx 加 `location` 必须放在 server 块内，且 WHEP 响应要 `proxy_buffering off` 以免 answer 被缓冲延迟。

## E6 网页 401 根因 + 认证免打扰（2026-08-08）

- 现象：硬刷新后 `GET /` 直接 401，Chrome 不弹密码框，反复刷新被 KasmVNC 拉黑。
- 根因：KasmVNC 网页层（websockify 8443）强制 Basic Auth（`user:password`，密码文件 `~/.kasmpasswd` 为 sha256-crypt）。Chrome 的 HTTP Basic 凭证**只在内存**，浏览器重启/清除后即丢失；且凭证被拒一次后 Chrome 不再自动重发/弹窗 → 401 → KasmVNC `BlacklistThreshold 5 / BlacklistTimeout 10` 把 IP 拉黑 10s。
- 修复：nginx 在 `location /`（反代 8443）注入 `proxy_set_header Authorization "Basic $(base64 user:password)"`，浏览器永远收不到 401，无需任何凭证操作；`websockify` 升级请求同样被注入，实测无凭证 `GET /websockify` → 101。
- 安全说明：8444 对 LAN 开放等于免密进入桌面；如需收紧，删掉该行并 reload nginx 即可恢复 Basic Auth。
- 另修：WHEP trickle 404 —— MediaMTX v1.20 的候选提交端点要求 `PATCH` + `Content-Type: application/trickle-ice-sdpfrag`（RFC 8840，body 含 `m=` 行 + `a=mid` + `a=ice-ufrag/pwd` + `a=candidate`），旧的 `POST + application/json` 返回 404；已按新格式重写 `player.js` 的 `onicecandidate`，实测 PATCH → 200。

## E7 WHEP「解码成功但能量=0 / 静音」根因：无头探测 Chrome 反馈回路（2026-08-08）

现象：WHEP 收到 RTP、framesDecoded>0，但 totalAudioEnergy≈0、UI `-999dB`；一会儿后看门狗降级 WS，WS 有「声音」但内容是无意义 DC（用户原话「声音不对，只是噪声」「显示 -1dB」）。时好时坏。

### 决定性对照实验

1. werift 拉 WHEP 抓 Opus RTP → ctypes 调系统 libopus 解码：主链路 RMS -47.7dB（静音）。
2. 同一时刻 WS PCM 路径（probe4）max=0.8847 且 `uniq(first 1000)=1` —— 全是同一个常数，是 **DC 直流**，不是音频。
3. 本地 `ffmpeg -f pulse -fragment_size 512 -i vsink.monitor → opus` 解码：-21dB，与 monitor 直测（-1.1dB）对不上 → monitor 本身异常。
4. paplay 原生播放正弦 → vsink.monitor 仍是常数 DC；新建 vsink2 → 正常正弦。**monitor 卡死输出常数 DC**。
5. 把 vsink 上的 3 个播放流（2 个 Chrome + ffmpeg 测试音）逐个静音：任一 Chrome 静音后信号立刻变回真实音频 → **DC 来自 Chrome**。
6. 查进程：两个 headless Chrome（chromeprobe3/4，`kasm_audio_autostart=1` 加载播放页）的音频服务进程把播放器的输出写进了 PulseAudio 默认 sink（= vsink）→ monitor → 又流回 WS/WHEP → **正反馈回路**，收敛成常数 DC（约 ±0.88）。

### 为什么症状如此

- WS 路径：PCM f32 原样转发 DC → 浏览器听到 -1dB 噪声/爆音（用户以为「有声音」）。
- WHEP 路径：Opus 编码器内置高通滤波器把 DC 滤掉 → 解码后能量≈0 →「WHEP 没有声音」。
- 时好时坏：回路只在探测 Chrome（或 ares 本机打开播放页的浏览器）在 vsink 上输出时才形成；Chrome 断开/挂起时 monitor 恢复。

### 修复（回路断开 + 持久化）

1. 新建独立 null sink `loop_sink`，把探测 Chrome 的音频输出指过去（`PULSE_SINK=loop_sink`），播放器功能不受影响（analyser/levelDb 照常），但输出不再回到 vsink.monitor。
2. 持久化：`~/.config/pulse/default.pa` = 系统 default.pa 完整复制 + 追加 `vsink`、`loop_sink` 两个 module-null-sink（PulseAudio 重启后自动恢复；不要只写一行覆盖系统配置）。
3. 卸载测试用 vsink2；保留 chromeprobe4（9224，带 `--enable-logging`）作为可观测探测实例。
4. 验证：vsink.monitor 连续多次采样稳定（uniq≈540、RMS=-26dB 为 tone-probe 轻测试音）；响亮测试音（volume=8，RMS -6dB）WS=-6.2dB、WHEP 解码=-6.4dB，两条路完全一致。

### 坑记录

- ffmpeg `sine` 源默认振幅只有满刻度的 1/8（RMS ≈ -22dB），`volume=0.9` 后仍很轻；做能量对比时必须先测输入电平，否则会把「忠实链路」误判成「衰减 20dB」。
- 判断 monitor 是否损坏：`uniq(first N)` 是否 ≈1（常数）是快速判据；`suspend-sink` 无法修复，需 unload/reload module-null-sink。
- PulseAudio 用户级 `~/.config/pulse/default.pa` 存在时会**整体替代**系统配置，追加时必须以系统文件为底。
