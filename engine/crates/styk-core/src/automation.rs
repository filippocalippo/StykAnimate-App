//! The automation mode's scripts: what `stykanimate --automation <script>` reads.
//!
//! A script is a list of steps, one per line, run in order against the real interface through the same events and
//! commands the interface sends (`docs/native/architecture.md`). This is the app's one automation language and the only
//! parser any part of the app uses: each feature adds its own step variants here (the stage's pointer and pen steps
//! come with the stage), and the step types are `#[non_exhaustive]` so adding one breaks no runner.
//!
//! The first line may be the version header `styk-auto/1`; a script without one is read as version 1, and a header
//! naming another version is refused, so a later change to the language can be told apart. Blank lines and lines
//! starting with `#` are ignored. A script is at most [`MAX_SCRIPT_BYTES`] long. This is the shell's part of the
//! language: opening projects, pressing the band's controls, keys, dragging a tab, resizing, a session, and what must be
//! true afterwards.
//!
//! ```text
//! styk-auto/1
//! open tests/containers/project-channels.styk
//! key ctrl+tab:hold
//! key release-ctrl
//! drag-tab 1 3 after
//! click workspace:draw
//! resize 900 700
//! expect order 2,3,1
//! screenshot out/band.png
//! ```
//!
//! Tabs are numbered from 1 in the order the projects were opened, and keep their number when they move.

use crate::stage::input::{Button, Pointer, PointerPhase};
use std::path::PathBuf;
use styk_services::input::{Modifiers, PenButtons, PenSample, Phase, Tool, Valid};

/// The version header a script may start with.
pub const HEADER: &str = "styk-auto/1";

/// The longest script that is read (64 KiB): a script is a short list of steps, and the parser holds all of it.
pub const MAX_SCRIPT_BYTES: usize = 64 * 1024;

/// A control a script can press.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Target {
    /// A project's tab, by the number it was opened under.
    Tab(usize),
    /// New animation.
    New,
    /// Home.
    Home,
    /// The mark.
    Mark,
    /// Undo.
    Undo,
    /// Redo.
    Redo,
    /// Save.
    Save,
    /// Export.
    Export,
    /// A workspace by name: `animate`, `draw` or `build`.
    Workspace(String),
}

/// A key a script can press.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Key {
    /// Ctrl+Tab (Shift for backwards), with the modifier held or already released.
    CtrlTab {
        /// Shift+Ctrl+Tab.
        backwards: bool,
        /// The modifier stays down.
        held: bool,
    },
    /// The modifier of the Ctrl+Tab board goes up.
    ReleaseCtrl,
    /// Tab (Shift for backwards) while the board shows.
    Tab {
        /// Shift+Tab.
        backwards: bool,
    },
    /// Escape.
    Escape,
    /// Ctrl+Page Up and Ctrl+Page Down: the neighbouring tab.
    Neighbour(isize),
}

/// What a script says must be true.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Expect {
    /// The tab in front, by number.
    Front(usize),
    /// The tabs' order, by number.
    Order(Vec<usize>),
    /// How many tabs show in the band.
    Tabs(usize),
    /// The workspace pressed in the switch.
    Workspace(String),
    /// The fold steps in force, by name (empty: none).
    Folds(Vec<String>),
    /// Whether the Ctrl+Tab board shows.
    Board(bool),
    /// Whether a tab shows the dot for unsaved changes.
    Dirty(usize, bool),
    /// Export's look: `primary` or `ghost`.
    Export(String),
    /// A tab's dot, by number: `none`, `edited`, `saving` or `saved`.
    Tab(usize, String),
    /// The window's width as the shell knows it, in logical pixels.
    Width(u32),
}

