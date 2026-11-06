//! Arguments the owner encodes because JSON cannot say them (`src/engine/engine-owner.mjs`, `sessionPayload`).
//!
//! JSON drops an object member set to `undefined` and turns `NaN` and infinities into `null`, so the editor's validation never
//! saw them. A call whose view says `encoded: true` carries
//!
//! - `{"@number": "NaN" | "Infinity" | "-Infinity"}` where the editor was given such a number: decoded to the number, so the
//!   finite checks refuse it with the editor's own message;
//! - `{"@undefined": true}` as an object member that was `undefined`: an absent member for every command, except the ones that
//!   give it a meaning ([`keeps_undefined`]). Those take a patch over a record they edit, and a member set to `undefined` removes the
//!   old one, as `{...old, ...patch}` or `Object.assign(record, patch)` followed by JSON does: `setRigBehavior` (every member of a
//!   rig, and the members of a merged one), `updateObject` and `updateSelection` (a figure's field). A command that keeps the marker
//!   decodes it itself and never stores it (`tests/engine-owner-undefined.test.mjs` sends it to every command).

use styk_doc::{Obj, Value};

pub(crate) const UNDEFINED: &str = "@undefined";
const NUMBER: &str = "@number";

/// The commands whose patches give an `undefined` member a meaning (see [`is_undefined`]).
pub(crate) fn keeps_undefined(method: &str) -> bool {
    matches!(method, "setRigBehavior" | "updateObject" | "updateSelection")
}

/// Whether `value` is the encoding of an `undefined` object member.
pub(crate) fn is_undefined(value: &Value) -> bool {
    value.as_obj().is_some_and(|marker| marker.len() == 1 && marker.get(UNDEFINED).is_some_and(Value::truthy))
}

fn number(marker: &Obj) -> Option<f64> {
    if marker.len() != 1 {
        return None;
    }
    match marker.get(NUMBER)?.as_str()? {
        "NaN" => Some(f64::NAN),
        "Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        _ => None,
    }
}

/// The arguments as the editor was given them, for the commands that do not read the `undefined` marker (`keep`: the ones that do).
/// What holds no marker is returned as it is.
pub(crate) fn decode(value: &Value, keep: bool) -> Value {
    match value {
        Value::Obj(object) => {
            if let Some(number) = number(object) {
                return Value::Num(number);
            }
            if object.values().iter().all(|member| !holds_marker(member)) {
                return value.clone();
            }
            let mut decoded = Obj::new();
            for (key, member) in object.iter() {
                if is_undefined(member) && !keep {
                    continue;
                }
                decoded.set(key, if is_undefined(member) { member.clone() } else { decode(member, keep) });
            }
            Value::object(decoded)
        }
        Value::Arr(items) => {
            if !items.iter().any(holds_marker) {
                return value.clone();
            }
            Value::array(items.iter().map(|item| decode(item, keep)).collect())
        }
        _ => value.clone(),
    }
}

/// Whether `value` is a marker or holds one.
fn holds_marker(value: &Value) -> bool {
    match value {
        Value::Obj(object) => number(object).is_some() || is_undefined(value) || object.values().iter().any(holds_marker),
        Value::Arr(items) => items.iter().any(holds_marker),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Value {
        styk_doc::json::parse(text.as_bytes()).unwrap()
    }

    #[test]
    fn non_finite_numbers_come_back_as_numbers() {
        let decoded = decode(&parse(r#"[{"a":{"@number":"NaN"},"b":[1,{"@number":"-Infinity"}]}]"#), false);
        let first = decoded.item(0).unwrap();
        assert!(first.get("a").and_then(Value::as_f64).unwrap().is_nan());
        assert_eq!(first.get("b").unwrap().item(1).and_then(|v| v.as_f64()), Some(f64::NEG_INFINITY));
        assert_eq!(decode(&parse(r#"{"@number":"Infinity"}"#), false).as_f64(), Some(f64::INFINITY));
    }

    #[test]
    fn an_undefined_member_is_absent_unless_the_command_reads_it() {
        let args = parse(r#"[{"keys":[1],"pitch":{"@undefined":true},"nested":{"x":{"@undefined":true},"y":2}}]"#);
        let absent = decode(&args, false).item(0).unwrap();
        assert!(!absent.as_obj().unwrap().contains("pitch"));
        assert_eq!(absent.get("nested").unwrap().as_obj().unwrap().len(), 1);
        let kept = decode(&args, true).item(0).unwrap();
        assert!(is_undefined(kept.get("pitch").unwrap()));
        assert!(is_undefined(kept.get("nested").unwrap().get("x").unwrap()));
        assert!(keeps_undefined("setRigBehavior") && keeps_undefined("updateObject") && !keeps_undefined("updateSegment"));
    }

    #[test]
    fn arguments_without_a_marker_are_the_same_values() {
        let args = parse(r#"[{"a":[1,"x",{"b":null}]}]"#);
        let decoded = decode(&args, false);
        assert!(decoded.item(0).unwrap().get("a").unwrap().same_node(&args.item(0).unwrap().get("a").unwrap()));
    }
}
