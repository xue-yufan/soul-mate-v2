#![forbid(unsafe_code)]

use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::Path,
    sync::Mutex,
};

use anyhow::{Context, Result, bail};
use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config};
use tokenizers::Tokenizer;

const MAX_TEXTS: usize = 64;
const MAX_TEXT_BYTES: usize = 8_000;
const DEFAULT_CACHE_CAPACITY: usize = 4_096;

struct VectorCache {
    capacity: usize,
    entries: HashMap<String, Vec<f32>>,
    order: VecDeque<String>,
}

impl VectorCache {
    fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            entries: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn get(&mut self, text: &str) -> Option<Vec<f32>> {
        let vector = self.entries.get(text)?.clone();
        if let Some(position) = self.order.iter().position(|item| item == text) {
            self.order.remove(position);
        }
        self.order.push_back(text.to_owned());
        Some(vector)
    }

    fn insert(&mut self, text: String, vector: Vec<f32>) {
        if self.entries.contains_key(&text) {
            return;
        }
        while self.entries.len() >= self.capacity {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            self.entries.remove(&oldest);
        }
        self.order.push_back(text.clone());
        self.entries.insert(text, vector);
    }

    fn len(&self) -> usize {
        self.entries.len()
    }
}

pub struct EmbeddingEngine {
    tokenizer: Tokenizer,
    model: BertModel,
    device: Device,
    dimension: usize,
    max_tokens: usize,
    pad_token_id: u32,
    cache: Mutex<VectorCache>,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct EmbeddingStats {
    pub cache_hits: usize,
    pub cache_misses: usize,
}

impl EmbeddingEngine {
    pub fn load(model_dir: &Path) -> Result<Self> {
        let config_path = model_dir.join("config.json");
        let tokenizer_path = model_dir.join("tokenizer.json");
        let weights_path = model_dir.join("model.safetensors");
        for file in [&config_path, &tokenizer_path, &weights_path] {
            if !file.is_file() {
                bail!("嵌入模型文件不存在：{}", file.display());
            }
        }

        let config: Config = serde_json::from_str(
            &std::fs::read_to_string(&config_path)
                .with_context(|| format!("读取配置失败：{}", config_path.display()))?,
        )
        .with_context(|| format!("解析 BERT 配置失败：{}", config_path.display()))?;
        let tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|error| anyhow::anyhow!("加载 tokenizer 失败：{error}"))?;
        let device = Device::Cpu;
        let weights = std::fs::read(&weights_path)
            .with_context(|| format!("读取模型权重失败：{}", weights_path.display()))?;
        let variables = VarBuilder::from_buffered_safetensors(weights, DType::F32, &device)?;
        let model = BertModel::load(variables, &config)?;
        Ok(Self {
            tokenizer,
            model,
            device,
            dimension: config.hidden_size,
            max_tokens: config.max_position_embeddings,
            pad_token_id: u32::try_from(config.pad_token_id)
                .context("BERT pad_token_id 超出 u32 范围")?,
            cache: Mutex::new(VectorCache::new(DEFAULT_CACHE_CAPACITY)),
        })
    }

    pub fn dimension(&self) -> usize {
        self.dimension
    }

    pub fn cache_entries(&self) -> Result<usize> {
        self.cache
            .lock()
            .map(|cache| cache.len())
            .map_err(|_| anyhow::anyhow!("嵌入缓存锁已损坏"))
    }