/// One step.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum Step {
    /// Stage navigation in logical stage pixels.
    Pan([f64; 2]),
    Zoom {
        factor: f64,
        at: [f64; 2],
    },
    Pointer(Pointer),
    /// Logical stage coordinates; the runner supplies the shared clock timestamp.
    Pen(PenSample),
    Frame(f64),
    /// Consecutive playback requests, wrapping at the document's end.
    Play {
        from: f64,
        frames: u32,
    },
    Measure(String),
    /// Open a project file (relative to the script).
    Open(PathBuf),
    /// Let this many frames pass.
    Wait(u32),
    /// Resize the window to this logical size.
    Resize(u32, u32),
    /// Switch the theme: `light` or `dark`.
    Theme(String),
    /// The band is a session of this: `none`, `build`, `movieclip` or `camera`.
    Session(String),
    /// Press a control.
    Click(Target),
    /// Press a key.
    Key(Key),
    /// Drag a tab onto the near or far half of another.
    DragTab {
        /// The tab dragged.
        from: usize,
        /// The tab it is dropped on.
        to: usize,
        /// The far half (`after`) or the near (`before`).
        after: bool,
    },
    /// An edit that makes the project in front unsaved: sets its frame rate.
    Edit(u32),
    /// Move the fixed clock (`--clock fixed`) forward by this many nanoseconds; with the system clock it is an error.
    Advance(u64),
    /// Stand in for K-doc's save: a save of the project in front landed now.
    SaveLanded,
    /// Check something.
    Expect(Expect),
    /// Write the window to a PNG (relative to the script).
    Screenshot(PathBuf),
}

/// A script that cannot be run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScriptError {
    /// The line, from 1.
    pub line: usize,
    /// What is wrong.
    pub message: String,
}

impl std::fmt::Display for ScriptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "line {}: {}", self.line, self.message)
    }
}

impl std::error::Error for ScriptError {}

/// A script: its steps with the line each came from.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Script {
    /// The steps in order, each with its line.
    pub steps: Vec<(usize, Step)>,
}

fn number(text: &str, line: usize, what: &str) -> Result<usize, ScriptError> {
    text.parse::<usize>()
        .ok()
        .filter(|n| *n >= 1)
        .ok_or_else(|| ScriptError {
            line,
            message: format!("{what} wants a number from 1, not {text:?}"),
        })
}

fn target(text: &str, line: usize) -> Result<Target, ScriptError> {
    Ok(match text {
        "new" => Target::New,
        "home" => Target::Home,
        "mark" => Target::Mark,
        "undo" => Target::Undo,
        "redo" => Target::Redo,
        "save" => Target::Save,
        "export" => Target::Export,
        other => match other.split_once(':') {
            Some(("tab", n)) => Target::Tab(number(n, line, "tab")?),
            Some(("workspace", name)) if ["animate", "draw", "build"].contains(&name) => {
                Target::Workspace(name.to_string())
            }
            _ => {
                return Err(ScriptError {
                    line,
                    message: format!(
                        "cannot click {other:?}: it is tab:<n>, workspace:<animate|draw|build>, new, home, mark, undo, redo, save or export"
                    ),
                });
            }
        },
    })
}

fn key(text: &str, line: usize) -> Result<Key, ScriptError> {
    Ok(match text {
        "ctrl+tab" => Key::CtrlTab {
            backwards: false,
            held: false,
        },
        "ctrl+tab:hold" => Key::CtrlTab {
            backwards: false,
            held: true,
        },
        "ctrl+shift+tab" => Key::CtrlTab {
            backwards: true,
            held: false,
        },
        "ctrl+shift+tab:hold" => Key::CtrlTab {
            backwards: true,
            held: true,
        },
        "release-ctrl" => Key::ReleaseCtrl,
        "tab" => Key::Tab { backwards: false },
        "shift+tab" => Key::Tab { backwards: true },
        "escape" => Key::Escape,
        "ctrl+pagedown" => Key::Neighbour(1),
        "ctrl+pageup" => Key::Neighbour(-1),
        other => {
            return Err(ScriptError {
                line,
                message: format!("unknown key {other:?}"),
            });
        }
    })
}

