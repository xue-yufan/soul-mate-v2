import fs from "node:fs";
import { buildApp } from "./app.js";
import { dataPaths, loadSettings } from "./config/settings.js";
import { Runtime } from "./runtime.js";
import { inspectRuntimeModules, logModuleStatuses } from "./diagnostics.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const settings = loadSettings();
  dataPaths(settings);
  const runtime = new Runtime(settings);
  await runtime.initialize();
  const app = await buildApp(runtime);
  logModuleStatuses(app.log, await inspectRuntimeModules(runtime));
  let closing = false;

  const shutdown = async (reason: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info(`正在关闭后端：${reason}`);
    const timeout = setTimeout(() => process.exit(1), 12_000);
    timeout.unref();
    try {
      const clients = runtime.beginShutdown(`后端即将关闭：${reason}`);
      if (clients > 0 && settings.server.ws_notify_delay_s > 0) {
        await sleep(settings.server.ws_notify_delay_s * 1000);
      }
      await app.close();
      await runtime.close();
      clearTimeout(timeout);
      process.exit(0);
    } catch (error) {
      console.error("[后端] 关闭失败：", error);
      process.exit(1);
    }
  };

  runtime.onShutdownRequested((reason) => {
    void shutdown(reason);
  });

  process.once("SIGINT", () => void shutdown("收到中断信号"));
  process.once("SIGTERM", () => void shutdown("收到终止信号"));
  process.once("uncaughtException", (error) => {
    console.error("[后端] 未捕获的异常：", error);
    void shutdown("未捕获的异常");
  });
  process.once("unhandledRejection", (error) => {
    console.error("[后端] 未处理的 Promise 拒绝：", error);
    void shutdown("未处理的 Promise 拒绝");
  });

  const parentPid = Number(process.env.SOUL_MATE_PARENT_PID ?? 0);
  if (Number.isInteger(parentPid) && parentPid > 0) {
    const timer = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        void shutdown("父进程已退出");
      }
    }, 2000);
    timer.unref();
  }

  const address = await app.listen({
    host: settings.server.host,
    port: settings.server.port,
  });
  fs.mkdirSync(settings.paths.log_dir, { recursive: true });
  app.log.info(
    `Soul Mate Node.js 后端已启动，监听地址：${address}，Agent 内核：${runtime.kernel.id}`,
  );
}

main().catch((error) => {
  console.error("[后端] 启动失败：", error);
  process.exit(1);
});
