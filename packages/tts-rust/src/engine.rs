use crate::decoder_builder::ensure_static_decoder;
use crate::lexicon::PiperLexicon;
use crate::wav::encode_pcm16;
use anyhow::{Context, Result, bail};
use ort::{
    environment::Environment,
    ep,
    session::{Session, builder::GraphOptimizationLevel},
    value::{Tensor, TensorRef},
};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const FRAME_BUCKET: usize = 64;
const MAX_FRAMES: usize = 4096;
const HOP_LENGTH: usize = 256;

pub struct SpeechEngine {
    environment: Environment,
    lexicon: PiperLexicon,
    front: Session,
    decoder_model_path: PathBuf,
    decoder_device: String,
    cache_dir: PathBuf,
    decoders: HashMap<usize, Session>,
}

impl SpeechEngine {
    pub fn new(
        environment: Environment,
        model_dir: &Path,
        cache_dir: &Path,
        device: &str,
    ) -> Result<Self> {
        fs::create_dir_all(cache_dir).with_context(|| {
            format!("failed to create cache directory: {}", cache_dir.display())
        })?;
        let front = Session::builder(&environment)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?
            .commit_from_file(model_dir.join("front.onnx"))
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let lexicon = PiperLexicon::load(model_dir)?;
        Ok(Self {
            environment,
            lexicon,
            front,
            decoder_model_path: model_dir.join("decoder.onnx"),
            decoder_device: device.to_owned(),
            cache_dir: cache_dir.to_path_buf(),
            decoders: HashMap::new(),
        })
    }

    pub fn synthesize(&mut self, text: &str) -> Result<Vec<u8>> {
        let token_ids = self.lexicon.tokenize(text)?;
        if std::env::var_os("SOUL_MATE_TTS_DEBUG_TOKENS").is_some() {
            eprintln!("[TTS/Rust] tokens={token_ids:?}");
        }
        let token_count = i64::try_from(token_ids.len())?;
        let (frame_count, features) = {
            let tokens = Tensor::from_array(([1i64, token_count], token_ids))
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            let lengths = Tensor::from_array(([1i64], vec![token_count]))
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            let scales = Tensor::from_array(([3i64], vec![0.667f32, 1.0, 0.8]))
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            let outputs = self
                .front
                .run(ort::inputs! {
                    "input" => tokens,
                    "input_lengths" => lengths,
                    "scales" => scales,
                })
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            let (shape, features) = outputs[0]
                .try_extract_tensor::<f32>()
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            if shape.len() != 3 || shape[0] != 1 {
                bail!("unexpected TTS frontend output shape: {shape:?}");
            }
            (usize::try_from(shape[2])?, features.to_vec())
        };
        if frame_count == 0 {
            bail!("TTS frontend returned no audio frames");
        }
        if frame_count > MAX_FRAMES {
            bail!("TTS input is too long: {frame_count} frames");
        }
        let bucket = frame_count.div_ceil(FRAME_BUCKET) * FRAME_BUCKET;
        if std::env::var_os("SOUL_MATE_TTS_DEBUG_TOKENS").is_some() {
            eprintln!("[TTS/Rust] frames={frame_count} bucket={bucket}");
        }
        let mut padded = vec![0.0f32; 192 * bucket];
        for channel in 0..192 {
            let source = channel * frame_count;
            let destination = channel * bucket;
            padded[destination..destination + frame_count]
                .copy_from_slice(&features[source..source + frame_count]);
        }
        if !self.decoders.contains_key(&bucket) {
            let decoder = self.build_decoder(bucket)?;
            self.decoders.insert(bucket, decoder);
        }
        let decoder = self
            .decoders
            .get_mut(&bucket)
            .context("decoder was not initialized")?;
        let input = TensorRef::from_array_view(([1i64, 192, bucket as i64], padded.as_slice()))
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let outputs = decoder
            .run(ort::inputs![input])
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let (_, waveform) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let expected_samples = frame_count * HOP_LENGTH;
        if waveform.len() < expected_samples {
            bail!(
                "TTS decoder returned {} samples, expected at least {expected_samples}",
                waveform.len()
            );
        }
        encode_pcm16(&waveform[..expected_samples])
    }

    fn build_decoder(&self, bucket: usize) -> Result<Session> {
        let model_path = ensure_static_decoder(&self.decoder_model_path, &self.cache_dir, bucket)?;
        let mut builder = Session::builder(&self.environment)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        if self.decoder_device != "CPU" {
            let openvino = ep::OpenVINO::default()
                .with_device_type(&self.decoder_device)
                .with_dynamic_shapes(false)
                .with_cache_dir(self.cache_dir.to_string_lossy())
                .build()
                .error_on_failure();
            builder = builder
                .with_execution_providers([openvino])
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        }
        builder
            .commit_from_file(model_path)
            .map_err(|error| anyhow::anyhow!(error.to_string()))
    }
}
