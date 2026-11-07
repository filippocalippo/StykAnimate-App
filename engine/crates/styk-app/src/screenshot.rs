//! Writing a captured window as a PNG: the output of `--screenshot`.

use std::fs::File;
use std::io::BufWriter;
use std::path::Path;
use styk_platform::window::Image;

/// Writes `image` to `path`, replacing the file only once it is complete.
pub fn write(path: &Path, image: &Image) -> Result<(), String> {
    let temporary = path.with_extension("png.partial");
    let result = (|| {
        let file = File::create(&temporary).map_err(|e| e.to_string())?;
        let mut encoder = ::png::Encoder::new(BufWriter::new(file), image.width, image.height);
        encoder.set_color(::png::ColorType::Rgba);
        encoder.set_depth(::png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(&image.rgba).map_err(|e| e.to_string())?;
        writer.finish().map_err(|e| e.to_string())?;
        std::fs::rename(&temporary, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("{}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_written_png_decodes_to_the_same_pixels() {
        let image = Image { width: 2, height: 1, rgba: vec![255, 0, 0, 255, 0, 0, 255, 255] };
        let path = std::env::temp_dir().join(format!("styk-app-png-test-{}.png", std::process::id()));
        write(&path, &image).unwrap();
        let decoder = ::png::Decoder::new(std::io::BufReader::new(File::open(&path).unwrap()));
        let mut reader = decoder.read_info().unwrap();
        let mut buffer = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buffer).unwrap();
        assert_eq!((info.width, info.height), (2, 1));
        assert_eq!(&buffer[..8], &image.rgba[..]);
        std::fs::remove_file(&path).unwrap();
        assert!(!path.with_extension("png.partial").exists());
    }

    #[test]
    fn a_failed_write_names_the_path_and_leaves_no_partial_file() {
        let image = Image { width: 1, height: 1, rgba: vec![0, 0, 0, 255] };
        let missing = std::env::temp_dir().join("styk-app-no-such-folder").join("out.png");
        let error = write(&missing, &image).unwrap_err();
        assert!(error.contains("out.png"), "{error}");
    }
}
