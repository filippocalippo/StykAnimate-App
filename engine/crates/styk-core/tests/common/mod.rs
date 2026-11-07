//! Helpers the pen parity and save tests share: tile hashes, settling the worker, and the engine's own save and open.

use sha2::{Digest, Sha256};
use std::time::Duration;
use styk_core::drawing::worker::{Reply, Request, Worker};
use styk_doc::{Value, json};
use styk_drawing::codec::{EncodedTile, TileEncoder, assemble_tile_blob, decode_tile_blob};
use styk_formats::container::{self, Kind};
use styk_formats::files;

pub fn hashes(worker: &Worker, token: u64) -> Vec<(i64, i64, String)> {
    worker.send(Request::Snapshot { token });
    loop {
        match worker.wait(Duration::from_secs(30)).expect("the worker answers") {
            Reply::Tiles { seq, .. } => worker.ack(seq),
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
            Reply::Tiles { seq, .. } => worker.ack(seq),
            _ => {}
        }
    }
}

/// The cel through the engine's own save and open: its tiles encoded by the drawing codec into the blob a document carries,
/// the document written as a `.styk` container and read back by the file layer, and the tiles decoded from what came out.
pub fn save_and_reopen(saved: &[(i64, i64, Vec<u8>)]) -> Vec<(i64, i64, String)> {
    let mut encoder = TileEncoder::new();
    let tiles: Vec<EncodedTile> = saved.iter().map(|(tx, ty, pixels)| EncodedTile { tx: *tx as i32, ty: *ty as i32, png: encoder.encode(pixels) }).collect();
    let blob = assemble_tile_blob(&tiles).expect("the tiles assemble into a blob");
    let mut base64 = Vec::new();
    json::base64_into(&blob, &mut base64);
    let text = format!("{{\"version\":5,\"keyframes\":[],\"image_assets\":[{{\"styk_tiles\":\"data:application/x-styk-tiles;base64,{}\"}}]}}", String::from_utf8(base64).unwrap());
    let document = json::parse(text.as_bytes()).expect("the document is JSON");
    let file = container::encode_v2(&container::lift(&document, &[]).expect("the document lifts"), Kind::Styk).expect("the container is written");
    let reopened = files::open_document(&file, Kind::Styk).expect("the saved document opens");
    let asset = reopened.get("image_assets").and_then(|assets| assets.item(0)).expect("the asset survives");
    let bytes = asset.get("styk_tiles").and_then(Value::payload_bytes).expect("the tile blob survives");
    let mut rows: Vec<(i64, i64, String)> = decode_tile_blob(&bytes, None, 1e12).expect("the blob decodes").iter().map(|t| (t.tx as i64, t.ty as i64, hex(&Sha256::digest(&t.pixels[..])))).collect();
    rows.sort_by_key(|r| (r.1, r.0));
    rows
}

