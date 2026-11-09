//! Process-lifetime parameter owner. Only the developer worker mutates it.
use serde_json::{Value, json};
pub const MAX_ENTRIES: usize = 256;
pub const MAX_BYTES: usize = 64 * 1024;
#[derive(Clone, Debug, PartialEq)]
pub enum Kind {
    Float { min: f64, max: f64 },
    Integer { min: i64, max: i64 },
    Bool,
    Enum(Vec<String>),
}
#[derive(Clone, Debug, PartialEq)]
pub struct Descriptor {
    pub name: String,
    pub kind: Kind,
    pub default: Value,
    pub unit: String,
    pub restart: bool,
}
impl Descriptor {
    pub fn validate(&self, value: Value) -> Result<Value, String> {
        match &self.kind {
            Kind::Float { min, max } if min.is_finite() && max.is_finite() && min <= max => {
                let v = value
                    .as_f64()
                    .filter(|v| v.is_finite())
                    .ok_or("expected finite number")?;
                Ok(json!(v.clamp(*min, *max)))
            }
            Kind::Integer { min, max } if min <= max => Ok(json!(
                value.as_i64().ok_or("expected integer")?.clamp(*min, *max)
            )),
            Kind::Bool if value.is_boolean() => Ok(value),
            Kind::Enum(options)
                if value
                    .as_str()
                    .is_some_and(|v| options.iter().any(|o| o == v)) =>
            {
                // Retain only the canonical bounded value, not spare capacity supplied by a caller.
                Ok(Value::String(
                    value.as_str().ok_or("expected enum string")?.to_owned(),
                ))
            }
            _ => Err("invalid parameter type, range or enum value".into()),
        }
    }
}
struct Entry {
    descriptor: Descriptor,
    effective: Value,
    pending: Option<Value>,
    setter: Box<dyn FnMut(&Value) -> Result<(), String> + Send>,
}
pub struct Registry {
    entries: Vec<Entry>,
    bytes: usize,
    pub revision: u64,
}
impl Default for Registry {
    fn default() -> Self {
        Self {
            entries: Vec::with_capacity(MAX_ENTRIES),
            bytes: MAX_ENTRIES * std::mem::size_of::<Entry>(),
            revision: 0,
        }
    }
}
impl Registry {
    pub fn register(
        &mut self,
        descriptor: Descriptor,
        setter: impl FnMut(&Value) -> Result<(), String> + Send + 'static,
    ) -> Result<(), String> {
        let strings = descriptor.name.capacity()
            + descriptor.unit.capacity()
            + match &descriptor.kind {
                Kind::Enum(v) => {
                    v.capacity() * std::mem::size_of::<String>()
                        + v.iter().map(String::capacity).sum::<usize>()
                }
                _ => 0,
            };
        if let Kind::Enum(options) = &descriptor.kind
            && (options.len() > 64 || options.iter().any(|s| s.is_empty() || s.len() > 128))
        {
            return Err("enum choices exceed bounds".into());
        }
        let value_bytes = match &descriptor.default {
            Value::String(s) => s.capacity(),
            _ => 0,
        };
        let largest = match &descriptor.kind {
            Kind::Enum(v) => v.iter().map(String::len).max().unwrap_or(0),
            _ => 0,
        };
        let cost = strings
            .checked_add(value_bytes + 2 * largest + std::mem::size_of_val(&setter))
            .ok_or("parameter size overflow")?;
        if cost > 4096 {
            return Err("parameter descriptor exceeds 4 KiB".into());
        }
        if self.entries.len() == MAX_ENTRIES
            || cost > MAX_BYTES.saturating_sub(self.bytes)
            || descriptor.name.is_empty()
            || descriptor.name.len() > 128
            || descriptor.unit.len() > 32
            || self
                .entries
                .iter()
                .any(|e| e.descriptor.name == descriptor.name)
        {
            return Err("parameter registration refused".into());
        }
        let effective = descriptor.validate(descriptor.default.clone())?;
        if effective != descriptor.default {
            return Err("default outside parameter range".into());
        }
        self.bytes += cost;
        self.entries.push(Entry {
            descriptor,
            effective,
            pending: None,
            setter: Box::new(setter),
        });
        self.entries
            .sort_by(|a, b| a.descriptor.name.cmp(&b.descriptor.name));
        Ok(())
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    pub fn get(&self, name: &str) -> Option<&Value> {
        self.entries
            .iter()
            .find(|e| e.descriptor.name == name)
            .map(|e| e.pending.as_ref().unwrap_or(&e.effective))
    }
    pub fn set(&mut self, name: &str, value: Value, startup: bool) -> Result<Value, String> {
        let entry = self
            .entries
            .iter_mut()
            .find(|e| e.descriptor.name == name)
            .ok_or("unknown parameter")?;
        let value = entry.descriptor.validate(value)?;
        if entry.descriptor.restart && !startup {
            entry.pending = Some(value.clone());
        } else {
            (entry.setter)(&value)?;
            entry.effective = value.clone();
            entry.pending = None;
        }
        self.revision = self.revision.wrapping_add(1);
        Ok(value)
    }
    pub fn reset(&mut self, name: &str) -> Result<Value, String> {
        let default = self
            .entries
            .iter()
            .find(|e| e.descriptor.name == name)
            .ok_or("unknown parameter")?
            .descriptor
            .default
            .clone();
        self.set(name, default, false)
    }
    pub fn assignments(&self, bytes: &[u8]) -> Result<Vec<(String, Value)>, String> {
        if bytes.len() > MAX_BYTES {
            return Err("parameter profile exceeds 64 KiB".into());
        }
        let profile: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
        if profile
            .get("flags")
            .is_some_and(|v| !v.as_object().is_some_and(|m| m.is_empty()))
        {
            return Err("experiment flags are not installed".into());
        }
        let params = profile["params"]
            .as_object()
            .ok_or("profile needs params object")?;
        if params.len() > MAX_ENTRIES {
            return Err("too many parameters".into());
        }
        params
            .iter()
            .map(|(name, value)| {
                let entry = self
                    .entries
                    .iter()
                    .find(|e| &e.descriptor.name == name)
                    .ok_or("unknown parameter")?;
                Ok((name.clone(), entry.descriptor.validate(value.clone())?))
            })
            .collect()
    }
    /// All validation precedes setters. An owner failure reports exactly the failed name; earlier acknowledgements remain real.
    pub fn load(&mut self, bytes: &[u8], startup: bool) -> Result<(), String> {
        for (name, value) in self.assignments(bytes)? {
            self.set(&name, value, startup)
                .map_err(|e| format!("{name}: {e}; earlier acknowledged values remain applied"))?;
        }
        Ok(())
    }
    pub fn startup(&mut self, profiles: &[Vec<u8>], overrides: &[String]) -> Result<(), String> {
        if profiles.iter().map(Vec::len).sum::<usize>()
            + overrides.iter().map(String::len).sum::<usize>()
            > MAX_BYTES
        {
            return Err("startup parameters exceed 64 KiB".into());
        }
        for bytes in profiles {
            self.load(bytes, true)?;
        }
        for arg in overrides {
            let (name, text) = arg.split_once('=').ok_or("--param expects name=value")?;
            let value = match self
                .entries
                .iter()
                .find(|e| e.descriptor.name == name)
                .ok_or("unknown parameter")?
                .descriptor
                .kind
            {
                Kind::Enum(_) => Value::String(text.into()),
                _ => serde_json::from_str(text).map_err(|_| "invalid parameter value")?,
            };
            self.set(name, value, true)?;
        }
        Ok(())
    }
    pub fn profile(&self, name: &str) -> Result<Vec<u8>, String> {
        let params: serde_json::Map<String, Value> = self
            .entries
            .iter()
            .map(|e| {
                (
                    e.descriptor.name.clone(),
                    e.pending.as_ref().unwrap_or(&e.effective).clone(),
                )
            })
            .collect();
        let bytes = serde_json::to_vec(&json!({"name":name,"params":params,"flags":{}}))
            .map_err(|e| e.to_string())?;
        if bytes.len() > MAX_BYTES {
            return Err("parameter profile exceeds 64 KiB".into());
        }
        Ok(bytes)
    }
    pub fn page(&self, offset: usize) -> Vec<Parameter> {
        let mut bytes = 0;
        let mut rows = Vec::new();
        for e in self.entries.iter().skip(offset).take(50) {
            let strings = e.descriptor.name.len()
                + e.descriptor.unit.len()
                + match &e.descriptor.kind {
                    Kind::Enum(v) => {
                        v.len() * std::mem::size_of::<String>()
                            + v.iter().map(String::len).sum::<usize>()
                    }
                    _ => 0,
                };
            bytes += std::mem::size_of::<Parameter>()
                + strings
                + e.descriptor.default.as_str().map_or(0, str::len)
                + e.effective.as_str().map_or(0, str::len)
                + e.pending
                    .as_ref()
                    .and_then(Value::as_str)
                    .map_or(0, str::len);
            if bytes > 7 * 1024 || rows.try_reserve_exact(1).is_err() {
                break;
            }
            rows.push(Parameter {
                descriptor: e.descriptor.clone(),
                effective: e.effective.clone(),
                pending: e.pending.clone(),
                modified: e.pending.as_ref().unwrap_or(&e.effective) != &e.descriptor.default,
            });
        }
        rows
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Parameter {
    pub descriptor: Descriptor,
    pub effective: Value,
    pub pending: Option<Value>,
    pub modified: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn registry() -> Registry {
        let mut r = Registry::default();
        r.register(
            Descriptor {
                name: "capture.cap_mb".into(),
                kind: Kind::Integer { min: 1, max: 256 },
                default: json!(8),
                unit: "MiB".into(),
                restart: false,
            },
            |v| {
                if v == &json!(13) {
                    Err("refused".into())
                } else {
                    Ok(())
                }
            },
        )
        .unwrap();
        r
    }
    #[test]
    fn validation_acknowledgement_and_reset() {
        let mut r = registry();
        assert_eq!(
            r.set("capture.cap_mb", json!(999), false).unwrap(),
            json!(256)
        );
        assert!(r.set("capture.cap_mb", json!(13), false).is_err());
        assert_eq!(r.get("capture.cap_mb"), Some(&json!(256)));
        assert!(r.set("capture.cap_mb", json!(1.5), false).is_err());
        assert_eq!(r.reset("capture.cap_mb").unwrap(), json!(8));
    }
    #[test]
    fn startup_profiles_then_overrides_last_wins() {
        let mut r = registry();
        r.startup(
            &[
                br#"{"params":{"capture.cap_mb":20}}"#.to_vec(),
                br#"{"params":{"capture.cap_mb":30}}"#.to_vec(),
            ],
            &["capture.cap_mb=40".into(), "capture.cap_mb=50".into()],
        )
        .unwrap();
        assert_eq!(r.get("capture.cap_mb"), Some(&json!(50)));
        assert!(
            r.load(br#"{"params":{"capture.cap_mb":2,"missing":1}}"#, false)
                .is_err()
        );
        assert_eq!(r.get("capture.cap_mb"), Some(&json!(50)));
    }
    #[test]
    fn types_restart_and_bounds() {
        let mut r = registry();
        for (name, kind, default, changed) in [
            (
                "float",
                Kind::Float { min: 0., max: 1. },
                json!(0.5),
                json!(0.8),
            ),
            ("bool", Kind::Bool, json!(false), json!(true)),
            (
                "enum",
                Kind::Enum(vec!["a".into(), "b".into()]),
                json!("a"),
                json!("b"),
            ),
        ] {
            r.register(
                Descriptor {
                    name: name.into(),
                    kind,
                    default: default.clone(),
                    unit: String::new(),
                    restart: true,
                },
                |_| Ok(()),
            )
            .unwrap();
            r.set(name, changed.clone(), false).unwrap();
            let p = r
                .page(0)
                .into_iter()
                .find(|p| p.descriptor.name == name)
                .unwrap();
            assert_eq!(p.effective, default);
            assert_eq!(p.pending, Some(changed));
        }
        assert!(r.load(&vec![b' '; MAX_BYTES + 1], false).is_err());
        assert!(r.set("float", Value::Null, false).is_err());
        assert!(r.set("enum", json!("c"), false).is_err());
        let mut oversized = String::with_capacity(MAX_BYTES);
        oversized.push('b');
        r.set("enum", Value::String(oversized), false).unwrap();
        assert!(r.get("enum").unwrap().as_str().unwrap().len() <= 128);
        let Value::String(retained) = r.get("enum").unwrap() else {
            panic!()
        };
        assert_eq!(retained.capacity(), 1);
        assert!(
            r.register(
                Descriptor {
                    name: "x".repeat(MAX_BYTES),
                    kind: Kind::Bool,
                    default: json!(false),
                    unit: String::new(),
                    restart: false
                },
                |_| Ok(())
            )
            .is_err()
        );
    }
}
