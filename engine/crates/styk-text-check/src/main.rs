//! `styk-text-check`: the typography check behind `cargo xtask fonts` (`docs/native/typography.md`).
//!
//! ```text
//! styk-text-check matrix <matrix.tsv>
//! styk-text-check sheet <matrix.tsv> <out-dir> <light|dark> <scale> [--no-font-gate]
//! styk-text-check bench <light|dark> <scale> <frames>
//! styk-text-check compare <matrix.tsv> <dir> <chromium|chromium-gray> <light|dark> <scale>
//! ```
//!
//! `matrix` writes what both renderers draw; `sheet` draws it in an iced window (off-screen under
//! `STYK_BACKGROUND_WINDOW=1`; `--no-font-gate` is the negative control of the font-readiness check) and writes `native-<theme>-<scale>*.png` and `.tsv`; `compare` sets those against
//! the files `fonts-chromium.mjs` wrote and prints the table, exiting 1 when a width or a font choice is out of
//! tolerance.

mod bench;
mod compare;
mod matrix;
mod sheet;

use std::path::Path;
use std::process::ExitCode;

const USAGE: &str = "usage: styk-text-check matrix <matrix.tsv> | sheet <matrix.tsv> <out-dir> <theme> <scale> | bench <theme> <scale> <frames> | compare <matrix.tsv> <dir> <chromium|chromium-gray> <theme> <scale>";

fn run(args: &[String]) -> Result<bool, String> {
    let scale = |text: &str| text.parse::<f32>().ok().filter(|scale| *scale > 0.0).ok_or_else(|| format!("not a scale: {text}"));
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["matrix", path] => {
            std::fs::write(path, matrix::to_tsv(&matrix::items())).map_err(|error| format!("{path}: {error}"))?;
            Ok(true)
        }
        ["sheet", matrix, out_dir, theme, factor] => sheet::run(Path::new(matrix), Path::new(out_dir), theme, scale(factor)?, true).map(|()| true),
        ["sheet", matrix, out_dir, theme, factor, "--no-font-gate"] => sheet::run(Path::new(matrix), Path::new(out_dir), theme, scale(factor)?, false).map(|()| true),
        ["bench", theme, factor, frames] => bench::run(theme, scale(factor)?, frames.parse::<usize>().map_err(|error| error.to_string())?).map(|()| true),
        ["compare", matrix, dir, chromium, theme, factor] => {
            let factor = scale(factor)?;
            let report = compare::compare(Path::new(matrix), Path::new(dir), chromium, &format!("{theme}-{factor}"), factor)?;
            print!("{}", report.text);
            Ok(report.widths_hold)
        }
        _ => Err(USAGE.to_string()),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(2)
        }
    }
}
