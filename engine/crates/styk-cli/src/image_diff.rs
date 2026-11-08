//! The differing-pixel fraction of the native screen catalogue (decision N8): a pixel differs when one of its channels
//! differs by more than [`TOLERANCE`], so anti-aliasing and text-edge noise do not count and a wrong size, colour, icon or
//! gap does. No threshold is inferred: the limit is the catalogue's.

/// The channel difference a pixel may have and still count as the same (the owner's rule: about 24 of 255).
pub const TOLERANCE: u8 = 24;

fn differs(a: &image::Rgba<u8>, b: &image::Rgba<u8>) -> bool {
    a.0.iter().zip(b.0.iter()).any(|(x, y)| x.abs_diff(*y) > TOLERANCE)
}

fn difference(a: &image::RgbaImage, b: &image::RgbaImage) -> Result<f64, String> {
    if a.dimensions() != b.dimensions() || a.is_empty() {
        return Err("screenshot: dimensions differ or image is empty".into());
    }
    let changed = a.pixels().zip(b.pixels()).filter(|(a, b)| differs(a, b)).count();
    Ok(changed as f64 / (u64::from(a.width()) * u64::from(a.height())) as f64)
}

pub fn run(args: &[String]) -> i32 {
    let result = (|| {
        let [reference, actual, limit] = args else { return Err("usage: styk image-diff <reference.png> <actual.png> <maximum differing-pixel fraction>".into()) };
        let limit: f64 = limit.parse().map_err(|_| "screenshot: invalid limit")?;
        if !limit.is_finite() || !(0.0..=1.0).contains(&limit) { return Err("screenshot: limit must be in [0, 1]".into()); }
        let read = |path| image::open(path).map(|image| image.to_rgba8()).map_err(|error| format!("screenshot: {path}: {error}"));
        let score = difference(&read(reference)?, &read(actual)?)?;
        println!("screenshot: differing-pixel fraction {score:.9}, maximum {limit:.9}");
        if score > limit { return Err("screenshot: difference exceeds the catalogue limit".into()); }
        Ok::<(), String>(())
    })();
    match result { Ok(()) => 0, Err(error) => { eprintln!("{error}"); 1 } }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn one_changed_pixel_is_half_of_a_two_pixel_image() {
        let a = image::RgbaImage::new(2, 1);
        let mut b = a.clone();
        assert_eq!(difference(&a, &b).unwrap(), 0.0);
        b.put_pixel(1, 0, image::Rgba([0, 0, 0, 255]));
        assert_eq!(difference(&a, &b).unwrap(), 0.5);
        assert!(difference(&a, &image::RgbaImage::new(1, 2)).is_err());
    }
    #[test]
    fn a_channel_difference_up_to_the_tolerance_is_the_same_pixel_and_one_more_differs() {
        let a = image::RgbaImage::from_pixel(1, 1, image::Rgba([100, 100, 100, 255]));
        let same = image::RgbaImage::from_pixel(1, 1, image::Rgba([124, 76, 100, 255]));
        let different = image::RgbaImage::from_pixel(1, 1, image::Rgba([125, 100, 100, 255]));
        assert_eq!(difference(&a, &same).unwrap(), 0.0, "24 levels on any channel is anti-aliasing noise");
        assert_eq!(difference(&a, &different).unwrap(), 1.0, "25 levels is a different pixel");
    }

    #[test]
    fn invalid_limits_and_missing_images_fail() {
        assert_eq!(run(&["missing.png".into(), "missing.png".into(), "NaN".into()]), 1);
        assert_eq!(run(&["missing.png".into(), "missing.png".into(), "0".into()]), 1);
    }

    #[test]
    fn the_command_exit_status_enforces_the_reference_limit() {
        let dir = std::env::temp_dir().join(format!("styk-image-diff-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let reference = dir.join("reference.png");
        let actual = dir.join("actual.png");
        let a = image::RgbaImage::new(2, 1);
        let mut b = a.clone();
        b.put_pixel(1, 0, image::Rgba([255, 0, 0, 255]));
        a.save(&reference).unwrap();
        b.save(&actual).unwrap();
        let args = |limit: &str| vec![reference.to_string_lossy().into_owned(), actual.to_string_lossy().into_owned(), limit.to_string()];
        assert_eq!(run(&args("0")), 1);
        assert_eq!(run(&args("0.5")), 0);
        std::fs::remove_file(reference).unwrap();
        std::fs::remove_file(actual).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
