//! What the system says about the person's setup that the interface prepares for before its first frame: the language
//! of their account and the scale of their display.

/// The language of the person's account as a BCP 47 tag (`it-IT`), or an empty string when the system does not say.
pub fn user_locale() -> String {
    imp::user_locale()
}

/// The scale the system gives its primary display (1.0 at 96 dpi, 1.5 at 144), 1.0 when it does not say.
pub fn system_scale() -> f32 {
    imp::system_scale()
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;
    use windows_sys::Win32::UI::HiDpi::GetDpiForSystem;

    pub fn user_locale() -> String {
        let mut name = [0u16; 85];
        // SAFETY: the buffer is LOCALE_NAME_MAX_LENGTH (85) units, as the call requires.
        let length = unsafe { GetUserDefaultLocaleName(name.as_mut_ptr(), name.len() as i32) };
        if length <= 1 {
            return String::new();
        }
        String::from_utf16_lossy(&name[..length as usize - 1])
    }

    pub fn system_scale() -> f32 {
        // SAFETY: no arguments.
        let dpi = unsafe { GetDpiForSystem() };
        if dpi == 0 { 1.0 } else { dpi as f32 / 96.0 }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn user_locale() -> String {
        String::new()
    }

    pub fn system_scale() -> f32 {
        1.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_locale_and_the_scale_are_plausible() {
        let scale = system_scale();
        assert!((1.0..=5.0).contains(&scale), "{scale}");
        let locale = user_locale();
        assert!(locale.len() <= 84 && !locale.contains('\0'), "{locale:?}");
    }
}
