use std::{
    collections::HashMap,
    panic::{AssertUnwindSafe, catch_unwind},
    path::PathBuf,
    sync::{
        Arc, Mutex as StdMutex, RwLock,
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::anyhow;
use napi::{Error, Result, Status};
use napi_derive::napi;
use soul_mate_embedding_core::EmbeddingEngine;
use tokio::sync::{Mutex as AsyncMutex, Notify, Semaphore};

const MAX_REQUEST_ID_BYTES: usize = 128;
const WORKER_LIMIT: usize = 2;
const QUEUE_LIMIT: usize = 8;
const SUBMISSION_LIMIT: usize = WORKER_LIMIT + QUEUE_LIMIT;
const CANCELLATION_TOMBSTONE_LIMIT: usize = 1_024;
const CANCELLATION_TOMBSTONE_TTL: Duration = Duration::from_secs(10);
const INDEX_LIMIT: usize = 100_000;

type SharedEngine = Arc<RwLock<Option<Arc<EmbeddingEngine>>>>;
type Requests = Arc<StdMutex<HashMap<String, Arc<RequestControl>>>>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum KernelState {
    Unloaded,
    Loading,
    Ready,
    Failed,
}

impl KernelState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Unloaded => "unloaded",
            Self::Loading => "loading",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }
}

struct StateData {
    state: KernelState,
    reason: Option<String>,
}

#[derive(Default)]
struct Metrics {
    active_requests: AtomicU32,
    queued_requests: AtomicU32,
    completed_requests: AtomicU64,
    cancelled_requests: AtomicU64,
    failed_requests: AtomicU64,
    rejected_requests: AtomicU64,
    cache_hits: AtomicU64,
    cache_misses: AtomicU64,
    inference_requests: AtomicU64,
    total_inference_micros: AtomicU64,
    last_inference_micros: AtomicU64,
    load_micros: AtomicU64,
}

#[derive(Default)]
struct RequestControl {
    cancelled: AtomicBool,
    notify: Notify,
}

impl RequestControl {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    async fn wait_cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        let notified = self.notify.notified();
        if self.is_cancelled() {
            return;
        }
        notified.await;
    }
}

struct RequestRegistration {
    requests: Requests,
    request_id: String,
}

impl Drop for RequestRegistration {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.remove(&self.request_id);
        }
    }
}

impl RequestRegistration {
    fn keep_alive(&self) {}
}

struct ActiveRequest {
    metrics: Arc<Metrics>,
}

impl ActiveRequest {
    fn new(metrics: Arc<Metrics>) -> Self {
        metrics.active_requests.fetch_add(1, Ordering::AcqRel);
        Self { metrics }
    }
}

impl Drop for ActiveRequest {
    fn drop(&mut self) {
        self.metrics.active_requests.fetch_sub(1, Ordering::AcqRel);
    }
}

#[napi(object)]
pub struct EmbeddingKernelStatus {
    pub state: String,
    pub loaded: bool,
    pub dimension: u32,
    pub cache_entries: u32,
    pub index_entries: u32,
    pub active_requests: u32,
    pub queued_requests: u32,
    pub registered_requests: u32,
    pub completed_requests: i64,
    pub cancelled_requests: i64,
    pub failed_requests: i64,
    pub rejected_requests: i64,
    pub cache_hits: i64,
    pub cache_misses: i64,
    pub average_inference_ms: f64,
    pub last_inference_ms: f64,
    pub load_ms: f64,
    pub worker_limit: u32,
    pub queue_limit: u32,
    pub reason: Option<String>,
    pub version: String,
}

#[napi(object)]
pub struct EmbeddingIndexEntry {
    pub id: String,
    pub vector: Vec<f64>,
}

#[napi(object)]
pub struct EmbeddingRankedItem {
    pub id: String,
    pub score: f64,
}

#[napi]
pub struct NativeEmbeddingKernel {
    engine: SharedEngine,
    state: Arc<RwLock<StateData>>,
    load_lock: AsyncMutex<()>,
    workers: Arc<Semaphore>,
    submissions: Arc<Semaphore>,
    requests: Requests,
    pending_cancellations: Arc<StdMutex<HashMap<String, Instant>>>,
    index: Arc<RwLock<HashMap<String, Arc<Vec<f32>>>>>,
    metrics: Arc<Metrics>,
}

