//! How the operating system smooths text: whether, with ClearType (subpixel) or grayscale, in which order the
//! display's subpixels run, and the contrast and gamma the person configured.
//!
//! The text stack draws text as the browser does (`docs/native/typography.md`, section 6), and the precedence is
//! Chromium's (`ui/gfx/font_render_params_win.cc`, `font_util_win.cc`):
//!
//! - font smoothing off (`SPI_GETFONTSMOOTHING`): text is drawn **aliased**, without antialiasing;
//! - smoothing on but not ClearType: grayscale;
//! - ClearType: the order of the subpixels is the primary display's `PixelStructure` in
//!   `HKCU\SOFTWARE\Microsoft\Avalon.Graphics\<display>` (0 none, which draws grayscale; 1 RGB; 2 BGR) when that is
//!   set, otherwise `SPI_GETFONTSMOOTHINGORIENTATION`, and no other value draws grayscale;
//! - the contrast and gamma of the coverage adjustment are DirectWrite's primary-display values when that registry key
//!   exists (the person has run the ClearType tuner), and the application's own defaults otherwise.
//!
//! Other targets have no such setting here and draw grayscale.

/// What the system does to the edges of text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Smoothing {
    /// No smoothing: text is aliased.
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
    /// The contrast the person configured for the primary display, when they did.
    pub contrast: Option<f32>,
    /// The gamma the person configured for the primary display, when they did.
    pub gamma: Option<f32>,
}

impl Default for FontSmoothing {
    /// Grayscale with no preferences: what a platform without the setting gets.
    fn default() -> Self {
        FontSmoothing { smoothing: Smoothing::Grayscale, order: SubpixelOrder::Rgb, contrast: None, gamma: None }
    }
}

/// The raw values Windows reports.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Raw {
    /// `SPI_GETFONTSMOOTHING`.
    pub enabled: bool,
    /// `SPI_GETFONTSMOOTHINGTYPE`: 1 standard, 2 ClearType.
    pub kind: u32,
    /// `SPI_GETFONTSMOOTHINGORIENTATION`: 0 BGR, 1 RGB, or `None` when the system could not say.
    pub orientation: Option<u32>,
    /// The primary display's `PixelStructure`, when it has one.
    pub pixel_structure: Option<u32>,
    /// DirectWrite's enhanced contrast and gamma for the primary display, when its registry key exists.
    pub configured: Option<(f32, f32)>,
}

/// The range Skia accepts for the contrast (`SkSurfaceProps`), and for the gamma.
const CONTRAST_RANGE: (f32, f32) = (0.0, 1.0);
const GAMMA_RANGE: (f32, f32) = (0.0, 3.999);

/// Turns the raw values into the system's smoothing.
pub fn decode(raw: Raw) -> FontSmoothing {
    let order = match raw.pixel_structure {
        Some(1) => Some(SubpixelOrder::Rgb),
        Some(2) => Some(SubpixelOrder::Bgr),
        // 0, or a value nobody defined: no subpixels, whatever the orientation says.
        Some(_) => None,
        None => match raw.orientation {
            Some(1) => Some(SubpixelOrder::Rgb),
            Some(0) => Some(SubpixelOrder::Bgr),
            _ => None,
        },
    };
    let smoothing = match (raw.enabled, raw.kind, order) {
        (false, _, _) => Smoothing::Off,
        (true, 2, Some(_)) => Smoothing::ClearType,
        (true, _, _) => Smoothing::Grayscale,
    };
    FontSmoothing {
        smoothing,
        order: order.unwrap_or(SubpixelOrder::Rgb),
        contrast: raw.configured.map(|(contrast, _)| contrast.clamp(CONTRAST_RANGE.0, CONTRAST_RANGE.1)),
        gamma: raw.configured.map(|(_, gamma)| gamma.clamp(GAMMA_RANGE.0, GAMMA_RANGE.1)),
    }
}

/// The system's text smoothing now.
pub fn current() -> FontSmoothing {
    imp::current()
}

#[cfg(windows)]
mod imp {
    use super::{FontSmoothing, Raw, decode};
    use windows::Win32::Graphics::DirectWrite::{DWRITE_FACTORY_TYPE_SHARED, DWriteCreateFactory, IDWriteFactory};
    use windows_sys::Win32::Graphics::Gdi::{DISPLAY_DEVICE_PRIMARY_DEVICE, DISPLAY_DEVICEW, EnumDisplayDevicesW};
    use windows_sys::Win32::System::Registry::{HKEY, HKEY_CURRENT_USER, KEY_READ, RRF_RT_REG_DWORD, RegCloseKey, RegGetValueW, RegOpenKeyExW};
    use windows_sys::Win32::UI::WindowsAndMessaging::{SPI_GETFONTSMOOTHING, SPI_GETFONTSMOOTHINGORIENTATION, SPI_GETFONTSMOOTHINGTYPE, SystemParametersInfoW};

