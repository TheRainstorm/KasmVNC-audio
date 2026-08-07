# KasmVNC 远程桌面低延迟音频实践

> 从一个「没有声音」的需求，到 160ms 端到端可用的音频链路，中间踩了三个坑：AudioWorklet 在无头环境不渲染、交织声道拆反导致慢放降八度、以及脉冲式转发带来的缓冲延迟。本文记录完整方案、故障根因与延迟优化过程。

## 背景

服务器（ares）上跑着 KasmVNC 远程桌面，无实体声卡。需要把桌面音频实时送到浏览器。需求：低延迟、无杂音、稳定。

初版方案用 PulseAudio 虚拟声卡 + Icecast 推 MP3，浏览器 `<audio>` 播放——能用，但延迟 10 秒，完全不可接受。随后改为「原始 PCM 走 WebSocket」：

```
桌面应用 → PulseAudio vsink（虚拟声卡）
                  │
                  ▼ vsink.monitor
        ┌─────────┴─────────┐
   ffmpeg f32le PCM    ffmpeg MP3（兜底）
        │                    │
   TCP 127.0.0.1:8450   Icecast :8445
        │                    │
   relay.py ──► WS :8451     │
                  │          │
   nginx :8444（TLS）────────┘
                  │
  浏览器：WebSocket → ScriptProcessor → 扬声器
```

## 关键技术决策

### 1. 传输格式：原始 f32le PCM，零压缩

ffmpeg 把 `vsink.monitor` 采集为 **48kHz / 立体声 / f32le** 裸流，直接 TCP 推给中继。不压缩、不封装，浏览器拿到就是 `Float32Array`，解码零开销：

```js
ws.binaryType = 'arraybuffer';
ws.onmessage = (e) => { pushPCM(new Float32Array(e.data)); };
```

### 2. 播放路径：ScriptProcessorNode，而不是 AudioWorklet

AudioWorklet 是现代方案，128-frame quantum（2.7ms）延迟最低，但在排障中发现一个致命环境差异：

- 无头 Chrome（headless）里，worklet 的 `registerProcessor` 成功、端口消息也能到达，但 **`process()` 从不被调用**，输出恒为静音。对照实验里同一个 analyser 读普通 OscillatorNode 有 -9dB 信号，读 worklet 输出就是 -999dB。
- ScriptProcessorNode 在同样环境完全正常。

真实浏览器理论上能跑 worklet，但既然无法在服务端复现验证，稳妥起见默认走 ScriptProcessor（bufferSize 1024 = 21ms），把 worklet 留作后续实验（见 EXPERIMENTS.md E4）。

### 3. 声道去交织：一个让声音「慢放降八度」的 bug

症状：浏览器能出声，但「频率非常低、像被慢放了」。状态栏还显示正常电平（-22dB），一度让人以为是内容问题。

根因：裸流是交织立体声 `[L0,R0,L1,R1,...]`，最初代码按「前 4096 个采样给左声道、后 4096 个给右声道」拆分：

```js
// 错误：把交织数据当成半幅平面数据
c0.set(pending.subarray(0, n));
c1.set(pending.subarray(n, n * 2));
```

结果每个输出样本承载的内容时间翻倍 → 频率减半、降八度、像慢放。验证方法很直接：放 440Hz 测试音，浏览器端 analyser 频谱主峰在 220Hz；改成逐采样去交织后主峰回到 445Hz。

```js
// 正确：逐采样拆左右
for (let j = 0; j < n; j++) {
  c0[j] = pending[pi];
  c1[j] = pending[pi + 1];
  pi += 2;
}
```

## 延迟优化：从 10s 到 ~160ms

### 源端（pulse → ffmpeg → relay → WS）

| 配置 | 延迟 |
|---|---|
| ffmpeg 默认 + relay 每次读 64KB | 81ms |
| ffmpeg 加 `-fflags nobuffer -fragment_size 4096` + relay 每次读 8KB | 28ms |

两个关键点：

- `fragment_size` 控制 PulseAudio 采集缓冲，默认由 pulse 决定（偏大），显式设小后采集延迟显著下降；
- relay 的读取块越大，一次转发携带的音频时长越长（64KB = 170ms），切成 8KB（21ms）让数据更平滑地流向浏览器，也减少浏览器端待处理缓冲的波动。

### 浏览器端（WS → JS → SP → 输出）

| ScriptProcessor bufferSize | 端到端实测 |
|---|---|
| 4096 | ~200ms |
| 1024 | ~162ms |

bufferSize 从 4096 降到 1024（21ms），并给待处理缓冲加了上限，避免长时间运行时积压导致延迟漂移。

### 实测延迟构成（同一台机，paplay 触发 → analyser 检测到）

```
源端  ~28ms
浏览器端  ~130ms（其中 analyser 检测与轮询约占 60ms，真实可听约 70~90ms）
端到端  ~162ms
```

## 诊断体系

播放器内嵌三个调试接口，排障全靠它们：

