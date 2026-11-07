//! How the application was started: the command line.

use std::path::PathBuf;

/// The command line's shape, shown with every parse error.
pub const USAGE: &str = "usage: stykanimate [file] [--automation <script>] [--screenshot <png>] [--size WxH] [--scale <factor>]
       (developer build) stykanimate --pen-lab [--self-test standard|blocked|behaviour|stress[:seconds]] [--out <folder>]";

/// What the command line asked for.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Launch {
    /// A document to open.
    pub file: Option<PathBuf>,
    /// A script of timestamped steps to run against the real interface.
    pub automation: Option<PathBuf>,
    /// Write the window's first complete frame to this PNG and exit.
    pub screenshot: Option<PathBuf>,
    /// The window's logical size, instead of the default.
    pub size: Option<(u32, u32)>,
    /// The interface scale factor, instead of the display's.
    pub scale: Option<f64>,
    /// Open the pen lab (developer build) instead of the application.
    pub pen_lab: bool,
    /// Run a pen-lab self-test: its kind and, optionally, its length in seconds.
    pub self_test: Option<String>,
    /// Where a self-test writes what it recorded.
    pub out: Option<PathBuf>,
}

/// A command line that cannot be run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchError(pub String);

impl std::fmt::Display for LaunchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}\n{USAGE}", self.0)
    }
}

impl std::error::Error for LaunchError {}

impl Launch {
    /// Reads the arguments after the program name.
    pub fn parse<I, S>(args: I) -> Result<Launch, LaunchError>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut launch = Launch::default();
        let mut args = args.into_iter().map(Into::into);
        while let Some(arg) = args.next() {
            let (flag, inline) = match arg.split_once('=') {
                Some((flag, value)) if flag.starts_with("--") => (flag.to_string(), Some(value.to_string())),
                _ => (arg, None),
            };
            let mut value = |name: &str| inline.clone().or_else(|| args.next()).ok_or_else(|| LaunchError(format!("{name} needs a value")));
            match flag.as_str() {
                "--automation" => launch.automation = Some(PathBuf::from(value("--automation")?)),
                "--screenshot" => launch.screenshot = Some(PathBuf::from(value("--screenshot")?)),
                "--size" => launch.size = Some(parse_size(&value("--size")?)?),
                "--scale" => launch.scale = Some(parse_scale(&value("--scale")?)?),
                "--pen-lab" => launch.pen_lab = true,
                "--self-test" => {
                    launch.pen_lab = true;
                    launch.self_test = Some(value("--self-test")?);
                }
                "--out" => launch.out = Some(PathBuf::from(value("--out")?)),
                other if other.starts_with("--") => return Err(LaunchError(format!("unknown option {other}"))),
                _ => {
                    if launch.file.is_some() {
                        return Err(LaunchError("only one file can be opened".into()));
                    }
                    launch.file = Some(PathBuf::from(flag));
                }
            }
        }
        Ok(launch)
    }
}

fn parse_size(text: &str) -> Result<(u32, u32), LaunchError> {
    let bad = || LaunchError(format!("--size wants WIDTHxHEIGHT in pixels, not {text:?}"));
    let (width, height) = text.split_once(['x', 'X']).ok_or_else(bad)?;
    match (width.trim().parse::<u32>(), height.trim().parse::<u32>()) {
        (Ok(width), Ok(height)) if width > 0 && height > 0 => Ok((width, height)),
        _ => Err(bad()),
    }
}

fn parse_scale(text: &str) -> Result<f64, LaunchError> {
    match text.trim().parse::<f64>() {
        Ok(scale) if scale.is_finite() && scale > 0.0 => Ok(scale),
        _ => Err(LaunchError(format!("--scale wants a positive number, not {text:?}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Launch, LaunchError> {
        Launch::parse(args.iter().copied())
    }

    #[test]
    fn no_arguments_is_a_plain_start() {
        assert_eq!(parse(&[]).unwrap(), Launch::default());
    }

    #[test]
    fn every_option_is_read() {
        let launch = parse(&["project.styk", "--automation", "run.json", "--screenshot", "out.png", "--size", "1280x800", "--scale", "1.5"]).unwrap();
        assert_eq!(launch.file, Some(PathBuf::from("project.styk")));
        assert_eq!(launch.automation, Some(PathBuf::from("run.json")));
        assert_eq!(launch.screenshot, Some(PathBuf::from("out.png")));
        assert_eq!(launch.size, Some((1280, 800)));
        assert_eq!(launch.scale, Some(1.5));
    }

    #[test]
    fn the_pen_lab_and_its_self_test_are_read() {
        let launch = parse(&["--pen-lab", "--out", "lab"]).unwrap();
        assert!(launch.pen_lab && launch.self_test.is_none());
        assert_eq!(launch.out, Some(PathBuf::from("lab")));
        let launch = parse(&["--self-test=standard:5"]).unwrap();
        assert!(launch.pen_lab, "a self-test opens the lab");
        assert_eq!(launch.self_test.as_deref(), Some("standard:5"));
    }

    #[test]
    fn options_may_use_equals_and_come_before_the_file() {
        let launch = parse(&["--size=900X600", "--screenshot=a.png", "doc.piv"]).unwrap();
        assert_eq!(launch.size, Some((900, 600)));
        assert_eq!(launch.screenshot, Some(PathBuf::from("a.png")));
        assert_eq!(launch.file, Some(PathBuf::from("doc.piv")));
    }

    #[test]
    fn a_path_with_an_equals_sign_is_still_a_file() {
        assert_eq!(parse(&["C:/a=b/doc.piv"]).unwrap().file, Some(PathBuf::from("C:/a=b/doc.piv")));
    }

    #[test]
    fn bad_command_lines_say_what_is_wrong() {
        for (args, wanted) in [
            (&["--size"][..], "--size needs a value"),
            (&["--size", "800"][..], "WIDTHxHEIGHT"),
            (&["--size", "0x600"][..], "WIDTHxHEIGHT"),
            (&["--scale", "0"][..], "positive number"),
            (&["--scale", "fast"][..], "positive number"),
            (&["--sizes", "1x1"][..], "unknown option --sizes"),
            (&["a.piv", "b.piv"][..], "only one file"),
        ] {
            let error = parse(args).unwrap_err();
            assert!(error.0.contains(wanted), "{args:?}: {error}");
            assert!(error.to_string().contains("usage: stykanimate"));
        }
    }
}