impl Default for NativeEmbeddingKernel {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl NativeEmbeddingKernel {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            engine: Arc::new(RwLock::new(None)),
            state: Arc::new(RwLock::new(StateData {
                state: KernelState::Unloaded,
                reason: None,
            })),
            load_lock: AsyncMutex::new(()),
            workers: Arc::new(Semaphore::new(WORKER_LIMIT)),
            submissions: Arc::new(Semaphore::new(SUBMISSION_LIMIT)),
            requests: Arc::new(StdMutex::new(HashMap::new())),
            pending_cancellations: Arc::new(StdMutex::new(HashMap::new())),
            index: Arc::new(RwLock::new(HashMap::new())),
            metrics: Arc::new(Metrics::default()),
        }
    }

    #[napi]
    pub async fn load(&self, model_dir: String) -> Result<u32> {
        let _guard = self.load_lock.lock().await;
        let current_state = self
            .state
            .read()
            .map_err(|_| Error::from_reason("嵌入状态锁已损坏"))?
            .state;
        if let Some(engine) = self.current_engine()? {
            if current_state == KernelState::Ready {
                return to_u32(engine.dimension());
            }
            let mut current = self
                .engine
                .write()
                .map_err(|_| Error::from_reason("嵌入内核锁已损坏"))?;
            *current = None;
        }
        self.update_state(KernelState::Loading, None)?;
        let started = Instant::now();
        let loaded = tokio::task::spawn_blocking(move || {
            guarded(|| EmbeddingEngine::load(&PathBuf::from(model_dir)))
        })
        .await
        .map_err(join_error)?;
        match loaded {
            Ok(engine) => {
                let dimension = to_u32(engine.dimension())?;
                self.metrics
                    .load_micros
                    .store(elapsed_micros(started), Ordering::Relaxed);
                let mut current = self
                    .engine
                    .write()
                    .map_err(|_| Error::from_reason("嵌入内核锁已损坏"))?;
                *current = Some(Arc::new(engine));
                if let Ok(mut index) = self.index.write() {
                    index.clear();
                }
                self.update_state(KernelState::Ready, None)?;
                Ok(dimension)
            }
            Err(error) => {
                let message = error.to_string();
                self.update_state(KernelState::Failed, Some(message.clone()))?;
                Err(embedding_error(anyhow!("{message}")))
            }
        }
    }

    #[napi]
    pub async fn embed(&self, request_id: String, texts: Vec<String>) -> Result<Vec<Vec<f64>>> {
        validate_request_id(&request_id)?;
        let _submission = self.submissions.clone().try_acquire_owned().map_err(|_| {
            self.metrics
                .rejected_requests
                .fetch_add(1, Ordering::Relaxed);
            Error::new(Status::GenericFailure, "嵌入请求队列已满")
        })?;
        let control = Arc::new(RequestControl::default());
        {
            let mut requests = self
                .requests
                .lock()
                .map_err(|_| Error::from_reason("嵌入请求表锁已损坏"))?;
            if requests.contains_key(&request_id) {
                self.metrics
                    .rejected_requests
                    .fetch_add(1, Ordering::Relaxed);
                return Err(Error::new(Status::GenericFailure, "重复的嵌入请求 ID"));
            }
            requests.insert(request_id.clone(), control.clone());
        }
        let cancelled_before_registration = self
            .pending_cancellations
            .lock()
            .map_err(|_| Error::from_reason("嵌入取消表锁已损坏"))?
            .remove(&request_id)
            .is_some();
        if cancelled_before_registration {
            control.cancel();
        }
        let registration = RequestRegistration {
            requests: self.requests.clone(),
            request_id,
        };

        self.metrics.queued_requests.fetch_add(1, Ordering::AcqRel);
        let worker = tokio::select! {
            _ = control.wait_cancelled() => None,
            worker = self.workers.clone().acquire_owned() => worker.ok(),
        };
        self.metrics.queued_requests.fetch_sub(1, Ordering::AcqRel);
        let Some(_worker) = worker else {
            self.metrics
                .cancelled_requests
                .fetch_add(1, Ordering::Relaxed);
            return Err(cancelled_error());
        };
        let _active = ActiveRequest::new(self.metrics.clone());

        let engine = self
            .current_engine()?
            .ok_or_else(|| Error::new(Status::GenericFailure, "嵌入模型尚未加载"))?;
        if self
            .state
            .read()
            .map_err(|_| Error::from_reason("嵌入状态锁已损坏"))?
            .state
            == KernelState::Failed
        {
            return Err(Error::new(
                Status::GenericFailure,
                "嵌入内核处于失败状态，请先重新加载",
            ));
        }
        if control.is_cancelled() {
            self.metrics
                .cancelled_requests
                .fetch_add(1, Ordering::Relaxed);
            return Err(cancelled_error());
        }

        let control_for_work = control.clone();
        let started = Instant::now();
        let result = tokio::task::spawn_blocking(move || {
            guarded(|| engine.embed_cancellable(&texts, || control_for_work.is_cancelled()))
        })
        .await
        .map_err(join_error)?;
        registration.keep_alive();

        match result {
            Ok((vectors, stats)) => {
                self.metrics
                    .cache_hits
                    .fetch_add(stats.cache_hits as u64, Ordering::Relaxed);
                self.metrics
                    .cache_misses
                    .fetch_add(stats.cache_misses as u64, Ordering::Relaxed);
                let elapsed = elapsed_micros(started);
                self.metrics
                    .inference_requests
                    .fetch_add(1, Ordering::Relaxed);
                self.metrics
                    .total_inference_micros
                    .fetch_add(elapsed, Ordering::Relaxed);
                self.metrics
                    .last_inference_micros
                    .store(elapsed, Ordering::Relaxed);
                self.metrics
                    .completed_requests
                    .fetch_add(1, Ordering::Relaxed);
                Ok(vectors
                    .into_iter()
                    .map(|vector| vector.into_iter().map(f64::from).collect())
                    .collect())
            }
            Err(_) if control.is_cancelled() => {
                self.metrics
                    .cancelled_requests
                    .fetch_add(1, Ordering::Relaxed);
                Err(cancelled_error())
            }
            Err(error) => {
                self.metrics.failed_requests.fetch_add(1, Ordering::Relaxed);
                let message = error.to_string();
                if message.contains("发生 panic") {
                    self.update_state(KernelState::Failed, Some(message.clone()))?;
                }
                Err(embedding_error(error))
            }
        }
    }

    #[napi]
    pub fn cancel(&self, request_id: String) -> Result<bool> {
        let control = self
            .requests
            .lock()
            .map_err(|_| Error::from_reason("嵌入请求表锁已损坏"))?
            .get(&request_id)
            .cloned();
        if let Some(control) = control {
            control.cancel();
            return Ok(true);
        }
        let mut pending = self
            .pending_cancellations
            .lock()
            .map_err(|_| Error::from_reason("嵌入取消表锁已损坏"))?;
        let now = Instant::now();
        pending.retain(|_, created| now.duration_since(*created) <= CANCELLATION_TOMBSTONE_TTL);
        if pending.len() >= CANCELLATION_TOMBSTONE_LIMIT {
            pending.clear();
        }
        pending.insert(request_id, now);
        Ok(true)
    }

    #[napi]
    pub fn status(&self) -> Result<EmbeddingKernelStatus> {
        let engine = self.current_engine()?;
        let state = self
            .state
            .read()
            .map_err(|_| Error::from_reason("嵌入状态锁已损坏"))?;
        let inference_requests = self.metrics.inference_requests.load(Ordering::Relaxed);
        let average_inference_ms = micros_to_ms(
            self.metrics
                .total_inference_micros
                .load(Ordering::Relaxed)
                .checked_div(inference_requests)
                .unwrap_or(0),
        );
        let registered_requests = {
            let requests = self
                .requests
                .lock()
                .map_err(|_| Error::from_reason("嵌入请求表锁已损坏"))?;
            requests.len().try_into().unwrap_or(u32::MAX)
        };
        let index_entries = self
            .index
            .read()
            .map_err(|_| Error::from_reason("嵌入索引锁已损坏"))?
            .len()
            .try_into()
            .unwrap_or(u32::MAX);
        Ok(EmbeddingKernelStatus {
            state: state.state.as_str().to_owned(),
            loaded: engine.is_some(),
            dimension: engine
                .as_ref()
                .map(|engine| to_u32(engine.dimension()))
                .transpose()?
                .unwrap_or(0),
            cache_entries: engine
                .as_ref()
                .map(|engine| engine.cache_entries().map(to_u32).map_err(embedding_error))
                .transpose()?
                .unwrap_or(Ok(0))?,
            index_entries,
            active_requests: self.metrics.active_requests.load(Ordering::Relaxed),
            queued_requests: self.metrics.queued_requests.load(Ordering::Relaxed),
            registered_requests,
            completed_requests: to_i64(self.metrics.completed_requests.load(Ordering::Relaxed)),
            cancelled_requests: to_i64(self.metrics.cancelled_requests.load(Ordering::Relaxed)),
            failed_requests: to_i64(self.metrics.failed_requests.load(Ordering::Relaxed)),
            rejected_requests: to_i64(self.metrics.rejected_requests.load(Ordering::Relaxed)),
            cache_hits: to_i64(self.metrics.cache_hits.load(Ordering::Relaxed)),
            cache_misses: to_i64(self.metrics.cache_misses.load(Ordering::Relaxed)),
            average_inference_ms,
            last_inference_ms: micros_to_ms(
                self.metrics.last_inference_micros.load(Ordering::Relaxed),
            ),
            load_ms: micros_to_ms(self.metrics.load_micros.load(Ordering::Relaxed)),
            worker_limit: WORKER_LIMIT as u32,
            queue_limit: QUEUE_LIMIT as u32,
            reason: state.reason.clone(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
        })
    }

    #[napi]
    pub fn index_upsert(&self, entries: Vec<EmbeddingIndexEntry>) -> Result<u32> {
        let engine = self
            .current_engine()?
            .ok_or_else(|| Error::new(Status::GenericFailure, "嵌入模型尚未加载"))?;
        let dimension = engine.dimension();
        let mut index = self
            .index
            .write()
            .map_err(|_| Error::from_reason("嵌入索引锁已损坏"))?;
        if index.len().saturating_add(entries.len()) > INDEX_LIMIT {
            return Err(Error::new(
                Status::GenericFailure,
                format!("嵌入索引超过上限 {INDEX_LIMIT}"),
            ));
        }
        for entry in entries {
            if entry.id.is_empty() || entry.id.len() > 256 {
                return Err(Error::new(Status::InvalidArg, "嵌入索引 ID 无效"));
            }
            if entry.vector.len() != dimension {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "嵌入索引维度不匹配：期望 {dimension}，实际 {}",
                        entry.vector.len()
                    ),
                ));
            }
            let vector = entry
                .vector
                .into_iter()
                .map(|value| {
                    if value.is_finite() {
                        Ok(value as f32)
                    } else {
                        Err(Error::new(Status::InvalidArg, "嵌入索引包含非有限数值"))
                    }
                })
                .collect::<Result<Vec<_>>>()?;
            index.insert(entry.id, Arc::new(vector));
        }
        to_u32(index.len())
    }

    #[napi]
    pub fn index_remove(&self, ids: Vec<String>) -> Result<u32> {
        let mut index = self
            .index
            .write()
            .map_err(|_| Error::from_reason("嵌入索引锁已损坏"))?;
        for id in ids {
            index.remove(&id);
        }
        to_u32(index.len())
    }

    #[napi]
    pub fn rank_vector(
        &self,
        query: Vec<f64>,
        ids: Vec<String>,
        limit: u32,
    ) -> Result<Vec<EmbeddingRankedItem>> {
        let engine = self
            .current_engine()?
            .ok_or_else(|| Error::new(Status::GenericFailure, "嵌入模型尚未加载"))?;
        if query.len() != engine.dimension() {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "查询向量维度不匹配：期望 {}，实际 {}",
                    engine.dimension(),
                    query.len()
                ),
            ));
        }
        let query = query
            .into_iter()
            .map(|value| value as f32)
            .collect::<Vec<_>>();
        let query_norm = query
            .iter()
            .map(|value| (*value as f64) * (*value as f64))
            .sum::<f64>()
            .sqrt();
        if query_norm == 0.0 {
            return Ok(Vec::new());
        }
        let index = self
            .index
            .read()
            .map_err(|_| Error::from_reason("嵌入索引锁已损坏"))?;
        let mut ranked = ids
            .into_iter()
            .filter_map(|id| {
                let vector = index.get(&id)?;
                let mut dot = 0.0f64;
                let mut norm = 0.0f64;
                for (left, right) in query.iter().zip(vector.iter()) {
                    dot += (*left as f64) * (*right as f64);
                    norm += (*right as f64) * (*right as f64);
                }
                let denominator = query_norm * norm.sqrt();
                (denominator > 0.0).then_some(EmbeddingRankedItem {
                    id,
                    score: dot / denominator,
                })
            })
            .collect::<Vec<_>>();
        ranked.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        ranked.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
        Ok(ranked)
    }

    #[napi]
    pub async fn unload(&self) -> Result<()> {
        let _guard = self.load_lock.lock().await;
        {
            let mut current = self
                .engine
                .write()
                .map_err(|_| Error::from_reason("嵌入内核锁已损坏"))?;
            *current = None;
        }
        if let Ok(mut index) = self.index.write() {
            index.clear();
        }
        self.update_state(KernelState::Unloaded, None)
    }

    fn current_engine(&self) -> Result<Option<Arc<EmbeddingEngine>>> {
        self.engine
            .read()
            .map(|current| current.clone())
            .map_err(|_| Error::from_reason("嵌入内核锁已损坏"))
    }

    fn update_state(&self, state: KernelState, reason: Option<String>) -> Result<()> {
        let mut current = self
            .state
            .write()
            .map_err(|_| Error::from_reason("嵌入状态锁已损坏"))?;
        current.state = state;
        current.reason = reason;
        Ok(())
    }
}

