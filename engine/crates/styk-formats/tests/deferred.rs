//! A container read with its work shared out is the container read in order: the same document, and for a damaged file the same
//! error, whichever piece the damage is in (`container::decode_deferred`).
use std::sync::Arc;

use styk_doc::fanout::{Fanout, Sequential, StdThreads};
use styk_doc::{Blob, Obj, Value, json};
use styk_formats::container::{ContainerError, Kind, decode, decode_deferred, encode_v2, lift};

/// A project of `frames` keyframes, each with a pose array that is stored in a section and one that is shared between frames,
/// and a picture: big enough to be shared out (the skeleton is over a megabyte).
fn project(frames: usize) -> Value {
    let shared = Value::nums(&(0..64).map(|n| n as f64 * 0.5).collect::<Vec<_>>());
    let mut keyframes = Vec::new();
    for index in 0..frames {
        let mut frame = Obj::new();
        frame.set("duration_raw", Value::Num(1.0));
        frame.set("note", Value::str(&format!("frame {index} \"quoted\" ] }} {{ \\ {}", "x".repeat(60))));
        frame.set("pose", Value::nums(&(0..40).map(|n| (index * 40 + n) as f64 + 0.25).collect::<Vec<_>>()));
        frame.set("shared", shared.clone());
        frame.set("objects", Value::array(vec![Value::object({ let mut o = Obj::new(); o.set("unique_id", Value::Num(index as f64)); o.set("pad", Value::str(&"p".repeat(80))); o })]));
        keyframes.push(Value::object(frame));
    }
    let mut figure = Obj::new();
    figure.set("figure_type_id", Value::Num(1.0));
    figure.set("image", Value::Blob(Arc::new(Blob { prefix: Arc::from("data:image/png;base64,"), bytes: Arc::from((0..70_000u32).map(|n| (n % 251) as u8).collect::<Vec<_>>()) })));
    let mut root = Obj::new();
    root.set("version", Value::Num(5.0));
    root.set("keyframes", Value::array(keyframes));
    root.set("figure_types", Value::array(vec![Value::object(figure)]));
    Value::object(root)
}

fn file(document: &Value) -> Vec<u8> {
    encode_v2(&lift(document, &[]).unwrap(), Kind::Styk).unwrap()
}

/// What a read comes to, as text: the document, or the error.
fn in_order(bytes: &[u8]) -> Result<String, ContainerError> {
    decode(bytes, Kind::Styk).map(|decoded| json::to_string(&decoded.document))
}

fn deferred(bytes: &[u8], fan: &dyn Fanout) -> Result<String, ContainerError> {
    let (decoded, check) = decode_deferred(bytes, Kind::Styk, fan)?;
    check.finish(fan)?;
    Ok(json::to_string(&decoded.document))
}

#[test]
fn a_big_project_reads_to_the_document_it_reads_to_in_order() {
    let document = project(6000);
    let bytes = file(&document);
    let expected = in_order(&bytes).unwrap();
    assert_eq!(expected, json::to_string(&document));
    for threads in [2, 4, 7] {
        assert_eq!(deferred(&bytes, &StdThreads(threads)).as_ref(), Ok(&expected), "{threads} threads");
    }
    assert_eq!(deferred(&bytes, &Sequential).as_ref(), Ok(&expected));
    // The pose arrays the frames share are one array in the document read in pieces too.
    let (decoded, check) = decode_deferred(&bytes, Kind::Styk, &StdThreads(4)).unwrap();
    check.finish(&StdThreads(4)).unwrap();
    let shared: Vec<*const styk_doc::Nums> = decoded.document.get("keyframes").unwrap().as_arr().unwrap().iter().map(|frame| match frame.get("shared") {
        Some(Value::Nums(nums)) => Arc::as_ptr(nums),
        other => panic!("{other:?}"),
    }).collect();
    assert!(shared.windows(2).all(|pair| pair[0] == pair[1]), "an array the file stores once is one array");
}

#[test]
fn a_damaged_project_is_refused_the_way_it_is_in_order() {
    let bytes = file(&project(6000));
    let sections = u32::from_le_bytes(bytes[56..60].try_into().unwrap()) as usize;
    let stored = u64::from_le_bytes(bytes[16..24].try_into().unwrap()) as usize;
    let skeleton_end = 56 + 4 + stored;
    let table = skeleton_end..skeleton_end + sections * 64;
    let mut damaged: Vec<(&str, Vec<u8>)> = Vec::new();
    let mut flip = |name: &'static str, at: usize| {
        let mut copy = bytes.clone();
        copy[at] ^= 0x5a;
        damaged.push((name, copy));
    };
    flip("the skeleton's checksum", 30);
    flip("the skeleton's frame", 56 + 4 + stored / 2);
    flip("the first section's checksum", table.start + 30);
    flip("the first section's frame", table.end + 5);
    flip("the last byte", bytes.len() - 1);
    flip("the section count", 56);
    flip("the header's version", 4);
    damaged.push(("a file cut short", bytes[..bytes.len() - 100].to_vec()));
    damaged.push(("a file with bytes after it", [bytes.clone(), vec![0, 1, 2]].concat()));
    // Both the skeleton and a section damaged: the skeleton's error is the file's.
    let mut both = bytes.clone();
    both[30] ^= 1;
    both[table.start + 30] ^= 1;
    damaged.push(("the skeleton's checksum and a section's", both));
    for (name, copy) in damaged {
        let expected = in_order(&copy);
        assert!(expected.is_err(), "{name} is damaged");
        for threads in [2, 5] {
            assert_eq!(deferred(&copy, &StdThreads(threads)), expected, "{name}, {threads} threads");
        }
    }
}

#[test]
fn a_string_that_looks_like_a_marker_is_the_string_it_is_whether_or_not_the_skeleton_is_read_in_pieces() {
    // The writer escapes it; the reader gives it back.
    let mut document = project(6000);
    let frames = document.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap();
    frames[3000].make_obj().unwrap().set("bad", Value::str("S2B:f32:0:99999999:4"));
    let bytes = file(&document);
    let expected = in_order(&bytes);
    assert!(expected.is_ok());
    for threads in [2, 4] {
        assert_eq!(deferred(&bytes, &StdThreads(threads)), expected);
    }
}
