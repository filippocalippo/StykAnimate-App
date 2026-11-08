//! Which titled sections are open: a port of `SectionMemory` (`src/inspector-kit.mjs`).
//!
//! Per context kind, a section a person opened stays open (saved as the `inspectorSections` setting). A section also
//! opens by itself while its auto-open rule holds (Connection while joined); closing it then dismisses it until the rule
//! stops holding, and forgets that the person had opened it: the last explicit action wins. Dismissals are not saved.

use std::collections::{BTreeMap, BTreeSet, HashSet};

/// At most this many kinds and sections per kind are remembered (`MEMORY_KINDS`, `MEMORY_SECTIONS`).
const MEMORY_KINDS: usize = 48;
const MEMORY_SECTIONS: usize = 64;

fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    id.len() <= 40 && chars.next().is_some_and(|c| c.is_ascii_lowercase()) && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SectionMemory {
    saved: BTreeMap<String, BTreeSet<String>>,
    dismissed: HashSet<(String, String)>,
    version: u64,
}

impl SectionMemory {
    /// The memory from the saved setting (kind → open section ids), normalised as today.
    pub fn from_saved(saved: impl IntoIterator<Item = (String, Vec<String>)>) -> SectionMemory {
        let mut memory = SectionMemory::default();
        for (kind, sections) in saved.into_iter().filter(|(kind, _)| valid_id(kind)).take(MEMORY_KINDS) {
            let open: BTreeSet<String> = sections.into_iter().filter(|id| valid_id(id)).take(MEMORY_SECTIONS).collect();
            if !open.is_empty() {
                memory.saved.insert(kind, open);
            }
        }
        memory
    }

    /// What the setting saves.
    pub fn saved(&self) -> &BTreeMap<String, BTreeSet<String>> {
        &self.saved
    }

    /// Changes with every toggle; part of the Inspector's cache key.
    pub fn version(&self) -> u64 {
        self.version
    }

    /// Whether a titled section shows its body.
    pub fn is_open(&self, kind: &str, section: &str, auto: bool) -> bool {
        if auto {
            return !self.dismissed.contains(&(kind.to_owned(), section.to_owned()));
        }
        self.saved.get(kind).is_some_and(|open| open.contains(section))
    }

    /// A render saw the section's rule stop holding: its dismissal is forgotten (`isOpen`'s `dismissed.delete`).
    pub(crate) fn rule_released(&mut self, kind: &str, section: &str) {
        self.dismissed.remove(&(kind.to_owned(), section.to_owned()));
    }

    /// A person toggled a section. `auto` is whether its rule held then. Returns whether anything changed.
    pub fn toggle(&mut self, kind: &str, section: &str, open: bool, auto: bool) -> bool {
        if !valid_id(kind) || !valid_id(section) {
            return false;
        }
        let key = (kind.to_owned(), section.to_owned());
        let changed = if auto {
            if open {
                self.dismissed.remove(&key)
            } else {
                self.dismissed.insert(key);
                self.save(kind, section, false);
                true
            }
        } else {
            self.save(kind, section, open)
        };
        if changed {
            self.version = self.version.wrapping_add(1);
        }
        changed
    }

    fn save(&mut self, kind: &str, section: &str, open: bool) -> bool {
        if open {
            if !self.saved.contains_key(kind) && self.saved.len() >= MEMORY_KINDS {
                return false;
            }
            let sections = self.saved.entry(kind.to_owned()).or_default();
            if sections.len() >= MEMORY_SECTIONS && !sections.contains(section) {
                return false;
            }
            sections.insert(section.to_owned())
        } else {
            let Some(sections) = self.saved.get_mut(kind) else { return false };
            let removed = sections.remove(section);
            if sections.is_empty() {
                self.saved.remove(kind);
            }
            removed
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_section_opened_stays_open_per_kind() {
        let mut memory = SectionMemory::default();
        assert!(!memory.is_open("figure", "colours", false));
        assert!(memory.toggle("figure", "colours", true, false));
        assert!(memory.is_open("figure", "colours", false));
        assert!(!memory.is_open("joint", "colours", false), "per context kind");
        assert!(memory.toggle("figure", "colours", false, false));
        assert!(memory.saved().is_empty());
    }

    #[test]
    fn closing_an_auto_open_section_dismisses_it_until_the_rule_stops() {
        let mut memory = SectionMemory::default();
        memory.toggle("figure", "connection", true, false);
        assert!(memory.is_open("figure", "connection", true));
        memory.toggle("figure", "connection", false, true);
        assert!(!memory.is_open("figure", "connection", true), "dismissed while the rule holds");
        assert!(!memory.is_open("figure", "connection", false), "and the person's earlier opening is forgotten");
        memory.rule_released("figure", "connection");
        assert!(memory.is_open("figure", "connection", true), "the next time it matters it opens again");
    }

    #[test]
    fn saved_memory_is_normalised() {
        let memory = SectionMemory::from_saved([("figure".into(), vec!["colours".into(), "Bad Id".into()]), ("BAD".into(), vec!["x".into()])]);
        assert_eq!(memory.saved().len(), 1);
        assert!(memory.is_open("figure", "colours", false));
    }
}
