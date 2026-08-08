#!/usr/bin/env bash
# 在 mediamtx 启动前生成运行配置 ~/.vnc/mediamtx.yml：
# 把模板中 webrtcAdditionalHosts 的 [127.0.0.1] 替换为服务器主 IPv4。
# IP 来源优先级：$KASM_AUDIO_LAN_IP > 默认路由出接口 src IP > hostname -I 第一个 > 127.0.0.1
set -euo pipefail

TPL="${MEDIAMTX_TPL:-$HOME/.vnc/mediamtx.yml.template}"
DST="${MEDIAMTX_CFG:-$HOME/.vnc/mediamtx.yml}"

LAN_IP="${KASM_AUDIO_LAN_IP:-}"
if [ -z "$LAN_IP" ]; then
  LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')"
fi
if [ -z "$LAN_IP" ]; then
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
case "$LAN_IP" in
  ''|*[!0-9.]*) LAN_IP=127.0.0.1 ;;
esac

sed -e "s|\\[127\\.0\\.0\\.1\\]|[$LAN_IP]|g" "$TPL" > "$DST"
echo "[gen-mediamtx-config] webrtcAdditionalHosts=[$LAN_IP] -> $DST"
