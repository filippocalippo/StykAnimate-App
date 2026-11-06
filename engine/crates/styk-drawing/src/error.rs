//! Errors carry the editor's localized message keys (`errors.drawingFill.invalidFillBounds`),
//! so the JavaScript side rethrows the message users already see for the same failure.

use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DrawingError {
    /// The localization key of the editor's message for this failure.
    pub key: &'static str,
    /// An `AbortError` (cancellation) rather than a failure.
    pub abort: bool,
}

impl DrawingError {
    pub const fn new(key: &'static str) -> DrawingError {
        DrawingError { key, abort: false }
    }
}

impl fmt::Display for DrawingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.key)
    }
}

impl std::error::Error for DrawingError {}

pub type Result<T> = std::result::Result<T, DrawingError>;

/// `Err(DrawingError::new(key))`.
#[inline]
pub fn fail<T>(key: &'static str) -> Result<T> {
    Err(DrawingError::new(key))
}

pub const WORKING_MEMORY: &str = "errors.drawingController.theStrokeExceedsTheDrawingWorkingMemoryLimit";
pub const FILL_MEMORY: &str = "errors.drawingCompositeTransport.theFillExceedsTheDrawingWorkingMemoryLimit";
pub const SELECTION_MEMORY: &str = "errors.drawingLasso.theSelectionExceedsTheDrawingWorkingMemoryLimit";
pub const TRANSFORM_MEMORY: &str = "errors.drawingTransform.theTransformExceedsTheDrawingWorkingMemoryLimit";
pub const COORDINATES: &str = "errors.drawingTiles.drawingCoordinatesExceedTheFileFormatRange";