    fn parameter(action: u32) -> Option<u32> {
        let mut value: u32 = 0;
        // SAFETY: the actions read one UINT or BOOL into the pointed-to u32, which outlives the call.
        let read = unsafe { SystemParametersInfoW(action, 0, (&mut value as *mut u32).cast(), 0) };
        (read != 0).then_some(value)
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The name of the primary display as the registry keys it by (`DISPLAY1` of `\\.\DISPLAY1`).
    fn primary_display() -> Option<String> {
        for index in 0.. {
            // SAFETY: a zeroed DISPLAY_DEVICEW with its size set, filled by the call.
            let mut device: DISPLAY_DEVICEW = unsafe { std::mem::zeroed() };
            device.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
            // SAFETY: `device` is valid for the call.
            if unsafe { EnumDisplayDevicesW(std::ptr::null(), index, &mut device, 0) } == 0 {
                return None;
            }
            if device.StateFlags & DISPLAY_DEVICE_PRIMARY_DEVICE != 0 {
                let end = device.DeviceName.iter().position(|unit| *unit == 0).unwrap_or(device.DeviceName.len());
                let name = String::from_utf16_lossy(&device.DeviceName[..end]);
                return name.rsplit('\\').next().map(str::to_owned);
            }
        }
        None
    }

    /// The primary display's ClearType tuner key, if the person has one: its `PixelStructure`, and whether it exists.
    fn tuner() -> Option<Option<u32>> {
        let key_name = wide(&format!("SOFTWARE\\Microsoft\\Avalon.Graphics\\{}", primary_display()?));
        let mut key: HKEY = std::ptr::null_mut();
        // SAFETY: a NUL-terminated name and an out pointer.
        if unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, key_name.as_ptr(), 0, KEY_READ, &mut key) } != 0 {
            return None;
        }
        let name = wide("PixelStructure");
        let mut value: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: `value` is a u32 of the `size` the call is told it has; the key is closed below.
        let status = unsafe { RegGetValueW(key, std::ptr::null(), name.as_ptr(), RRF_RT_REG_DWORD, std::ptr::null_mut(), (&mut value as *mut u32).cast(), &mut size) };
        // SAFETY: the key opened above.
        unsafe { RegCloseKey(key) };
        Some((status == 0).then_some(value))
    }

    /// DirectWrite's enhanced contrast and gamma for the primary display, which Chromium applies when the tuner key exists.
    fn directwrite_parameters() -> Option<(f32, f32)> {
        // SAFETY: plain DirectWrite calls on objects created here.
        unsafe {
            let factory: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED).ok()?;
            let parameters = factory.CreateRenderingParams().ok()?;
            Some((parameters.GetEnhancedContrast(), parameters.GetGamma()))
        }
    }

    pub fn current() -> FontSmoothing {
        let tuner = tuner();
        decode(Raw {
            enabled: parameter(SPI_GETFONTSMOOTHING).is_some_and(|value| value != 0),
            kind: parameter(SPI_GETFONTSMOOTHINGTYPE).unwrap_or(1),
            orientation: parameter(SPI_GETFONTSMOOTHINGORIENTATION),
            pixel_structure: tuner.flatten(),
            configured: tuner.and_then(|_| directwrite_parameters()),
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

    /// A default Windows: smoothing on, ClearType, RGB, nothing configured.
    const CLEARTYPE: Raw = Raw { enabled: true, kind: 2, orientation: Some(1), pixel_structure: None, configured: None };

    #[test]
    fn clear_type_on_a_default_system() {
        let smoothing = decode(CLEARTYPE);
        assert_eq!(smoothing.smoothing, Smoothing::ClearType);
        assert_eq!(smoothing.order, SubpixelOrder::Rgb);
        assert_eq!((smoothing.contrast, smoothing.gamma), (None, None), "nothing configured is no preference");
    }

    #[test]
    fn the_modes_and_the_system_orientation() {
        assert_eq!(decode(Raw { enabled: false, ..CLEARTYPE }).smoothing, Smoothing::Off, "smoothing off draws aliased text");
        assert_eq!(decode(Raw { enabled: false, kind: 1, ..CLEARTYPE }).smoothing, Smoothing::Off);
        assert_eq!(decode(Raw { kind: 1, ..CLEARTYPE }).smoothing, Smoothing::Grayscale);
        let bgr = decode(Raw { orientation: Some(0), ..CLEARTYPE });
        assert_eq!((bgr.smoothing, bgr.order), (Smoothing::ClearType, SubpixelOrder::Bgr));
        assert_eq!(decode(Raw { orientation: None, ..CLEARTYPE }).smoothing, Smoothing::Grayscale, "no orientation, no subpixels");
        assert_eq!(decode(Raw { orientation: Some(7), ..CLEARTYPE }).smoothing, Smoothing::Grayscale);
    }

    #[test]
    fn the_displays_pixel_structure_overrides_the_system_orientation() {
        // The system says RGB; the display's tuner says BGR, flat or nonsense.
        let bgr = decode(Raw { pixel_structure: Some(2), ..CLEARTYPE });
        assert_eq!((bgr.smoothing, bgr.order), (Smoothing::ClearType, SubpixelOrder::Bgr));
        let rgb = decode(Raw { pixel_structure: Some(1), orientation: Some(0), ..CLEARTYPE });
        assert_eq!((rgb.smoothing, rgb.order), (Smoothing::ClearType, SubpixelOrder::Rgb));
        assert_eq!(decode(Raw { pixel_structure: Some(0), ..CLEARTYPE }).smoothing, Smoothing::Grayscale, "flat: no subpixels");
        assert_eq!(decode(Raw { pixel_structure: Some(9), ..CLEARTYPE }).smoothing, Smoothing::Grayscale);
        // It does not turn smoothing on.
        assert_eq!(decode(Raw { enabled: false, pixel_structure: Some(2), ..CLEARTYPE }).smoothing, Smoothing::Off);
    }

    #[test]
    fn configured_contrast_and_gamma_are_taken_and_clamped() {
        let smoothing = decode(Raw { configured: Some((0.75, 1.9)), ..CLEARTYPE });
        assert_eq!((smoothing.contrast, smoothing.gamma), (Some(0.75), Some(1.9)));
        let wild = decode(Raw { configured: Some((7.0, 12.0)), ..CLEARTYPE });
        assert_eq!((wild.contrast, wild.gamma), (Some(1.0), Some(3.999)), "Skia's range");
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
