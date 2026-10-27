//! Saved effect ownership (`src/vfx.mjs::remapVfxOwner`).
//! Topology, clipboard insertion and explicit materialization share this owner.
use styk_doc::{Obj, Value};

/// Move saved node stacks with a definition and optional physical-handle map.
/// Figure stacks, wildcard scopes, unrelated scopes, insertion order and opaque
/// stack values survive unchanged. Callers own document/handle validation.
pub fn remap_owner(
    owner: &mut Obj,
    type_id: f64,
    handles: Option<&[(f64, Vec<f64>)]>,
    source_type: f64,
) {
    let Some(table) = owner.get("_stykVfx").and_then(Value::as_obj).cloned() else {
        return;
    };
    let number = |text: &str| {
        let text = text.trim();
        if text.is_empty() {
            0.0
        } else {
            text.parse::<f64>().unwrap_or(f64::NAN)
        }
    };
    // Template interpolation uses Number::toString, not JSON's null for
    // nonfinite values. Finite values reuse the document's V8-exact formatter.
    let format = |value: f64| {
        if value.is_nan() { "NaN".to_string() }
        else if value == f64::INFINITY { "Infinity".to_string() }
        else if value == f64::NEG_INFINITY { "-Infinity".to_string() }
        else { styk_doc::json::to_string(&Value::Num(value)) }
    };
    let mut next = Obj::new();
    for (key, stack) in table.iter() {
        if &**key == "figure" {
            next.set(key, stack.clone());
            continue;
        }
        // JS destructures only the first two split tokens. An absent token is
        // undefined (NaN), whereas a present empty token converts to zero.
        let mut tokens = key.split('/');
        let scope = tokens.next().unwrap();
        let handle = tokens.next().map(number).unwrap_or(f64::NAN);
        if scope != "*" && number(scope) != source_type {
            next.set(key, stack.clone());
            continue;
        }
        let replacements = handles
            .and_then(|map| map.iter().find(|(old, _)| *old == handle))
            .map(|(_, replacements)| replacements.as_slice())
            .unwrap_or(std::slice::from_ref(&handle));
        for replacement in replacements {
            let scope = if scope == "*" {
                "*".to_string()
            } else {
                format(type_id)
            };
            next.set(&format!("{scope}/{}", format(*replacement)), stack.clone());
        }
    }
    if next.is_empty() {
        owner.remove("_stykVfx");
    } else {
        owner.set("_stykVfx", Value::object(next));
    }
}
