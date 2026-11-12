import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cli = path.resolve(
  desktopDir,
  "../../node_modules/electron-vite/bin/electron-vite.js",
);

const env = { ...process.env };
// IDEs such as VS Code may export this for their own Electron process. If it
// leaks into electron-vite, our Electron executable runs as Node and exits
// before creating a window.
delete env.ELECTRON_RUN_AS_NODE;
const electronRoot = path.resolve(desktopDir, "node_modules/electron");
const electronPackage = JSON.parse(
  readFileSync(path.join(electronRoot, "package.json"), "utf8"),
);

if (process.platform === "win32") {
  // A copied/staged workspace can inherit a Low Integrity label. Electron's
  // GUI process crashes before main.ts if its runtime stays at that level.
  spawnSync("icacls", [electronRoot, "/inheritance:e", "/T"], {
    stdio: "ignore",
    windowsHide: true,
  });
  spawnSync("icacls", [electronRoot, "/setintegritylevel", "M", "/T"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

env.ELECTRON_EXEC_PATH = path.resolve(
  electronRoot,
  "dist",
  readFileSync(path.join(electronRoot, "path.txt"), "utf8").trim(),
);
env.ELECTRON_MAJOR_VER = String(electronPackage.version).split(".")[0];

const child = spawn(
  process.execPath,
  [cli, ...(process.argv.length > 2 ? process.argv.slice(2) : ["dev"])],
  {
    cwd: desktopDir,
    env,
    stdio: "inherit",
  },
);

child.on("error", (error) => {
  console.error("[Electron 开发启动器] 启动失败：", error);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

