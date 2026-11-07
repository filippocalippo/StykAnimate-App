//! How the operating system smooths text: whether, with ClearType (subpixel) or grayscale, in which order the
//! display's subpixels run, and the contrast and gamma it asks for.
//!
//! The text stack draws subpixel text only when the person's system does, as the browser does
//! (`docs/native/typography.md`, section 6): the settings are the ones of Windows' "Adjust ClearType text" and
//! "Smooth edges of screen fonts" (`SPI_GETFONTSMOOTHING*`, the registry's `FontSmoothingGamma`). Other targets have no
//! such setting here and draw grayscale.

/// What the system does to the edges of text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Smoothing {
    /// No smoothing.
    Off,
    /// Grayscale antialiasing.
    Grayscale,
    /// ClearType: antialiasing with the display's subpixels.
    ClearType,
}

/// The order of the display's subpixels, left to right.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubpixelOrder {
    /// Red, green, blue.
    Rgb,
    /// Blue, green, red.
    Bgr,
}

/// The system's text smoothing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FontSmoothing {
    /// What is done to the edges of text.
    pub smoothing: Smoothing,
    /// The order of the display's subpixels.
    pub order: SubpixelOrder,
    /// The ClearType contrast (`SPI_GETFONTSMOOTHINGCONTRAST` / 1000, 1 to 2.2), when the system has one.
    pub contrast: Option<f32>,
    /// The ClearType gamma (the registry's `FontSmoothingGamma` / 1000, 1 to 2.2), when the person set one.
    pub gamma: Option<f32>,
}

impl Default for FontSmoothing {
    /// Grayscale with no preferences: what a platform without the setting gets.
    fn default() -> Self {
        FontSmoothing { smoothing: Smoothing::Grayscale, order: SubpixelOrder::Rgb, contrast: None, gamma: None }
    }
}

/// The raw values Windows reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Raw {
    /// `SPI_GETFONTSMOOTHING`.
    pub enabled: bool,
    /// `SPI_GETFONTSMOOTHINGTYPE`: 1 standard, 2 ClearType.
    pub kind: u32,
    /// `SPI_GETFONTSMOOTHINGORIENTATION`: 0 BGR, 1 RGB.
    pub orientation: u32,
    /// `SPI_GETFONTSMOOTHINGCONTRAST`: 1000 to 2200, or 0.
    pub contrast: u32,
    /// The registry's `FontSmoothingGamma`: 1000 to 2200, or 0 when unset.
    pub gamma: u32,
}

/// Turns the raw values into the system's smoothing.
pub fn decode(raw: Raw) -> FontSmoothing {
    let thousandths = |value: u32| (1000..=2200).contains(&value).then(|| value as f32 / 1000.0);
    FontSmoothing {
        smoothing: match (raw.enabled, raw.kind) {
            (false, _) => Smoothing::Off,
            (true, 2) => Smoothing::ClearType,
            (true, _) => Smoothing::Grayscale,
        },
        order: if raw.orientation == 0 { SubpixelOrder::Bgr } else { SubpixelOrder::Rgb },
        contrast: thousandths(raw.contrast),
        gamma: thousandths(raw.gamma),
    }
}

/// The system's text smoothing now.
pub fn current() -> FontSmoothing {
    imp::current()
}

#[cfg(windows)]
mod imp {
    use super::{FontSmoothing, Raw, decode};
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW};
    use windows_sys::Win32::UI::WindowsAndMessaging::{SPI_GETFONTSMOOTHING, SPI_GETFONTSMOOTHINGCONTRAST, SPI_GETFONTSMOOTHINGORIENTATION, SPI_GETFONTSMOOTHINGTYPE, SystemParametersInfoW};

    fn parameter(action: u32) -> Option<u32> {
        let mut value: u32 = 0;
        // SAFETY: the actions read one UINT or BOOL into the pointed-to u32, which outlives the call.
        let read = unsafe { SystemParametersInfoW(action, 0, (&mut value as *mut u32).cast(), 0) };
        (read != 0).then_some(value)
    }

    fn gamma() -> u32 {
        let key: Vec<u16> = "Control Panel\\Desktop\0".encode_utf16().collect();
        let name: Vec<u16> = "FontSmoothingGamma\0".encode_utf16().collect();
        let mut value: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: both names are NUL-terminated UTF-16, and `value` is a u32 of the `size` the call is told it has.
        let status = unsafe { RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), RRF_RT_REG_DWORD, std::ptr::null_mut(), (&mut value as *mut u32).cast(), &mut size) };
        if status == 0 { value } else { 0 }
    }

    pub fn current() -> FontSmoothing {
        decode(Raw {
            enabled: parameter(SPI_GETFONTSMOOTHING).is_some_and(|value| value != 0),
            kind: parameter(SPI_GETFONTSMOOTHINGTYPE).unwrap_or(1),
            orientation: parameter(SPI_GETFONTSMOOTHINGORIENTATION).unwrap_or(1),
            contrast: parameter(SPI_GETFONTSMOOTHINGCONTRAST).unwrap_or(0),
            gamma: gamma(),
        })
    }
}

#[cfg(not(windows))]
mod imp {
    use super::FontSmoothing;

    pub fn current() -> FontSmoothing {
        FontSmoothing::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLEARTYPE: Raw = Raw { enabled: true, kind: 2, orientation: 1, contrast: 1200, gamma: 0 };

    #[test]
    fn clear_type_on_a_default_system() {
        let smoothing = decode(CLEARTYPE);
        assert_eq!(smoothing.smoothing, Smoothing::ClearType);
        assert_eq!(smoothing.order, SubpixelOrder::Rgb);
        assert_eq!(smoothing.contrast, Some(1.2));
        assert_eq!(smoothing.gamma, None, "an unset gamma is no preference");
    }

    #[test]
    fn the_other_modes_and_orders() {
        assert_eq!(decode(Raw { enabled: false, ..CLEARTYPE }).smoothing, Smoothing::Off);
        assert_eq!(decode(Raw { kind: 1, ..CLEARTYPE }).smoothing, Smoothing::Grayscale);
        assert_eq!(decode(Raw { orientation: 0, ..CLEARTYPE }).order, SubpixelOrder::Bgr);
        assert_eq!(decode(Raw { gamma: 1800, contrast: 0, ..CLEARTYPE }).gamma, Some(1.8));
        assert_eq!(decode(Raw { contrast: 0, ..CLEARTYPE }).contrast, None);
        assert_eq!(decode(Raw { contrast: 5000, ..CLEARTYPE }).contrast, None, "a value outside the range is no preference");
    }

    #[test]
    fn the_system_can_be_read() {
        // Whatever the machine says, reading it does not fail; other targets report the grayscale default.
        let smoothing = current();
        #[cfg(not(windows))]
        assert_eq!(smoothing, FontSmoothing::default());
        let _ = smoothing;
    }
}
