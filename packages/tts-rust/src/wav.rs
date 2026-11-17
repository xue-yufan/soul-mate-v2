use anyhow::{Result, bail};

const SAMPLE_RATE: u32 = 22_050;
const CHANNELS: u16 = 1;
const BITS_PER_SAMPLE: u16 = 16;

pub fn encode_pcm16(samples: &[f32]) -> Result<Vec<u8>> {
    if samples.is_empty() {
        bail!("TTS decoder returned no samples");
    }
    let mean = samples.iter().map(|sample| f64::from(*sample)).sum::<f64>() / samples.len() as f64;
    let variance = samples
        .iter()
        .map(|sample| {
            let delta = f64::from(*sample) - mean;
            delta * delta
        })
        .sum::<f64>()
        / samples.len() as f64;
    if !samples.iter().all(|sample| sample.is_finite()) || variance <= 1e-10 {
        bail!("TTS decoder returned an invalid waveform");
    }

    let data_length = u32::try_from(samples.len() * 2)?;
    let mut output = Vec::with_capacity(44 + data_length as usize);
    output.extend_from_slice(b"RIFF");
    output.extend_from_slice(&(36 + data_length).to_le_bytes());
    output.extend_from_slice(b"WAVEfmt ");
    output.extend_from_slice(&16u32.to_le_bytes());
    output.extend_from_slice(&1u16.to_le_bytes());
    output.extend_from_slice(&CHANNELS.to_le_bytes());
    output.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    output.extend_from_slice(&(SAMPLE_RATE * u32::from(CHANNELS) * 2).to_le_bytes());
    output.extend_from_slice(&(CHANNELS * 2).to_le_bytes());
    output.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
    output.extend_from_slice(b"data");
    output.extend_from_slice(&data_length.to_le_bytes());
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16;
        output.extend_from_slice(&value.to_le_bytes());
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_valid_wav_header() {
        let wave = encode_pcm16(&[0.0, 0.25, -0.25]).unwrap();
        assert_eq!(&wave[0..4], b"RIFF");
        assert_eq!(&wave[8..12], b"WAVE");
        assert_eq!(&wave[36..40], b"data");
        assert_eq!(wave.len(), 44 + 6);
    }
}
