#!/usr/bin/env bash
# 全屏循环播放 A/V 同步测试片（20s）。
#   画面：Xvnc(:1) -> KasmVNC -> 浏览器
#   声音：默认 sink(vsink) -> WHIP/WHEP -> 浏览器
# 关闭：按 q 或 Esc，或 ctrl+C
set -e
cd "$(dirname "$0")"
exec ffplay -fs -loop 0 -window_title "AVSYNC-TEST" -i avsync.mkv