fn expectation(words: &[&str], line: usize) -> Result<Expect, ScriptError> {
    let bad = |message: &str| ScriptError {
        line,
        message: message.to_string(),
    };
    Ok(match words {
        ["front", n] => Expect::Front(number(n, line, "front")?),
        ["order", list] => Expect::Order(
            list.split(',')
                .map(|n| number(n, line, "order"))
                .collect::<Result<_, _>>()?,
        ),
        ["tabs", n] => Expect::Tabs(n.parse().map_err(|_| bad("tabs wants a count"))?),
        ["workspace", name] if ["animate", "draw", "build", "home"].contains(name) => {
            Expect::Workspace((*name).to_string())
        }
        ["folds", "none"] => Expect::Folds(Vec::new()),
        ["folds", list] => Expect::Folds(list.split(',').map(str::to_string).collect()),
        ["board", "open"] => Expect::Board(true),
        ["board", "closed"] => Expect::Board(false),
        ["dirty", n, "yes"] => Expect::Dirty(number(n, line, "dirty")?, true),
        ["dirty", n, "no"] => Expect::Dirty(number(n, line, "dirty")?, false),
        ["export", look @ ("primary" | "ghost")] => Expect::Export((*look).to_string()),
        ["tab", n, state @ ("none" | "edited" | "saving" | "saved")] => {
            Expect::Tab(number(n, line, "tab")?, (*state).to_string())
        }
        ["width", n] => Expect::Width(n.parse().map_err(|_| bad("width wants a number"))?),
        _ => {
            return Err(bad(
                "expect wants: front <n>, order <n,n,..>, tabs <count>, workspace <name>, folds <list|none>, board <open|closed>, dirty <n> <yes|no>, tab <n> <none|edited|saving|saved>, export <primary|ghost> or width <n>",
            ));
        }
    })
}

