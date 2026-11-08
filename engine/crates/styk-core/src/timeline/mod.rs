//! Timeline models and input policy. The session owns the playhead and edits; views only report input.
pub mod geometry;
#[cfg(feature = "engine")]
mod panel;
#[cfg(feature = "engine")]
mod projection;
pub mod transport;
use crate::{commands::CommandId, i18n::Msg, identity::DocumentId, settings::TimelineMode};
#[cfg(feature = "engine")]
pub use panel::Panel;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Identity {
    pub document: DocumentId,
    pub lineage: u64,
    pub revision: u64,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Exposure {
    pub tick: u32,
    pub end: u32,
    pub empty: bool,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Layer {
    pub index: usize,
    pub id: String,
    pub name: crate::i18n::Label,
    pub depth: usize,
    pub locked: bool,
    pub hidden: bool,
    pub folder: bool,
    pub exposures: Vec<Exposure>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Card {
    pub index: usize,
    pub tick: u32,
    pub end: u32,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Model {
    pub identity: Option<Identity>,
    pub mode: TimelineMode,
    pub pending: bool,
    pub tick: f64,
    pub total: u32,
    pub fps: f64,
    pub active_layer: String,
    pub row_count: usize,
    pub first_row: usize,
    pub layers: Vec<Layer>,
    pub card_count: usize,
    pub first_card: usize,
    pub cards: Vec<Card>,
    pub selected_layers: std::sync::Arc<[String]>,
    pub selected: Selection,
    pub geometry: geometry::Geometry,
    pub transport: transport::Model,
    pub disabled: Option<Msg>,
    pub editor: Option<CommandId>,
}
impl Default for Model {
    fn default() -> Self {
        Self {
            identity: None,
            mode: TimelineMode::Advanced,
            pending: true,
            tick: 0.,
            total: 0,
            fps: 24.,
            active_layer: String::new(),
            row_count: 0,
            first_row: 0,
            layers: Vec::new(),
            card_count: 0,
            first_card: 0,
            cards: Vec::new(),
            selected_layers: Default::default(),
            selected: Selection::default(),
            geometry: Default::default(),
            transport: Default::default(),
            disabled: None,
            editor: None,
        }
    }
}
/// Compact, ordered timeline selection. Expansion is only at an actual legacy range-edit boundary.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Selection {
    #[default]
    Empty,
    Span {
        first: usize,
        last: usize,
    },
    Items(std::sync::Arc<[usize]>),
}
impl Selection {
    pub fn len(&self) -> usize {
        match self {
            Self::Empty => 0,
            Self::Span { first, last } => last.checked_sub(*first).map_or(0, |length| length.saturating_add(1)),
            Self::Items(items) => items.len(),
        }
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn contains(&self, at: usize) -> bool {
        match self {
            Self::Empty => false,
            Self::Span { first, last } => (*first..=*last).contains(&at),
            Self::Items(items) => items.contains(&at),
        }
    }
    pub fn first(&self) -> Option<usize> {
        self.iter().next()
    }
    pub fn last(&self) -> Option<usize> {
        match self {
            Self::Empty => None,
            Self::Span { last, .. } => Some(*last),
            Self::Items(items) => items.last().copied(),
        }
    }
    pub fn iter(&self) -> impl Iterator<Item = usize> + '_ {
        let (first, len) = match self {
            Self::Span { first, .. } => (*first, self.len()),
            _ => (0, self.len()),
        };
        (0..len).map(move |i| if let Self::Items(items) = self { items[i] } else { first + i })
    }
    pub fn items(items: Vec<usize>) -> Self {
        let mut seen = std::collections::HashSet::new();
        Self::Items(items.into_iter().filter(|i| seen.insert(*i)).collect())
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Modifiers {
    pub extend: bool,
    pub toggle: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Begin,
    Move,
    End,
    Cancel,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Payload {
    None,
    Modifiers(Modifiers),
    Number(f64),
    Range { first: f64, last: f64 },
    Layer { id: String, modifiers: Modifiers },
    Cell { point: [f64; 2], modifiers: Modifiers },
    Card { index: usize, modifiers: Modifiers },
    Scrub { phase: Phase, x: f64 },
}
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Action { id: CommandId, payload: Payload, now: u64 },
    Viewport { width: f64, height: f64 },
    Scroll { x: f64, y: f64 },
    Wake { now: u64 },
    RasterExport(bool),
}