    pub fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        self.embed_cancellable(texts, || false)
            .map(|(vectors, _)| vectors)
    }

    pub fn embed_cancellable(
        &self,
        texts: &[String],
        is_cancelled: impl Fn() -> bool,
    ) -> Result<(Vec<Vec<f32>>, EmbeddingStats)> {
        if texts.len() > MAX_TEXTS {
            bail!("单次嵌入文本不能超过 {MAX_TEXTS} 条");
        }
        for text in texts {
            if text.len() > MAX_TEXT_BYTES {
                bail!("单条嵌入文本不能超过 {MAX_TEXT_BYTES} 字节");
            }
        }

        let mut computed = HashMap::<String, Vec<f32>>::new();
        let mut stats = EmbeddingStats::default();
        let mut missing = Vec::new();
        let mut seen = HashSet::new();
        {
            let mut cache = self
                .cache
                .lock()
                .map_err(|_| anyhow::anyhow!("嵌入缓存锁已损坏"))?;
            for text in texts {
                if is_cancelled() {
                    bail!("嵌入请求已取消");
                }
                if !seen.insert(text.clone()) {
                    continue;
                }
                if let Some(vector) = cache.get(text) {
                    stats.cache_hits += 1;
                    computed.insert(text.clone(), vector);
                } else {
                    stats.cache_misses += 1;
                    missing.push(text.clone());
                }
            }
        }

        let missing_vectors = self.embed_batch(&missing, &is_cancelled)?;
        for (text, vector) in missing.into_iter().zip(missing_vectors) {
            self.cache
                .lock()
                .map_err(|_| anyhow::anyhow!("嵌入缓存锁已损坏"))?
                .insert(text.clone(), vector.clone());
            computed.insert(text, vector);
        }
        if is_cancelled() {
            bail!("嵌入请求已取消");
        }

        let vectors = texts
            .iter()
            .map(|text| {
                computed
                    .get(text)
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("嵌入结果缺失：{text}"))
            })
            .collect::<Result<Vec<_>>>()?;
        Ok((vectors, stats))
    }

    fn embed_batch(
        &self,
        texts: &[String],
        is_cancelled: &impl Fn() -> bool,
    ) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        if is_cancelled() {
            bail!("嵌入请求已取消");
        }
        let mut encoded = Vec::with_capacity(texts.len());
        let mut max_len = 0usize;
        for text in texts {
            let encoding = self
                .tokenizer
                .encode(text.as_str(), true)
                .map_err(|error| anyhow::anyhow!("tokenizer 编码失败：{error}"))?;
            let len = encoding.get_ids().len().min(self.max_tokens);
            if len == 0 {
                bail!("tokenizer 没有生成有效 token");
            }
            max_len = max_len.max(len);
            encoded.push((
                encoding.get_ids()[..len].to_vec(),
                encoding.get_type_ids()[..len].to_vec(),
                encoding.get_attention_mask()[..len].to_vec(),
            ));
        }
        if max_len == 0 {
            bail!("嵌入批次没有有效 token");
        }

        let batch = encoded.len();
        let mut ids = vec![self.pad_token_id; batch * max_len];
        let mut type_ids = vec![0u32; batch * max_len];
        let mut attention = vec![0u32; batch * max_len];
        for (row, (row_ids, row_types, row_mask)) in encoded.iter().enumerate() {
            let offset = row * max_len;
            ids[offset..offset + row_ids.len()].copy_from_slice(row_ids);
            type_ids[offset..offset + row_types.len()].copy_from_slice(row_types);
            attention[offset..offset + row_mask.len()].copy_from_slice(row_mask);
        }

        let ids = Tensor::from_vec(ids, (batch, max_len), &self.device)?;
        let type_ids = Tensor::from_vec(type_ids, (batch, max_len), &self.device)?;
        let attention_mask = Tensor::from_vec(attention, (batch, max_len), &self.device)?;
        if is_cancelled() {
            bail!("嵌入请求已取消");
        }
        let hidden = self.model.forward(&ids, &type_ids, Some(&attention_mask))?;
        let mask = attention_mask.to_dtype(hidden.dtype())?.unsqueeze(2)?;
        let sum = hidden.broadcast_mul(&mask)?.sum(1)?;
        let count = mask.sum(1)?;
        let pooled = sum.broadcast_div(&count)?;
        let norm = pooled.sqr()?.sum_keepdim(1)?.sqrt()?;
        let normalized = pooled.broadcast_div(&norm)?;
        if is_cancelled() {
            bail!("嵌入请求已取消");
        }
        normalized.to_vec2::<f32>().map_err(Into::into)
    }
}

#[cfg(test)]
mod tests {
    use super::VectorCache;

    #[test]
    fn cache_evicts_least_recently_used_entry() {
        let mut cache = VectorCache::new(2);
        cache.insert("a".to_owned(), vec![1.0]);
        cache.insert("b".to_owned(), vec![2.0]);
        assert!(cache.get("a").is_some());
        cache.insert("c".to_owned(), vec![3.0]);

        assert!(cache.get("a").is_some());
        assert!(cache.get("b").is_none());
        assert!(cache.get("c").is_some());
    }
}
