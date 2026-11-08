//! Settings owns preferences; documents never contain them. Controls and transport use this same owner.
//! The schema and mutation path are independent of the engine and toolkit.
pub mod persistence;
use styk_doc::{Obj, Value};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TimelineMode {
    Simple,
    #[default]
    Advanced,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PlaybackQuality {
    Low,
    Medium,
    Draft,
    Auto,
    #[default]
    Normal,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Animation {
    pub timeline_mode: TimelineMode,
    pub loop_playback: bool,
    pub fit_view_on_playback: bool,
    pub replace_keyframes_on_drop: bool,
    pub playback_quality: PlaybackQuality,
}
impl Default for Animation {
    fn default() -> Self {
        Self {
            timeline_mode: TimelineMode::Advanced,
            loop_playback: true,
            fit_view_on_playback: true,
            replace_keyframes_on_drop: true,
            playback_quality: PlaybackQuality::Normal,
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ViewMemory {
    pub auto_key: bool,
    /// The complete view section, including preferences whose controls arrive in later chunks.
    values: Value,
}
impl Default for ViewMemory {
    fn default() -> Self {
        Self { auto_key: false, values: Value::object(Obj::new()) }
    }
}

// One table defines the keys and their persistence section. Extend this owner when Settings controls arrive.
macro_rules! settings {
    ($($id:ident => ($key:literal, $section:literal)),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
        pub enum SettingId { $($id),+ }
        impl SettingId {
            pub const ALL: &'static [Self] = &[$(Self::$id),+];
            pub fn key(self) -> &'static str { match self { $(Self::$id => $key),+ } }
            pub fn section(self) -> &'static str { match self { $(Self::$id => $section),+ } }
        }
    }
}
settings! {
    TimelineMode => ("timelineMode", "values"), LoopPlayback => ("loopPlayback", "values"),
    FitViewOnPlayback => ("fitViewOnPlayback", "values"), ReplaceKeyframesOnDrop => ("replaceKeyframesOnDrop", "values"),
    PlaybackQuality => ("playbackQuality", "values"), AutoKey => ("autoKey", "view"),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effect {
    Timeline,
    PlaybackQuality,
    Persist,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Change {
    pub id: SettingId,
    pub old: Value,
    pub new: Value,
    pub effects: Vec<Effect>,
    /// Identity of this mutation, independent of its value (including ABA changes).
    mutation: std::sync::Arc<()>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Set { id: SettingId, value: Value, now: u64 },
    Revert { change: Change, now: u64 },
    Wake { now: u64 },
    Flush { now: u64 },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    Invalid,
    NewerSchema,
    Storage(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    animation: Animation,
    view: ViewMemory,
    /// Unknown values survive load/save and are available to future owners without a migration.
    envelope: Value,
    touched: std::collections::BTreeSet<SettingId>,
    mutations: std::collections::BTreeMap<SettingId, std::sync::Arc<()>>,
    read_only: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            animation: Animation::default(),
            view: ViewMemory::default(),
            envelope: Value::Null,
            touched: Default::default(),
            mutations: Default::default(),
            read_only: false,
        }
    }
}
impl Settings {
    pub fn animation(&self) -> &Animation {
        &self.animation
    }
    pub fn view(&self) -> &ViewMemory {
        &self.view
    }
    pub fn read_only(&self) -> bool {
        self.read_only
    }
    pub(crate) fn refuse_writes(&mut self) {
        self.read_only = true;
    }
    pub fn value(&self, id: SettingId) -> Value {
        use SettingId::*;
        match id {
            TimelineMode => string(match self.animation.timeline_mode {
                self::TimelineMode::Simple => "simple",
                self::TimelineMode::Advanced => "advanced",
            }),
            LoopPlayback => Value::Bool(self.animation.loop_playback),
            FitViewOnPlayback => Value::Bool(self.animation.fit_view_on_playback),
            ReplaceKeyframesOnDrop => Value::Bool(self.animation.replace_keyframes_on_drop),
            PlaybackQuality => string(match self.animation.playback_quality {
                self::PlaybackQuality::Low => "low",
                self::PlaybackQuality::Normal => "normal",
                self::PlaybackQuality::Medium => "medium",
                self::PlaybackQuality::Draft => "draft",
                self::PlaybackQuality::Auto => "auto",
            }),
            AutoKey => Value::Bool(self.view.auto_key),
        }
    }
    /// The sole mutation path; a refused effect calls `revert` through Core, never through a control callback.
    pub fn set(&mut self, id: SettingId, value: Value) -> Result<Change, Error> {
        if self.read_only {
            return Err(Error::NewerSchema);
        }
        let old = self.value(id);
        self.assign(id, &value)?;
        self.touched.insert(id);
        let mutation = std::sync::Arc::new(());
        self.mutations.insert(id, mutation.clone());
        Ok(Change {
            id,
            old,
            new: self.value(id),
            effects: vec![if id == SettingId::PlaybackQuality { Effect::PlaybackQuality } else { Effect::Timeline }, Effect::Persist],
            mutation,
        })
    }
    pub fn revert(&mut self, change: &Change) -> Result<Change, Error> {
        // A late failed apply cannot revert a more recent user choice.
        if !self.mutations.get(&change.id).is_some_and(|current| std::sync::Arc::ptr_eq(current, &change.mutation)) {
            return Err(Error::Invalid);
        }
        self.set(change.id, change.old.clone())
    }
    fn assign(&mut self, id: SettingId, value: &Value) -> Result<(), Error> {
        use SettingId::*;
        match id {
            TimelineMode => {
                self.animation.timeline_mode = match value.as_str() {
                    Some("simple") => self::TimelineMode::Simple,
                    Some("advanced") => self::TimelineMode::Advanced,
                    _ => return Err(Error::Invalid),
                }
            }
            PlaybackQuality => {
                self.animation.playback_quality = match value.as_str() {
                    Some("low") => self::PlaybackQuality::Low,
                    Some("normal") => self::PlaybackQuality::Normal,
                    Some("medium") => self::PlaybackQuality::Medium,
                    Some("draft") => self::PlaybackQuality::Draft,
                    Some("auto") => self::PlaybackQuality::Auto,
                    _ => return Err(Error::Invalid),
                }
            }
            id => {
                let Value::Bool(on) = value else {
                    return Err(Error::Invalid);
                };
                match id {
                    LoopPlayback => self.animation.loop_playback = *on,
                    FitViewOnPlayback => self.animation.fit_view_on_playback = *on,
                    ReplaceKeyframesOnDrop => self.animation.replace_keyframes_on_drop = *on,
                    AutoKey => self.view.auto_key = *on,
                    _ => return Err(Error::Invalid),
                }
            }
        }
        Ok(())
    }
    /// Apply the worker's ready load while preserving changes made before that load finished.
    pub fn loaded(&mut self, envelope: Value) -> Vec<Change> {
        self.read_only = envelope.get("schema").and_then(Value::as_f64).is_some_and(|n| n > 1.);
        self.view.values = envelope.get("view").cloned().unwrap_or_else(|| Value::object(Obj::new()));
        let mut changes = Vec::new();
        for &id in SettingId::ALL {
            if self.touched.contains(&id) {
                continue;
            }
            if let Some(value) = envelope.path(&[id.section(), id.key()]) {
                let old = self.value(id);
                if self.assign(id, value).is_ok() && old != self.value(id) {
                    let mutation = std::sync::Arc::new(());
                    self.mutations.insert(id, mutation.clone());
                    changes.push(Change {
                        id,
                        old,
                        new: self.value(id),
                        effects: vec![if id == SettingId::PlaybackQuality { Effect::PlaybackQuality } else { Effect::Timeline }],
                        mutation,
                    });
                }
            }
        }
        self.envelope = envelope;
        changes
    }
}
pub(crate) fn string(s: &str) -> Value {
    Value::Str(s.into())
}
pub(crate) fn put(value: &mut Value, key: &str, entry: Value) {
    if !value.is_object() {
        *value = Value::object(Obj::new());
    }
    if let Some(object) = value.make_obj() {
        object.set(key, entry);
    }
}
