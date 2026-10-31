//! A document lifted piece by piece (`ViewLifter`) is the document lifted whole: the same markers, the same
//! section bytes in the same places, and what several pieces share is written once.
use styk_doc::json;
use styk_doc::{Obj, Value};
use styk_formats::container::{ViewLifter, lift};

fn numbers(seed: usize) -> Value {
    let values: Vec<String> = (0..40).map(|i| format!("{}", (i * seed) as f64 * 0.5)).collect();
    json::parse(format!("[{}]", values.join(",")).as_bytes()).unwrap()
}

/// The document of the tests: three records, the second and third holding the same array, and an image only the third has.
fn document() -> Value {
    let shared = numbers(3);
    let record = |own: Value, shared: Option<&Value>, image: Option<&str>| {
        let mut object = Obj::new();
        object.set("own", own);
        if let Some(shared) = shared {
            object.set("shared", shared.clone());
        }
        if let Some(image) = image {
            object.set("data_url", json::parse(format!("\"{image}\"").as_bytes()).unwrap());
        }
        Value::object(object)
    };
    let image = format!("data:image/png;base64,{}", "AAAA".repeat(20_000));
    let mut root = Obj::new();
    root.set("records", Value::array(vec![record(numbers(1), None, None), record(numbers(2), Some(&shared), None), record(numbers(5), Some(&shared), Some(&image))]));
    Value::object(root)
}

#[test]
fn pieces_name_what_they_share_with_the_same_marker_and_write_it_once() {
    let document = document();
    let whole = lift(&document, &[]).unwrap();
    let records = document.get("records").unwrap().elements().unwrap();
    let mut lifter = ViewLifter::new();
    let parts: Vec<_> = records.iter().map(|record| lifter.part(&record, "").unwrap()).collect();
    // The pieces' bytes laid end to end at their bases are the whole's sections.
    let mut arrays = Vec::new();
    let mut payloads = Vec::new();
    for part in &parts {
        assert_eq!(part.arrays_base, arrays.len());
        assert_eq!(part.payloads_base, payloads.len());
        arrays.extend_from_slice(&part.arrays);
        payloads.extend_from_slice(&part.payloads);
    }
    assert_eq!(arrays, whole.arrays);
    assert_eq!(payloads, whole.payloads);
    // The skeletons are the whole's, record by record.
    let wanted = json::parse(&whole.skeleton).unwrap();
    for (part, record) in parts.iter().zip(wanted.get("records").unwrap().elements().unwrap().iter()) {
        assert_eq!(json::parse(&part.skeleton).unwrap(), record);
    }
    // The array the second and third records share is written with the second and only named by the third.
    assert!(!parts[1].arrays.is_empty());
    assert!(parts[2].arrays.len() < parts[1].arrays.len() * 2, "the shared array is not written again");
    let shared = |part: &styk_formats::container::ViewPart| json::parse(&part.skeleton).unwrap().get("shared").unwrap().as_str().unwrap().to_string();
    assert_eq!(shared(&parts[1]), shared(&parts[2]));
    assert!(parts[2].payloads_base == 0 && !parts[2].payloads.is_empty());
}

#[test]
fn pose_channels_that_share_their_keys_name_one_sequence() {
    let keys = json::parse(br#"[{"id":"a","tick":0,"value":{"frameId":"f1"}},{"id":"b","tick":4,"value":{"frameId":"f2"}}]"#).unwrap();
    let channel = |id: &str, keys: &Value| {
        let mut object = Obj::new();
        object.set("id", Value::str(id));
        object.set("property", Value::str("pose"));
        object.set("keys", keys.clone());
        Value::object(object)
    };
    // The channels of two animations hold the same sequence; a third holds another with equal content.
    let other = json::parse(&json::to_string(&keys).into_bytes()).unwrap();
    let mut first = Obj::new();
    first.set("channels", Value::array(vec![channel("one", &keys), channel("two", &keys), channel("three", &other)]));
    let mut second = Obj::new();
    second.set("channels", Value::array(vec![channel("four", &keys)]));
    // A name that looks like a sequence marker is a name.
    second.set("name", Value::str("S2R:0"));
    let mut lifter = ViewLifter::new();
    let one = lifter.part(&Value::object(first), "").unwrap();
    let two = lifter.part(&Value::object(second), "").unwrap();
    let skeleton = std::str::from_utf8(&one.skeleton).unwrap();
    assert_eq!(skeleton.matches("\"keys\":\"S2R:0\"").count(), 2, "{skeleton}");
    assert!(skeleton.contains("\"keys\":\"S2R:1\""), "an equal sequence that is not the same array is another one: {skeleton}");
    let defined = json::parse(&one.sequences).unwrap();
    assert_eq!(defined.elements().unwrap().len(), 2);
    assert_eq!(defined.item(0).unwrap().get("id").and_then(Value::as_f64), Some(0.0));
    assert_eq!(defined.item(0).unwrap().get("v").unwrap(), &keys);
    let later = std::str::from_utf8(&two.skeleton).unwrap();
    assert!(later.contains("\"keys\":\"S2R:0\""), "a later piece names the sequence an earlier one defined: {later}");
    assert!(two.sequences.is_empty(), "and defines nothing again");
    assert!(later.contains("\"name\":\"S2E:S2R:0\""), "{later}");
}

fn picture(prefix: &str, size: usize) -> Value {
    Value::Blob(std::sync::Arc::new(styk_doc::Blob { prefix: std::sync::Arc::from(prefix), bytes: std::sync::Arc::from((0..size).map(|i| (i % 251) as u8).collect::<Vec<u8>>()) }))
}

#[test]
fn a_picture_the_tree_holds_is_named_by_token_and_its_bytes_stay_out_of_the_piece() {
    let mut asset = Obj::new();
    asset.set("data_base64", picture("", 60_000));
    asset.set("data_url", picture("data:image/png;base64,", 60_000));
    asset.set("small", picture("", 100));
    asset.set("name", Value::str("S2P:not a token"));
    let record = Value::object(asset);
    let part = ViewLifter::new().part(&record, "").unwrap();
    assert!(part.payloads.is_empty(), "no picture bytes are copied out");
    let skeleton = json::parse(&part.skeleton).unwrap();
    let token = |key: &str| skeleton.get(key).and_then(Value::as_str).unwrap().strip_prefix("S2P:").unwrap().parse::<u64>().unwrap();
    assert_ne!(token("data_base64"), token("data_url"), "each blob has its own token");
    assert_eq!(styk_doc::payload::text(token("data_base64")).unwrap(), record.get("data_base64").unwrap().text().unwrap());
    assert_eq!(styk_doc::payload::text(token("data_url")).unwrap(), record.get("data_url").unwrap().text().unwrap());
    assert!(!skeleton.get("small").unwrap().as_str().unwrap().starts_with("S2P:"), "a small picture stays in the skeleton");
    assert_eq!(skeleton.get("name").unwrap().as_str(), Some("S2E:S2P:not a token"), "a name that looks like a token is a name");
}

#[test]
fn a_file_still_lifts_the_same_picture_into_its_payload_section() {
    let mut asset = Obj::new();
    asset.set("data_base64", picture("", 60_000));
    let lifted = lift(&Value::object(asset), &[]).unwrap();
    assert_eq!(lifted.payloads.len(), 60_000);
    assert!(String::from_utf8_lossy(&lifted.skeleton).contains("S2S:1:0:60000"));
}
