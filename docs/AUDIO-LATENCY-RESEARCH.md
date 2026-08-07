# KasmVNC 音频延迟优化 — 网络调研报告

> 日期：2026-08-08　目标：把当前链路（PulseAudio → ffmpeg → TCP → relay → WebSocket → AudioWorklet/ScriptProcessor）的端到端延迟压到尽可能接近 20ms。
> 结论先行：**纯浏览器 + WS 管线做不到 <20ms**。物理下限约 65-90ms（Pulse 采集 + Chrome 输出缓冲）；只有「Chrome 启动参数 + WebRTC/WHIP」组合才有希望进入 20-40ms 区间。

---

## 1. 当前链路与实测

```
vsink.monitor (PulseAudio 虚拟声卡)
  → ffmpeg -f pulse -fragment_size 4096 → PCM f32le 48k stereo
  → TCP 127.0.0.1:8450
  → audio-relay.py（纯透传广播）
  → WebSocket 127.0.0.1:8451
  → player.js（ScriptProcessor 1024 → AudioContext 48k）
  → Chrome 音频后端（PulseAudio）→ 扬声器
```

现有实测（见 `EXPERIMENTS.md`）：

| 段 | 实测 |
|---|---|
| 源端（pulse→ffmpeg→relay→WS） | ~28ms（E2：默认 81ms → 加 `-fflags nobuffer -fragment_size 4096` 后） |
| 浏览器端（WS→JS→SP1024→输出） | ~130ms（含约 60ms 检测/测量开销，真实可听约 70-90ms） |
| 端到端 | ~162ms |
| 用户体感 | ~500ms（与实测差距待查，怀疑主线程饥饿/缓冲堆积） |

---

## 2. 延迟分解（每段的最小值）

| 段 | 当前 | 理论最小 | 瓶颈说明 |
|---|---|---|---|
| PulseAudio 采集（vsink.monitor） | ~10-40ms | ~10ms | Pulse 内部缓冲与 wakeup 周期；sink 缓冲默认较大 |
| ffmpeg pulse 输入 | ~11ms | ~2.7-5.3ms | `fragment_size 4096`B@48k = 10.7ms/块；可试 1024-2048B |
| TCP 本地回环 + relay | <1ms 传输 | <1ms | 瓶颈在**突发**：relay 一次 `read(8192)`=21ms 数据立即广播，客户端要缓冲补偿 |
| WebSocket (LAN) | <1ms | <1ms | 无丢包时无队头阻塞 |
| JS 解码/去交织 | ~0ms | ~0ms | 直通拷贝 |
| ScriptProcessor 1024 | ~21ms | — | 128-quantum AudioWorklet 仅 2.7ms；且 SP 在主线程，会被 VNC 视频解码饿死 |
| **Chrome 输出缓冲（Linux/Pulse 后端）** | **~40ms** | **~22ms** | **整条链路最大的单一硬下限**，见 §4.2 |

**合计**：现状 ~162ms；逐段压榨后理论下限 ≈ 10(PA) + 5(frag) + 1(relay) + 1(WS) + 3(worklet) + 22-40(输出) ≈ **65-90ms**。

---

## 3. 已用技术（对照代码核对）

- ✅ `ffmpeg -fflags nobuffer -fragment_size 4096`（`deploy/audio-stream.sh`）——E2 实测源端 81→28ms
- ✅ ScriptProcessor bufferSize 1024（`deploy/player.js:88`）——E3 实测 200→162ms
- ✅ 48kHz f32le 免重采样（`new Ctx({ sampleRate: 48000 })`）
- 🟡 AudioWorklet 128-quantum 候选（`tests/*.html`，E4 进行中；无头 Chrome 的 `process()` 不执行，需真实会话验证）
- ❌ 未设 `latencyHint`（`player.js:178`）
- ❌ relay 无限速/令牌桶（`audio-relay.py` 纯透传，`read(8192)` 后立即 `gather` 广播）
- ❌ Chrome 未加低延迟启动参数（现 PID 1290034，无 `--audio-buffer-size` 等）

---

## 4. 调研发现的可优化点

### 4.1 浏览器侧（立即可做，零成本）

1. **`latencyHint: 0`**：`new AudioContext({ sampleRate: 48000, latencyHint: 0 })`。实测参考（Jeff Kaufman / issarice 的 browser-audio-latency 测量，mic→speaker 场景，播放侧原理相同）：
   - Chrome 默认 ~67ms 端到端；加 `latencyHint: 0` 且 getUserMedia 关闭 `echoCancellation/noiseSuppression/autoGainControl` 后降到 **~19ms**；Firefox ~14ms。
   - 结论：浏览器端输出相关配置可省约 20-40ms。
