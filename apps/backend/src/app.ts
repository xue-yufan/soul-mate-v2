import crypto from "node:crypto";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { Runtime } from "./runtime.js";
import { HttpError } from "./api/errors.js";
import { registerConfigRoutes } from "./api/config-routes.js";
import { registerDataRoutes } from "./api/data-routes.js";
import { registerWebSocket } from "./api/ws.js";

function tokenMatches(expected: string, supplied: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

export async function buildApp(runtime: Runtime): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: runtime.settings.logging.level.toLowerCase(),
      messageKey: "消息",
      hooks: {
        logMethod(args, method) {
          if (
            typeof args[0] === "string" &&
            args[0].startsWith("Server listening at ")
          ) {
            args[0] = args[0].replace(
              "Server listening at ",
              "后端服务开始监听：",
            );
          }
          method.apply(this, args);
        },
      },
    },
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: "请求编号",
    }),
    bodyLimit: 24_000_000,
  });

  await app.register(cors, {
    origin: runtime.settings.server.cors_origins,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
  await app.register(websocket, {
    options: { maxPayload: 8_000_000 },
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!runtime.localToken || request.method === "OPTIONS") return;
    if (request.headers.upgrade?.toLowerCase() === "websocket") return;
    if (request.url.split("?")[0] === "/healthz") return;

    const authorization = request.headers.authorization ?? "";
    const supplied = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
    if (!tokenMatches(runtime.localToken, supplied)) {
      await reply.code(401).send({ detail: "本地 API 鉴权失败" });
    }
  });

  app.addHook("onRequest", async (request) => {
    request.log.info(
      {
        method: request.method,
        url: request.url,
      },
      "收到请求",
    );
  });

  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        url: request.url,
        status_code: reply.statusCode,
        duration_ms: Number(reply.elapsedTime.toFixed(2)),
      },
      "请求处理完成",
    );
  });

  app.setErrorHandler((rawError, _request, reply) => {
    const error = rawError as Error & { statusCode?: number };
    const status =
      error instanceof HttpError
        ? error.statusCode
        : typeof error.statusCode === "number"
          ? error.statusCode
          : 500;
    if (status >= 500) {
      app.log.error({ err: error }, "请求处理失败");
    }
    reply.status(status).send({
      detail:
        error instanceof HttpError
          ? error.message
          : status >= 500
            ? "服务端内部错误"
            : error.message,
    });
  });

  registerDataRoutes(app, runtime);
  registerConfigRoutes(app, runtime);
  registerWebSocket(app, runtime);
  app.get("/", async () => ({
    app: runtime.settings.app.name,
    version: runtime.settings.app.version,
    runtime: "node",
    agent_kernel: runtime.kernel.id,
    contract_version: runtime.kernel.contractVersion,
  }));
  return app;
}
