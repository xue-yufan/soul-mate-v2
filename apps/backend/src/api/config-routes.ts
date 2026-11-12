import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime.js";
import {
  applyConfigPatch,
  buildSettingsPayload,
  ConfigValueError,
  restoreOverrides,
  RESTART_REQUIRED_PATHS,
} from "../config/schema.js";
import { loadSettings } from "../config/settings.js";
import { HttpError } from "./errors.js";
import {
  inspectRuntimeModules,
  logModuleStatuses,
} from "../diagnostics.js";

function snapshot(runtime: Runtime) {
  const settings = runtime.settings;
  return {
    app: {
      name: settings.app.name,
      version: settings.app.version,
      env: settings.app.env,
    },
    contracts: { ws_event_version: settings.contracts.ws_event_version },
    features: { ...settings.features },
    model: {
      provider: settings.model.provider,
      adapter: settings.model.adapter,
      model: settings.model.model,
      base_url: settings.model.base_url,
      api_key_set: Boolean(settings.model.api_key),
    },
    cost: {
      budget: settings.cost.budget,
      currency: settings.cost.currency,
    },
    tts: {
      provider: settings.tts.provider,
      voice: settings.tts.voice,
      rate: settings.tts.rate,
    },
    agent: {
      default_session_id: settings.agent.default_session_id,
      history_turns: settings.agent.history_turns,
      max_tool_steps: settings.agent.max_tool_steps,
    },
    settings: buildSettingsPayload(settings),
  };
}

export function registerConfigRoutes(
  app: FastifyInstance,
  runtime: Runtime,
): void {
  app.get("/config/public", async () => snapshot(runtime));

  const update = async (body: {
    values?: Record<string, unknown>;
    reset?: string[];
  }) => {
    const values = body?.values ?? {};
    const reset = body?.reset ?? [];
    let previous: Record<string, unknown>;
    try {
      previous = applyConfigPatch(values, reset);
    } catch (error) {
      if (error instanceof ConfigValueError) {
        throw new HttpError(400, error.message);
      }
      throw new HttpError(500, `写入配置失败：${String(error)}`);
    }

    let settings;
    try {
      settings = loadSettings();
    } catch (error) {
      restoreOverrides(previous);
      throw new HttpError(
        400,
        `新配置校验失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      await runtime.reload(settings);
      logModuleStatuses(app.log, await inspectRuntimeModules(runtime));
    } catch (error) {
      restoreOverrides(previous);
      throw new HttpError(
        500,
        `配置已写入，但重建运行时失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const changed = [...Object.keys(values), ...reset];
    return {
      ok: true,
      updated: Object.keys(values).sort(),
      reset: [...reset].sort(),
      restart_required: changed.some((path) =>
        RESTART_REQUIRED_PATHS.has(path),
      ),
      config: snapshot(runtime),
    };
  };

  app.patch("/config", async (request) => update(request.body as never));
  app.post("/config", async (request) => update(request.body as never));
}