2. **AudioWorklet 128-quantum 替代 ScriptProcessor**：quantum 21.3ms → 2.7ms，且脱离主线程，避免 VNC 视频解码导致回调饥饿、缓冲堆积（这很可能就是体感 500ms 的来源）。前提：在真实 X 会话的 Chrome 中验证 `process()` 执行（E4 未决）。
3. **drop-oldest 防堆积**：WS 数据到来快于播放时，缓冲会越长越延迟；超过水位线应丢旧数据而不是排队。当前实现若无限堆积，会直接解释「体感 500ms vs 实测 162ms」的差距。
4. **减小预卷（pre-roll）**：收到 ≥2 个 quantum 就开始播放，而不是等积累更长时间。
5. **可视化降频**：`analyser` 的 FFT 若每个 SP 回调都跑，会占用主线程；降频或只在空闲时刷新。

### 4.2 Chrome 启动参数（中等收益，需改浏览器启动方式）

- Chromium 官方提交 `7faf272`（2023，Add output buffer bypass to WebAudio）实测（Linux PulseAudio 后端，roundtrip-latency-tester）：
  ```
  --audio-buffer-size=128 --disable-features=WebAudioBypassOutputBuffering
  ```
  输出延迟 **40ms → 22ms**，roundtrip ~93ms。
- **页面内无法强制**——只能在 Chrome 启动时注入（改 xstartup / 桌面会话的启动命令）。
- 注意：`--audio-buffer-size` 在 Chromium `media_switches.cc` 中标注为 *"for debugging purpose"*；Chrome 148 是否仍生效需实测验证。

### 4.3 relay / 传输侧

1. **令牌桶/定时派发**：现在 relay 一次广播 8192B（≈21ms 数据）的突发，WS 客户端必须用 jitter buffer 吸收。改为按实时速率（48k×2ch×4B = 384KB/s）的 1.0-1.05 倍平滑派发，可显著减小客户端缓冲需求（同类项目 melody 的做法）。
2. **PulseAudio 原生 RTP**（`module-rtp-send`，`loop=1` 发本地）：比 ffmpeg 拉 monitor 更少一层缓冲，且自带 RTP timestamp，便于 relay/网关做精准调度；缺陷是浏览器不能直接消费裸 RTP，需要 WebRTC 网关配合。

### 4.4 架构级：WebRTC/WHIP（唯一能逼近 20ms 的路线）

- 链路：`ffmpeg -f pulse -i vsink.monitor → Opus → WHIP → SRS / MediaMTX → 浏览器 WHEP`。
- 延迟预算：Opus 20ms 帧 + 编解码算法延迟（约 5-26.5ms）+ LAN jitter buffer（可调小，局域网抖动低，正常 20-80ms、优秀 <20ms）→ 端到端 **20-50ms 现实可行**。
- 已知坑：**FFmpeg 8.0 的 WHIP 输出要求音视频轨同时存在**（MediaMTX 文档及讨论 #4927），音频-only 会失败，需用黑屏/静音视频轨垫底。
- 工程量大：要跑一个 media server + 页面端 WHEP/WebRTC 客户端 + 时钟/采样率同步。

---

## 5. 结论：20ms 是否可行

| 方案组合 | 预期端到端 | 结论 |
|---|---|---|
| 现状 | ~162ms（体感 ~500ms） | 基线 |
| P0：`latencyHint:0` + AudioWorklet + drop-oldest + relay 限速 | ~70-100ms | 立即可做，先把体感拉回实测值 |
| P0+P1：再加 Chrome 启动参数 | ~50-75ms | 需要改启动方式，实测参数是否生效 |
| P0+P1+P2：再换 WebRTC/WHIP | **~20-40ms** | 唯一可能接近 20ms 的组合 |

**严格 <20ms 在 Chrome Linux 上基本不可达**：即使传输、采集全部归零，Chrome 的 PulseAudio 输出缓冲最小约 22ms（带启动参数）——这是 WebAudio 规范与后端实现决定的物理下限。20-40ms 是现实中的“极致”区间。

**WASM/GPU 说明**：本场景瓶颈在音频后端缓冲与传输调度，不在解码 CPU；WASM 解码、GPU 计算对降低输出延迟没有帮助（重采样若未来需要 48k↔44.1k 转换，WASM 重采样才有意义）。

---

## 6. 落地优先级

1. **P0（今天可做）**：`player.js` 加 `latencyHint: 0`；AudioWorklet 128-quantum（先修 E4 验证）；WS 队列 drop-oldest + 减小预卷；relay 加令牌桶限速（或至少按连接限速）；`audio-stream.sh` 试 `-fragment_size 1024/2048`。
2. **P1（改环境）**：Chrome 启动注入 `--audio-buffer-size=128 --disable-features=WebAudioBypassOutputBuffering`，实测 Chrome 148 是否生效。
3. **P2（架构）**：评估 ffmpeg WHIP → MediaMTX/SRS → WHEP（含黑屏视频轨垫底），目标 20-40ms。
4. **P3（排查）**：复现并量化「体感 500ms vs 实测 162ms」，用 `performance.now()` 记录 WS 消息到达时间与播放时间差，确认是否主线程饥饿/backlog 堆积。