impl Script {
    /// Reads a script's text.
    pub fn parse(text: &str) -> Result<Script, ScriptError> {
        if text.len() > MAX_SCRIPT_BYTES {
            return Err(ScriptError {
                line: 1,
                message: format!(
                    "the script is {} bytes: scripts are at most {MAX_SCRIPT_BYTES}",
                    text.len()
                ),
            });
        }
        let mut steps = Vec::new();
        let mut header_allowed = true;
        for (index, raw) in text.lines().enumerate() {
            let line = index + 1;
            let content = raw.trim();
            if content.is_empty() || content.starts_with('#') {
                continue;
            }
            // Only the first line can be the header.
            let first = std::mem::replace(&mut header_allowed, false);
            if content.starts_with("styk-auto/") {
                if first && line == 1 && content == HEADER {
                    continue;
                }
                return Err(ScriptError {
                    line,
                    message: if first && line == 1 {
                        format!("unknown script version {content:?}: this program reads {HEADER}")
                    } else {
                        "the version header is only allowed on the first line".to_string()
                    },
                });
            }
            let (verb, rest) = content
                .split_once(char::is_whitespace)
                .map_or((content, ""), |(verb, rest)| (verb, rest.trim()));
            let words: Vec<&str> = rest.split_whitespace().collect();
            let wants = |what: &str| ScriptError {
                line,
                message: format!("{verb} wants {what}"),
            };
            let step = match verb {
                "pan" => match words.as_slice() {
                    [x, y] => Step::Pan([finite(x, line)?, finite(y, line)?]),
                    _ => return Err(wants("<dx> <dy>")),
                },
                "zoom" => match words.as_slice() {
                    [factor, x, y] if finite(factor, line)? > 0.0 => Step::Zoom {
                        factor: finite(factor, line)?,
                        at: [finite(x, line)?, finite(y, line)?],
                    },
                    _ => return Err(wants("<positive factor> <x> <y>")),
                },
                "frame" => match words.as_slice() {
                    [tick] if finite(tick, line)? >= 0.0 => Step::Frame(finite(tick, line)?),
                    _ => return Err(wants("<nonnegative tick>")),
                },
                "play" => match words.as_slice() {
                    [from, count] if finite(from, line)? >= 0.0 => Step::Play {
                        from: finite(from, line)?,
                        frames: count
                            .parse::<u32>()
                            .ok()
                            .filter(|n| *n > 0 && *n <= 1_000_000)
                            .ok_or_else(|| wants("<from> <1..1000000 frames>"))?,
                    },
                    _ => return Err(wants("<from> <frames>")),
                },
                "measure" if words.len() == 1 => Step::Measure(words[0].to_string()),
                "pointer" => match words.as_slice() {
                    [id, phase, button, x, y] => Step::Pointer(Pointer {
                        id: id.parse().map_err(|_| wants("an unsigned pointer id"))?,
                        phase: match *phase {
                            "down" => PointerPhase::Down,
                            "move" => PointerPhase::Move,
                            "up" => PointerPhase::Up,
                            "cancel" => PointerPhase::Cancel,
                            _ => return Err(wants("down|move|up|cancel")),
                        },
                        button: match *button {
                            "left" => Button::Left,
                            "middle" => Button::Middle,
                            "right" => Button::Right,
                            _ => return Err(wants("left|middle|right")),
                        },
                        point: [finite(x, line)?, finite(y, line)?],
                        modifiers: Modifiers::NONE,
                    }),
                    _ => return Err(wants("<id> <phase> <button> <x> <y>")),
                },
                "pen" => match words.as_slice() {
                    [id, phase, tool, x, y, pressure] => {
                        let pressure = finite(pressure, line)?;
                        if !(0.0..=1.0).contains(&pressure) {
                            return Err(wants("pressure in 0..1"));
                        }
                        let mut sample = PenSample::at(
                            0,
                            id.parse().map_err(|_| wants("an unsigned pointer id"))?,
                            match *tool {
                                "pen" => Tool::Pen,
                                "eraser" => Tool::Eraser,
                                _ => return Err(wants("pen|eraser")),
                            },
                            finite(x, line)?,
                            finite(y, line)?,
                        );
                        sample.phase = match *phase {
                            "hover" => Phase::Hover,
                            "down" => Phase::Down,
                            "move" => Phase::Move,
                            "up" => Phase::Up,
                            _ => return Err(wants("hover|down|move|up")),
                        };
                        sample.pressure = pressure as f32;
                        sample.valid = Valid::PRESSURE;
                        if matches!(sample.phase, Phase::Down | Phase::Move) {
                            sample.buttons = PenButtons::TIP;
                        }
                        Step::Pen(sample)
                    }
                    _ => return Err(wants("<id> <phase> <pen|eraser> <x> <y> <pressure>")),
                },
                "open" if !rest.is_empty() => Step::Open(PathBuf::from(rest)),
                "open" => return Err(wants("a path")),
                "wait" => Step::Wait(
                    words
                        .first()
                        .and_then(|w| w.parse().ok())
                        .ok_or_else(|| wants("a number of frames"))?,
                ),
                "resize" => match words.as_slice() {
                    [w, h] => Step::Resize(
                        w.parse().map_err(|_| wants("a width and a height"))?,
                        h.parse().map_err(|_| wants("a width and a height"))?,
                    ),
                    _ => return Err(wants("a width and a height")),
                },
                "theme" => match words.as_slice() {
                    [name @ ("light" | "dark")] => Step::Theme((*name).to_string()),
                    _ => return Err(wants("light or dark")),
                },
                "session" => match words.as_slice() {
                    [name @ ("none" | "build" | "movieclip" | "camera")] => {
                        Step::Session((*name).to_string())
                    }
                    _ => return Err(wants("none, build, movieclip or camera")),
                },
                "click" => Step::Click(target(
                    words.first().copied().ok_or_else(|| wants("a control"))?,
                    line,
                )?),
                "key" => Step::Key(key(
                    words.first().copied().ok_or_else(|| wants("a key"))?,
                    line,
                )?),
                "drag-tab" => match words.as_slice() {
                    [from, to, side @ ("before" | "after")] => Step::DragTab {
                        from: number(from, line, "drag-tab")?,
                        to: number(to, line, "drag-tab")?,
                        after: *side == "after",
                    },
                    _ => return Err(wants("<from> <to> <before|after>")),
                },
                "advance" => Step::Advance(
                    words
                        .first()
                        .and_then(|w| w.parse().ok())
                        .ok_or_else(|| wants("a number of nanoseconds"))?,
                ),
                "save-landed" => Step::SaveLanded,
                "edit" => Step::Edit(
                    words
                        .first()
                        .and_then(|w| w.parse().ok())
                        .ok_or_else(|| wants("a frame rate"))?,
                ),
                "expect" => Step::Expect(expectation(&words, line)?),
                "screenshot" if !rest.is_empty() => Step::Screenshot(PathBuf::from(rest)),
                "screenshot" => return Err(wants("a path")),
                other => {
                    return Err(ScriptError {
                        line,
                        message: format!("unknown step {other:?}"),
                    });
                }
            };
            steps.push((line, step));
        }
        Ok(Script { steps })
    }
}

