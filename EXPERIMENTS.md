# 实验记录

所有测量在同一台机器（ares, 127.0.0.1）完成：paplay 启动测试音 → 检测信号到达。测试音为 ffmpeg 生成的 440Hz 立体声正弦波。

## E0 基线（v3 AudioWorklet 播放器）

- 无头 Chrome 中 AudioWorklet 的 `process()` 从不执行（已注册、端口消息可达，但输出恒静音 -999dB），而 ScriptProcessorNode 正常出信号。
- 结论：默认路径必须用 ScriptProcessorNode；AudioWorklet 仅作真实浏览器可行性候选（见 E4）。

## E1 声道去交织 bug（“慢放/降八度”）

- 现象：浏览器听到的声音频率减半、像慢放。状态栏 `93MB | -22dB`。
- 根因：交织立体声 `[L,R,L,R,...]` 被错误地按“前一半=左、后一半=右”拆分，等于每个采样播放时长翻倍。
- 验证：440Hz 测试音，旧拆分主频 220Hz，正确去交织后 445Hz。
- 修复：`c0[j]=pending[2j]; c1[j]=pending[2j+1]`。

## E2 源端延迟优化（ffmpeg / relay）

| 配置 | 源端延迟 |
|---|---|
| ffmpeg 默认 + relay 读 65536B | 81ms |
| ffmpeg `-fflags nobuffer -fragment_size 4096` + relay 读 8192B | 28ms |

## E3 浏览器端缓冲优化

| ScriptProcessor bufferSize | 端到端 |
|---|---|
| 4096 | ~200ms |
| 2048 | - |
| 1024 | ~162ms |

1024 帧 = 21.3ms @48kHz。更小会加剧主线程（VNC 视频解码）繁忙时的丢帧。

## E4（进行中）AudioWorklet 128-quantum 可行性

- 目标：把浏览器缓冲从 21ms 降到 2.7ms。
- 无头 Chrome 不可行；需在真实 X 会话 Chrome 中验证 `process()` 是否执行。

## 延迟预算（当前，实测）

```
源端（pulse→ffmpeg→relay→WS）  ~28ms
浏览器端（WS→JS→SP1024→输出）  ~130ms（含 ~60ms 检测/测量开销，真实可听约 ~70-90ms）
端到端实测                     ~162ms
```

用户体感 ~500ms，与实测差距待查：怀疑为浏览器主线程繁忙导致 ScriptProcessor 回调饥饿、待处理缓冲堆积，或视频与音频的相对延迟。
