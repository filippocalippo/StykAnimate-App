//! Bounded, recoverable capture stream. File I/O belongs to the caller's worker.
use serde_json::{Value, json};
use std::io::{Read, Write};

pub const MAX_CHUNK: usize = 64 * 1024;
pub const MAX_CAPTURE: usize = 256 * 1024 * 1024;
const MAGIC: &[u8] = b"styktrace/1\n";

/// A capture is complete chunks only. A partial trailing chunk is recoverable.
pub struct Capture {
    data: Vec<u8>,
    bytes: usize,
    cap: usize,
    pub dropped: u64,
    pub recovered: bool,
}
impl Capture {
    pub fn new(cap: usize) -> Result<Self, String> {
        if !(MAGIC.len()..=MAX_CAPTURE).contains(&cap) {
            return Err("capture cap outside supported range".into());
        }
        let mut data = Vec::new();
        data.try_reserve_exact(cap)
            .map_err(|_| "capture allocation refused")?;
        data.extend_from_slice(MAGIC);
        Ok(Self {
            data,
            bytes: MAGIC.len(),
            cap,
            dropped: 0,
            recovered: false,
        })
    }
    pub fn bytes(&self) -> usize {
        self.bytes
    }
    pub fn chunks(&self) -> impl Iterator<Item = &[u8]> {
        let mut remaining = &self.data[MAGIC.len()..];
        std::iter::from_fn(move || {
            if remaining.len() < 4 {
                return None;
            }
            let size = u32::from_le_bytes([remaining[0], remaining[1], remaining[2], remaining[3]])
                as usize;
            let chunk = &remaining[4..4 + size];
            remaining = &remaining[4 + size..];
            Some(chunk)
        })
    }
    pub fn push(&mut self, json: &[u8]) -> Result<(), String> {
        if json.len() > MAX_CHUNK || json.len().saturating_add(4) > self.cap - self.bytes {
            self.dropped += 1;
            return Err("capture byte budget exhausted".into());
        }
        serde_json::from_slice::<Value>(json).map_err(|e| e.to_string())?;
        self.bytes += json.len() + 4;
        self.data
            .extend_from_slice(&(json.len() as u32).to_le_bytes());
        self.data.extend_from_slice(json);
        Ok(())
    }
    pub fn write(&self, mut out: impl Write) -> Result<(), String> {
        out.write_all(&self.data).map_err(|e| e.to_string())
    }
    pub fn read(mut input: impl Read, cap: usize) -> Result<Self, String> {
        let mut capture = Self::new(cap)?;
        let mut magic = [0; 12];
        // The header is deliberately versioned; unknown majors cannot be mistaken for records.
        input
            .read_exact(&mut magic[..MAGIC.len()])
            .map_err(|e| e.to_string())?;
        if &magic[..MAGIC.len()] != MAGIC {
            return Err("unsupported capture version".into());
        }
        loop {
            let mut length = [0; 4];
            match input.read(&mut length[..1]) {
                Ok(0) => break,
                Ok(_) => {}
                Err(e) => return Err(e.to_string()),
            }
            if let Err(e) = input.read_exact(&mut length[1..]) {
                if e.kind() != std::io::ErrorKind::UnexpectedEof {
                    return Err(e.to_string());
                }
                capture.recovered = true;
                break;
            }
            let size = u32::from_le_bytes(length) as usize;
            if size > MAX_CHUNK || size.saturating_add(4) > cap - capture.bytes {
                return Err("capture byte budget exhausted".into());
            }
            let mut chunk = vec![0; size];
            if let Err(e) = input.read_exact(&mut chunk) {
                if e.kind() != std::io::ErrorKind::UnexpectedEof {
                    return Err(e.to_string());
                }
                capture.recovered = true;
                break;
            }
            capture.push(&chunk)?;
        }
        Ok(capture)
    }
    /// Export independently readable Chrome trace JSON for Perfetto, streamed without a second capture allocation.
    pub fn perfetto(&self, mut out: impl Write) -> Result<(), String> {
        out.write_all(b"{\"traceEvents\":[")
            .map_err(|e| e.to_string())?;
        for (i, chunk) in self.chunks().enumerate() {
            if i > 0 {
                out.write_all(b",").map_err(|e| e.to_string())?;
            }
            out.write_all(chunk).map_err(|e| e.to_string())?;
        }
        out.write_all(b"]}").map_err(|e| e.to_string())
    }
}
pub fn event(record: &styk_trace::Record) -> Value {
    let mut value = json!({"name":record.name,"pid":1,"tid":record.thread,"ts":record.start_ns as f64 / 1000.0});
    match record.kind {
        styk_trace::RecordKind::Span => {
            value["ph"] = json!("X");
            value["dur"] = json!(record.duration_ns as f64 / 1000.0);
        }
        styk_trace::RecordKind::Mark => {
            value["ph"] = json!("i");
            value["s"] = json!("t");
        }
        styk_trace::RecordKind::Counter(n) => {
            value["ph"] = json!("C");
            value["args"] = json!({"value":n});
        }
    }
    value
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip_and_partial_tail() {
        let mut c = Capture::new(1024).unwrap();
        c.push(br#"{"ph":"i","name":"test"}"#).unwrap();
        let mut bytes = Vec::new();
        c.write(&mut bytes).unwrap();
        let restored = Capture::read(bytes.as_slice(), 1024).unwrap();
        assert_eq!(restored.bytes(), c.bytes());
        bytes.extend_from_slice(&8u32.to_le_bytes());
        bytes.extend_from_slice(b"{}");
        let recovered = Capture::read(bytes.as_slice(), 1024).unwrap();
        assert!(recovered.recovered);
        assert_eq!(recovered.chunks().count(), 1);
        let mut json = Vec::new();
        restored.perfetto(&mut json).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&json).unwrap()["traceEvents"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn bounds_and_version_are_enforced() {
        let mut c = Capture::new(18).unwrap();
        c.push(b"{}").unwrap();
        assert!(c.push(b"{}").is_err());
        assert_eq!(c.dropped, 1);
        assert!(Capture::read(b"styktrace/2\n".as_slice(), 1024).is_err());
        let mut forged = MAGIC.to_vec();
        forged.extend_from_slice(&u32::MAX.to_le_bytes());
        assert!(Capture::read(forged.as_slice(), 1024).is_err());
    }
}
