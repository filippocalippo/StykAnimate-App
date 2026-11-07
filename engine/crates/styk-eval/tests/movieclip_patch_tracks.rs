//! The pose track of a figure a movieclip replaces is made when a tweened sample asks for it (the movieclip fixtures' parity tests read every frame), not for every figure the sheet replaces when
//! the document is prepared, and figures replaced the same way share it: a clip of every figure of a project replaces thousands, each with a track as long as the layer's (a clip of
//! 18,141 replaced figures on a 590-key layer held 900 MiB of them, none of which a frame ever read).
use std::path::Path;

fn prepared(name: &str) -> styk_eval::eval::Prepared {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/eval");
    let tree = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.json"))).unwrap()).unwrap();
    styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap())
}

#[test]
fn figures_replaced_the_same_way_share_one_track_made_only_when_a_frame_asks_for_it() {
    let prepared = prepared("movieclip-joined");
    let (replaced, made, distinct) = prepared.patch_tracks();
    assert!(replaced > 0, "the document replaces figures with a movieclip's frames");
    assert!(made <= replaced);
    assert!(distinct <= made, "no figure has a track of its own that another does not share when it is replaced the same way: {replaced} replaced, {made} asked, {distinct} different");
    println!("{replaced} replaced, {made} asked for a track, {distinct} different tracks");
}
