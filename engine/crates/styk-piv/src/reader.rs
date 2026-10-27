//! Sequential little-endian reader over a decompressed payload.
//!
//! Its errors are the Python service's `FastReader` errors (`server.py`), which
//! differ from the original `piv_codec.Reader` only in wording: scalar reads say
//! `Unexpected EOF at payload offset 0x..`, byte runs add `, need N bytes`.

use std::fmt;

use crate::error::{PyResult, piv};
use crate::text::cp1252_decode;

pub(crate) struct Reader<'a> {
    pub data: &'a [u8],
    pub pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Reader<'a> {
        Reader { data, pos: 0 }
    }

    /// `Reader.take(count)`. The count may come from arithmetic on file values, so it is signed and wide.
    pub fn take(&mut self, count: i128) -> PyResult<&'a [u8]> {
        if count < 0 || self.pos as i128 + count > self.data.len() as i128 {
            return Err(piv(format!("Unexpected EOF at payload offset {:#x}, need {} bytes", self.pos, count)));
        }
        let start = self.pos;
        self.pos += count as usize;
        Ok(&self.data[start..self.pos])
    }

    #[inline]
    fn fixed<const N: usize>(&mut self) -> PyResult<[u8; N]> {
        match self.data.get(self.pos..self.pos + N) {
            Some(bytes) => {
                self.pos += N;
                let mut out = [0u8; N];
                out.copy_from_slice(bytes);
                Ok(out)
            }
            None => Err(piv(format!("Unexpected EOF at payload offset {:#x}", self.pos))),
        }
    }

    #[inline]
    pub fn u8(&mut self) -> PyResult<u8> {
        Ok(self.fixed::<1>()?[0])
    }

    #[inline]
    pub fn u16(&mut self) -> PyResult<u16> {
        Ok(u16::from_le_bytes(self.fixed()?))
    }

    #[inline]
    pub fn u32(&mut self) -> PyResult<u32> {
        Ok(u32::from_le_bytes(self.fixed()?))
    }

    #[inline]
    pub fn u64(&mut self) -> PyResult<u64> {
        Ok(u64::from_le_bytes(self.fixed()?))
    }

    /// A finite `f32`. `what` is the field's path, or the struct format letter where Python gave no path.
    pub fn f32(&mut self, what: fmt::Arguments<'_>) -> PyResult<f32> {
        let offset = self.pos;
        let value = f32::from_le_bytes(self.fixed()?);
        if !value.is_finite() {
            return Err(piv(format!("Non-finite {} at {:#x}", what, offset)));
        }
        Ok(value)
    }

    pub fn f64(&mut self, what: fmt::Arguments<'_>) -> PyResult<f64> {
        let offset = self.pos;
        let value = f64::from_le_bytes(self.fixed()?);
        if !value.is_finite() {
            return Err(piv(format!("Non-finite {} at {:#x}", what, offset)));
        }
        Ok(value)
    }

    /// The bytes of `count` values of `size` bytes each (`FastReader.array`).
    pub fn array(&mut self, count: usize, size: usize) -> PyResult<&'a [u8]> {
        let end = self.pos as u128 + (size as u128) * (count as u128);
        if end > self.data.len() as u128 {
            return Err(piv(format!("Unexpected array EOF at payload offset {:#x}", self.pos)));
        }
        let start = self.pos;
        self.pos = end as usize;
        Ok(&self.data[start..self.pos])
    }

    /// `count` `u16` values as numbers.
    pub fn u16_array(&mut self, count: usize) -> PyResult<Vec<u16>> {
        Ok(self.array(count, 2)?.as_chunks::<2>().0.iter().map(|pair| u16::from_le_bytes(*pair)).collect())
    }

    /// A length-prefixed Windows-1252 string.
    pub fn string8(&mut self) -> PyResult<String> {
        let length = self.u8()?;
        Ok(cp1252_decode(self.take(length as i128)?))
    }
}