fn guarded<T>(operation: impl FnOnce() -> anyhow::Result<T>) -> anyhow::Result<T> {
    match catch_unwind(AssertUnwindSafe(operation)) {
        Ok(result) => result,
        Err(payload) => {
            let message = payload
                .downcast_ref::<&str>()
                .map(|value| (*value).to_owned())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "未知 panic".to_owned());
            Err(anyhow!("Rust 嵌入任务发生 panic：{message}"))
        }
    }
}

fn validate_request_id(request_id: &str) -> Result<()> {
    if request_id.is_empty() || request_id.len() > MAX_REQUEST_ID_BYTES {
        return Err(Error::new(
            Status::InvalidArg,
            format!("嵌入请求 ID 长度必须为 1-{MAX_REQUEST_ID_BYTES} 字节"),
        ));
    }
    Ok(())
}

fn cancelled_error() -> Error {
    Error::new(Status::GenericFailure, "嵌入请求已取消")
}

fn elapsed_micros(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX)
}

fn micros_to_ms(micros: u64) -> f64 {
    micros as f64 / 1_000.0
}

fn to_u32(value: usize) -> Result<u32> {
    u32::try_from(value).map_err(|_| Error::from_reason("嵌入数值超出 u32 范围"))
}

fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn join_error(error: tokio::task::JoinError) -> Error {
    Error::from_reason(format!("嵌入后台任务失败：{error}"))
}

fn embedding_error(error: anyhow::Error) -> Error {
    Error::from_reason(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::guarded;

    #[test]
    fn panic_is_converted_to_error() {
        let result = guarded::<()>(|| panic!("测试 panic"));
        assert!(result.unwrap_err().to_string().contains("测试 panic"));
    }
}
