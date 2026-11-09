//! Bounded sink for the existing logging facade. Writers never wait for readers.
use std::{
    collections::VecDeque,
    fmt::{self, Write},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
pub const BYTE_LIMIT: usize = 2 * 1024 * 1024;
pub const LINE_LIMIT: usize = 8192;
pub const TEXT_LIMIT: usize = 2048;
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub sequence: u64,
    pub time_ns: u64,
    pub level: u8,
    pub module: String,
    pub text: String,
    pub truncated: bool,
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Filter {
    pub level: u8,
    pub module: String,
    pub text: String,
    pub offset: usize,
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Page {
    pub lines: Vec<Line>,
    pub total: usize,
    pub dropped: u64,
}
struct Ring {
    lines: VecDeque<Line>,
    bytes: usize,
    sequence: u64,
}
pub struct Logs {
    ring: Mutex<Ring>,
    dropped: AtomicU64,
}
impl Default for Logs {
    fn default() -> Self {
        Self {
            ring: Mutex::new(Ring {
                lines: VecDeque::with_capacity(LINE_LIMIT),
                bytes: LINE_LIMIT * std::mem::size_of::<Line>(),
                sequence: 0,
            }),
            dropped: AtomicU64::new(0),
        }
    }
}
struct Text {
    bytes: [u8; TEXT_LIMIT],
    len: usize,
    truncated: bool,
}
impl Write for Text {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        let mut count = text.len().min(TEXT_LIMIT - self.len);
        while !text.is_char_boundary(count) {
            count -= 1;
        }
        self.bytes[self.len..self.len + count].copy_from_slice(&text.as_bytes()[..count]);
        self.len += count;
        self.truncated |= count < text.len();
        if count < text.len() {
            Err(fmt::Error)
        } else {
            Ok(())
        }
    }
}
impl Logs {
    pub fn record(&self, time_ns: u64, level: u8, module: &str, args: fmt::Arguments<'_>) {
        let Ok(mut ring) = self.ring.try_lock() else {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        };
        let mut text = Text {
            bytes: [0; TEXT_LIMIT],
            len: 0,
            truncated: false,
        };
        if text.write_fmt(args).is_err() && !text.truncated {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let mut module_len = module.len().min(128);
        while !module.is_char_boundary(module_len) {
            module_len -= 1;
        }
        let cost = text.len + module_len;
        while ring.lines.len() >= LINE_LIMIT || cost > BYTE_LIMIT.saturating_sub(ring.bytes) {
            if let Some(old) = ring.lines.pop_front() {
                ring.bytes -= old.text.capacity() + old.module.capacity();
                self.dropped.fetch_add(1, Ordering::Relaxed);
            } else {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                return;
            }
        }
        ring.sequence += 1;
        let sequence = ring.sequence;
        let line = Line {
            sequence,
            time_ns,
            level,
            module: module[..module_len].into(),
            text: String::from_utf8_lossy(&text.bytes[..text.len]).into_owned(),
            truncated: text.truncated || module_len < module.len(),
        };
        ring.bytes += line.text.capacity() + line.module.capacity();
        ring.lines.push_back(line);
    }
    /// Worker only: bounded 8192-record scan, a 50-row page (each row capped at 2 KiB).
    pub fn page(&self, filter: &Filter) -> Result<Page, String> {
        let ring = self.ring.try_lock().map_err(|_| "log stream busy")?;
        let mut page = Page {
            dropped: self.dropped.load(Ordering::Relaxed),
            ..Page::default()
        };
        let mut bytes = 0;
        let mut full = false;
        for line in &ring.lines {
            if (filter.level != 0 && line.level > filter.level)
                || !line.module.contains(&filter.module)
                || !line.text.contains(&filter.text)
            {
                continue;
            }
            let index = page.total;
            page.total += 1;
            let cost = line.text.len() + line.module.len() + std::mem::size_of::<Line>();
            if index >= filter.offset && !full {
                if page.lines.len() == 50 || bytes + cost > 48 * 1024 {
                    full = true;
                    continue;
                }
                page.lines.push(line.clone());
                bytes += cost;
            }
        }
        Ok(page)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn formatting_stops_when_the_prefix_is_full() {
        struct Many(std::cell::Cell<usize>);
        impl fmt::Display for Many {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                for _ in 0..TEXT_LIMIT * 2 {
                    self.0.set(self.0.get() + 1);
                    f.write_str("x")?;
                }
                Ok(())
            }
        }
        let value = Many(std::cell::Cell::new(0));
        let logs = Logs::default();
        logs.record(1, 2, "module", format_args!("{value}"));
        assert!(
            value.0.get() <= TEXT_LIMIT + 1,
            "formatting must stop at the bound"
        );
        let page = logs.page(&Filter::default()).unwrap();
        assert_eq!(page.lines.len(), 1);
        assert_eq!(page.lines[0].text.len(), TEXT_LIMIT);
        assert!(page.lines[0].truncated);
    }
    #[test]
    fn byte_limited_pages_are_contiguous_even_when_later_rows_are_smaller() {
        let log = Logs::default();
        for n in 0..60 {
            let text = if n < 30 {
                "x".repeat(2048)
            } else {
                "small".into()
            };
            log.record(1, 2, "module", format_args!("{text}"));
        }
        let mut ids = Vec::new();
        let mut offset = 0;
        loop {
            let page = log
                .page(&Filter {
                    offset,
                    ..Default::default()
                })
                .unwrap();
            assert!(!page.lines.is_empty());
            offset += page.lines.len();
            ids.extend(page.lines.iter().map(|l| l.sequence));
            if offset == page.total {
                break;
            }
        }
        assert_eq!(ids, (1..=60).collect::<Vec<_>>());
    }
    #[test]
    fn bounds_eviction_filter_and_utf8() {
        let log = Logs::default();
        for _ in 0..9000 {
            log.record(1, 2, "module", format_args!("{}", "é".repeat(3000)));
        }
        let ring = log.ring.lock().unwrap();
        assert!(ring.bytes <= BYTE_LIMIT);
        assert!(ring.lines.len() <= LINE_LIMIT);
        assert!(
            ring.lines
                .iter()
                .all(|l| l.text.len() <= TEXT_LIMIT && l.truncated)
        );
        drop(ring);
        let page = log
            .page(&Filter {
                module: "module".into(),
                ..Filter::default()
            })
            .unwrap();
        assert!(page.dropped > 0);
        assert!(page.lines.len() <= 50);
        assert!(
            log.page(&Filter {
                level: 1,
                ..Filter::default()
            })
            .unwrap()
            .lines
            .is_empty()
        );
        let held = log.ring.lock().unwrap();
        log.record(1, 1, "x", format_args!("never blocks"));
        drop(held);
    }
}