- `__kasmAudioDebug()`：上下文状态、WS 状态、模式、已收字节、待处理采样数；
- `__kasmAudioSpectrum()`：主频、频谱平坦度、非零 bin 数——一眼区分「纯音 / 音乐 / 直流噪声」；
- `__kasmAudioLevel()`：即时 RMS 电平，用于精确测延迟。

还有一个流健康探针（`tests/probe4.py`）：连 WS 抓几秒数据，统计唯一值个数、直流分量、声道相关性。直流 + 唯一值=1 = 反馈回路或坏流；唯一值几百 = 真实内容。

## 一个差点把人绕晕的坑：自我反馈回路

排障「噪声」时，抓流分析发现全频段都是恒定直流（±0.88），而且时好时坏。逐个静音隔离后定位到「Chrome 的播放流」。最后发现：**那是我们自己跑在服务器本地的无头测试浏览器**——它连上 WS 播放音频，声音又灌回同一个 PulseAudio sink，形成

```
vsink → ffmpeg → relay → WS → 测试浏览器 → PulseAudio → vsink → ...
```

的反馈回路，收敛成恒定直流。教训：**在服务器本机测试播放器时，必须给浏览器静音（--mute-audio 还不够，直接关掉测试实例）**，否则会污染所有真实用户的流。

## 部署与运维

完整代码与部署脚本见本仓库：

- `deploy/player.js`：浏览器播放器（含诊断）；
- `deploy/audio-relay.py`：TCP→WS 中继（systemd 用户服务）；
- `deploy/audio-stream.sh`：ffmpeg 双路推流；
- `deploy/kasmvnc-audio.conf`：nginx 8444 统一入口（含 `/stream/` → MediaMTX）；
- `deploy/inject.py`：把播放器注入 KasmVNC 页面；
- `deploy/mediamtx.yml` + `deploy/kasm-audio-webrtc.service` + `deploy/kasm-audio-whep.service`：WebRTC 服务。

浏览器访问 `https://<host>:8444`，右下角 🔊 按钮**默认收起**：悬停展开状态（模式/延迟/电平），5 秒无交互自动隐藏（播放中只留一个绿点）。

## 现状与展望

- 延迟：端到端实测 ~160ms，用户体感约 0.5s（差距可能来自主线程繁忙导致的回调饥饿，见 EXPERIMENTS.md）。
- 下一步：真实 X 会话中验证 AudioWorklet 128-quantum 的可行性（目标浏览器缓冲 2.7ms）；自适应缓冲水位；评估 `<20ms` 的物理下限。

完整实验数据见 [EXPERIMENTS.md](EXPERIMENTS.md)。


## 升级：WebRTC / WHIP-WHEP（把延迟从 160ms 压向 60ms）

WS PCM 管线再怎么调，浏览器端 ScriptProcessor(21ms) + Chrome 输出缓冲(40ms) 就有物理下限 ~65-90ms，体感还会被主线程饥饿放大到 0.5s。于是把传输层换成 WebRTC：

```
桌面应用 → PulseAudio vsink
                │
                ▼ vsink.monitor
        ffmpeg-whip（Opus 10ms 帧，libopus 96k/48k）
                │  WHIP (HTTP POST offer + UDP SRTP)
                ▼
        MediaMTX v1.20（仅 WebRTC，:8889/:8189）
                │  WHEP (HTTP POST answer + trickle)
                ▼
        浏览器 RTCPeerConnection → AudioContext → 扬声器
```

### 关键决策

1. **Opus 10ms 帧**：`-frame_duration 10`，RTP 实测 100 包/s、时钟同步误差 4ms、环回抖动 0——局域网下几乎零抖动，jitter buffer 可以压得很小。
2. **音频-only 发布**：MediaMTX v1.20 接受纯音频 WHIP（FFmpeg 8.0 的「必须音视频并存」问题只在那个版本出现，我们用 ffmpeg master）。
3. **发布端常驻**：`kasm-audio-whep.service`（systemd user，Restart=on-failure）；MediaMTX 也是 systemd user 服务。重启自愈，不依赖交互式 shell。
4. **播放器降级链**：WHEP → WS PCM → Icecast MP3。WHEP 5 秒无轨道或 ICE 失败自动切 WS，WS 断再切 MP3，任何一环挂了都有声。
5. **延迟可视化**：状态栏实时显示 `WHEP | 播放中 | 延迟≈Nms`（WHEP 用 `inbound-rtp.playoutDelay + outputLatency + baseLatency`，WS 用待播缓冲 + SP quantum）。

### 实验数据（E5）

- RTP：697 包/8s = 100 包/s（10ms），RTP 时钟 6960ms vs 墙钟 6964ms。
- 延迟预算：采集 ~3-15ms + Opus 10ms + 转发 <5ms + 网络 <1ms + 浏览器 playout/output ~30-60ms ≈ **预期 60-110ms**，比 WS 路径的 162ms 至少省 50ms；配合远程 Chrome `--audio-buffer-size=128` 还能再省 ~20ms。

### 待办

- 用户硬刷新后实测 WHEP 路径的体感与状态栏延迟数字；
- 若仍 >60ms，重启远程桌面 Chrome 注入低延迟输出参数（会断开当前桌面页面，需择机）。
