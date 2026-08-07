# KasmVNC Audio

为 KasmVNC 远程桌面添加低延迟音频。桌面音频经 PulseAudio 虚拟声卡 `vsink` 采集，ffmpeg 转为 48kHz 立体声 f32le PCM，经 TCP 中继广播到 WebSocket，浏览器端播放器解码后输出。

## 架构

```
桌面应用 → PulseAudio vsink → vsink.monitor
                                 │
                                 ├─ ffmpeg (f32le PCM) → TCP 127.0.0.1:8450 → relay.py → WS 127.0.0.1:8451
                                 └─ ffmpeg (MP3 兜底)  → Icecast 127.0.0.1:8445  → /audio/live.mp3

浏览器 ← wss://<host>:8444/ws-audio (nginx 反代) ← relay
        ← https://<host>:8444/audio/live.mp3 (MP3 兜底)
```

## 组件

| 文件 | 作用 |
|---|---|
| `deploy/player.js` | 浏览器播放器：WebSocket 收 f32le PCM，ScriptProcessor 输出，带 dB/MB/频谱诊断 |
| `deploy/audio-relay.py` | Python 中继：TCP 8450 → WebSocket 8451，小分块低延迟广播 |
| `deploy/audio-stream.sh` | ffmpeg 双路推流：PCM→TCP、MP3→Icecast，崩溃自动重启 |
| `deploy/kasmvnc-audio.conf` | nginx 8444：TLS 入口，反代 KasmVNC 8443 + WS 音频 + Icecast |
| `deploy/kasm-audio-relay.service` | systemd 用户服务，管理 relay |
| `deploy/inject.py` | 把播放器注入 `/usr/share/kasmvnc/www/{index,vnc}.html` |
| `deploy/xstartup` | 会话启动：pulse 虚拟声卡 + 推流脚本 + xfce4 |

## 部署

1. PulseAudio 虚拟声卡（见 `xstartup`）：`pactl load-module module-null-sink sink_name=vsink`，默认 sink 设为 `vsink`。
2. ffmpeg 双路推流：`bash deploy/audio-stream.sh`。
3. relay：`systemctl --user enable --now kasm-audio-relay.service`。
4. nginx：复制 `deploy/kasmvnc-audio.conf` 到 `/etc/nginx/conf.d/`，`nginx -t && systemctl reload nginx`。
5. 注入播放器：`python3 deploy/inject.py`（先 `base64 -w0 player.js | ssh ares 'base64 -d > /tmp/player-v4.js'` 传文件），强刷页面。
6. Icecast（可选兜底）：`/etc/icecast2/icecast.xml` 开启 8445，source 密码放 `~/.vnc/.icecast-source-pass`。

## 已知问题 / 待办

- `xstartup` 里冗余启动 relay 与 systemd 服务冲突，已在仓库中移除该行，线上生效需重开会话（未执行，避免中断）。
- 播放器在无头 Chrome 中 AudioWorklet 的 `process()` 不执行（无音频设备），故默认走 ScriptProcessor；真实浏览器 worklet 可行性实验见 `EXPERIMENTS.md`。
- 延迟目标 <20ms 受 PulseAudio 采集与浏览器输出设备物理限制，实测下限见实验记录。

## 测试

```bash
# 端到端延迟（node 在本机 spawn paplay，浏览器 analyser 检测）
node tests/latency.js
# 源端延迟（pulse→ffmpeg→relay→WS）
python3 tests/latency-src.py
# 流内容健康检查（uniq/直流/声道相关）
python3 tests/probe4.py
```
