# bin/ — 依赖工具（大文件不入 git）

以下二进制为本地运行所需，**不入版本库**（见 `bin/.gitignore`），按需下载：

| 工具 | 版本 | 用途 | 获取 |
|---|---|---|---|
| `mediamtx` | v1.20.0 | WebRTC 媒体服务器（WHIP/WHEP） | https://github.com/bluenviron/mediamtx/releases/download/v1.20.0/mediamtx_v1.20.0_linux_amd64.tar.gz |
| `ffmpeg-whip` | master N-125990-g5c395992f9-20260807 | 带 WHIP muxer 的 FFmpeg（Ubuntu 自带 6.1 无 WHIP） | BtbN FFmpeg-Builds：https://github.com/BtbN/FFmpeg-Builds/releases （`ffmpeg-master-latest-linux64-gpl.tar.xz`，2026-08-07 构建） |
| `ffmpeg` | n7.1.5-12-g1fdbca85aa-20260807 | 系统 ffmpeg 6.1 的替代（PCM/MP3 双路推流） | 同上 release 的 `ffmpeg-n7.1-latest-linux64-gpl.tar.xz` |

要点：

- WHIP 发布命令（Opus 10ms 帧，`kasm-audio-whep.service` 使用）：
  `bin/ffmpeg-whip -fflags nobuffer -f pulse -fragment_size 512 -i vsink.monitor -c:a libopus -b:a 96k -ar 48000 -ac 2 -frame_duration 10 -f whip http://127.0.0.1:8889/stream/whip`
- MediaMTX 配置见 `bin/mediamtx.yml`（只开 WebRTC，`paths.all_others: source: publisher`）。已启用仅回环的本地 API `127.0.0.1:9997`，供 `deploy/whip-watchdog.py` 检查发布状态；**运行中改动该文件会触发热重载并终止当前 WHIP 发布会话**（看门狗会自动恢复）。
- 用 `bin/ffmpeg-whip -h muxer=whip` 确认 WHIP muxer 可用；Ubuntu 自带 ffmpeg 6.1 没有。
- `mediamtx.log` 为运行日志，不入库。
