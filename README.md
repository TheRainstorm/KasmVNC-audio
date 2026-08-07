# KasmVNC Audio

为 KasmVNC 远程桌面添加低延迟音频。桌面音频经 PulseAudio 虚拟声卡 `vsink` 采集，主链路用 **WebRTC（WHIP→MediaMTX→WHEP，Opus 10ms 帧）**，WebSocket PCM 与 Icecast MP3 作为降级兜底。

## 架构

```
桌面应用 → PulseAudio vsink → vsink.monitor
                                 │
                                 ├─ ffmpeg-whip (Opus 10ms) → WHIP → MediaMTX :8889/:8189 → WHEP → 浏览器 RTCPeerConnection  ← 主链路（低延迟）
                                 ├─ ffmpeg (f32le PCM) → TCP 8450 → relay.py → WS 8451    → 浏览器 WebSocket                ← 兜底 1
                                 └─ ffmpeg (MP3 兜底)  → Icecast 8445  → /audio/live.mp3   → 浏览器 <audio>                   ← 兜底 2

浏览器 ← https://<host>:8444（nginx：KasmVNC 8443 + /stream/→8889 + /ws-audio→8451 + /audio/→8445）
```

## 组件

| 文件 | 作用 |
|---|---|
| `deploy/player.js` | 浏览器播放器：WHEP/WebRTC 优先 → WS PCM → MP3 降级链；状态栏实时延迟、电平、模式；按钮默认收起、5s 无交互自动隐藏 |
| `deploy/audio-relay.py` | Python 中继：TCP 8450 → WebSocket 8451，小分块低延迟广播 |
| `deploy/audio-stream.sh` | ffmpeg 双路推流：PCM→TCP、MP3→Icecast，崩溃自动重启 |
| `deploy/kasmvnc-audio.conf` | nginx 8444：TLS 入口，反代 KasmVNC 8443 + WS 音频 + Icecast |
| `deploy/kasm-audio-relay.service` | systemd 用户服务，管理 PCM relay |
| `deploy/kasm-audio-webrtc.service` | systemd 用户服务，管理 MediaMTX |
| `deploy/kasm-audio-whep.service` | systemd 用户服务，管理 WHIP 发布端（ffmpeg-whip） |
| `bin/mediamtx.yml` | MediaMTX 配置：仅 WebRTC，`all_others` 发布者模式 |
| `deploy/inject.py` | 把播放器注入 `/usr/share/kasmvnc/www/{index,vnc}.html` |
| `deploy/xstartup` | 会话启动：pulse 虚拟声卡 + 推流脚本 + xfce4 |

## 部署

1. PulseAudio 虚拟声卡（见 `xstartup`）：`pactl load-module module-null-sink sink_name=vsink`，默认 sink 设为 `vsink`。
2. ffmpeg 双路推流：`bash deploy/audio-stream.sh`。
3. relay：`systemctl --user enable --now kasm-audio-relay.service`。
4. nginx：复制 `deploy/kasmvnc-audio.conf` 到 `/etc/nginx/conf.d/`，`nginx -t && systemctl reload nginx`。
5. 注入播放器：`sudo python3 deploy/inject.py`，强刷页面（Ctrl+Shift+R）。
6. WebRTC：`bin/mediamtx.yml` 放 `bin/`，`systemctl --user enable --now kasm-audio-webrtc.service kasm-audio-whep.service`（依赖 `bin/ffmpeg-whip`，见 `bin/README.md`）。
6. Icecast（可选兜底）：`/etc/icecast2/icecast.xml` 开启 8445，source 密码放 `~/.vnc/.icecast-source-pass`。

## 已知问题 / 待办

- `xstartup` 里冗余启动 relay 与 systemd 服务冲突，已在仓库中移除该行，线上生效需重开会话（未执行，避免中断）。
- 播放器在无头 Chrome 中 AudioWorklet 的 `process()` 不执行（无音频设备），故默认走 ScriptProcessor；真实浏览器 worklet 可行性实验见 `EXPERIMENTS.md`。
- 延迟目标 <60ms：WHEP 主链路预期 60-110ms，浏览器 `playoutDelay` 是最大变量（状态栏实时显示）；远程 Chrome 加 `--audio-buffer-size=128` 可再省 ~20ms（需重开会话）。
- 详细实验与网络调研见 `EXPERIMENTS.md`、`docs/AUDIO-LATENCY-RESEARCH.md`。

## 测试

```bash
# 端到端延迟（node 在本机 spawn paplay，浏览器 analyser 检测）
node tests/latency.js
# 源端延迟（pulse→ffmpeg→relay→WS）
python3 tests/latency-src.py
# 流内容健康检查（uniq/直流/声道相关）
python3 tests/probe4.py
```
