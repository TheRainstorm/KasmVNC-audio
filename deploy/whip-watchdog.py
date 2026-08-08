#!/usr/bin/env python3
"""KasmVNC-audio WHIP 发布看门狗。

检测 MediaMTX 上 path 'stream' 是否 ready（本地 API :9997）。连续多次不 ready
就重启 kasm-audio-whep 发布端自愈。覆盖两种故障：
  1) mediamtx.yml 被改动触发 MediaMTX 热重载 → WebRTC 模块重启 → 发布会话被终止；
  2) ffmpeg-whip 的 WHIP muxer 不感知服务端断连，进程活着但已不在推流。
"""
import json
import subprocess
import time
import urllib.request

API = "http://127.0.0.1:9997/v3/paths/list"
SERVICE = "kasm-audio-whep"
POLL = 5          # 检查间隔（秒）
STRIKES_MAX = 3   # 连续不 ready 次数（≈15s）触发重启
COOLDOWN = 25     # 重启后冷却（秒），等发布端重新推流


def stream_ready() -> bool:
    try:
        with urllib.request.urlopen(API, timeout=3) as r:
            data = json.load(r)
    except Exception:
        return False
    for it in data.get("items", []):
        if it.get("name") == "stream" and it.get("ready"):
            return True
    return False


def main():
    strikes = 0
    cooldown_until = 0.0
    while True:
        if time.time() < cooldown_until:
            time.sleep(POLL)
            continue
        if stream_ready():
            strikes = 0
        else:
            strikes += 1
            print(f"[whip-watchdog] path 'stream' 不可用 {strikes}/{STRIKES_MAX}", flush=True)
            if strikes >= STRIKES_MAX:
                print("[whip-watchdog] 重启 kasm-audio-whep ...", flush=True)
                subprocess.run(["systemctl", "--user", "restart", SERVICE], check=False)
                strikes = 0
                cooldown_until = time.time() + COOLDOWN
        time.sleep(POLL)


if __name__ == "__main__":
    main()
