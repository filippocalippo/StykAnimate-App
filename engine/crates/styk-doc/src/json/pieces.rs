//! Reading one large document's text in pieces, side by side.
//!
//! A project's skeleton is mostly two arrays of records (`keyframes`, `figure_types`), tens of megabytes of text each, and reading it
//! is one long pass. [`parse_pieces`] finds the records of those arrays with a scan that only follows quotes and brackets, cuts
//! each array into pieces of whole records, reads the pieces on a [`Fanout`] and joins what they made. It gives the tree that
//! [`super::parse_with`] gives: the pieces tile the text, every one must read as records separated by commas, and what is outside
//! them (the other members, the commas, the brackets) is read by the ordinary parser. Whenever anything is off (a piece does not
//! read, a hook refuses a string, the text is not one this scan understands) it gives nothing, and the caller reads the text in
//! order, which is where the errors of a damaged file come from: the same ones, at the same places, as without this.

use std::sync::Arc;

use crate::fanout::{self, Fanout};
use crate::value::Value;
use crate::JsonError;

use super::{Parser, StringHook};

/// What decides the strings of a document read in pieces: [`StringHook`] for a hook that more than one thread may ask.
pub trait SharedHook: Send + Sync {
    fn string(&self, text: &str) -> Option<Result<Value, JsonError>>;
}

/// A [`SharedHook`] asked as a [`StringHook`].
struct Shared<'a>(&'a dyn SharedHook);

impl StringHook for Shared<'_> {
    fn string(&mut self, text: &str) -> Option<Result<Value, JsonError>> {
        self.0.string(text)
    }
}

/// An array is worth cutting when it holds at least this much text: smaller ones are read with the rest.
const MIN_ARRAY_BYTES: usize = 256 * 1024;

/// The most records a piece has to be worth a task of its own.
const MIN_PIECE_BYTES: usize = 64 * 1024;

/// The records of the array that starts at `text[at]` (`[`): where each starts and ends, and where the array ends. `None` for an
/// array that is empty, holds anything but objects, or is not built as this scan expects; the ordinary parser then reads it.
fn records(text: &[u8], at: usize) -> Option<(Vec<(usize, usize)>, usize)> {
    let mut found = Vec::new();
    let mut i = at + 1;
    loop {
        while matches!(text.get(i), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            i += 1;
        }
        if text.get(i) != Some(&b'{') {
            return None;
        }
        let start = i;
        // Depth counts the brackets of this record; quotes hide the brackets inside strings, and a backslash hides the next byte.
        let mut depth = 0usize;
        loop {
            match *text.get(i)? {
                b'"' => {
                    i += 1;
                    loop {
                        match *text.get(i)? {
                            b'"' => break,
                            b'\\' => i += 2,
                            _ => i += 1,
                        }
                    }
                }
                b'{' | b'[' => depth += 1,
                b'}' | b']' => {
                    depth = depth.checked_sub(1)?;
                    if depth == 0 {
                        i += 1;
                        break;
                    }
                }
                _ => {}
            }
            i += 1;
        }
        found.push((start, i));
        while matches!(text.get(i), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            i += 1;
        }
        match text.get(i)? {
            b',' => i += 1,
            b']' => return (found.len() >= 2).then_some((found, i + 1)),
            _ => return None,
        }
    }
}

/// One member of the root object: read in place, or an array cut into pieces to be read elsewhere.
enum Member {
    Value(Value),
    /// The array's records, and the pieces they are cut into as ranges of the text.
    Array(Vec<std::ops::Range<usize>>),
}

