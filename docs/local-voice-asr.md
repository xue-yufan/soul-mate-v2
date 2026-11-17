# 本地语音识别

## 当前范围

语音输入使用本地 C/C++ 推理引擎，不调用浏览器在线识别或云端 ASR。当前版本
实现的是“点击麦克风开始、检测到停顿自动结束、识别后发送”的完整流程：

```text
麦克风
  -> Web Audio 单声道采集
  -> 16 kHz 16-bit WAV
  -> WebSocket audio_input
  -> sherpa-onnx 或 whisper.cpp
  -> transcription_result
  -> 原有 Agent 对话
```

识别结果会进入现有 `text_input` 流程，因此历史、情绪、记忆、工具和 TTS 都不
需要第二套逻辑。

## Intel NPU（OpenVINO）

本机已验证 Intel Core Ultra 5 125H 的 Intel AI Boost NPU。sherpa-onnx 的
`openvino` provider 需要 **OpenVINO-enabled ONNX Runtime**，官方 CPU 包即使
接受 `--provider=openvino` 也只会回退 CPU。

当前可用组合：

- sherpa-onnx 2.0
- ONNX Runtime 1.29/API 28
- OpenVINO 2026.2.1
- FP32 SenseVoice `model.onnx`

```yaml
voice:
  provider: openvino
  provider_config: D:/.../.voice-asr/sherpa-onnx-npu-129/openvino-npu.config
```

`openvino-npu.config`：

```ini
device_type=NPU
enable_qdq_optimizer=True
num_streams=1
cache_dir=D:/.../.voice-asr/openvino-cache
```

SenseVoice 的 INT8 模型包含 NPU 不支持的 `int32 MatMul`，会拆图并显著变慢；
OpenVINO 模式因此优先选择 FP32 `model.onnx`。实测本机 NPU 能完成真实转写，
但当前大模型收益不佳：

- CPU：模型加载加识别约 2 秒
- NPU 首次：约 17 秒
- NPU 编译缓存后：约 14 秒

NPU 路径曾用于验证设备使用，但当前 OpenVINO/ORT 组合在连续加载多个模型后会
出现编译冲突，因此开发配置暂时使用 `provider: cpu`。恢复前应先重启设备并
使用独立缓存重新验证，或为 NPU 选择更小的专用流式模型并保持常驻进程。

## 引擎优先级

`voice.engine: auto` 的查找顺序是：

1. `sherpa-onnx-offline`
2. `sherpa-onnx`
3. `whisper-cli`
4. `whisper-cpp`
5. `whisper`

candidate 是否真正可用还取决于模型和参数。前面的引擎配置不完整时，会继续
尝试后面的引擎。设置页和 `/health` 会显示实际选中的引擎、命令和模型。

仓库不附带推理二进制和模型，避免许可证、体积和多平台构建问题。默认识别功能
关闭；安装模型后在 `config.local.yaml` 启用。

## 推荐安装

当前已验证组合：

- sherpa-onnx `v2.0.0` Windows x64 shared Release
- SenseVoice INT8 `2025-09-09`
- 中文、英文、日文、韩文、粤语

PowerShell 下载示例：

```powershell
$root = "$PWD/.voice-asr"
New-Item -ItemType Directory -Force "$root/downloads" | Out-Null
New-Item -ItemType Directory -Force "$root/models" | Out-Null

curl.exe -L --fail --output "$root/downloads/sherpa-onnx.tar.bz2" `
  https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.0/sherpa-onnx-v2.0.0-win-x64-shared-MD-Release.tar.bz2

curl.exe -L --fail --output "$root/downloads/sense-voice-int8.tar.bz2" `
  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2

tar.exe -xjf "$root/downloads/sherpa-onnx.tar.bz2" -C "$root"
tar.exe -xjf "$root/downloads/sense-voice-int8.tar.bz2" -C "$root/models"
```

模型压缩包约 166 MB，解压后模型约 226 MB。Windows 自带的 `tar.exe` 支持
`.tar.bz2`，不需要额外安装 7-Zip。

当前机器已经安装到 `.voice-asr`，并在 `apps/backend/config.local.yaml`
启用了 `features.voice`。`.voice-asr` 已加入 `.gitignore`，它属于稳定的本地运行时
资产目录，不作为临时目录清理。

打包版不读取 `config.local.yaml`，而是读取：

```text
%APPDATA%/soul-mate-frontend/settings.json
```

该文件的 `features.voice` 和 `voice` 段可以指向同一套引擎与模型。当前机器上的
打包用户配置也已同步启用。