fn finite(text: &str, line: usize) -> Result<f64, ScriptError> {
    text.parse::<f64>()
        .ok()
        .filter(|x| x.is_finite())
        .ok_or_else(|| ScriptError {
            line,
            message: format!("expected finite number, got {text:?}"),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_steps_share_the_versioned_shell_script() {
        let script=Script::parse("styk-auto/1\nopen scene_a\nadvance 16000000\npan 3 -2\nzoom 1.2 100 200\npointer 7 cancel middle 1.5 2.5\npen 8 down eraser 3 4 0.75\nframe 1.25\nplay 100 120\nmeasure frame_time\n").unwrap();
        assert_eq!(script.steps[2].1, Step::Pan([3., -2.]));
        assert!(matches!(
            script.steps[4].1,
            Step::Pointer(Pointer {
                id: 7,
                phase: PointerPhase::Cancel,
                ..
            })
        ));
        assert!(matches!(
            script.steps[5].1,
            Step::Pen(PenSample {
                pointer: 8,
                tool: Tool::Eraser,
                pressure: 0.75,
                phase: Phase::Down,
                ..
            })
        ));
        assert_eq!(script.steps[6].1, Step::Frame(1.25));
        assert_eq!(
            script.steps[7].1,
            Step::Play {
                from: 100.,
                frames: 120
            }
        );
        for bad in [
            "pan NaN 2",
            "zoom 0 0 0",
            "frame -1",
            "play 0 0",
            "pen 1 down pen 0 0 2",
            "pointer 1 lost middle 0 0",
        ] {
            assert!(Script::parse(bad).is_err(), "{bad}");
        }
        Script::parse(include_str!(
            "../../../../docs/native/scenarios/stage.styk-auto"
        ))
        .unwrap();
    }

    #[test]
    fn a_script_reads_every_step_and_skips_comments_and_blank_lines() {
        let script = Script::parse(
            "# two projects\nopen a.styk\n\nopen b.styk\nwait 2\nkey ctrl+tab:hold\nkey release-ctrl\ndrag-tab 1 3 after\nclick workspace:draw\nclick tab:2\nresize 900 700\ntheme dark\nsession build\nedit 30\nexpect order 2,3,1\nexpect folds tight,name\nexpect folds none\nscreenshot out/a.png\n",
        )
        .expect("it parses");
        let steps: Vec<&Step> = script.steps.iter().map(|(_, step)| step).collect();
        assert_eq!(steps[0], &Step::Open(PathBuf::from("a.styk")));
        assert_eq!(
            script.steps[0].0, 2,
            "lines count from 1, comments included"
        );
        assert_eq!(steps[2], &Step::Wait(2));
        assert_eq!(
            steps[3],
            &Step::Key(Key::CtrlTab {
                backwards: false,
                held: true
            })
        );
        assert_eq!(
            steps[5],
            &Step::DragTab {
                from: 1,
                to: 3,
                after: true
            }
        );
        assert_eq!(steps[6], &Step::Click(Target::Workspace("draw".into())));
        assert_eq!(steps[7], &Step::Click(Target::Tab(2)));
        assert_eq!(steps[8], &Step::Resize(900, 700));
        assert_eq!(steps[10], &Step::Session("build".into()));
        assert_eq!(steps[11], &Step::Edit(30));
        assert_eq!(steps[12], &Step::Expect(Expect::Order(vec![2, 3, 1])));
        assert_eq!(
            steps[13],
            &Step::Expect(Expect::Folds(vec!["tight".into(), "name".into()]))
        );
        assert_eq!(steps[14], &Step::Expect(Expect::Folds(Vec::new())));
        assert_eq!(steps[15], &Step::Screenshot(PathBuf::from("out/a.png")));
    }

    #[test]
    fn a_bad_line_says_which_and_why() {
        for (text, line, wanted) in [
            ("open\n", 1, "open wants a path"),
            ("\n\nclick sparkle\n", 3, "cannot click"),
            ("click tab:0\n", 1, "from 1"),
            ("key ctrl+q\n", 1, "unknown key"),
            ("drag-tab 1 2 middle\n", 1, "drag-tab wants"),
            ("expect everything\n", 1, "expect wants"),
            ("resize 800\n", 1, "resize wants"),
            ("session sideways\n", 1, "session wants"),
            ("dance\n", 1, "unknown step"),
        ] {
            let error = Script::parse(text).unwrap_err();
            assert_eq!(error.line, line, "{text:?}");
            assert!(error.message.contains(wanted), "{text:?}: {error}");
        }
    }

    #[test]
    fn the_version_header_is_accepted_on_the_first_line_only_and_other_versions_are_refused() {
        assert_eq!(
            Script::parse(
                "styk-auto/1
open a.styk
"
            )
            .unwrap()
            .steps,
            vec![(2, Step::Open(PathBuf::from("a.styk")))]
        );
        assert_eq!(
            Script::parse(
                "open a.styk
"
            )
            .unwrap()
            .steps
            .len(),
            1,
            "a script without a header is version 1"
        );
        let later = Script::parse(
            "styk-auto/2
open a.styk
",
        )
        .unwrap_err();
        assert_eq!(later.line, 1);
        assert!(later.message.contains("unknown script version"), "{later}");
        let misplaced = Script::parse(
            "open a.styk
styk-auto/1
",
        )
        .unwrap_err();
        assert_eq!(misplaced.line, 2);
        assert!(misplaced.message.contains("first line"), "{misplaced}");
        let after_comment = Script::parse(
            "# note
styk-auto/1
",
        )
        .unwrap_err();
        assert_eq!(
            after_comment.line, 2,
            "the header is the first line, not the first non-comment line"
        );
    }

    #[test]
    fn a_script_over_64_kib_is_refused_before_it_is_read() {
        let big = "wait 1
"
        .repeat(MAX_SCRIPT_BYTES / 7 + 1);
        assert!(big.len() > MAX_SCRIPT_BYTES);
        let error = Script::parse(&big).unwrap_err();
        assert_eq!(error.line, 1);
        assert!(error.message.contains("65536"), "{error}");
        assert!(
            Script::parse(
                &"wait 1
"
                .repeat(MAX_SCRIPT_BYTES / 7 - 1)
            )
            .is_ok()
        );
    }

    #[test]
    fn the_clock_and_save_steps_are_read() {
        let script =
            Script::parse("advance 2200000000\nsave-landed\nexpect tab 2 saved\n").unwrap();
        let steps: Vec<&Step> = script.steps.iter().map(|(_, step)| step).collect();
        assert_eq!(
            steps,
            [
                &Step::Advance(2_200_000_000),
                &Step::SaveLanded,
                &Step::Expect(Expect::Tab(2, "saved".into()))
            ]
        );
        assert!(Script::parse("advance soon\n").is_err());
        assert!(Script::parse("expect tab 2 sparkling\n").is_err());
    }

    #[test]
    fn an_empty_script_is_no_steps() {
        assert_eq!(Script::parse("# nothing\n").unwrap().steps.len(), 0);
    }
}
