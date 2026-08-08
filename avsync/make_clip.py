#!/usr/bin/env python3
"""生成 A/V 同步测试片：黑底，每 2s 出现 2 帧全白闪屏 + 同一时刻 50ms 1kHz 提示音。
白闪经 KasmVNC 视频链路、提示音经 vsink.monitor -> WHIP/WHEP 音频链路，源端严格同帧。"""
import subprocess, sys, os, wave
import numpy as np

DIR = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(DIR, "avsync.mkv")
WAV = os.path.join(DIR, "beep.wav")
DUR = 20
FPS = 30
BEEP_HZ = 1000
BEEP_MS = 50
PERIOD = 2.0
SR = 48000

# ---- 提示音 WAV（采样级精确）----
n = int(DUR * SR)
a = np.zeros(n, dtype=np.float32)
t = 0.0
while t < DUR:
    s0 = int(t * SR)
    s1 = int((t + BEEP_MS / 1000.0) * SR)
    seg = np.arange(s1 - s0, dtype=np.float32) / SR
    a[s0:s1] = (0.8 * np.sin(2 * np.pi * BEEP_HZ * seg)).astype(np.float32)
    t += PERIOD
with wave.open(WAV, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((a * 32767).astype(np.int16).tobytes())

# ---- 闪屏 drawbox（时间基准与音频同源：都从 t=0 起）----
flashes = []
t = 0.0
while t < DUR:
    flashes.append("between(t\\,{:.3f}\\,{:.3f})".format(t, t + 2.0 / FPS))
    t += PERIOD
enable = "+".join(flashes)

cmd = [
    "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:s=1280x720:r={}:d={}".format(FPS, DUR),
    "-i", WAV,
    "-vf", "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='{}'".format(enable),
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "pcm_s16le", "-shortest", OUT,
]
r = subprocess.run(cmd)
if r.returncode != 0:
    sys.exit("生成失败")
print("已生成", OUT, os.path.getsize(OUT), "bytes")
