use serde_json::{json, Value};

pub fn encode_packet(value: &Value, maximum: usize) -> Option<Vec<u8>> {
    let bytes = serde_json::to_vec(value).ok()?;
    if bytes.len() <= maximum {
        return Some(bytes);
    }
    if value["type"] != "response" {
        return None;
    }
    let id = value["requestId"].as_str()?;
    let bounded = serde_json::to_vec(
        &json!({"type":"response","requestId":id,"error":{"_tag":"ResultTooLarge"}}),
    )
    .ok()?;
    (bounded.len() <= maximum).then_some(bounded)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oversized_response_returns_correlated_error_without_crashing_transport() {
        let value = json!({"type":"response","requestId":"r","result":{"data":"é".repeat(256)}});
        let encoded = encode_packet(&value, 128).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&encoded).unwrap(),
            json!({"type":"response","requestId":"r","error":{"_tag":"ResultTooLarge"}})
        );
        assert!(encoded.len() <= 128);
        assert!(encode_packet(&json!({"type":"status","data":"x".repeat(256)}), 128).is_none());
    }
}
