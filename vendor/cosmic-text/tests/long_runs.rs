//! Edits in long text: what is shaped again (the shaped-run cache) and how a pathological train of combining marks is
//! shaped. These tests need a font, any one the system has.

use cosmic_text::*;

fn shape(fs: &mut FontSystem, text: &str) -> Vec<LayoutLine> {
    let attrs = Attrs::new();
    let list = AttrsList::new(&attrs);
    let line = ShapeLine::new(fs, text, &list, Shaping::Advanced, 4, Direction::Auto);
    line.layout(14.0, Some(700.0), Wrap::WordOrGlyph, None, None, Hinting::default())
}

fn glyphs(lines: &[LayoutLine]) -> Vec<(usize, usize, f32)> {
    lines.iter().flat_map(|line| line.glyphs.iter().map(|g| (g.start, g.end, g.w))).collect()
}

fn paragraph(words: usize) -> String {
    (0..words).map(|n| format!("word{n}")).collect::<Vec<_>>().join(" ")
}

#[test]
fn an_edit_in_a_paragraph_shapes_only_the_words_it_touches() {
    let mut fs = FontSystem::new();
    let text = paragraph(2000);
    let _ = shape(&mut fs, &text);
    let after_first = fs.shape_run_cache.misses();
    assert!(after_first >= 2000, "the first layout shapes every word ({after_first})");

    // One more character in the middle of the paragraph.
    let edited = text.replacen("word1000", "word1000x", 1);
    let lines = shape(&mut fs, &edited);
    let reshaped = fs.shape_run_cache.misses() - after_first;
    assert!(reshaped <= 2, "{reshaped} runs were shaped again after a one-character edit (all {} before the cache)", 2000);

    // The cached answer is the answer of shaping from nothing.
    let mut fresh = FontSystem::new();
    assert_eq!(glyphs(&lines), glyphs(&shape(&mut fresh, &edited)));
}

#[test]
fn a_base_with_thousands_of_marks_is_shaped_in_segments_and_an_edit_shapes_one() {
    let mut fs = FontSystem::new();
    let _ = shape(&mut fs, "b");
    let text = format!("a{}", "\u{301}".repeat(5000));
    let before = fs.shape_run_cache.misses();
    let lines = shape(&mut fs, &text);
    let after_first = fs.shape_run_cache.misses();
    // The segments of marks are three runs to the cache: the base with its first marks, the marks that follow in full
    // segments, and the last partial segment.
    assert!(after_first - before <= 3, "{} distinct runs for one train of marks", after_first - before);

    // Every byte of the text belongs to a glyph, in order, with no gap.
    let shaped = glyphs(&lines);
    let mut end = 0;
    for (start, stop, _) in &shaped {
        assert!(*start <= end, "a gap before {start} (covered to {end})");
        end = end.max(*stop);
    }
    assert_eq!(end, text.len());

    let _ = shape(&mut fs, &format!("{text}\u{301}"));
    let reshaped = fs.shape_run_cache.misses() - after_first;
    assert!(reshaped <= 1, "{reshaped} runs were shaped again after one more mark");
}

#[test]
fn the_marks_of_written_text_are_not_cut() {
    // A base with a dozen marks (Zalgo text) is one cluster for the shaper, as it was.
    let mut fs = FontSystem::new();
    let _ = shape(&mut fs, "b");
    let text = format!("a{}", "\u{301}".repeat(12));
    let before = fs.shape_run_cache.misses();
    let lines = shape(&mut fs, &text);
    assert_eq!(fs.shape_run_cache.misses() - before, 1);
    assert_eq!(glyphs(&lines).iter().map(|g| g.1).max(), Some(text.len()));
}

#[test]
fn a_very_long_word_is_shaped_in_chunks_and_an_edit_at_its_end_shapes_one() {
    let mut fs = FontSystem::new();
    let _ = shape(&mut fs, "b");
    let text = "x".repeat(16_300);
    let before = fs.shape_run_cache.misses();
    let lines = shape(&mut fs, &text);
    let first = fs.shape_run_cache.misses() - before;
    assert!(first <= 3, "{first} distinct runs for 16,300 of one letter (one chunk, the partial last one)");

    let edited = format!("{text}b");
    let lines_after = shape(&mut fs, &edited);
    let reshaped = fs.shape_run_cache.misses() - before - first;
    assert!(reshaped <= 2, "{reshaped} runs were shaped again after a character was typed at the end");

    // Every character has a glyph, in order.
    assert_eq!(glyphs(&lines).len(), 16_300);
    assert_eq!(glyphs(&lines_after).len(), 16_301);
    assert_eq!(glyphs(&lines_after).iter().map(|g| g.1).max(), Some(16_301));
}
