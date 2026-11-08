//! Document-sized timeline projection on a bounded worker. No evaluated frame or document mirror reaches a view.
use super::{Card, Exposure, Identity, Layer};
use std::collections::BTreeSet;
use styk_doc::Value;
pub struct Projection {
    pub row_index: std::collections::HashMap<String, usize>,
    pub neighbors: Vec<(usize, usize)>,
    pub identity: Identity,
    pub rows: Vec<Layer>,
    pub cards: Vec<Card>,
    pub total: u32,
    pub fps: f64,
    pub sheet: bool,
    pub audio: crate::audio::AudioState,
    pub audible: bool,
}
fn number(value: Option<&Value>, default: f64) -> f64 {
    value.and_then(Value::as_f64).unwrap_or(default)
}
pub fn project(identity: Identity, report: &Value) -> Projection {
    let timeline = styk_edit::timeline_rows(report);
    let total = timeline.last().map_or(0., |(start, count)| start + count).max(0.) as u32;
    let delay = number(report.get("frame_delay_ms"), 0.);
    let fps = if delay > 0. { 1000. / delay } else { number(report.get("fps"), 24.) };
    let layers = report.path(&["_styk", "layers"]);
    let sheet = report.path(&["_styk", "layerSheet"]);
    let tracks = sheet.and_then(|s| s.get("tracks"));
    let mut keys = BTreeSet::from([0]);
    if let Some(tracks) = tracks.and_then(Value::as_obj) {
        for (_, track) in tracks.iter() {
            if let Some(items) = track.get("keys").and_then(Value::elements) {
                keys.extend(
                    items
                        .iter()
                        .filter_map(|key| key.get("tick").and_then(Value::as_f64))
                        .map(|tick| tick as u32)
                        .filter(|tick| *tick < number(sheet.and_then(|s| s.get("duration")), total as f64) as u32),
                );
            }
        }
    } else {
        keys.extend(timeline.iter().map(|(tick, _)| *tick as u32));
    }
    let ticks: Vec<_> = keys.into_iter().collect();
    let cards =
        ticks.iter().enumerate().map(|(index, &tick)| Card { index, tick, end: ticks.get(index + 1).copied().unwrap_or(total) }).collect();
    let mut ids = vec!["camera".to_string(), "scene".to_string()];
    let mut ordered: Vec<_> = layers
        .and_then(|l| l.get("order"))
        .and_then(Value::elements)
        .map(|order| order.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    ordered.reverse(); // layer-timeline::_reindex displays frontmost first.
    let folder_of = |id: &str| layers.and_then(|l| l.path(&["byId", id, "folderId"])).and_then(Value::as_str);
    let folders = layers.and_then(|l| l.path(&["folders", "byId"])).and_then(Value::as_obj);
    let occupied: BTreeSet<_> = ordered.iter().filter_map(|id| folder_of(id)).collect();
    if let Some(folders) = folders {
        ids.extend(folders.iter().filter(|(id, _)| !occupied.contains::<str>(id)).map(|(id, _)| id.to_string()));
    }
    let mut seen = BTreeSet::new();
    for id in ordered {
        if let Some(folder) = folder_of(&id) {
            if seen.insert(folder.to_string()) {
                ids.push(folder.to_string());
            }
        }
        ids.push(id);
    }
    let mut rows = Vec::new();
    for id in ids {
        let folder = folders.and_then(|folders| folders.get(&id));
        let record = folder.or_else(|| {
            if id == "scene" || id == "camera" {
                layers.and_then(|l| l.path(&["fixed", &id]))
            } else {
                layers.and_then(|l| l.path(&["byId", &id]))
            }
        });
        let depth = usize::from(folder_of(&id).is_some());
        let locked = record.and_then(|r| r.get("locked")).is_some_and(Value::truthy);
        let hidden = record.and_then(|r| r.get("visible")) == Some(&Value::Bool(false));
        let track = tracks.and_then(|t| t.get(&id));
        let mut exposures: Vec<_> = track
            .and_then(|t| t.get("keys"))
            .and_then(Value::elements)
            .map(|keys| {
                keys.iter()
                    .map(|key| Exposure {
                        tick: number(key.get("tick"), 0.) as u32,
                        end: number(track.and_then(|t| t.get("end")), total as f64) as u32,
                        empty: key.get("empty").is_some_and(Value::truthy),
                    })
                    .collect()
            })
            .unwrap_or_default();
        for i in 1..exposures.len() {
            exposures[i - 1].end = exposures[i].tick;
        }
        let name = match id.as_str() {
            "camera" => crate::i18n::Label::key("app.camera"),
            "scene" => crate::i18n::Label::key("app.scene"),
            _ => crate::i18n::Label::plain(record.and_then(|r| r.get("name")).and_then(Value::as_str).unwrap_or(&id)),
        };
        rows.push(Layer { index: rows.len(), name, id, depth, locked, hidden, folder: folder.is_some(), exposures });
    }
    let audio = crate::audio::AudioState::from_document(report).unwrap_or_default();
    let audible = !audio.audible_clips().is_empty();
    let row_index = rows.iter().enumerate().map(|(i, row)| (row.id.clone(), i)).collect();
    let mut neighbors = vec![(0, 0); rows.len()];
    let mut previous = None;
    for (i, row) in rows.iter().enumerate() {
        neighbors[i].0 = previous.unwrap_or(i);
        if !row.folder {
            previous = Some(i);
        }
    }
    let mut next = None;
    for (i, row) in rows.iter().enumerate().rev() {
        neighbors[i].1 = next.unwrap_or(i);
        if !row.folder {
            next = Some(i);
        }
    }
    Projection { row_index, neighbors, identity, rows, cards, total, fps, sheet: sheet.is_some(), audio, audible }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frontmost_layers_and_separate_folders_match_the_legacy_row_contract() {
        let report = styk_doc::json::parse(br#"{"fps":24,"keyframes":[],"_styk":{"layers":{"order":["back","middle","front"],"byId":{"back":{"name":"Back"},"middle":{"name":"Middle","folderId":"group","visible":false},"front":{"name":"Front","folderId":"group","locked":true}},"folders":{"byId":{"empty":{"name":"Empty"},"group":{"name":"Group"}}}}}}"#).unwrap();
        let rows = project(Identity { document: crate::identity::DocumentId::preview(1), lineage: 1, revision: 0 }, &report);
        assert_eq!(
            rows.rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            ["camera", "scene", "empty", "group", "front", "middle", "back"]
        );
        assert!(rows.rows[2].folder && rows.rows[3].folder);
        assert_eq!(rows.rows[4].depth, 1);
        assert!(rows.rows[4].locked);
        assert!(rows.rows[5].hidden);
        assert_eq!(rows.neighbors[1].1, 4);
        assert_eq!(rows.neighbors[4].0, 1);
        assert_eq!(rows.neighbors[6].1, 6);
    }
}