## sherpa-onnx

推荐优先使用 SenseVoice 小模型。目录至少包含：

```text
D:/models/sense-voice/
  model.onnx
  tokens.txt
```

```yaml
features:
  voice: true

voice:
  engine: sherpa
  command: D:/sherpa-onnx/bin/sherpa-onnx-offline.exe
  args: []
  model_dir: D:/models/sense-voice
  temp_dir: D:/soul-mate-asr-tmp
  language: zh
  timeout_s: 60
  max_audio_seconds: 30
  threads: 2
```

自动参数等价于：

```text
--tokens={model_dir}/tokens.txt
--sense-voice-model={model_dir}/model.onnx
--num-threads={threads}
{audio}
```

其他模型结构可自行填写 `voice.args`。每行一个参数，最后一个不足时程序会自动
追加 `{audio}`：

```yaml
voice:
  engine: sherpa
  model_dir: D:/models/paraformer
  args:
    - --paraformer={model_dir}/model.onnx
    - --tokens={model_dir}/tokens.txt
    - --num-threads={threads}
```

## whisper.cpp

`model_dir` 指向包含 `ggml-*.bin` 的目录。留空 `args` 时使用常见 CLI 参数：

```yaml
features:
  voice: true

voice:
  engine: whisper
  command: D:/whisper.cpp/build/bin/Release/whisper-cli.exe
  args: []
  model_dir: D:/whisper.cpp/models
  language: zh
  timeout_s: 60
  max_audio_seconds: 30
  threads: 2
```

自定义参数可以使用 `{audio}`、`{model}`、`{language}`、`{output}`。识别结果优先
从 `{output}.txt` 读取，其次读取 `{output}` 或标准输出。

## 延迟说明

当前每次结束录音都会启动一次引擎进程，因此首次识别需要承担模型加载时间。
下一阶段若需要边说边出字，应把当前单次进程调用升级为常驻 sherpa-onnx 流式
sidecar，并增加模型内置 VAD、部分转写事件和 barge-in；前端录音、WAV 编码、
WebSocket 协议和错误诊断可以继续复用。

## 本地 TTS

`tts.provider: openvino` 使用中文 Piper VITS `zh_CN-xiao_ya-medium`。模型被拆成
两段，避免把整个动态 TTS 图交给单一设备：

- `front.onnx`：CPU 运行文本编码、时长预测和 Flow，输出 `192 x frames` 声学特征。
- `decoder.onnx`：GPU 运行卷积声码器，按 64 帧分桶编译并缓存。
- `tokens.txt` / `lexicon.txt`：本地中文 G2P，不调用在线服务。

服务监听 `http://127.0.0.1:9890`，接口为 `GET /healthz`、`GET /openapi.json`
和 `POST /tts`。设置页中的“TTS 声码器设备”可以选择 `GPU`、`NPU`、`CPU`
或 `AUTO`。

本机实测：

- GPU 首次请求包含声码器编译，约 4.6 秒；编译缓存后同一句约 0.11 秒。
- TTS 输出为 22.05 kHz WAV，再经本地 ASR 回验，识别结果与输入逐字一致。
- NPU 能真实执行声码器，但 64 帧约 11.1 秒、128 帧约 22.2 秒、
  256 帧约 44.4 秒，无法满足对话延迟，因此默认使用 GPU 声码器。

NPU 的瓶颈是当前 Intel NPU 驱动编译器和卷积声码器的组合，不是 Python 环境。
直接改用 Qwen3-TTS 也不可行：当前 `openvino-genai 2026.4.1` 的
`Text2SpeechPipeline` 不支持该架构，而 Kokoro 的动态波形以及 STFT/ISTFT
同样没有可用的 NPU 实时实现。

Python 3.14 可以运行现有 `openvino` 服务。Kokoro 的 Python 依赖要求
Python `<3.13`，因此仅在实验目录使用独立 Python 3.12 环境；默认 TTS 链路
不依赖该环境。

## ASR 当前状态

本机曾用 SenseVoice FP32、sherpa-onnx 和 OpenVINO-enabled ONNX Runtime
完成真实 NPU 转写。但在连续运行多个 OpenVINO 模型后，当前 ORT EP 会报
`UpdateMemoryAccessCounts` 编译冲突，CPU provider 不受影响。为避免语音输入
不可用，开发配置暂时回退 `voice.provider: cpu`。恢复 NPU 前应先重启设备，
再用独立缓存重新验证；不要仅凭日志中的 `device_type=NPU` 判断识别成功。
