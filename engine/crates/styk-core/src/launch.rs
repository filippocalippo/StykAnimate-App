//! How the application was started: the command line.

use std::path::PathBuf;

/// The command line's shape, shown with every parse error.
pub const USAGE: &str = "usage: stykanimate [file...] [--automation <script>] [--screenshot <png>] [--screen <id>] [--input-check <json>] [--size WxH] [--scale <factor>] [--clock fixed|system] [--shell-check]
       (developer build) stykanimate --pen-lab [--self-test standard|blocked|behaviour|stress[:seconds]] [--out <folder>]";

/// Which clock the program runs on (`styk_services::clock`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ClockMode {
    /// The real, monotonic clock.
    #[default]
    System,
    /// A clock that moves only when a script advances it (`advance` in the automation language): the same frames every run.
    Fixed,
}

/// What the command line asked for.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Launch {
    #[cfg(feature = "devtools")]
    pub params: Vec<PathBuf>,
    #[cfg(feature = "devtools")]
    pub param: Vec<String>,
    /// Opt-in current-user developer control channel. Rejected by shipping builds.
    pub control: bool,
    /// The documents to open, in order (the Electron app opens every one it is given).
    pub files: Vec<PathBuf>,
    /// A script of timestamped steps to run against the real interface.
    pub automation: Option<PathBuf>,
    /// Write the window's first complete frame to this PNG and exit.
    pub screenshot: Option<PathBuf>,
    /// A screen of the screen catalogue to show instead of the application (`component-sheet`): how a part of the
    /// interface is looked at and tested on its own.
    pub screen: Option<String>,
    /// Developer build: drive the component sheet through the operating system's input path and write what happened
    /// to this JSON file, then exit.
    pub input_check: Option<PathBuf>,
    /// The clock: `--clock fixed` makes a run deterministic.
    pub clock: ClockMode,
    /// The window's logical size, instead of the default.
    pub size: Option<(u32, u32)>,
    /// The interface scale factor, instead of the display's.
    pub scale: Option<f64>,
    /// Run the shell's in-process checks against the real window (hit testing, minimum size, snap-zone placement,
    /// DPI change), print the results and exit with their status. Needs `STYK_BACKGROUND_WINDOW=1`.
    pub shell_check: bool,
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
                #[cfg(feature = "devtools")]
                "--param" => launch.param.push(value("--param")?),
                #[cfg(feature = "devtools")]
                "--params" => launch.params.push(PathBuf::from(value("--params")?)),
                "--control" => launch.control = true,
                "--automation" => launch.automation = Some(PathBuf::from(value("--automation")?)),
                "--screenshot" => launch.screenshot = Some(PathBuf::from(value("--screenshot")?)),
                "--screen" => launch.screen = Some(value("--screen")?),
                "--input-check" => launch.input_check = Some(PathBuf::from(value("--input-check")?)),
                "--size" => launch.size = Some(parse_size(&value("--size")?)?),
                "--scale" => launch.scale = Some(parse_scale(&value("--scale")?)?),
                "--clock" => {
                    launch.clock = match value("--clock")?.as_str() {
                        "fixed" => ClockMode::Fixed,
                        "system" => ClockMode::System,
                        other => return Err(LaunchError(format!("--clock wants fixed or system, not {other:?}"))),
                    }
                }
                "--shell-check" => launch.shell_check = true,
                "--pen-lab" => launch.pen_lab = true,
                "--self-test" => {
                    launch.pen_lab = true;
                    launch.self_test = Some(value("--self-test")?);
                }
                "--out" => launch.out = Some(PathBuf::from(value("--out")?)),
                other if other.starts_with("--") => return Err(LaunchError(format!("unknown option {other}"))),
                _ => {
                    launch.files.push(PathBuf::from(flag));
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
        assert_eq!(launch.files, vec![PathBuf::from("project.styk")]);
        assert_eq!(launch.automation, Some(PathBuf::from("run.json")));
        assert_eq!(launch.screenshot, Some(PathBuf::from("out.png")));
        assert_eq!(launch.size, Some((1280, 800)));
        assert_eq!(launch.scale, Some(1.5));
    }

    #[test]
    fn the_clock_is_the_system_one_unless_a_fixed_one_is_asked_for() {
        assert_eq!(parse(&[]).unwrap().clock, ClockMode::System);
        assert_eq!(parse(&["--clock", "fixed"]).unwrap().clock, ClockMode::Fixed);
        assert_eq!(parse(&["--clock=system"]).unwrap().clock, ClockMode::System);
        assert!(parse(&["--clock", "wall"]).unwrap_err().0.contains("fixed or system"));
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
        let launch = parse(&["--size=900X600", "--screenshot=a.png", "--screen=component-sheet", "doc.piv"]).unwrap();
        assert_eq!(launch.screen.as_deref(), Some("component-sheet"));
        assert_eq!(parse(&["--input-check", "report.json"]).unwrap().input_check, Some(PathBuf::from("report.json")));
        assert_eq!(launch.size, Some((900, 600)));
        assert_eq!(launch.screenshot, Some(PathBuf::from("a.png")));
        assert_eq!(launch.files, vec![PathBuf::from("doc.piv")]);
    }

    #[test]
    fn a_path_with_an_equals_sign_is_still_a_file() {
        assert_eq!(parse(&["C:/a=b/doc.piv"]).unwrap().files, vec![PathBuf::from("C:/a=b/doc.piv")]);
    }

    #[test]
    fn several_files_are_all_kept_in_order_as_the_electron_app_does() {
        let launch = parse(&["a.piv", "b.styk", "--size", "900x600", "c.stk"]).unwrap();
        assert_eq!(launch.files, vec![PathBuf::from("a.piv"), PathBuf::from("b.styk"), PathBuf::from("c.stk")]);
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
        ] {
            let error = parse(args).unwrap_err();
            assert!(error.0.contains(wanted), "{args:?}: {error}");
            assert!(error.to_string().contains("usage: stykanimate"));
        }
    }
}
