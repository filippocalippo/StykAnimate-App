//! The one command registry: identities and metadata, with no document or engine types.

use crate::shortcuts::{Platform, Scope, Shortcut};

/// The feature module whose handler owns a command; unported features fail explicitly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner { History, Selection, Camera, ViewState, Timeline, NotYet }

// Each row declares its identity, serialisation spelling and metadata once.
macro_rules! commands {
    ($($variant:ident => $id:literal, $info:expr;)*) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum CommandId { $($variant,)* }

        impl CommandId {
            pub const ALL: &'static [Self] = &[$(Self::$variant,)*];
            pub const fn id(self) -> &'static str { match self { $(Self::$variant => $id,)* } }
            pub fn from_id(id: &str) -> Option<Self> { match id { $($id => Some(Self::$variant),)* _ => None } }
            pub const fn info(self) -> &'static Info {
                match self { $(Self::$variant => { const INFO: Info = $info; &INFO },)* }
            }
        }
    };
}

include!("metadata/data.rs");

/// History ownership, not a request for the registry to mutate the session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum History {
    None,
    /// A completed edit is one session history entry (a refused/no-op edit is none).
    Edit,
    /// Previews share the gesture's one commit; cancellation creates no entry.
    Gesture,
    /// The feature's dialog/session determines when its edit commits.
    Completion,
    Undo,
    Redo,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode { Animate, Draw, Build }

/// The same requirement names as today's command catalogue. Missing facts fail closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Requirement {
    Desktop, NewWindow, RecentFiles, Updates, Feedback, Telemetry, UpdateReady,
    Figure, Figures, Joint, Text, Movieclip, MovieclipSession, CameraSession, Pixels, Appearance,
}

impl Requirement {
    pub fn name(self) -> &'static str {
        match self {
            Self::Desktop => "desktop", Self::NewWindow => "desktop:newWindow",
            Self::RecentFiles => "desktop:recentFiles", Self::Updates => "desktop:updates",
            Self::Feedback => "desktop:feedback", Self::Telemetry => "desktop:telemetry",
            Self::UpdateReady => "update-ready", Self::Figure => "figure", Self::Figures => "figures",
            Self::Joint => "joint", Self::Text => "text", Self::Movieclip => "movieclip",
            Self::MovieclipSession => "movieclip-session", Self::CameraSession => "camera-session",
            Self::Pixels => "pixels", Self::Appearance => "appearance",
        }
    }

    pub fn reason_key(self) -> &'static str {
        match self {
            Self::Desktop | Self::NewWindow | Self::RecentFiles | Self::Updates | Self::Feedback | Self::Telemetry => "overlays.requires.desktop",
            Self::UpdateReady => "overlays.requires.updateReady", Self::Figure => "overlays.requires.figure",
            Self::Figures => "overlays.requires.figures", Self::Joint => "overlays.requires.joint",
            Self::Text => "overlays.requires.text", Self::Movieclip => "overlays.requires.movieclip",
            Self::MovieclipSession => "overlays.requires.movieclipSession", Self::CameraSession => "overlays.requires.cameraSession",
            Self::Pixels => "overlays.requires.pixels", Self::Appearance => "app.copyAnAppearanceFirst",
        }
    }
}

/// Cheap facts read from the owning features at dispatch time. Never cached in the registry.
#[derive(Clone, Copy, Debug, Default)]
pub struct Gates {
    pub mode: Option<Mode>,
    pub desktop: bool,
    pub new_window: bool,
    pub recent_files: bool,
    pub updates: bool,
    pub feedback: bool,
    pub telemetry: bool,
    pub update_ready: bool,
    pub figure: bool,
    pub selection_count: usize,
    pub selected_joint: bool,
    pub movieclip: bool,
    pub text: bool,
    pub movieclip_session: bool,
    pub camera_session: bool,
    pub pixels: bool,
    pub appearance: bool,
}

