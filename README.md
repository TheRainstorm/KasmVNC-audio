# KasmVNC Audio

为 [KasmVNC](https://github.com/kasmtech/KasmVNC) 远程桌面添加**低延迟实时音频**。桌面音频经 PulseAudio 虚拟声卡 `vsink` 采集，主链路走 **WebRTC（WHIP→MediaMTX→WHEP，Opus 10ms 帧）**，WebSocket PCM 与 Icecast MP3 作为自动降级兜底。浏览器端带实时延迟/电平显示、通道手动切换、按钮自动收起。

实测：WHEP 主链路端到端延迟约 **45ms**（状态栏实时显示），与 WS PCM 路径相当或更低，明显优于 Icecast MP3 的秒级路径。

## 架构

```
桌面应用 → PulseAudio vsink → vsink.monitor
                                 │
                                 ├─ ffmpeg-whip (Opus 10ms) → WHIP → MediaMTX :8889/:8189 → WHEP → 浏览器 RTCPeerConnection  ← 主链路（低延迟）
                                 ├─ ffmpeg (f32le PCM) → TCP 8450 → relay.py → WS 8451    → 浏览器 WebSocket                ← 兜底 1
                                 └─ ffmpeg (MP3 兜底)  → Icecast 8445  → /audio/live.mp3   → 浏览器 <audio>                   ← 兜底 2

浏览器 ← https://<host>:8444（nginx：KasmVNC 8443 + /stream/→8889 + /ws-audio→8451 + /audio/→8445）
```

| 端口 | 用途 | 监听 |
|---|---|---|
| 8444 | nginx TLS 统一入口（浏览器访问） | 0.0.0.0 |
| 8443 | KasmVNC（websockify） | 回环，经 nginx 反代 |
| 8889 | MediaMTX HTTP（WHIP/WHEP 信令） | 回环，经 nginx `/stream/` 反代 |
| 8188 / 8189 | WHEP 媒体（TCP/UDP，ICE 候选，客户端直连） | 0.0.0.0 |
| 8450 / 8451 | PCM：ffmpeg→TCP→relay→WebSocket | 回环 |
| 9997 | MediaMTX 本地 API（whip-watchdog 检查发布状态） | 回环 |
| 8445 | Icecast MP3 兜底 | 回环 |

## 快速开始

```bash
git clone https://github.com/TheRainstorm/KasmVNC-audio
cd KasmVNC-audio

# 1) 下载依赖二进制（不随 git 分发，见 bin/README.md）：bin/mediamtx、bin/ffmpeg-whip、bin/ffmpeg
# 2) 安装支持脚本 + systemd 用户服务（路径自动替换，可 --dry-run 预览）
bash deploy/install.sh

# 3) nginx 统一入口（需 root）
sudo cp deploy/kasmvnc-audio.conf /etc/nginx/conf.d/
sudo openssl req -x509 -newkey rsa:2048 -nodes \
     -keyout /etc/nginx/ssl/kasmvnc.key -out /etc/nginx/ssl/kasmvnc.pem \
     -days 3650 -subj "/CN=remote-audio"
sudo nginx -t && sudo systemctl reload nginx

# 4) 把播放器注入 KasmVNC 网页（需 root；KasmVNC 升级后需重跑）
sudo python3 deploy/inject.py

# 5) 浏览器打开 https://<host>:8444，右下角点 🔊
```

## 目录结构

| 文件 | 作用 |
|---|---|
| `deploy/install.sh` | 一键安装：支持脚本 + systemd 用户服务（路径自动替换，支持 `--dry-run`/`--no-start`） |
| `deploy/player.js` | 浏览器播放器：WHEP/WebRTC 优先 → WS PCM → MP3 降级链；状态栏实时延迟、电平、模式；按钮默认收起、5s 无交互自动隐藏；通道手动选择（自动/WHEP/WS，localStorage 记忆） |
| `deploy/audio-relay.py` | Python 中继：TCP 8450 → WebSocket 8451，小分块低延迟广播 |
| `deploy/audio-stream.sh` | ffmpeg 双路推流：PCM→TCP、MP3→Icecast，崩溃自动重启 |
| `deploy/kasmvnc-audio.conf` | nginx 8444：TLS 入口，反代 KasmVNC 8443 + WS 音频 + Icecast + WHIP/WHEP |
| `deploy/kasm-audio-{relay,webrtc,whep}.service` | systemd 用户服务（relay / MediaMTX / WHIP 发布端） |
| `deploy/whip-watchdog.py` + `deploy/kasm-audio-whep-watchdog.service` | WHIP 发布看门狗：检测 MediaMTX 上 `stream` 流消失（热重载/发布端挂死）自动重启发布端，~20s 自愈 |
| `bin/mediamtx.yml` | MediaMTX 配置模板：仅 WebRTC，`all_others` 发布者模式；运行配置由 `deploy/gen-mediamtx-config.sh` 在服务启动前自动生成到 `~/.vnc/mediamtx.yml`（ICE 候选 = 默认路由主 IPv4，无需手动填） |
| `deploy/gen-mediamtx-config.sh` | mediamtx `ExecStartPre`：按默认路由自动算出服务器主 IPv4 写入运行配置（`KASM_AUDIO_LAN_IP` 可覆盖） |
| `bin/README.md` | 依赖二进制下载说明（mediamtx、ffmpeg-whip） |
| `deploy/inject.py` | 把播放器注入 `/usr/share/kasmvnc/www/{index,vnc}.html` |
| `deploy/xstartup` | KasmVNC 会话启动示例：pulse 虚拟声卡 + 推流脚本 + xfce4 |
| `tests/` | 延迟 / 流健康测试脚本 |

## 详细安装

### 0. 前置要求

- Ubuntu 22.04/24.04 x86_64（其他发行版需自行适配）。
- 已安装并跑通 **KasmVNC**（`kasmvncserver`，Debian/Ubuntu 可用 `dpkg -i kasmvncserver_*.deb` 安装），桌面会话可访问。
- `pulseaudio` + `pulseaudio-utils`（`pactl`）、`nginx`、`python3`（≥3.8，`pip install websockets`）、`curl`。
- 可选：`icecast2`（MP3 兜底）、`node` ≥18（端到端延迟测试）。

### 1. 下载依赖二进制

`bin/` 下的运行产物**不随 git 分发**（见 `bin/.gitignore`），按 `bin/README.md` 下载：

| 工具 | 用途 | 获取 |
|---|---|---|
| `bin/mediamtx` | WebRTC 媒体服务器（WHIP/WHEP） | https://github.com/bluenviron/mediamtx/releases （v1.20.0，解压出 `mediamtx` 可执行文件） |
| `bin/ffmpeg-whip` | 带 WHIP muxer 的 FFmpeg（Ubuntu 自带 6.1 没有 WHIP） | https://github.com/BtbN/FFmpeg-Builds/releases （`ffmpeg-master-latest-linux64-gpl.tar.xz`，把 `bin/ffmpeg` 复制为 `ffmpeg-whip`） |
| `bin/ffmpeg` | PCM/MP3 双路推流（也可直接用系统 ffmpeg） | 同上 release 的 `ffmpeg-n7.1-latest-linux64-gpl.tar.xz` |

验证：

```bash
bin/ffmpeg-whip -h muxer=whip   # 出现 whip 说明支持
bin/mediamtx -version
```

> 提示：只有 WHIP 发布端必须用 `ffmpeg-whip`；PCM/MP3 兜底路系统自带的 `ffmpeg` 即可。

### 2. PulseAudio 虚拟声卡 `vsink`

音频源是虚拟声卡 `vsink`（无实体声卡时桌面音频都进这里），采集端读 `vsink.monitor`：

```bash
pactl load-module module-null-sink sink_name=vsink sink_properties=device.description=Virtual_Sink
pactl set-default-sink vsink
```

`deploy/xstartup` 里已包含这段（KasmVNC 会话启动时自动执行）。若手动测试，先保证 PulseAudio 在跑（`pulseaudio --start --exit-idle-time=-1`）。

### 3. 一键安装脚本

```bash
bash deploy/install.sh          # 安装并启动
bash deploy/install.sh --dry-run  # 先看会做什么
bash deploy/install.sh --no-start # 只装文件不启动
```

做的事：

1. 把 `deploy/audio-relay.py`、`deploy/audio-stream.sh` 复制到 `~/.vnc/`（内部硬编码路径自动替换为你的 `$HOME`）。
2. 把 3 个 systemd 用户服务装到 `~/.config/systemd/user/`，`ExecStart` 里的仓库路径自动替换为当前路径。
3. `systemctl --user enable --now kasm-audio-webrtc kasm-audio-whep kasm-audio-relay kasm-audio-whep-watchdog`。看门狗会检测 `stream` 流是否在线（经 MediaMTX 本地 API :9997），丢失约 15s 后自动重启发布端自愈。

检查：

```bash
systemctl --user is-active kasm-audio-webrtc kasm-audio-whep kasm-audio-relay
# 期望三个都是 active
ss -ltn | grep -E '8889|8188|8450|8451'
journalctl --user -u kasm-audio-whep -f   # 看 WHIP 发布端日志
```

### 4. nginx 统一入口（8444）

把 `deploy/kasmvnc-audio.conf` 放到 `/etc/nginx/conf.d/`，并准备证书：

```bash
sudo cp deploy/kasmvnc-audio.conf /etc/nginx/conf.d/
sudo mkdir -p /etc/nginx/ssl
sudo openssl req -x509 -newkey rsa:2048 -nodes \
     -keyout /etc/nginx/ssl/kasmvnc.key -out /etc/nginx/ssl/kasmvnc.pem \
     -days 3650 -subj "/CN=remote-audio"
sudo nginx -t && sudo systemctl reload nginx
```

**配置要点**：

- `location /stream/` → MediaMTX :8889（WHIP/WHEP 信令，`proxy_buffering off`）。
- `location /` → KasmVNC :8443，带 `Authorization` 头注入（`Basic dXNlcjpwYXNzd29yZA==` 是 `user:password` 的占位符）。KasmVNC 有 Basic Auth 时改成你自己的 `base64(用户:密码)`；想保留登录弹窗就直接删掉这一行。
- WHEP 媒体是**浏览器直连**服务器 8189/UDP、8188/TCP，不经过 nginx。跨机器访问时必须让 ICE 候选包含服务器地址：
  - 运行配置在 `~/.vnc/mediamtx.yml`（不入 git），由 `gen-mediamtx-config.sh` 在每次服务启动前自动生成：`webrtcAdditionalHosts` 填默认路由的主 IPv4（`KASM_AUDIO_LAN_IP=192.168.1.10` 可覆盖）。**这是跨机 WHEP 能否连上的关键**——`127.0.0.1` 只有服务器本机能听。
- 防火墙放行：

```bash
sudo ufw allow 8444/tcp   # 浏览器入口
sudo ufw allow 8189/udp   # WHEP 媒体（UDP）
sudo ufw allow 8188/tcp   # WHEP 媒体（TCP 兜底）
```

### 5. 注入播放器

```bash
sudo python3 deploy/inject.py
```

把 `deploy/player.js` 注入 `/usr/share/kasmvnc/www/{index,vnc}.html`。**KasmVNC 升级（apt 覆盖 www）后需重跑**。然后浏览器硬刷新（Ctrl+Shift+R）。

### 6. Icecast MP3 兜底（可选）

```bash
sudo apt install icecast2
# 把 icecast2 配置里的监听端口改为 8445，放行 source 密码
echo '你的source密码' > ~/.vnc/.icecast-source-pass
# 重启 icecast2
```

`audio-stream.sh` 会自动把 MP3 推到 `icecast://source:<密码>@127.0.0.1:8445/live.mp3`。

## 使用

- 打开 `https://<host>:8444`，右下角 **🔊** 按钮默认收起：悬停展开状态（模式/延迟/电平），5 秒无交互自动隐藏。
- **通道切换**：黄色小按钮 `通道:自动/强制WHEP/强制WS`，点击循环切换并记忆（localStorage）。`自动`=优先 WHEP、失败/持续静音自动降级 WS；`强制WHEP`=异常不降级、2s 后重连；`强制WS`=直连 WebSocket。
- 自动化：URL 加 `?kasm_audio_autostart=1` 自动开播；控制台 `__kasmAudioSetMode('whep'|'ws'|'auto')`、`__kasmAudioGetMode()`、`__kasmAudioDebug()`。

## 验证

```bash
# 服务
systemctl --user status kasm-audio-webrtc kasm-audio-whep kasm-audio-relay

# 源端信号（有应用在播放时应看到非零 RMS；或放 880Hz 测试音）
ffmpeg -re -f lavfi -i "sine=frequency=880:sample_rate=48000" -af volume=0.5 -f pulse -device vsink &
timeout 2 parecord --device=vsink.monitor --format=s16le --rate=48000 --channels=1 /tmp/m.wav

# 浏览器端：状态栏应显示 WHEP | 播放中 | 延迟≈40-60ms | -25dB 左右

# 端到端延迟（node 本机 spawn 测试音，浏览器 analyser 检测）
node tests/latency.js
# 源端延迟（pulse→ffmpeg→relay→WS）
python3 tests/latency-src.py
# 流健康检查（uniq/直流/声道相关）
python3 tests/probe4.py
```

## 故障排查

| 现象 | 原因 / 排查 | 解决 |
|---|---|---|
| 8444 进不去 / 401 | nginx `Authorization` 头与 KasmVNC 凭据不符；KasmVNC `BlacklistThreshold` 拉黑 10s | 改成自己的 `base64(用户:密码)` 或删掉该行；等 10s 再试 |
| 右下角没有 🔊 | 注入失败 / 浏览器缓存 | 重跑 `sudo python3 deploy/inject.py`，Ctrl+Shift+R |
| 状态栏一直 WS，WHEP 连不上 | ICE 候选不含服务器地址（跨机时 `mediamtx.yml` 还是 `127.0.0.1`）；防火墙未放行 8189/udp；IPv6 路由异常 | 改 `webrtcAdditionalHosts` 为 LAN IP；放行端口；`player.js` 已强制 IPv4 过滤 |
| WHEP 突然失效（之前正常） | `mediamtx.yml` 被改动触发 MediaMTX 热重载，WebRTC 模块重启把 WHIP 发布会话终止，而 ffmpeg-whip 不感知、不再重发 | 看门狗 ~20s 自动恢复；想立即恢复：`systemctl --user restart kasm-audio-whep`；避免在运行中乱改 `bin/mediamtx.yml` |
| WHEP 有连接但无声 | 源静音（`vsink.monitor` RMS=0）；Chrome 远端轨接 WebAudio 的 NetEq 不拉流问题（已用 `<audio>` 元素规避） | 确认有应用在播；重连或切通道 |
| 有声音但延迟高 | 浏览器 `playoutDelay` 是最大变量；ScriptProcessor 路径有 21ms quantum | 用 WHEP 通道；远程 Chrome 加 `--audio-buffer-size=128` 重启 |
| 无头 Chrome 不出声 | 无音频设备时 AudioWorklet `process()` 不执行 | 本方案面向真实桌面浏览器；无头环境不可用 |

## 已知限制与延迟优化

- **延迟预算**：采集 ~3-15ms + Opus 10ms + 转发 <5ms + 网络 <1ms + 浏览器 playout/output ~30-60ms ≈ WHEP 预期 60-110ms，实测约 45ms。
- WS PCM 路径浏览器端 ScriptProcessor(21ms) + Chrome 输出缓冲(~40ms) 有物理下限 ~65-90ms。
- 远程 Chrome 加 `--audio-buffer-size=128` 可再省 ~20ms（需重开会话）。
- 详细实验与网络调研见 `EXPERIMENTS.md`、`docs/AUDIO-LATENCY-RESEARCH.md`。

## 许可证

本项目为 **MIT**。它不包含 KasmVNC 源码（KasmVNC 为 GPL-2.0，本项目仅作为独立集成层运行/配置它）；依赖组件 MediaMTX 为 MIT，FFmpeg 作为外部进程调用且未随仓库分发。详见各子目录 LICENSE。
