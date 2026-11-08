//! Window-wide tooltip timing; callers supply target metadata and the monotonic clock.
use super::placement::{self, Align, Placement, Positioned, Rect, Side, Size};
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Content {
    pub label: String,
    pub shortcut: String,
}
impl Content {
    pub fn resolve(
        tooltip: Option<&str>,
        hotkey_title: Option<&str>,
        aria_label: Option<&str>,
        native_title: Option<&str>,
        visible_label: &str,
        shortcut: &str,
    ) -> Option<Self> {
        if tooltip == Some("") || (tooltip.is_none() && native_title.is_some_and(|s| !s.is_empty()))
        {
            return None;
        }
        let label = tooltip
            .or(hotkey_title.filter(|s| !s.is_empty()))
            .or(aria_label)
            .unwrap_or("")
            .trim();
        let keys = shortcut.trim();
        if (label.is_empty() && keys.is_empty())
            || (keys.is_empty() && label == visible_label.trim())
        {
            return None;
        }
        Some(Self {
            label: label.into(),
            shortcut: keys.into(),
        })
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tip {
    pub target: u64,
    pub content: Content,
}
#[derive(Clone, Debug, Default)]
pub struct Tooltip {
    visible: Option<Tip>,
    pending: Option<(Tip, u64)>,
    last_hidden: Option<u64>,
}
impl Tooltip {
    pub fn visible(&self) -> Option<&Tip> {
        self.visible.as_ref()
    }
    pub fn deadline(&self) -> Option<u64> {
        self.pending.as_ref().map(|(_, d)| *d)
    }
    /// Pointer hover is disabled on touch; keyboard focus-visible still schedules.
    pub fn schedule(&mut self, tip: Tip, now: u64, touch: bool, keyboard: bool) {
        if touch && !keyboard {
            return;
        }
        let delay = if self.visible.is_some()
            || self
                .last_hidden
                .is_some_and(|t| now.saturating_sub(t) < 300)
        {
            0
        } else {
            500
        };
        self.pending = Some((tip, now.saturating_add(delay)));
        self.tick(now);
    }
    pub fn tick(&mut self, now: u64) {
        if self.pending.as_ref().is_some_and(|(_, d)| now >= *d) {
            self.visible = self.pending.take().map(|(tip, _)| tip);
        }
    }
    /// Pointer down, Escape, scroll, focus out, removal and abort share this teardown.
    pub fn hide(&mut self, now: u64) {
        self.pending = None;
        if self.visible.take().is_some() {
            self.last_hidden = Some(now);
        }
    }
    pub fn place(
        anchor: Rect,
        size: Size,
        viewport: Size,
        vertical_rail: bool,
        top_inset: f64,
    ) -> Positioned {
        let side = if !vertical_rail {
            Side::Top
        } else if anchor.x + anchor.width / 2. > viewport.width / 2. {
            Side::Left
        } else {
            Side::Right
        };
        placement::compute(
            anchor,
            size,
            viewport,
            Placement {
                side,
                align: Align::Center,
                fit: false,
                overlap: false,
                top_inset,
                ..Placement::default()
            },
        )
    }
}
