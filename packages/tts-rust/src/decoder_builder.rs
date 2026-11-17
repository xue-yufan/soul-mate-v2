use anyhow::{Context, Result, bail};
use onnx_protobuf::{
    AttributeProto, Message, ModelProto, NodeProto, TensorProto, ValueInfoProto, attribute_proto,
    tensor_proto, tensor_shape_proto,
};
use protobuf::{Enum, EnumOrUnknown};
use std::fs;
use std::path::{Path, PathBuf};

pub fn ensure_static_decoder(source: &Path, cache_dir: &Path, bucket: usize) -> Result<PathBuf> {
    let destination = cache_dir.join(format!("decoder-{bucket}.onnx"));
    if destination.is_file() {
        return Ok(destination);
    }

    let bytes = fs::read(source)
        .with_context(|| format!("failed to read decoder source: {}", source.display()))?;
    let mut model = ModelProto::parse_from_bytes(&bytes)
        .with_context(|| format!("failed to parse decoder source: {}", source.display()))?;
    make_static(&mut model, bucket)?;

    let partial = destination.with_extension("onnx.partial");
    let mut output = fs::File::create(&partial)
        .with_context(|| format!("failed to create static decoder: {}", partial.display()))?;
    model
        .write_to_writer(&mut output)
        .context("failed to serialize static decoder")?;
    drop(output);
    fs::rename(&partial, &destination).with_context(|| {
        format!(
            "failed to finalize static decoder: {}",
            destination.display()
        )
    })?;
    Ok(destination)
}

fn make_static(model: &mut ModelProto, bucket: usize) -> Result<()> {
    let graph = model
        .graph
        .as_mut()
        .context("decoder ONNX graph is missing")?;
    if graph.input.len() != 1 || graph.output.is_empty() {
        bail!(
            "unexpected decoder graph signature: inputs={}, outputs={}",
            graph.input.len(),
            graph.output.len()
        );
    }

    set_tensor_shape(&mut graph.input[0], &[1, 192, bucket as i64]);
    let original_output = graph.output[0].name.clone();
    let max_samples = i64::try_from(bucket * 256)?;
    graph.initializer.extend([
        tensor_f32(
            "decoder_static_pad",
            &[1, 1, 1, max_samples],
            max_samples as usize,
        )?,
        tensor_i64("decoder_static_starts", &[1], &[0]),
        tensor_i64("decoder_static_ends", &[1], &[max_samples]),
        tensor_i64("decoder_static_axes", &[1], &[3]),
        tensor_i64("decoder_static_steps", &[1], &[1]),
    ]);
    graph.node.extend([
        node(
            "decoder_static_concat",
            "Concat",
            &[&original_output, "decoder_static_pad"],
            &["decoder_static_padded"],
            vec![int_attribute("axis", 3)],
        ),
        node(
            "decoder_static_slice",
            "Slice",
            &[
                "decoder_static_padded",
                "decoder_static_starts",
                "decoder_static_ends",
                "decoder_static_axes",
                "decoder_static_steps",
            ],
            &["decoder_static_audio"],
            Vec::new(),
        ),
    ]);
    graph.output[0].name = "decoder_static_audio".to_owned();
    set_tensor_shape(&mut graph.output[0], &[1, 1, 1, max_samples]);
    Ok(())
}

fn set_tensor_shape(value: &mut ValueInfoProto, dimensions: &[i64]) {
    let type_proto = value.type_.mut_or_insert_default();
    let tensor = type_proto.mut_tensor_type();
    let shape = tensor.shape.mut_or_insert_default();
    shape.dim = dimensions
        .iter()
        .map(|dimension| tensor_shape_proto::Dimension {
            value: Some(tensor_shape_proto::dimension::Value::DimValue(*dimension)),
            ..Default::default()
        })
        .collect();
}

fn tensor_f32(name: &str, dimensions: &[i64], count: usize) -> Result<TensorProto> {
    Ok(TensorProto {
        dims: dimensions.to_vec(),
        data_type: tensor_proto::DataType::FLOAT.value(),
        float_data: vec![0.0; count],
        name: name.to_owned(),
        ..Default::default()
    })
}

fn tensor_i64(name: &str, dimensions: &[i64], values: &[i64]) -> TensorProto {
    TensorProto {
        dims: dimensions.to_vec(),
        data_type: tensor_proto::DataType::INT64.value(),
        int64_data: values.to_vec(),
        name: name.to_owned(),
        ..Default::default()
    }
}

fn node(
    name: &str,
    operation: &str,
    inputs: &[&str],
    outputs: &[&str],
    attributes: Vec<AttributeProto>,
) -> NodeProto {
    NodeProto {
        input: inputs.iter().map(|value| (*value).to_owned()).collect(),
        output: outputs.iter().map(|value| (*value).to_owned()).collect(),
        name: name.to_owned(),
        op_type: operation.to_owned(),
        attribute: attributes,
        ..Default::default()
    }
}

fn int_attribute(name: &str, value: i64) -> AttributeProto {
    AttributeProto {
        name: name.to_owned(),
        type_: EnumOrUnknown::new(attribute_proto::AttributeType::INT),
        i: value,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use onnx_protobuf::GraphProto;
    use protobuf::MessageField;

    #[test]
    fn specializes_decoder_shape_and_audio_output() {
        let mut input = ValueInfoProto::new();
        set_tensor_shape(&mut input, &[-1, 192, -1]);
        input.name = "features".to_owned();
        let mut output = ValueInfoProto::new();
        set_tensor_shape(&mut output, &[-1, 1, 1, -1]);
        output.name = "audio".to_owned();
        let graph = GraphProto {
            name: "decoder".to_owned(),
            input: vec![input],
            output: vec![output],
            ..Default::default()
        };
        let mut model = ModelProto {
            graph: MessageField::some(graph),
            ..Default::default()
        };

        make_static(&mut model, 128).unwrap();
        let graph = model.graph.as_ref().unwrap();
        assert_eq!(
            graph.input[0]
                .type_
                .as_ref()
                .unwrap()
                .tensor_type()
                .shape
                .as_ref()
                .unwrap()
                .dim
                .iter()
                .map(|dimension| dimension.dim_value())
                .collect::<Vec<_>>(),
            vec![1, 192, 128]
        );
        assert_eq!(graph.output[0].name, "decoder_static_audio");
        assert_eq!(graph.node.len(), 2);
        assert_eq!(
            graph.output[0]
                .type_
                .as_ref()
                .unwrap()
                .tensor_type()
                .shape
                .as_ref()
                .unwrap()
                .dim
                .last()
                .unwrap()
                .dim_value(),
            128 * 256
        );
    }
}
