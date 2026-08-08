#!/usr/bin/env bash
# KasmVNC-audio 一键安装：支持脚本 + systemd 用户服务（不含 nginx / 注入，见 README）
#
# 用法:
#   bash deploy/install.sh            # 安装并启动服务
#   bash deploy/install.sh --dry-run  # 只打印将要做什么，不改动任何文件
#   bash deploy/install.sh --no-start # 安装文件但不启动服务
set -euo pipefail

DRY=0
START=1
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --no-start) START=0 ;;
    *) echo "未知参数: $a" >&2; exit 2 ;;
  esac
done

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VNC_DIR="$HOME/.vnc"
SYSTEMD_DIR="$HOME/.config/systemd/user"

say()  { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; }

# 生成文件（src -> dst，sed 表达式替换路径；--dry-run 只打印）
gen() {
  local src="$1" dst="$2"; shift 2
  if [ "$DRY" = 1 ]; then
    echo "  # 将要生成: $dst （替换 $* ）"
    return
  fi
  local args=()
  for e in "$@"; do args+=(-e "$e"); done
  sed "${args[@]}" "$src" > "$dst"
  echo "  # 已生成: $dst"
}

# ---- 0. 依赖检查 ----
say "仓库目录: $REPO_DIR"
[ -f "$REPO_DIR/bin/mediamtx" ]     || warn "缺少 bin/mediamtx（未随 git 分发，请按 bin/README.md 下载）"
[ -f "$REPO_DIR/bin/ffmpeg-whip" ]  || warn "缺少 bin/ffmpeg-whip（WHEP 主链路必需，请按 bin/README.md 下载）"
command -v ffmpeg >/dev/null        || warn "PATH 中没有 ffmpeg（PCM/MP3 兜底路需要，系统自带版本即可）"
command -v pactl  >/dev/null        || err "未找到 pactl（PulseAudio），请先安装 pulseaudio"
command -v systemctl >/dev/null     || err "未找到 systemctl（需要 systemd 用户服务）"

# ---- 1. 支持脚本 -> ~/.vnc ----
mkdir -p "$VNC_DIR" "$SYSTEMD_DIR"

gen deploy/audio-relay.py   "$VNC_DIR/audio-relay.py"   "s|/home/yfy|$HOME|g"
gen deploy/audio-stream.sh  "$VNC_DIR/audio-stream.sh"  "s|/home/yfy|$HOME|g"
gen deploy/whip-watchdog.py "$VNC_DIR/whip-watchdog.py" "s|/home/yfy|$HOME|g"
gen deploy/gen-mediamtx-config.sh "$VNC_DIR/gen-mediamtx-config.sh" "s|/home/yfy|$HOME|g"
gen bin/mediamtx.yml "$VNC_DIR/mediamtx.yml.template" "s|/home/yfy|$HOME|g"
[ "$DRY" = 1 ] || chmod +x "$VNC_DIR/audio-relay.py" "$VNC_DIR/audio-stream.sh" "$VNC_DIR/whip-watchdog.py" "$VNC_DIR/gen-mediamtx-config.sh"
if [ "$DRY" = 0 ]; then
  KASM_AUDIO_LAN_IP="${KASM_AUDIO_LAN_IP:-}" "$VNC_DIR/gen-mediamtx-config.sh" || true
fi

# ---- 2. systemd 用户服务（路径替换: /home/yfy/repo/KasmVNC-audio -> $REPO_DIR, /home/yfy -> $HOME）----
for s in kasm-audio-relay kasm-audio-webrtc kasm-audio-whep kasm-audio-whep-watchdog; do
  gen "deploy/$s.service" "$SYSTEMD_DIR/$s.service" \
      "s|/home/yfy/repo/KasmVNC-audio|$REPO_DIR|g" \
      "s|/home/yfy|$HOME|g"
done

if [ "$DRY" = 1 ]; then
  say "dry-run 结束，未改动任何文件。"
  exit 0
fi

say "reload systemd 并启动服务 ..."
systemctl --user daemon-reload
if [ "$START" = 1 ]; then
  systemctl --user enable --now kasm-audio-webrtc.service kasm-audio-whep.service kasm-audio-relay.service kasm-audio-whep-watchdog.service
else
  systemctl --user enable kasm-audio-webrtc.service kasm-audio-whep.service kasm-audio-relay.service kasm-audio-whep-watchdog.service
  say "--no-start：服务已启用但未启动，可稍后 systemctl --user start kasm-audio-webrtc kasm-audio-whep kasm-audio-relay"
fi

echo
say "完成。接下来（需要 root，见 README 第五、六步）:"
say "  1) sudo cp deploy/kasmvnc-audio.conf /etc/nginx/conf.d/  （并放好 /etc/nginx/ssl/kasmvnc.{pem,key}）"
say "  2) sudo python3 deploy/inject.py                        （把播放器注入 KasmVNC 网页）"
say "  3) 浏览器打开 https://<host>:8444 ，右下角点 🔊 播放"
