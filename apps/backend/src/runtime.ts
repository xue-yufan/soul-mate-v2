import crypto from "node:crypto";
import type { AgentKernel, ModelPort } from "@soul-mate/agent-contracts";
import { TypeScriptAgentKernel } from "@soul-mate/agent-ts";
import type { Settings } from "./config/settings.js";
import { loadSettings } from "./config/settings.js";
import { Persona } from "./persona/index.js";
import { Database } from "./storage/database.js";
import { SqliteHistoryPort } from "./storage/history.js";
import { OpenAICompatibleModel } from "./model/openai-compatible.js";
import {
  DocumentService,
  MemoryExtractor,
  MemoryService,
  RecallService,
  WorldbookService,
} from "./memory/service.js";
import { RustSidecarKernel } from "./agent/rust-kernel.js";
import { PendingRegistry } from "./permission/pending.js";
import { CameraBroker } from "./vision/camera-broker.js";
import { TtsAdapter } from "./tts/index.js";
import { EmbeddingService } from "./memory/embedding-service.js";
import { McpManager } from "./mcp/manager.js";

export class Runtime {
  settings: Settings;
  readonly bootId = crypto.randomUUID().replaceAll("-", "");
  readonly startedAt = Date.now();
  readonly localToken: string | null;
  readonly database: Database;
  readonly persona: Persona;
  readonly history: SqliteHistoryPort;
  readonly pending = new PendingRegistry();
  readonly camera = new CameraBroker();
  model: OpenAICompatibleModel;
  kernel: AgentKernel;
  memory: MemoryService;
  recall: RecallService;
  documents: DocumentService;
  worldbook: WorldbookService;
  extractor: MemoryExtractor;
  tts: TtsAdapter;
  embedding: EmbeddingService;
  mcp: McpManager;
  private reloading = Promise.resolve();

  constructor(
    initial?: Settings,
    options: { localToken?: string | null } = {},
  ) {
    this.localToken =
      options.localToken !== undefined
        ? options.localToken
        : process.env.SOUL_MATE_LOCAL_TOKEN?.trim() || null;
    this.settings = initial ?? loadSettings();
    this.database = new Database(this.settings);
    this.persona = new Persona(this.settings.persona.file);
    this.history = new SqliteHistoryPort(this.database);
    this.model = new OpenAICompatibleModel(this.settings.model);
    this.kernel = this.buildKernel(this.settings);
    this.embedding = new EmbeddingService(this.settings, {
      database: this.database,
    });
    this.mcp = new McpManager(this.settings);
    this.memory = new MemoryService(this.settings, this.database);
    this.recall = new RecallService(
      this.settings,
      this.database,
      this.embedding,
    );
    this.documents = new DocumentService(this.settings, this.database);
    this.worldbook = new WorldbookService(this.settings, this.database);
    this.extractor = new MemoryExtractor(
      this.settings,
      this.model,
      this.memory,
    );
    this.tts = new TtsAdapter(this.settings);
  }

  private buildKernel(settings: Settings): AgentKernel {
    if (settings.agent.kernel === "rust") {
      return new RustSidecarKernel(
        settings.agent.rust_command,
        settings.agent.rust_args,
      );
    }
    return new TypeScriptAgentKernel();
  }

  async reload(nextSettings: Settings): Promise<void> {
    const pending = this.reloading
      .catch(() => undefined)
      .then(async () => {
        if (
          nextSettings.paths.sqlite_path !== this.settings.paths.sqlite_path
        ) {
          throw new Error("数据目录变更需要重启后端");
        }
        const nextModel = new OpenAICompatibleModel(nextSettings.model);
        const nextKernel = this.buildKernel(nextSettings);
        const oldKernel = this.kernel;
      const nextEmbedding = new EmbeddingService(nextSettings, {
        database: this.database,
      });
        const oldEmbedding = this.embedding;
        const nextMcp = new McpManager(nextSettings);
        const oldMcp = this.mcp;
        const oldTts = this.tts;
        this.settings = nextSettings;
        this.model = nextModel;
        this.kernel = nextKernel;
        this.embedding = nextEmbedding;
        this.memory = new MemoryService(nextSettings, this.database);
        this.recall = new RecallService(
          nextSettings,
          this.database,
          nextEmbedding,
        );
        this.documents = new DocumentService(nextSettings, this.database);
        this.worldbook = new WorldbookService(nextSettings, this.database);
        this.extractor = new MemoryExtractor(
          nextSettings,
          nextModel,
          this.memory,
        );
        this.tts = new TtsAdapter(nextSettings);
        await oldKernel.close().catch((error: unknown) => {
          console.warn("[运行时] 旧 Agent 内核关闭失败：", error);
        });
        await oldEmbedding.close();
        await oldMcp.close();
        await nextMcp.start();
        this.mcp = nextMcp;
        await oldTts.close();
      });
    this.reloading = pending;
    return pending;
  }

  async close(): Promise<void> {
    this.pending.clear();
    await this.embedding.close();
    await this.mcp.close();
    await this.tts.close();
    await this.kernel.close();
    this.database.close();
  }

  async initialize(): Promise<void> {
    if (this.embedding.enabled) {
      try {
        await this.embedding.start();
      } catch (error) {
        console.warn(
          "[嵌入] Rust 嵌入内核加载失败（N-API 与 sidecar 均不可用）：",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    await this.mcp.start();
    void this.tts.startEngine().catch((error: unknown) => {
      console.warn(
        "[语音] TTS 引擎启动失败：",
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  context() {
    return {
      model: this.model as ModelPort,
      history: this.history,
      recall: this.recall,
      systemPrompt: this.persona.prompt,
      modelName: this.settings.model.model,
      historyTurns: this.settings.agent.history_turns,
      maxToolSteps: this.settings.agent.max_tool_steps,
      runTimeoutMs: this.settings.agent.run_timeout_s * 1000,
    };
  }
}
