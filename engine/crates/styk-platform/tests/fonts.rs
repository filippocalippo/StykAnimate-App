//! The installed-font walk: containment, limits, cancellation, collections, and the same face list as today's service.

use std::cell::Cell;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use styk_platform::fonts::SystemFonts;
use styk_services::fonts::{FontError, FontFace, FontId, FontService};

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Scratch {
        let path = std::env::temp_dir().join(format!("styk-fonts-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Scratch(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn noto(style: &str) -> Vec<u8> {
    fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../../vendor/text/NotoSans-{style}.ttf"))).unwrap()
}

fn never() -> bool {
    false
}

fn families(list: &[FontFace]) -> Vec<String> {
    list.iter().map(|f| format!("{} / {}", f.family, f.style)).collect()
}

/// Directory links: a junction on Windows (no privilege needed), a symlink elsewhere.
fn link_dir(target: &Path, link: &Path) -> bool {
    #[cfg(windows)]
    {
        Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().map(|o| o.status.success()).unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
}

#[test]
fn lists_valid_fonts_with_their_names_and_reads_them_back_unchanged() {
    let scratch = Scratch::new("list");
    let folder = scratch.0.join("Fonts");
    fs::create_dir_all(folder.join("sub")).unwrap();
    fs::write(folder.join("NotoSans-Regular.ttf"), noto("Regular")).unwrap();
    fs::write(folder.join("sub").join("bold.TTF"), noto("Bold")).unwrap();
    fs::write(folder.join("readme.txt"), b"not a font").unwrap();
    fs::write(folder.join("broken.otf"), b"OTTO not really").unwrap();
    let fonts = SystemFonts::with_directories(vec![folder.clone()]);
    let list = fonts.list(&never).unwrap();
    assert_eq!(families(&list), ["Noto Sans / Bold", "Noto Sans / Regular"]);
    assert!(list.iter().all(|f| !f.collection && f.id.as_str().len() == 37));
    assert_eq!(fonts.stats().candidates, 3);
    assert_eq!(fonts.stats().skipped, 1);
    let regular = list.iter().find(|f| f.style == "Regular").unwrap();
    assert_eq!(&*fonts.read(&regular.id, &never).unwrap(), noto("Regular").as_slice());
    // The second read answers from the cache.
    assert_eq!(&*fonts.read(&regular.id, &never).unwrap(), noto("Regular").as_slice());
    assert_eq!(fonts.read(&FontId::parse("font_00000000000000000000000000000000").unwrap(), &never), Err(FontError::Unavailable));
}

#[test]
fn a_link_that_leaves_the_font_folders_is_not_followed() {
    let scratch = Scratch::new("escape");
    let folder = scratch.0.join("Fonts");
    let outside = scratch.0.join("Outside");
    fs::create_dir_all(&folder).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("Escaped.ttf"), noto("Italic")).unwrap();
    fs::write(folder.join("Inside.ttf"), noto("Regular")).unwrap();
    assert!(link_dir(&outside, &folder.join("link")), "the test needs to create a directory link");
    let fonts = SystemFonts::with_directories(vec![folder.clone()]);
    let list = fonts.list(&never).unwrap();
    assert_eq!(families(&list), ["Noto Sans / Regular"], "the font behind the link must not be listed");
}

#[test]
fn a_link_that_stays_inside_is_followed_once() {
    let scratch = Scratch::new("inside");
    let folder = scratch.0.join("Fonts");
    fs::create_dir_all(folder.join("real")).unwrap();
    fs::write(folder.join("real").join("A.ttf"), noto("Regular")).unwrap();
    assert!(link_dir(&folder.join("real"), &folder.join("alias")));
    let fonts = SystemFonts::with_directories(vec![folder.clone()]);
    assert_eq!(fonts.list(&never).unwrap().len(), 1, "the same real folder is visited once");
}

/// A collection of the given standalone fonts: their tables are shared by offset, as real collections do.
fn collection(fonts: &[Vec<u8>]) -> Vec<u8> {
    let n = fonts.len();
    let mut out = b"ttcf".to_vec();
    out.extend(0x0001_0000u32.to_be_bytes());
    out.extend((n as u32).to_be_bytes());
    let header = 12 + 4 * n;
    let mut placed = Vec::new();
    let mut at = header;
    for font in fonts {
        placed.push(at);
        at += font.len();
    }
    for p in &placed {
        out.extend((*p as u32).to_be_bytes());
    }
    for (font, base) in fonts.iter().zip(&placed) {
        // The directory of each face points at its own table data, with offsets made absolute.
        let mut copy = font.clone();
        let tables = u16::from_be_bytes([copy[4], copy[5]]) as usize;
        for i in 0..tables {
            let record = 12 + i * 16 + 8;
            let offset = u32::from_be_bytes(copy[record..record + 4].try_into().unwrap()) as usize + base;
            copy[record..record + 4].copy_from_slice(&(offset as u32).to_be_bytes());
        }
        out.extend(copy);
    }
    out
}

fn sum32(bytes: &[u8]) -> u32 {
    let mut sum = 0u32;
    for chunk in bytes.chunks(4) {
        let mut word = [0u8; 4];
        word[..chunk.len()].copy_from_slice(chunk);
        sum = sum.wrapping_add(u32::from_be_bytes(word));
    }
    sum
}

#[test]
fn collection_faces_are_listed_and_repacked_into_standalone_fonts() {
    let scratch = Scratch::new("collection");
    let folder = scratch.0.join("Fonts");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("Family.ttc"), collection(&[noto("Regular"), noto("Bold")])).unwrap();
    let fonts = SystemFonts::with_directories(vec![folder]);
    let list = fonts.list(&never).unwrap();
    assert_eq!(families(&list), ["Noto Sans / Bold", "Noto Sans / Regular"]);
    assert!(list.iter().all(|f| f.collection));
    for face in list.iter() {
        let bytes = fonts.read(&face.id, &never).unwrap();
        assert_eq!(&bytes[0..4], &[0, 1, 0, 0]);
        let count = u16::from_be_bytes([bytes[4], bytes[5]]) as usize;
        let tags: Vec<&[u8]> = (0..count).map(|i| &bytes[12 + i * 16..16 + i * 16]).collect();
        assert!(tags.windows(2).all(|w| w[0] < w[1]), "tables sorted by tag");
        assert!(!tags.contains(&b"DSIG".as_slice()));
        assert_eq!(sum32(&bytes), 0xb1b0afba, "a standalone font's checksum adjustment makes the file sum to the magic number");
        assert_eq!(bytes.len() as u64 % 4, 0);
    }
}

#[test]
fn a_collection_with_too_many_faces_is_refused_whole() {
    let scratch = Scratch::new("faces");
    let folder = scratch.0.join("Fonts");
    fs::create_dir_all(&folder).unwrap();
    let mut file = b"ttcf".to_vec();
    file.extend(0x0001_0000u32.to_be_bytes());
    file.extend(129u32.to_be_bytes());
    file.extend(vec![0u8; 129 * 4 + 64]);
    fs::write(folder.join("Many.ttc"), file).unwrap();
    let fonts = SystemFonts::with_directories(vec![folder]);
    assert!(fonts.list(&never).unwrap().is_empty());
    assert_eq!(fonts.stats().skipped, 1);
}

#[test]
fn a_table_directory_pointing_outside_the_file_is_skipped_before_any_parser() {
    let scratch = Scratch::new("bounds");
    let folder = scratch.0.join("Fonts");
    fs::create_dir_all(&folder).unwrap();
    let mut font = noto("Regular");
    // The first table's length field becomes larger than the file.
    let longer = (font.len() as u32 + 1000).to_be_bytes();
    font[12 + 12..12 + 16].copy_from_slice(&longer);
    fs::write(folder.join("Lies.ttf"), font).unwrap();
    let mut duplicate = noto("Regular");
    let first_tag: [u8; 4] = duplicate[12..16].try_into().unwrap();
    duplicate[12 + 16..12 + 20].copy_from_slice(&first_tag);
    fs::write(folder.join("Twice.ttf"), duplicate).unwrap();
    let fonts = SystemFonts::with_directories(vec![folder]);
    assert!(fonts.list(&never).unwrap().is_empty());
    assert_eq!(fonts.stats().skipped, 2);
}

#[test]
fn cancel_in_the_middle_of_the_walk_stops_it_promptly_and_leaves_no_partial_list() {
    let scratch = Scratch::new("cancel");
    let folder = scratch.0.join("Fonts");
    fs::create_dir_all(&folder).unwrap();
    for i in 0..600 {
        fs::write(folder.join(format!("f{i:04}.ttf")), vec![0u8; 64]).unwrap();
    }
    let fonts = SystemFonts::with_directories(vec![folder.clone()]);
    let polls = Cell::new(0usize);
    let cancel = || {
        polls.set(polls.get() + 1);
        polls.get() > 40
    };
    assert_eq!(fonts.list(&cancel), Err(FontError::Cancelled));
    assert!(polls.get() < 60, "the walk polled {} times after being cancelled at 40", polls.get());
    assert!(fonts.stats().candidates == 0, "a cancelled scan records nothing");
    // The service still works afterwards: nothing half-done was kept.
    fs::write(folder.join("NotoSans.ttf"), noto("Regular")).unwrap();
    assert_eq!(fonts.list(&never).unwrap().len(), 1);
}

#[test]
fn a_cancelled_read_returns_without_data() {
    let scratch = Scratch::new("cancel-read");
    let folder = scratch.0.join("Fonts");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("N.ttf"), noto("Regular")).unwrap();
    let fonts = SystemFonts::with_directories(vec![folder]);
    let id = fonts.list(&never).unwrap()[0].id.clone();
    assert_eq!(fonts.read(&id, &|| true), Err(FontError::Cancelled));
    assert!(fonts.read(&id, &never).is_ok());
}