impl Gates {
    pub fn satisfies(&self, requirement: Requirement) -> bool {
        match requirement {
            Requirement::Desktop => self.desktop,
            Requirement::NewWindow => self.new_window,
            Requirement::RecentFiles => self.recent_files,
            Requirement::Updates => self.updates,
            Requirement::Feedback => self.feedback,
            Requirement::Telemetry => self.telemetry,
            Requirement::UpdateReady => self.update_ready,
            Requirement::Figure => self.figure,
            Requirement::Figures => self.selection_count > 1,
            Requirement::Joint => self.figure && self.selected_joint && self.selection_count <= 1 && !self.movieclip,
            Requirement::Text => self.figure && self.text,
            Requirement::Movieclip => self.figure && self.movieclip,
            Requirement::MovieclipSession => self.movieclip_session,
            Requirement::CameraSession => self.camera_session,
            Requirement::Pixels => self.pixels,
            Requirement::Appearance => self.appearance,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disabled {
    NotAvailable,
    Mode(Mode),
    Requirement(Requirement),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Availability {
    pub disabled: Option<Disabled>,
    pub hidden: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Polygon {
    Allow,
    /// Switching or replacing a document first cancels its polygon draft.
    CancelDraft,
    Refuse,
}

/// One entry is shared by menus, shortcuts, automation and the command palette.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Info {
    pub id: CommandId,
    pub owner: Owner,
    pub label: &'static str,
    /// Only the parameterised zoom and brush-opacity labels use this scalar.
    pub label_number: Option<(&'static str, u16)>,
    pub icon: Option<&'static str>,
    pub category: &'static str,
    pub keywords: &'static [&'static str],
    pub modes: &'static [Mode],
    pub requires: &'static [Requirement],
    pub toggle: bool,
    pub danger: bool,
    pub palette: bool,
    pub alias_of: Option<CommandId>,
    /// The command whose shortcuts are shown, never an extra dispatch binding.
    pub display_hotkey: Option<CommandId>,
    pub shortcut: Option<Shortcut>,
    pub history: History,
    pub polygon: Polygon,
    pub polygon_key: bool,
    pub stays_on_home: bool,
    pub key_on_home: bool,
    pub field_key: bool,
}

impl Info {
    const fn new(id: CommandId, label: &'static str, category: &'static str, history: History) -> Self {
        Self { id, owner: Owner::NotYet, label, label_number: None, icon: None, category, keywords: &[], modes: &[], requires: &[],
            toggle: false, danger: false, palette: true, alias_of: None, display_hotkey: None, shortcut: None,
            history, polygon: Polygon::Refuse, polygon_key: false, stays_on_home: false, key_on_home: false, field_key: false }
    }

    /// A feature supplies whether its handler exists. Unported features remain typed, visible and unavailable.
    pub fn availability(&self, context: &Gates, implemented: bool) -> Availability {
        let wrong_mode = context.mode.filter(|mode| !self.modes.is_empty() && !self.modes.contains(mode));
        let disabled = if !implemented { Some(Disabled::NotAvailable) }
            else if wrong_mode.is_some() { self.modes.first().copied().map(Disabled::Mode) }
            else { self.requires.iter().find(|r| !context.satisfies(**r)).copied().map(Disabled::Requirement) };
        Availability { disabled, hidden: wrong_mode.is_some() }
    }

    pub fn displayed_shortcut(&self) -> Option<&'static Shortcut> {
        self.display_hotkey.unwrap_or(self.id).info().shortcut.as_ref()
    }

    /// Hide a hint claimed by a more specific, workspace-wide scope (today's registry).
    pub fn visible_bindings(&self, platform: Platform, desktop: bool, active: &[Scope]) -> Vec<&'static str> {
        let Some(own) = self.displayed_shortcut() else { return Vec::new(); };
        own.bindings(platform, desktop).iter().copied().filter(|binding| {
            !CommandId::ALL.iter().filter_map(|id| id.info().shortcut.as_ref()).any(|other| {
                other.scope != own.scope && active.contains(&other.scope) && other.scope.rank() < own.scope.rank()
                    && other.bindings(platform, desktop).iter().any(|rival| {
                        crate::shortcuts::same_binding(binding, rival, platform)
                            || (other.extra_shift && !rival.contains("Shift+")
                                && crate::shortcuts::same_binding_with_shift(binding, rival, platform))
                    })
            })
        }).collect()
    }
}

impl CommandId {
    /// The keyboard owner shares one gesture across these commands; R itself only sets its modifier.
    pub const fn is_keyboard_handle(self) -> bool {
        matches!(self, Self::HandleLeft | Self::HandleRight | Self::HandleUp | Self::HandleDown | Self::HandleEditHold)
    }
    /// The reference's checkbox/radio exception is narrower than the whole Builder scope.
    pub const fn is_builder_shortcut(self) -> bool {
        matches!(self, Self::BuilderHighlight | Self::BuilderStaticHandles | Self::BuilderCanvasColor | Self::BuilderOrder)
    }
}
