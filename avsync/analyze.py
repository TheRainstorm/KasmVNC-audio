#!/usr/bin/env python3
"""分析手机录制的音画同步测试视频，计算“听到提示音 vs 看到白闪”的延迟。

用法: python3 analyze.py 录制视频.mp4 [--fps 30]
输出: 每轮 闪屏时刻 / 提示音时刻 / 偏差(ms)，以及均值/中位数。
偏差 >0 表示声音比画面晚（人耳感受“声音慢半拍”）。
"""
import subprocess, sys, argparse, os
import numpy as np

BEEP_HZ = 1000
BAND = (800, 1200)
THRESH = 0.25          # 包络峰值比例阈值
VIDEO_SCALE = "640x360"

def run(cmd):
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

def video_fps(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                        "-show_entries", "stream=r_frame_rate,avg_frame_rate",
                        "-of", "default=nw=1:nk=1", path],
                       capture_output=True, text=True)
    lines = [l for l in r.stdout.splitlines() if l.strip()]
    if not lines:
        return 30.0
    def parse(s):
        if "/" in s:
            a, b = s.split("/")
            b = float(b) or 1.0
            return float(a) / b
        return float(s)
    return max(parse(lines[0]), parse(lines[1])) if len(lines) > 1 else parse(lines[0])

def detect_beeps(path, dur_hint=20.0):
    raw = run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "48000",
               "-f", "f32le", "-"])
    a = np.frombuffer(raw.stdout, dtype=np.float32)
    sr = 48000
    N = len(a)
    # 带通（FFT 掩码）
    f = np.fft.rfftfreq(N, 1 / sr)
    band = (f >= BAND[0]) & (f <= BAND[1])
    env = np.abs(np.fft.irfft(np.fft.rfft(a) * band))
    # 包络平滑（2ms 窗）
    k = sr // 500
    env = np.convolve(env, np.ones(k) / k, mode="same")
    peak = env.max()
    thr = peak * THRESH
    times = []
    t = 0.0
    while t < dur_hint:
        s0, s1 = int(t * sr), int((t + 2.0) * sr)
        seg = env[s0:s1]
        idx = np.argmax(seg > thr) if (seg > thr).any() else -1
        if idx >= 0:
            times.append(t + idx / sr)
        t += 2.0
    return times, peak

def detect_flashes(path):
    raw = run(["ffmpeg", "-v", "error", "-i", path, "-vf",
               "scale={},format=gray".format(VIDEO_SCALE), "-f", "rawvideo",
               "-pix_fmt", "gray", "-"])
    w, h = (int(x) for x in VIDEO_SCALE.split("x"))
    fps = video_fps(path)
    n_frames = len(raw.stdout) // (w * h)
    if n_frames == 0:
        return [], fps
    arr = np.frombuffer(raw.stdout[:n_frames * w * h], dtype=np.uint8)
    means = arr.reshape(n_frames, w * h).mean(axis=1)
    # 找超过阈值的帧，聚成簇，取每簇第一帧为闪屏时刻
    thr = 60.0
    over = means > thr
    times = []
    prev = -10 ** 9
    for i in np.where(over)[0]:
        if i - prev > int(fps * 0.5):
            times.append(i / fps)
        prev = i
    return times, fps

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--dur", type=float, default=20.0, help="测试片时长秒数（默认 20）")
    args = ap.parse_args()
    if not os.path.exists(args.video):
        sys.exit("文件不存在: " + args.video)

    flashes, fps = detect_flashes(args.video)
    beeps, peak = detect_beeps(args.video, args.dur)
    print("视频帧率: %.2f fps，闪屏 %d 处，提示音 %d 处，音频包络峰值 %.3f" %
          (fps, len(flashes), len(beeps), peak))

    if not flashes or not beeps:
        print("未检测到足够的闪屏/提示音。请确认录到了屏幕白闪和 1kHz 提示音。")
        return
    # 每个提示音找最近的白闪配对（容忍录制中某轮丢失）
    fa = np.array(flashes)
    offs = []
    rows = []
    for b in beeps:
        j = int(np.argmin(np.abs(fa - b)))
        d = (b - fa[j]) * 1000.0
        if abs(d) > 1200:   # 找不到同轮的白闪则跳过
            continue
        offs.append(d)
        rows.append((fa[j], b, d))
    n = len(offs)
    if n == 0:
        print("无法配对白闪与提示音（偏差都超过 1.2s）。")
        return
    print("\n轮次   白闪(s)  提示音(s)  偏差(ms)")
    for i, (fv, bv, d) in enumerate(rows):
        print("%2d   %7.3f   %7.3f   %+8.1f" % (i + 1, fv, bv, d))
    arr = np.array(offs)
    print("\n均值 %+.1f ms，中位数 %+.1f ms，抖动(std) %.1f ms" %
          (arr.mean(), np.median(arr), arr.std()))
    print("（偏差为正 = 声音晚于画面；人耳对 >50ms 的音画不同步会明显察觉）")

if __name__ == "__main__":
    main()