## 7. 待复测清单

- [ ] E4：真实 X 会话 Chrome 中 AudioWorklet `process()` 是否执行、延迟对比
- [ ] `latencyHint: 0` 前后端到端对比（同一测试音 + 检测脚本）
- [ ] relay 令牌桶前后对比（WS 突发大小、客户端缓冲水位）
- [ ] `-fragment_size 1024/2048` 源端对比
- [ ] Chrome 148 对 `--audio-buffer-size` 的实际支持情况

## 8. 参考链接

- Chromium "Add output buffer bypass to WebAudio"（`--audio-buffer-size=128 --disable-features=WebAudioBypassOutputBuffering`，Linux/Pulse 输出延迟 40→22ms）：https://chromium.googlesource.com/chromium/src/+/7faf272d89832d155e5b5aceb29389fbf5a29b55
- Browser Audio Latency（Chrome 默认 67ms → latencyHint:0 + 关 AEC/NS/AGC 后 19ms；Firefox 14ms）：https://www.jefftk.com/p/browser-audio-latency
- AudioWorklet Latency: Firefox vs Chrome（同一测量另一版本）：https://lw2.issarice.com/posts.php?id=eKC94QTfM2idmYaou
- MediaMTX 文档 — FFmpeg WHIP 发布（FFmpeg 8.0 必须音视频轨并存）：https://mediamtx.org/docs/publish/ffmpeg
- MediaMTX #4927 — FFmpeg 8.0 WHIP 音轨缺失 bug：https://github.com/bluenviron/mediamtx/discussions/4927
- rtcstats — WebRTC jitter buffer 正常范围（<20ms 优秀 / 20-80ms 正常）：https://rtcstats.com/kb/foundation-remote-inbound-rtp-jitter-ms
- PulseAudio `module-rtp-send`（原生 RTP、低延迟、loop=1 本地推送）：https://www.freedesktop.org/wiki/Software/PulseAudio/Documentation/User/Modules/
- Chromium `media_switches.cc`（`--audio-buffer-size` 标注为调试用途）：https://chromium.googlesource.com/chromium/src/+/main/media/base/media_switches.cc

## 9. 落地进度（2026-08-08）

- ✅ **P2 架构级 WebRTC 已上线**：ffmpeg-whip(master) → MediaMTX v1.20 → 浏览器 WHEP。
  - 音频-only 发布**成功**（MediaMTX v1.20 未受 FFmpeg 8.0「必须音视频并存」问题影响，见 E5）。
  - RTP 实测：10ms Opus 帧，100 包/s，RTP 时钟 vs 墙钟同步误差 4ms，环回抖动 0。
  - 发布端与 MediaMTX 均 systemd user 服务常驻，`Restart=always/on-failure`。
  - nginx `location /stream/ → 127.0.0.1:8889`（`proxy_buffering off`）。
- ✅ **播放器降级链**：WHEP → WS PCM → Icecast MP3；WHEP 5s 超时/ICE 失败自动降级。
- ✅ **延迟可视化 + UI 收起**：状态栏 `WHEP | 播放中 | 延迟≈Nms`；按钮默认收起，5s 无交互自动隐藏（播放中仅留绿点），悬停展开。
- ✅ **源端 fragment 512B**（2.7ms）双路推流已部署。
- ⏳ **P1 Chrome 输出参数**（`--audio-buffer-size=128`）未做：会断开远程桌面当前会话，需用户同意后择机重启。
- ⏳ **latencyHint 已设 `interactive`**；`latencyHint: 0` 未实测（受浏览器版本与策略影响，先看 WHEP 实测数）。

### 新的预期延迟分解（WHEP）

| 段 | 预期 |
|---|---|
| PulseAudio 采集（fragment 512B） | ~2.7-15ms |
| Opus 10ms 帧 + 算法前向延迟 | ~16ms |
| MediaMTX 同机转发 | <5ms |
| 局域网 UDP | <1ms |
| 浏览器 jitter buffer（playoutDelay） | 30-60ms（UI 实时显示） |
| Chrome 输出（baseLatency+outputLatency） | 10-20ms |
| **合计** | **~60-110ms**（若远程 Chrome 加 `--audio-buffer-size=128`：-20ms） |

### 后续实验

- [ ] 浏览器硬刷新后实测 WHEP 端到端（状态栏延迟 + 体感）
- [ ] WHEP vs WS 同场景对比
- [ ] `latencyHint: 0` vs `interactive` 对比
- [ ] 远程 Chrome `--audio-buffer-size=128` 前后对比（需用户同意重启）
