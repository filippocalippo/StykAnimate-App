//! Bounds-checked big-endian reads with the failure behaviour of opentype.js's `DataView` calls: any read that
//! leaves the file is an error, never a truncated value.

use super::FontError;

pub(crate) type R<T> = Result<T, FontError>;

/// The whole font file. Table offsets are not bounded by table lengths: opentype.js reads through the file.
#[derive(Clone, Copy)]
pub(crate) struct Data<'a>(pub &'a [u8]);

impl<'a> Data<'a> {
    pub fn slice(&self, offset: i64, length: usize) -> R<&'a [u8]> {
        if offset < 0 {
            return Err(FontError::Range);
        }
        let start = offset as u64;
        let end = start.checked_add(length as u64).ok_or(FontError::Range)?;
        if end > self.0.len() as u64 {
            return Err(FontError::Range);
        }
        Ok(&self.0[start as usize..end as usize])
    }
    pub fn u8(&self, offset: i64) -> R<u8> {
        Ok(self.slice(offset, 1)?[0])
    }
    pub fn u16(&self, offset: i64) -> R<u16> {
        let b = self.slice(offset, 2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }
    pub fn i16(&self, offset: i64) -> R<i16> {
        Ok(self.u16(offset)? as i16)
    }
    pub fn u32(&self, offset: i64) -> R<u32> {
        let b = self.slice(offset, 4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
}

/// opentype.js's stateful `Parser`: `offset` is the structure's base, `rel` the cursor inside it.
#[derive(Clone, Copy)]
pub(crate) struct Parser<'a> {
    pub data: Data<'a>,
    pub offset: i64,
    pub rel: i64,
}

impl<'a> Parser<'a> {
    pub fn new(data: Data<'a>, offset: i64) -> Self {
        Parser { data, offset, rel: 0 }
    }
    pub fn at(&self) -> i64 {
        self.offset + self.rel
    }
    pub fn u8(&mut self) -> R<u8> {
        let v = self.data.u8(self.at())?;
        self.rel += 1;
        Ok(v)
    }
    pub fn i8(&mut self) -> R<i8> {
        Ok(self.u8()? as i8)
    }
    pub fn u16(&mut self) -> R<u16> {
        let v = self.data.u16(self.at())?;
        self.rel += 2;
        Ok(v)
    }
    pub fn i16(&mut self) -> R<i16> {
        Ok(self.u16()? as i16)
    }
    pub fn u32(&mut self) -> R<u32> {
        let v = self.data.u32(self.at())?;
        self.rel += 4;
        Ok(v)
    }
    pub fn f2dot14(&mut self) -> R<f64> {
        Ok(self.i16()? as f64 / 16384.0)
    }
    pub fn tag(&mut self) -> R<[u8; 4]> {
        let b = self.data.slice(self.at(), 4)?;
        self.rel += 4;
        Ok([b[0], b[1], b[2], b[3]])
    }
    pub fn skip(&mut self, bytes: i64) {
        self.rel += bytes;
    }
    /// `parseVersion(minorBase)`: `major + minor / minorBase / 10`.
    pub fn version(&mut self, minor_base: f64) -> R<f64> {
        let major = self.u16()? as f64;
        let minor = self.u16()? as f64;
        Ok(major + minor / minor_base / 10.0)
    }
    /// A list of 16-bit values whose count is read from the stream (`parseUShortList()`).
    pub fn u16_list(&mut self) -> R<Vec<u16>> {
        let count = self.u16()? as usize;
        self.u16_list_of(count)
    }
    pub fn u16_list_of(&mut self, count: usize) -> R<Vec<u16>> {
        let bytes = self.data.slice(self.at(), count.checked_mul(2).ok_or(FontError::Range)?)?;
        self.rel += count as i64 * 2;
        Ok(bytes.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect())
    }
    /// `parsePointer`: a 16-bit offset from this structure's base; 0 is a null pointer.
    pub fn pointer16(&mut self) -> R<Option<Parser<'a>>> {
        let offset = self.u16()? as i64;
        Ok(if offset > 0 { Some(Parser::new(self.data, self.offset + offset)) } else { None })
    }
    pub fn pointer32(&mut self) -> R<Option<Parser<'a>>> {
        let offset = self.u32()? as i64;
        Ok(if offset > 0 { Some(Parser::new(self.data, self.offset + offset)) } else { None })
    }
}
