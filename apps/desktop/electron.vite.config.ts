import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

import vue from "@vitejs/plugin-vue";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// 界面上的版本号只有一个来源：package.json
const pkg = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./package.json", import.meta.url)),
    "utf-8",
  ),
) as { version: string };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: fileURLToPath(new URL("./electron/main.ts", import.meta.url)),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: fileURLToPath(new URL("./electron/preload.ts", import.meta.url)),
        },
        // preload 保持 CJS，这样 BrowserWindow 的 sandbox 默认值不用动
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    base: "./",
    // 渲染层用 __APP_VERSION__ 取版本，不再各处硬编码 "0.1.0"
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    plugins: [vue()],
    server: {
      host: "127.0.0.1",
      port: 5300,
      strictPort: true,
    },
    build: {
      // Electron 44 already runs a current Chromium. Avoid an unnecessary
      // esbuild transform pass that is unreliable on some Windows temp ACLs.
      target: "esnext",
      minify: false,
      rollupOptions: {
        // 渲染层入口保持在项目根目录，不用 electron-vite 默认的 src/renderer
        input: fileURLToPath(new URL("./index.html", import.meta.url)),
        output: {
          // Keep each esbuild transform below its Windows temp-file threshold.
          // Without this split, one large vendor chunk can make esbuild fail
          // while cleaning its Windows temp output.
          manualChunks(id) {
            const marker = "/node_modules/";
            const index = id.lastIndexOf(marker);
            if (index < 0) return undefined;
            const parts = id.slice(index + marker.length).split("/");
            const name = parts[0]?.startsWith("@")
              ? `${parts[0]}-${parts[1] ?? ""}`
              : (parts[0] ?? "vendor");
            if (name === "vue") return undefined;
            return `vendor-${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
          },
        },
      },
    },
  },
});