/// Reads `text`, a JSON document whose root is an object, in pieces on `fan`; `None` when it is not worth it or something is off
/// (see the module's text). `hook` is asked about every string value, as [`super::parse_with`]'s is.
pub fn parse_pieces(text: &Arc<Vec<u8>>, hook: &Arc<dyn SharedHook>, fan: &dyn Fanout) -> Option<Value> {
    if fan.threads() <= 1 || text.len() < 2 * MIN_ARRAY_BYTES {
        return None;
    }
    let bytes: &[u8] = text;
    let mut asked = Shared(&**hook);
    let mut parser = Parser::new(bytes, &mut asked);
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        parser.at = 3;
    }
    parser.space();
    if parser.text.get(parser.at) != Some(&b'{') {
        return None;
    }
    parser.at += 1;
    parser.space();
    if parser.text.get(parser.at) == Some(&b'}') {
        return None;
    }
    let (mut keys, mut members, mut plain): (Vec<Arc<str>>, Vec<Member>, bool) = (Vec::new(), Vec::new(), true);
    let mut cut_bytes = 0usize;
    loop {
        let key = parser.key().ok()?;
        parser.space();
        if parser.text.get(parser.at) != Some(&b':') {
            return None;
        }
        parser.at += 1;
        parser.space();
        let member = match parser.text.get(parser.at) {
            Some(b'[') => match records(bytes, parser.at) {
                Some((found, end)) if end - parser.at >= MIN_ARRAY_BYTES => {
                    let pieces = cut(&found, fan.threads());
                    cut_bytes += end - parser.at;
                    parser.at = end;
                    Member::Array(pieces)
                }
                _ => Member::Value(parser.value(1).ok()?),
            },
            _ => Member::Value(parser.value(1).ok()?),
        };
        if plain && (key.as_bytes().first().is_some_and(u8::is_ascii_digit) && crate::value::index_key(&key).is_some() || keys.iter().any(|k| Arc::ptr_eq(k, &key) || **k == *key)) {
            plain = false;
        }
        keys.push(key);
        members.push(member);
        parser.space();
        match parser.text.get(parser.at) {
            Some(b',') => {
                parser.at += 1;
                parser.space();
            }
            Some(b'}') => {
                parser.at += 1;
                break;
            }
            _ => return None,
        }
    }
    parser.space();
    if parser.at != bytes.len() || cut_bytes == 0 {
        return None;
    }
    // Every piece of every cut array, in order: its member, and the range of the text.
    let jobs: Vec<(Arc<Vec<u8>>, Arc<dyn SharedHook>, std::ops::Range<usize>)> =
        members.iter().flat_map(|member| if let Member::Array(pieces) = member { pieces.as_slice() } else { &[] }).map(|range| (text.clone(), hook.clone(), range.clone())).collect();
    let read = fanout::map(fan, jobs, |(text, hook, range)| read_records(&text, &hook, range)).ok()?;
    let mut read = read.into_iter();
    let mut values = Vec::with_capacity(members.len());
    for member in members {
        values.push(match member {
            Member::Value(value) => value,
            Member::Array(pieces) => {
                let mut records: Vec<Value> = Vec::new();
                for _ in 0..pieces.len() {
                    records.extend(read.next()??);
                }
                Value::Arr(Arc::new(records))
            }
        });
    }
    Some(parser.build_object(keys, values, plain))
}

/// Cuts the records into pieces of about the same size, several for every thread so that a slow one does not keep the others
/// waiting. A piece is the text from its first record to its last.
fn cut(found: &[(usize, usize)], threads: usize) -> Vec<std::ops::Range<usize>> {
    let total = found.last().map_or(0, |last| last.1) - found.first().map_or(0, |first| first.0);
    let size = (total / (threads * 3)).max(MIN_PIECE_BYTES);
    let mut pieces = Vec::new();
    let mut from = 0;
    while from < found.len() {
        let start = found[from].0;
        let mut to = from;
        while to + 1 < found.len() && found[to].1 - start < size {
            to += 1;
        }
        pieces.push(start..found[to].1);
        from = to + 1;
    }
    pieces
}

