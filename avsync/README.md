# A/V 同步延迟测试（人耳视角）

测量「看到画面 vs 听到声音」的真实偏差。源端（ares 桌面）同时产生白闪和提示音，
分别走 KasmVNC 视频链路 与 vsink.monitor -> WHIP/WHEP 音频链路，用手机录下
「你实际看到的屏幕 + 你实际听到的声音」，再自动分析偏差。

## 用法

1. 启动测试片（全屏循环 20s：黑底，每 2s 白闪 2 帧 + 50ms 1kHz 提示音）：

   ```
   ~/repo/KasmVNC-audio/avsync/play.sh
   ```

   按 `q` 或 `Esc` 退出。

2. 用手机录约 15s：镜头对准屏幕、同时录到扬声器声音。
   手机帧率越高越准（60fps 优于 30fps）。

3. 分析录制视频（可拷回 ares 或本地跑）：

   ```
   python3 ~/repo/KasmVNC-audio/avsync/analyze.py 录制.mp4 [--dur 20]
   ```

## 输出解读

- 每轮打印：白闪时刻 / 提示音时刻 / 偏差(ms)。
- 偏差为正 = 声音晚于画面（人耳觉得声音慢半拍）；负 = 声音早于画面。
- 均值/中位数是最终结论，抖动(std) 反映稳定性。
- 人耳对 >50ms 的音画不同步通常可察觉；<30ms 基本无感。

## 精度

- 视频侧：手机 30fps → ±16ms；60fps → ±8ms（白闪为 2 帧，取首帧）。
- 音频侧：1kHz 提示音包络阈值检测，±1~2ms。
- 总体精度约 ±20ms（30fps 手机），足以判断 50ms 量级的同步问题。

## 文件

- `make_clip.py` 重新生成测试片 `avsync.mkv`（默认参数即可）。
- `avsync.mkv` 20s 测试片（MKV + PCM，无音频编码延迟）。
- `play.sh` ffplay 全屏循环播放（画面 :1，声音默认 sink=vsink）。
- `analyze.py` 手机录像分析器。

## 注意

- 测试片会让桌面短暂全屏闪白，属正常现象。
- 声音走默认 sink（当前为 vsink）；如默认 sink 变了，先 `pactl set-default-sink vsink`。
