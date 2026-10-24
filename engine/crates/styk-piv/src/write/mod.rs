//! Writing Pivot 5 projects from an editable document.
//!
//! - [`frames`]: the frame table behind unchanged tables (the cheap, byte-preserving path);
//! - [`full`]: new background and figure tables, with IDs made dense;
//! - [`assets`]: the image and text tables of a figure;
//! - [`migrate`]: a Pivot 2-4 document as a Pivot 5 one.

pub(crate) mod assets;
pub(crate) mod frames;
pub(crate) mod full;
pub(crate) mod migrate;
