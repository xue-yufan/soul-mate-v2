# Vision OpenCV C++ sidecar

这是默认关闭的单帧视觉预处理验证模块。Node 后端通过 NDJSON 启动一次进程、
发送一张 Base64 图片并等待一个结果；sidecar 崩溃、超时或协议失败时，调用方
继续使用原始图片。

当前只验证：

- Laplacian 清晰度；
- 平均亮度和对比度；
- 最长边受限缩放；
- 低亮度/低对比度时 CLAHE；
- 模糊时轻量 unsharp；
- JPEG 重新编码。

不包含透视校正、OCR、目标检测或连续视频分析。

## 构建

需要 CMake、MSVC 和 vcpkg：

```powershell
$env:VCPKG_ROOT = "D:/vcpkg"
npm run build:vision-opencv
```

输出：

```text
packages/vision-opencv/dist/soul-mate-vision-opencv.exe
```

## 启用验证

在 `config.local.yaml`：

```yaml
vision:
  opencv:
    enabled: true
    command: ""
    args: []
    timeout_s: 5
    max_edge: 1600
    jpeg_quality: 86
```

`command` 留空时自动查找开发构建和打包资源路径。关闭 `enabled` 或删除可执行
文件都会回退原图。
