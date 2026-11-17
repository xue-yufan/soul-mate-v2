import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(packageDir, "../..");
const buildDir = path.join(workspaceRoot, ".vision-opencv", "build");
const sdkRoot = path.join(workspaceRoot, ".vision-opencv", "opencv-sdk");
const distDir = path.join(packageDir, "dist");
const bundledOpenCvDir = path.join(
  sdkRoot,
  "extracted",
  "opencv",
  "build",
  "x64",
  "vc16",
  "lib",
);
const openCvDir =
  process.env.OPENCV_DIR?.trim() ||
  (fs.existsSync(path.join(bundledOpenCvDir, "OpenCVConfig.cmake"))
    ? bundledOpenCvDir
    : "");
const vcpkgRoot =
  process.env.VCPKG_ROOT?.trim() ||
  (process.platform === "win32" ? "D:/vcpkg" : "");

function loadWindowsCompilerEnvironment() {
  if (process.platform !== "win32" || process.env.VSCMD_ARG_TGT_ARCH) return;
  const candidates = [
    process.env.SOUL_MATE_VCVARS64,
    "C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Auxiliary/Build/vcvars64.bat",
    "C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Auxiliary/Build/vcvars64.bat",
    "C:/Program Files/Microsoft Visual Studio/2022/Professional/VC/Auxiliary/Build/vcvars64.bat",
    "C:/Program Files/Microsoft Visual Studio/2022/Enterprise/VC/Auxiliary/Build/vcvars64.bat",
  ].filter(Boolean);
  const vcvars = candidates.find((candidate) => fs.existsSync(candidate));
  if (!vcvars) {
    throw new Error("找不到 vcvars64.bat；请设置 SOUL_MATE_VCVARS64");
  }
  const result = spawnSync(
    `call "${vcvars}" >nul && set`,
    {
      cwd: workspaceRoot,
      encoding: "utf-8",
      windowsHide: true,
      shell: "cmd.exe",
    },
  );
  if (result.status !== 0) {
    throw new Error(`初始化 MSVC 环境失败：${result.stderr || vcvars}`);
  }
  for (const line of result.stdout.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    if (
      ![
        "PATH",
        "INCLUDE",
        "LIB",
        "LIBPATH",
        "VCINSTALLDIR",
        "VSINSTALLDIR",
        "VCToolsInstallDir",
        "WindowsSdkDir",
        "WindowsSDKVersion",
        "UCRTVersion",
        "UniversalCRTSdkDir",
        "ExtensionSdkDir",
      ].includes(key) &&
      !key.startsWith("VSCMD_")
    ) {
      continue;
    }
    process.env[key] = line.slice(separator + 1);
  }
}

if (!vcpkgRoot || !fs.existsSync(vcpkgRoot)) {
  throw new Error("找不到 vcpkg；请设置 VCPKG_ROOT");
}

const toolchain = path.join(vcpkgRoot, "scripts", "buildsystems", "vcpkg.cmake");
if (!openCvDir && (!vcpkgRoot || !fs.existsSync(toolchain))) {
  throw new Error(`找不到 vcpkg CMake toolchain：${toolchain}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} 失败，退出码 ${String(result.status)}`);
  }
}

fs.rmSync(buildDir, { recursive: true, force: true });
fs.mkdirSync(buildDir, { recursive: true });
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

loadWindowsCompilerEnvironment();
if (process.platform === "win32") {
  const compilerTemp = path.join(buildDir, "compiler-temp");
  fs.mkdirSync(compilerTemp, { recursive: true });
  process.env.TMP = compilerTemp;
  process.env.TEMP = compilerTemp;
}

const configureArgs = [
  "-S",
  packageDir,
  "-B",
  buildDir,
  "-G",
  "Visual Studio 17 2022",
  "-A",
  "x64",
  "-DCMAKE_BUILD_TYPE=Release",
];
if (openCvDir) {
  configureArgs.push(`-DOpenCV_DIR=${openCvDir}`);
} else {
  configureArgs.push(
    `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`,
    "-DVCPKG_TARGET_TRIPLET=x64-windows",
  );
}
run("cmake", configureArgs);
run("cmake", [
  "--build",
  buildDir,
  "--config",
  "Release",
  "--parallel",
]);

const candidates = [
  path.join(buildDir, "Release", "soul-mate-vision-opencv.exe"),
  path.join(buildDir, "soul-mate-vision-opencv.exe"),
  path.join(buildDir, "soul-mate-vision-opencv"),
];
const built = candidates.find((candidate) => fs.existsSync(candidate));
if (!built) {
  throw new Error("构建成功但没有找到 vision-opencv 可执行文件");
}

const destination = path.join(
  distDir,
  process.platform === "win32"
    ? "soul-mate-vision-opencv.exe"
    : "soul-mate-vision-opencv",
);
fs.copyFileSync(built, destination);

if (process.platform === "win32") {
  const openCvBin = path.resolve(openCvDir, "..", "bin");
  if (fs.existsSync(openCvBin)) {
    for (const name of fs.readdirSync(openCvBin)) {
      if (!/^opencv_world\d+\.dll$/i.test(name)) continue;
      fs.copyFileSync(path.join(openCvBin, name), path.join(distDir, name));
    }
  }
}
console.log(`vision-opencv: ${destination}`);
