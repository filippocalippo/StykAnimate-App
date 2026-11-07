//! Helpers the pen parity and save tests share: tile hashes, settling the worker, and the engine's own document, save and open.

use sha2::{Digest, Sha256};
use std::time::Duration;
use styk_core::drawing::worker::{Reply, Request, Worker};
use styk_doc::{Value, json};
use styk_drawing::codec::{EncodedTile, TileEncoder, assemble_tile_blob, decode_tile_blob};
use styk_edit::session::Session;
use styk_formats::container::{self, Kind};
use styk_formats::files;

pub fn hashes(worker: &Worker, token: u64) -> Vec<(i64, i64, String)> {
    worker.send(Request::Snapshot { token });
    loop {
        match worker.wait(Duration::from_secs(30)).expect("the worker answers") {
            Reply::Tiles { seq, last: true, .. } => worker.ack(seq),
            Reply::Snapshot { tiles, .. } => {
                let mut rows: Vec<(i64, i64, String)> = tiles.iter().map(|(tx, ty, pixels)| (*tx, *ty, hex(&Sha256::digest(pixels)))).collect();
                rows.sort_by_key(|r| (r.1, r.0));
                return rows;
            }
            _ => {}
        }
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn settle(worker: &Worker) {
    worker.send(Request::Ping { token: 9 });
    loop {
        match worker.wait(Duration::from_secs(60)).expect("the worker answers") {
            Reply::Pong { .. } => return,
            Reply::Tiles { seq, last: true, .. } => worker.ack(seq),
            _ => {}
        }
    }
}

/// Where a cel sits in the document: the object record's placement. `scale` is world units a pixel covers.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pose {
    pub root: (f64, f64),
    pub scale: f64,
    pub angle: f64,
}

impl Pose {
    /// The pose a mapping's pixel matrix (`[a, b, c, d, e, f]`, pixels to world) stands for: a turn and a uniform scale.
    pub fn of_matrix(m: [f64; 6]) -> Pose {
        Pose { root: (m[4], m[5]), scale: styk_math::hypot(m[0], m[1]), angle: styk_math::atan2(m[1], m[0]) }
    }
}

const CEL: &str = "cel-pen";
const FIGURE: &str = r#"{"figure_type_id":2,"name":"Drawing","segment_count":1,"segments":[{"segment_id":1,"parent_id":0,"length":256,"angle_rad":0,"thickness":0,"bend_rad":0,"primitive_code":2,"aux_code":0,"flags":2,"segment_type":"image","segment_kind":"image","color_rgb":[0,0,0],"transparency":0,"extra_u16":0,"extra_u8_a":0,"extra_u8_b":0,"extra":[0,0,0],"visible":true,"z_order":1}],"polyfills":[],"image_assets":[{"kind":"image","asset_index":0,"table_index":0,"mime_type":"image/png","width":1,"height":1,"data_url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=","anchor_start":{"x":0,"y":0},"anchor_end":{"x":256,"y":0},"anchor_length":256,"anchor_angle_rad":0,"display_width":1,"display_height":1,"drawing_anchor":{"x":0,"y":0}}],"text_assets":[],"_styk":{"sourceName":"Drawing","drawing":{"version":2,"celId":"cel-pen","pixelsPerUnit":1,"revision":0,"bounds":null}}}"#;
const UID: f64 = 2.0;
const DRAWS: &str = r#"[["uuid","11111111-2222-4333-8444-555555555555"],["uuid","66666666-2222-4333-8444-555555555555"]]"#;

fn parse(text: &str) -> Value {
    json::parse(text.as_bytes()).expect("JSON")
}

/// A document session as the owner makes calls on it: the view of the last answer goes with the next call.
struct Open {
    session: Session,
    view: Value,
}

impl Open {
    /// The first document of a recorded tape, in a session with the history sized as the app sizes it.
    fn start() -> Open {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/startup-sheet.reference.json");
        let reference = parse(&std::fs::read_to_string(file).expect("the recorded document reads"));
        let first = reference.get("steps").and_then(|s| s.item(0)).expect("a first step");
        let mut state = first.get("state").and_then(Value::as_obj).expect("a state").clone();
        for (key, value) in reference.get("editor").and_then(Value::as_obj).expect("an editor").iter() {
            state.set(key, value.clone());
        }
        let view = Value::object(state);
        let document = parse(first.get("document").and_then(Value::as_str).expect("the document text"));
        Open::over(document, view)
    }

    fn over(document: Value, view: Value) -> Open {
        let session = Session::start(document, &json::to_string(&view)).expect("the session starts on the document");
        Open { session, view }
    }

    fn call(&mut self, method: &str, args: &str) -> Value {
        let mut view = self.view.as_obj().expect("a view").clone();
        view.set("patch", Value::Bool(true));
        view.set("changesOnly", Value::Bool(true));
        view.set("draws", parse(DRAWS));
        view.set("drawPool", Value::Bool(true));
        let answer = parse(&self.session.call(method, args, &json::to_string(&Value::object(view))));
        assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{method}: {}", json::to_string(&answer));
        if let Some(state) = answer.get("state").filter(|s| s.is_object()) {
            let mut next = self.view.as_obj().expect("a view").clone();
            for (key, value) in state.as_obj().expect("an object").iter() {
                next.set(key, value.clone());
            }
            self.view = Value::object(next);
        }
        answer
    }

    /// The definition of the cel the document holds.
    fn cel(&self) -> Option<Value> {
        let figures = self.session.report().get("figure_types")?.elements()?;
        figures.into_iter().find(|f| f.path(&["_styk", "drawing", "celId"]).and_then(Value::as_str) == Some(CEL))
    }
}

/// Every object record with the unique identity `uid` anywhere in `value`.
fn objects_with(value: &Value, uid: f64, out: &mut Vec<Value>) {
    if let Some(object) = value.as_obj() {
        if object.get("unique_id").and_then(Value::as_f64) == Some(uid) && object.get("root_x").is_some() {
            out.push(value.clone());
        }
        for (_, child) in object.iter() {
            objects_with(child, uid, out);
        }
    } else if let Some(items) = value.elements() {
        for item in items {
            objects_with(&item, uid, out);
        }
    }
}

/// What a saved and reopened document holds of one drawing layer.
#[derive(Debug)]
pub struct Reopened {
    /// The hashes of the cel's tiles as the reopened document's published blob decodes them.
    pub tiles: Vec<(i64, i64, String)>,
    /// The placement of the cel's object record.
    pub pose: Pose,
    /// The layer's track in the reopened document holds a key that shows the cel's object.
    pub layer_shows_cel: bool,
}

/// The cel through the engine's own document, save and open: a drawing layer made by the editing session, the stroke committed as the
/// session's one pixel entry, the cel published with its tiles encoded by the drawing codec, the document written as a `.styk`
/// container and read back by the file layer, a session started on what came out (which validates every drawing and the layer sheet),
/// and the tiles, the pose and the layer read from that session.
pub fn save_and_reopen_document(saved: &[(i64, i64, Vec<u8>)], pose: Pose) -> Reopened {
    let mut open = Open::start();
    let layer = open.call("createDrawingLayer", r#"["Ink"]"#).get("result").and_then(|r| r.get("id")).and_then(Value::as_str).expect("the layer").to_string();
    let key = open.session.report().path(&["_styk", "layerSheet", "tracks", &layer, "keys"]).and_then(|k| k.item(0)).and_then(|k| k.get("id").and_then(Value::as_str).map(str::to_string)).expect("the layer's key");
    let object = format!(
        r#"{{"object_slot":0,"unique_id":{UID},"figure_type_id":2,"root_x":{},"root_y":{},"scale":{},"color_override_raw":0,"field28":0,"angles":[{}],"len_flag":0,"lengths":[],"bend_flag":0,"bends":[],"join":null}}"#,
        pose.root.0, pose.root.1, pose.scale, pose.angle
    );
    let stroke = format!(r#"[{{"id":"{layer}","tick":0,"keyId":"{key}","celId":"{CEL}","created":true,"selectable":true,"figure":{FIGURE},"object":{object}}},{{"record":7,"bytes":1000}},"Brush stroke"]"#);
    let answer = open.call("commitDrawingPixels", &stroke);
    assert_eq!(answer.get("result"), Some(&Value::Bool(true)));
    assert!(open.cel().is_some(), "the stroke created the cel in the document");

    // The drawing store finished the cel: its tiles, encoded by the drawing codec, are the figure's published blob.
    let mut encoder = TileEncoder::new();
    let tiles: Vec<EncodedTile> = saved.iter().map(|(tx, ty, pixels)| EncodedTile { tx: *tx as i32, ty: *ty as i32, png: encoder.encode(pixels) }).collect();
    let blob = assemble_tile_blob(&tiles).expect("the tiles assemble into a blob");
    let mut base64 = Vec::new();
    json::base64_into(&blob, &mut base64);
    let mut definition = open.cel().expect("the cel");
    definition.make_obj().and_then(|f| f.get_mut("image_assets")).and_then(Value::make_arr).and_then(|a| a.get_mut(0)).and_then(Value::make_obj).expect("the carrier sprite").set("styk_tiles", Value::str(&format!("data:application/x-styk-tiles;base64,{}", String::from_utf8(base64).unwrap())));
    let published = open.call("@publishCel", &format!("[\"{CEL}\",{}]", json::to_string(&definition)));
    assert_eq!(published.get("result"), Some(&Value::Bool(true)));

    let file = container::encode_v2(&container::lift(open.session.report(), &[]).expect("the document lifts"), Kind::Styk).expect("the container is written");
    let reopened = files::open_document(&file, Kind::Styk).expect("the saved document opens");
    let after = Open::over(reopened, open.view.clone());

    let cel = after.cel().expect("the cel survives the save and open");
    let asset = cel.get("image_assets").and_then(|a| a.item(0)).expect("the carrier sprite survives");
    let bytes = asset.get("styk_tiles").and_then(Value::payload_bytes).expect("the tile blob survives");
    let mut rows: Vec<(i64, i64, String)> = decode_tile_blob(&bytes, None, 1e12).expect("the blob decodes").iter().map(|t| (t.tx as i64, t.ty as i64, hex(&Sha256::digest(&t.pixels[..])))).collect();
    rows.sort_by_key(|r| (r.1, r.0));
    let mut found = Vec::new();
    objects_with(after.session.report(), UID, &mut found);
    let placed = found.first().expect("the cel's object survives");
    let number = |key: &str| placed.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN);
    let angle = placed.get("angles").and_then(|a| a.item(0)).and_then(|v| v.as_f64()).unwrap_or(f64::NAN);
    let track = after.session.report().path(&["_styk", "layerSheet", "tracks", &layer, "keys"]).and_then(|k| k.item(0));
    let layer_shows_cel = track.is_some_and(|k| k.get("id").and_then(Value::as_str) == Some(key.as_str())) && found.iter().all(|o| o.get("figure_type_id") == cel.get("figure_type_id"));
    Reopened { tiles: rows, pose: Pose { root: (number("root_x"), number("root_y")), scale: number("scale"), angle }, layer_shows_cel }
}
