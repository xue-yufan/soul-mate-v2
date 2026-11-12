import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const packageDir = path.dirname(fileURLToPath(import.meta.url));
const addonPath = path.join(packageDir, "dist", "soul-mate-embedding.node");
const modelDir = process.argv[2] ?? process.env.SOUL_MATE_EMBED_MODEL_DIR;
if (!modelDir) {
  console.error(
    "用法：npm run bench:embedding -- <模型目录>，或设置 SOUL_MATE_EMBED_MODEL_DIR",
  );
  process.exit(2);
}

const { NativeEmbeddingKernel } = require(addonPath);
const kernel = new NativeEmbeddingKernel();
const requestId = (() => {
  let value = 0;
  return () => `benchmark-${++value}`;
})();

async function timed(operation) {
  const started = performance.now();
  const result = await operation();
  return { result, ms: performance.now() - started };
}

try {
  const load = await timed(() => kernel.load(modelDir));
  const warmup = await timed(() =>
    kernel.embed(requestId(), ["预热 1", "预热 2", "预热 3", "预热 4"]),
  );

  const texts = Array.from(
    { length: 16 },
    (_, index) => `记忆与检索基准文本 ${index}：今天的心情和天气`,
  );
  const cold = await timed(() => kernel.embed(requestId(), texts));
  const entries = texts.map((_, index) => ({
    id: `doc-${index}`,
    vector: cold.result[index],
  }));
  kernel.indexUpsert(entries);
  const rank = await timed(() =>
    kernel.rankVector(
      cold.result[0],
      entries.map((entry) => entry.id),
      5,
    ),
  );
  const cached = await timed(() => kernel.embed(requestId(), texts));
  const concurrentTexts = [0, 1].map((group) =>
    Array.from(
      { length: 8 },
      (_, index) =>
        `并发基准 ${group}-${index}：角色记忆、情绪和资料检索 ${Date.now()}`,
    ),
  );
  const concurrent = await timed(() =>
    Promise.all(
      concurrentTexts.map((items) => kernel.embed(requestId(), items)),
    ),
  );
  const bulkTexts = Array.from(
    { length: 64 },
    (_, index) => `批量导入基准 ${index}：${"长文本内容".repeat(12)}`,
  );
  const bulkBatches = Array.from({ length: 4 }, (_, index) =>
    bulkTexts.slice(index * 16, index * 16 + 16),
  );
  const bulk = await timed(async () => {
    let next = 0;
    const worker = async () => {
      while (next < bulkBatches.length) {
        const index = next++;
        await kernel.embed(requestId(), bulkBatches[index]);
      }
    };
    await Promise.all([worker(), worker()]);
  });
  const status = kernel.status();

  console.log(
    JSON.stringify(
      {
        addonPath,
        modelDir,
        dimension: load.result,
        loadMs: load.ms,
        warmup4Ms: warmup.ms,
        batch16ColdMs: cold.ms,
        rank16Ms: rank.ms,
        batch16CachedMs: cached.ms,
        concurrent2x8Ms: concurrent.ms,
        batch64TwoWorkersMs: bulk.ms,
        speedup: cold.ms / Math.max(cached.ms, 0.001),
        rssMiB: process.memoryUsage().rss / 1024 / 1024,
        cacheHitRate:
          status.cacheHits / Math.max(status.cacheHits + status.cacheMisses, 1),
        status,
      },
      null,
      2,
    ),
  );
} finally {
  await kernel.unload();
}
