//! The typed document the editor keeps up to date across edits (one `Loader`, each revision converting only the records the edit replaced) is
//! the document a loader that never saw the others makes of the same report. A replay of a recorded scenario (`replay.rs`) checks it after
//! every step, undo and redo included.

use crate::Editor;
use std::sync::Arc;
use styk_eval::eval::Prepared;
use styk_eval::load::Loader;

/// What the document holds that a rebuild could get wrong, in a form that compares: the sheet's tracks by layer, and for each pose whether it
/// has effects.
fn summary(prepared: &Prepared) -> String {
    let doc = &prepared.doc;
    let mut out = format!("ticks {} vfx {} keyframes {}\n", prepared.total_ticks, prepared.has_vfx, doc.keyframes.len());
    out += &format!("poses with effects {:?}\n", doc.keyframes.iter().map(|frame| frame.has_vfx).collect::<Vec<_>>());
    let mut sources: Vec<_> = doc.frame_sources.iter().map(|(id, frame)| (id.to_string(), frame.has_vfx, frame.objects.len())).collect();
    sources.sort();
    out += &format!("sources {sources:?}\n");
    if let Some(sheet) = &doc.sheet {
        out += &format!("sheet duration {}\n", sheet.duration);
        let mut tracks: Vec<_> = sheet.tracks.iter().collect();
        tracks.sort_by(|a, b| a.0.cmp(b.0));
        for (id, track) in tracks {
            out += &format!("track {id} {track:?}\n");
        }
    }
    out
}

/// `Err` names what differs between the document the editor keeps and the one made whole of its report. The editor's own chain is followed:
/// the document is brought up to date here as the shown frame does, so each revision is converted over the one before it.
pub(crate) fn rebuilt_whole(editor: &Editor) -> Result<(), String> {
    let Ok(kept) = editor.prepared() else { return Ok(()) };
    let Ok(document) = Loader::new().document(editor.report(), "") else { return Ok(()) };
    let whole = Prepared::new(Arc::new(document));
    let (kept, whole) = (summary(&kept), summary(&whole));
    if kept == whole {
        return Ok(());
    }
    let at = kept.bytes().zip(whole.bytes()).position(|(a, b)| a != b).unwrap_or(kept.len().min(whole.len()));
    let from = kept.floor_char_boundary(at.saturating_sub(100));
    Err(format!("the document kept across edits differs from the one made whole at byte {at}: kept …{}… whole …{}…", &kept[from..kept.floor_char_boundary((at + 100).min(kept.len()))], &whole[whole.floor_char_boundary(from.min(whole.len()))..whole.floor_char_boundary((at + 100).min(whole.len()))]))
}
