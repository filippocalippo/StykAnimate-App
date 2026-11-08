//! One bounded stage-message slot. Times are caller-supplied monotonic milliseconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    Hint,
    Toast,
    Update,
    Mode,
    Recovery,
    Error,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Info,
    Success,
    Warning,
    Error,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Action {
    pub command: String,
    pub label: String,
    pub dismiss: bool,
}
#[derive(Clone, Debug)]
pub struct Message {
    pub id: u64,
    pub key: String,
    pub title: String,
    pub text: String,
    pub priority: Priority,
    pub tone: Tone,
    pub actions: Vec<Action>,
    pub task: bool,
    pub timeout: u64,
    pub dismissible: bool,
}
impl Message {
    pub fn new(
        id: u64,
        key: impl Into<String>,
        tone: Tone,
        task: bool,
        actions: Vec<Action>,
    ) -> Self {
        let timeout = if task || tone == Tone::Error {
            0
        } else if !actions.is_empty() {
            8000
        } else if tone == Tone::Warning {
            6000
        } else {
            4000
        };
        Self {
            id,
            key: key.into(),
            title: String::new(),
            text: String::new(),
            priority: if tone == Tone::Error {
                Priority::Error
            } else {
                Priority::Toast
            },
            tone,
            actions,
            task,
            timeout,
            dismissible: timeout == 0 && !task,
        }
    }
}
#[derive(Clone, Debug)]
struct Record {
    message: Message,
    remaining: Option<u64>,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Push {
    pub shown: Option<u64>,
    pub displaced: Option<u64>,
    pub duplicate: Option<u64>,
    pub dropped: Option<u64>,
}
#[derive(Clone, Debug, Default)]
pub struct Messages {
    current: Option<Record>,
    waiting: Vec<Record>,
    deadline: Option<u64>,
}
impl Messages {
    pub fn current(&self) -> Option<&Message> {
        self.current.as_ref().map(|r| &r.message)
    }
    pub fn waiting(&self) -> impl Iterator<Item = &Message> {
        self.waiting.iter().map(|r| &r.message)
    }
    pub fn deadline(&self) -> Option<u64> {
        self.deadline
    }
    fn arm(&mut self, now: u64, ms: u64) {
        self.deadline = if ms > 0 {
            Some(now.saturating_add(ms))
        } else {
            None
        };
        if let Some(r) = &mut self.current {
            r.remaining = Some(ms);
        }
    }
    fn insert(&mut self, r: Record) -> Option<u64> {
        let i = self
            .waiting
            .iter()
            .position(|w| w.message.priority < r.message.priority)
            .unwrap_or(self.waiting.len());
        self.waiting.insert(i, r);
        if self.waiting.len() > 3 {
            self.waiting.pop().map(|r| r.message.id)
        } else {
            None
        }
    }
    pub fn push(&mut self, message: Message, now: u64) -> Push {
        if let Some(r) = self
            .current
            .as_ref()
            .filter(|r| r.message.key == message.key)
        {
            let id = r.message.id;
            let ms = r.message.timeout;
            self.arm(now, ms);
            return Push {
                duplicate: Some(id),
                ..Push::default()
            };
        }
        if let Some(r) = self.waiting.iter().find(|r| r.message.key == message.key) {
            return Push {
                duplicate: Some(r.message.id),
                ..Push::default()
            };
        }
        let mut result = Push::default();
        let r = Record {
            message,
            remaining: None,
        };
        if self
            .current
            .as_ref()
            .is_none_or(|c| r.message.priority > c.message.priority)
        {
            if let Some(mut old) = self.current.take() {
                result.displaced = Some(old.message.id);
                old.remaining = Some(self.deadline.unwrap_or(0).saturating_sub(now));
                result.dropped = if old.message.timeout == 0 {
                    self.insert(old)
                } else {
                    Some(old.message.id)
                };
            }
            result.shown = Some(r.message.id);
            let ms = r.message.timeout;
            self.current = Some(r);
            self.arm(now, ms);
        } else {
            result.dropped = self.insert(r);
        }
        result
    }
    /// Returns the removed ID (also for overflow callers); newly visible state is read via current().
    pub fn dismiss(&mut self, id: u64, now: u64) -> Option<u64> {
        if self.current().is_some_and(|r| r.id == id) {
            self.current = if self.waiting.is_empty() {
                None
            } else {
                Some(self.waiting.remove(0))
            };
            self.deadline = None;
            if let Some(r) = &self.current {
                self.arm(now, r.remaining.unwrap_or(r.message.timeout));
            }
            return Some(id);
        }
        let i = self.waiting.iter().position(|r| r.message.id == id)?;
        self.waiting.remove(i);
        Some(id)
    }
    pub fn tick(&mut self, now: u64) -> Option<u64> {
        if self.deadline.is_some_and(|d| now >= d) {
            let id = self.current()?.id;
            self.dismiss(id, now)
        } else {
            None
        }
    }
    pub fn interaction(&mut self, hovered: bool, focused: bool, now: u64) {
        if hovered || focused {
            if let Some(d) = self.deadline.take()
                && let Some(r) = &mut self.current
            {
                r.remaining = Some(d.saturating_sub(now));
            }
        } else if self.deadline.is_none()
            && let Some(r) = &self.current
        {
            self.arm(now, r.remaining.unwrap_or(0));
        }
    }
    pub fn update(&mut self, id: u64, title: String, text: String) -> bool {
        let record = self
            .current
            .iter_mut()
            .chain(self.waiting.iter_mut())
            .find(|r| r.message.id == id);
        if let Some(r) = record {
            r.message.title = title;
            r.message.text = text;
            true
        } else {
            false
        }
    }
}

/// Final measured slot position. `x` is the horizontal centre, as in the stage header contract.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Position {
    pub x: f64,
    pub top: f64,
}

/// A modal takes precedence over the header slot; otherwise use the stage bottom and avoid controls in order.
pub fn position(
    size: super::placement::Size,
    viewport_height: f64,
    stage: Option<super::placement::Rect>,
    modal: Option<super::placement::Rect>,
    header_slot: Option<Position>,
    obstacles: &[super::placement::Rect],
    top_inset: f64,
) -> Option<Position> {
    let mut x;
    let mut bottom;
    if let Some(box_) = modal {
        let top = top_inset.max(0.);
        x = box_.x + box_.width / 2.;
        bottom = if box_.y - 8. - size.height >= top + 8. {
            viewport_height - box_.y + 8.
        } else if box_.y + box_.height + 8. + size.height <= viewport_height - 8. {
            viewport_height - (box_.y + box_.height) - 8. - size.height
        } else {
            viewport_height - top - 8. - size.height
        };
    } else {
        if header_slot.is_some() {
            return header_slot;
        }
        let stage = stage?;
        x = stage.x + stage.width / 2.;
        bottom = viewport_height - (stage.y + stage.height) + 8.;
        for obstacle in obstacles {
            if obstacle.width <= 0. || obstacle.height <= 0. {
                continue;
            }
            let intersects = x - size.width / 2. < obstacle.x + obstacle.width
                && obstacle.x < x + size.width / 2.
                && viewport_height - bottom - size.height < obstacle.y + obstacle.height
                && obstacle.y < viewport_height - bottom;
            if !intersects {
                continue;
            }
            let shifted = obstacle.x - 8. - size.width / 2.;
            if shifted - size.width / 2. >= stage.x + 8. {
                x = shifted;
            } else {
                bottom = viewport_height - obstacle.y + 8.;
            }
        }
    }
    Some(Position {
        x,
        top: viewport_height - bottom - size.height,
    })
}