#[test]
fn a_file_that_changed_since_the_scan_is_refused() {
    let scratch = Scratch::new("changed");
    let folder = scratch.0.join("Fonts");
    fs::create_dir_all(&folder).unwrap();
    let path = folder.join("N.ttf");
    fs::write(&path, noto("Regular")).unwrap();
    let fonts = SystemFonts::with_directories(vec![folder]);
    let id = fonts.list(&never).unwrap()[0].id.clone();
    let mut longer = noto("Regular");
    longer.extend([0u8; 16]);
    fs::write(&path, longer).unwrap();
    assert_eq!(fonts.read(&id, &never), Err(FontError::Changed));
}

#[test]
fn the_scan_stops_at_the_face_limit() {
    let scratch = Scratch::new("limit");
    let folder = scratch.0.join("Fonts");
    fs::create_dir_all(&folder).unwrap();
    for style in ["Regular", "Bold", "Italic", "BoldItalic"] {
        fs::write(folder.join(format!("{style}.ttf")), noto(style)).unwrap();
    }
    let fonts = SystemFonts::with_directories(vec![folder]).with_max_fonts(2);
    assert_eq!(fonts.list(&never).unwrap().len(), 2);
}

/// `STYK_FONT_LIST_JSON`: the output of `node tmp/list-fonts.cjs`, i.e. `desktop/font-service.cjs` on this machine.
#[test]
#[ignore = "needs the JavaScript service's listing of this machine"]
fn lists_the_same_faces_as_the_javascript_service_on_this_machine() {
    let path = std::env::var("STYK_FONT_LIST_JSON").expect("STYK_FONT_LIST_JSON");
    let text = fs::read_to_string(path).unwrap();
    let expected: Vec<(String, String, String)> = text
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| {
            let mut parts = l.split('\t');
            (parts.next().unwrap().to_string(), parts.next().unwrap().to_string(), parts.next().unwrap().to_string())
        })
        .collect();
    let started = std::time::Instant::now();
    let list = SystemFonts::new().list(&never).unwrap();
    eprintln!("{} faces in {:?}", list.len(), started.elapsed());
    let mut got: Vec<(String, String, String)> = list.iter().map(|f| (f.id.to_string(), f.family.clone(), f.style.clone())).collect();
    let mut want = expected.clone();
    got.sort();
    want.sort();
    let missing: Vec<_> = want.iter().filter(|w| !got.contains(w)).take(10).collect();
    let extra: Vec<_> = got.iter().filter(|g| !want.contains(g)).take(10).collect();
    assert!(missing.is_empty() && extra.is_empty(), "javascript {} faces, rust {}; only in javascript: {missing:?}; only in rust: {extra:?}", want.len(), got.len());
}
