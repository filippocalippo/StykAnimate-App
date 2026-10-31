//! Receiver admission uses the same format reader as native containers.
use std::sync::Arc;
use styk_doc::Value;
use styk_formats::container::{ContainerError, MAX_MATERIALIZED_BYTES, parse_lifted, parse_lifted_owned, parse_lifted_owned_within};

fn numbers() -> Vec<u8> { (0..33).flat_map(|index| (index as f64 * 0.125).to_le_bytes()).collect() }

#[test]
fn owned_and_borrowed_records_preserve_aliases_unknown_fields_and_marker_escapes() {
    let skeleton = br#"{"first":"S2B:f64:0:0:33","alias":"S2B:f64:0:0:33","future":{"literal":"S2E:S2B:foreign","payload":"S2S:1:0:3"}}"#;
    let borrowed = parse_lifted(skeleton, &numbers(), &[17, 23, 91]).unwrap();
    let owned = parse_lifted_owned(skeleton.to_vec(), numbers(), vec![17, 23, 91]).unwrap();
    assert_eq!(styk_doc::json::to_string(&borrowed), styk_doc::json::to_string(&owned));
    let (Some(Value::Nums(first)), Some(Value::Nums(alias))) = (owned.get("first"), owned.get("alias")) else { panic!("materialized numeric arrays") };
    assert!(Arc::ptr_eq(first, alias));
    assert_eq!(owned.path(&["future", "literal"]).and_then(Value::as_str), Some("S2B:foreign"));
}

#[test]
fn repeated_marker_expansion_refuses_before_receiver_admission() {
    let skeleton = format!("[{}]", vec!["\"S2B:f64:0:0:33\""; 100].join(","));
    // The global API admits this small record; a tighter stream limit must not.
    assert!(parse_lifted(skeleton.as_bytes(), &numbers(), &[]).is_ok());
    assert!(matches!(parse_lifted_owned_within(skeleton.into_bytes(), numbers(), vec![], 4096), Err(ContainerError::MaterializedTooLarge)));
}

#[test]
fn conservative_number_upper_bounds_do_not_refuse_small_decimal_records() {
    let skeleton = format!("[{}]", vec!["\"S2B:f64:0:0:33\""; 5].join(","));
    let document = parse_lifted_owned_within(skeleton.into_bytes(), numbers(), vec![], 4096).unwrap();
    assert_eq!(document.array_len(), Some(5));
    assert!(styk_doc::json::to_string(&document).len() < 4096);
    assert!(matches!(parse_lifted_owned_within(b"null".to_vec(), vec![], vec![], MAX_MATERIALIZED_BYTES + 1), Err(ContainerError::MaterializedTooLarge)));
}

#[test]
fn repeated_payload_references_are_charged_each_time() {
    let payload = vec![7u8; 60];
    // 60 bytes of payload are 80 bytes of base64 for every reference to them.
    assert!(parse_lifted_owned_within(br#"["S2S:1:0:60"]"#.to_vec(), vec![], payload.clone(), 200).is_ok());
    assert!(matches!(parse_lifted_owned_within(br#"["S2S:1:0:60","S2S:1:0:60"]"#.to_vec(), vec![], payload, 200), Err(ContainerError::MaterializedTooLarge)));
}