/// The records in `range` of the text, separated by commas; `None` if the range is anything else.
fn read_records(text: &Arc<Vec<u8>>, hook: &Arc<dyn SharedHook>, range: std::ops::Range<usize>) -> Option<Vec<Value>> {
    let mut asked = Shared(&**hook);
    let mut parser = Parser::new(&text[range.clone()], &mut asked);
    let mut records = Vec::new();
    loop {
        // The array is at depth 1, its records at 2.
        records.push(parser.value(2).ok()?);
        parser.space();
        match parser.text.get(parser.at) {
            Some(b',') => {
                parser.at += 1;
                parser.space();
            }
            None => return Some(records),
            _ => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fanout::StdThreads;

    struct Keep;
    impl SharedHook for Keep {
        fn string(&self, _: &str) -> Option<Result<Value, JsonError>> {
            None
        }
    }

    /// A document of two big arrays of records among small members, with strings that look like structure.
    fn document(records: usize) -> Vec<u8> {
        let mut text = String::from("{\"name\":\"a, ] } {\",\"keyframes\":[");
        for i in 0..records {
            if i > 0 {
                text.push(',');
            }
            text.push_str(&format!("{{\"id\":{i},\"note\":\"x\\\"]}},{{\\\\\",\"poses\":[1,2,{i}.5],\"nested\":{{\"deep\":[{{\"a\":null}},true,\"s\"]}},\"pad\":\"{}\"}}", "p".repeat(40)));
        }
        text.push_str("],\"figure_types\":[");
        for i in 0..records / 4 {
            if i > 0 {
                text.push_str(" , ");
            }
            text.push_str(&format!("{{\"figure_type_id\":{},\"segments\":[{{\"segment_id\":1}}],\"pad\":\"{}\"}}", i + 1, "q".repeat(60)));
        }
        text.push_str("],\"tail\":[1,2,3],\"fps\":24}");
        text.into_bytes()
    }

    #[test]
    fn pieces_read_the_tree_that_reading_in_order_reads() {
        let bytes = document(12_000);
        let in_order = crate::json::parse(&bytes).unwrap();
        let text = Arc::new(bytes);
        let hook: Arc<dyn SharedHook> = Arc::new(Keep);
        for threads in [2, 3, 8] {
            let beside = parse_pieces(&text, &hook, &StdThreads(threads)).expect("a document of records is read in pieces");
            assert_eq!(crate::json::to_string(&beside), crate::json::to_string(&in_order), "{threads} threads");
        }
        assert!(parse_pieces(&text, &hook, &fanout::Sequential).is_none(), "one thread reads in order");
    }

    #[test]
    fn a_text_that_is_not_what_the_scan_expects_is_left_to_the_ordinary_parser() {
        let hook: Arc<dyn SharedHook> = Arc::new(Keep);
        let fan = StdThreads(4);
        let good = document(12_000);
        // Damaged in each of several places: a piece, the commas between records, the end of the array, the root.
        let pad = "p".repeat(40);
        let damage: Vec<(&str, String, String)> = vec![
            ("a record", "\"id\":5000,".into(), "\"id\":5000".into()),
            ("a separator", "},{\"id\":7000".into(), "}{\"id\":7000".into()),
            ("a quote", format!("\"pad\":\"{pad}\"}}],\"figure_types\""), format!("\"pad\":\"{pad}}}],\"figure_types\"")),
            ("the end of the root", ",\"fps\":24}".into(), ",\"fps\":24".into()),
            ("text after the root", ",\"fps\":24}".into(), ",\"fps\":24}}".into()),
            ("a number", "\"poses\":[1,2,3000.5]".into(), "\"poses\":[1,2,3000.5.5]".into()),
        ];
        for (name, find, put) in damage {
            let mut text = String::from_utf8(good.clone()).unwrap();
            assert!(text.contains(&find), "{name}: {find}");
            text = text.replacen(&find, &put, 1);
            let bytes = text.into_bytes();
            assert!(crate::json::parse(&bytes).is_err(), "{name} is damaged");
            assert!(parse_pieces(&Arc::new(bytes), &hook, &fan).is_none(), "{name}: pieces do not make a document of it");
        }
    }

    #[test]
    fn small_documents_and_other_shapes_are_read_in_order() {
        let hook: Arc<dyn SharedHook> = Arc::new(Keep);
        let fan = StdThreads(4);
        for text in ["{}", "[1,2]", "{\"a\":[{\"b\":1},{\"b\":2}]}", "3"] {
            assert!(parse_pieces(&Arc::new(text.as_bytes().to_vec()), &hook, &fan).is_none(), "{text}");
        }
        // Big arrays of numbers, or of mixed values, are not cut.
        let numbers = format!("{{\"a\":[{}],\"b\":[{{\"x\":1}},2]}}", vec!["1.5"; 200_000].join(","));
        assert!(parse_pieces(&Arc::new(numbers.into_bytes()), &hook, &fan).is_none());
    }
}
