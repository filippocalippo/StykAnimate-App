//! Worker-only admission of an immutable COW graph, with shared allocations
//! counted once across roots. This is transient traversal, never a weight cache.
use super::{Shape, Value};
use std::collections::HashSet;
use std::mem::size_of;
use std::sync::Arc;

// Arc headers, allocator alignment and the owner itself. Deliberately rounds up
// rather than charging payload lengths alone; this is conservative admission.
const ALLOCATION: usize = 64;

/// Conservative retained allocation bytes for these canonical COW roots.
/// Shared containers, shapes, key/string buffers and blob sections count once.
/// `check` receives the accumulated charge at most 1024 visited entries apart;
/// hosts enforce their existing budget/cancellation there. Packed arrays/blobs
/// require no element walk. Must run on a worker, never an interface thread.
/// The estimate includes a wide shape's possible lazy index, so a subsequent
/// owning Loader lookup cannot silently grow an admitted root beyond its charge.
pub fn retained_bytes_checked<E>(
    roots: &[&Value],
    mut check: impl FnMut(usize) -> Result<(), E>,
) -> Result<usize, E> {
    enum Walk<'a> {
        Value(&'a Value),
        Values(&'a [Value], usize),
        Keys(&'a [Arc<str>], usize),
    }
    fn add(total: &mut usize, bytes: usize) {
        *total = total.saturating_add(bytes);
    }
    fn string(value: &Arc<str>, seen: &mut HashSet<(u8, usize)>, total: &mut usize) {
        if seen.insert((1, Arc::as_ptr(value) as *const () as usize)) {
            add(total, ALLOCATION.saturating_add(value.len()));
        }
    }
    let mut seen = HashSet::new();
    let mut work = Vec::new();
    let mut total = 0usize;
    let mut visited = 0usize;
    check(total)?;
    for root in roots {
        work.push(Walk::Value(root));
        while let Some(next) = work.pop() {
            visited += 1;
            match next {
                Walk::Value(Value::Null | Value::Bool(_) | Value::Num(_)) => {}
                Walk::Value(Value::Str(value)) => string(value, &mut seen, &mut total),
                Walk::Value(Value::Nums(value)) => {
                    if seen.insert((2, Arc::as_ptr(value) as usize)) {
                        add(
                            &mut total,
                            ALLOCATION
                                .saturating_add(size_of::<super::Nums>())
                                .saturating_add(value.heap_bytes()),
                        );
                    }
                }
                Walk::Value(Value::Blob(value)) => {
                    if seen.insert((3, Arc::as_ptr(value) as usize)) {
                        add(
                            &mut total,
                            ALLOCATION.saturating_add(size_of::<super::Blob>()),
                        );
                        string(&value.prefix, &mut seen, &mut total);
                        if seen.insert((4, Arc::as_ptr(&value.bytes) as *const () as usize)) {
                            add(&mut total, ALLOCATION.saturating_add(value.bytes.len()));
                        }
                    }
                }
                Walk::Value(Value::Arr(value)) => {
                    if seen.insert((5, Arc::as_ptr(value) as usize)) {
                        add(
                            &mut total,
                            ALLOCATION
                                .saturating_add(size_of::<Vec<Value>>())
                                .saturating_add(
                                    value.capacity().saturating_mul(size_of::<Value>()),
                                ),
                        );
                        work.push(Walk::Values(value, 0));
                    }
                }
                Walk::Value(Value::Obj(value)) => {
                    if seen.insert((6, Arc::as_ptr(value) as usize)) {
                        add(
                            &mut total,
                            ALLOCATION
                                .saturating_add(size_of::<super::Obj>())
                                .saturating_add(
                                    value.values.capacity().saturating_mul(size_of::<Value>()),
                                ),
                        );
                        work.push(Walk::Values(&value.values, 0));
                        let shape = &value.shape;
                        if seen.insert((7, Arc::as_ptr(shape) as usize)) {
                            add(
                                &mut total,
                                ALLOCATION
                                    .saturating_add(size_of::<Shape>())
                                    .saturating_add(
                                        shape.keys.len().saturating_mul(size_of::<Arc<str>>()),
                                    ),
                            );
                            if shape.keys.len() > super::SCAN_KEYS {
                                let capacity = shape
                                    .keys
                                    .len()
                                    .checked_next_power_of_two()
                                    .unwrap_or(usize::MAX)
                                    .saturating_mul(2);
                                add(
                                    &mut total,
                                    ALLOCATION.saturating_add(
                                        capacity.saturating_mul(size_of::<(Arc<str>, u32)>() + 16),
                                    ),
                                );
                            }
                            work.push(Walk::Keys(&shape.keys, 0));
                        }
                    }
                }
                Walk::Values(values, at) => {
                    if let Some(value) = values.get(at) {
                        work.push(Walk::Values(values, at + 1));
                        work.push(Walk::Value(value));
                    }
                }
                Walk::Keys(keys, at) => {
                    if let Some(key) = keys.get(at) {
                        string(key, &mut seen, &mut total);
                        work.push(Walk::Keys(keys, at + 1));
                    }
                }
            }
            if visited % 1024 == 0 {
                check(total)?;
            }
        }
    }
    check(total)?;
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Blob, Obj};
    #[test]
    fn retained_graph_counts_shared_heads_sections_shapes_and_strings_once() {
        let text = Value::str("shared");
        let nums = Value::nums(&[0.125; 8192]);
        let blob = Value::Blob(Arc::new(Blob {
            prefix: Arc::from("image:"),
            bytes: vec![1; 8192].into(),
        }));
        let mut child = Obj::new();
        child.set("text", text.clone());
        child.set("nums", nums);
        child.set("blob", blob);
        let child = Value::object(child);
        let mut root = Obj::new();
        root.set("a", child.clone());
        root.set("b", child.clone());
        let before = Value::object(root);
        let mut after = before.clone();
        after.make_obj().unwrap().set("extra", text);
        let bytes = retained_bytes_checked(&[&before], |_| Ok::<_, ()>(())).unwrap();
        assert_eq!(
            bytes,
            retained_bytes_checked(&[&before, &before], |_| Ok::<_, ()>(())).unwrap()
        );
        let union = retained_bytes_checked(&[&before, &after], |_| Ok::<_, ()>(())).unwrap();
        assert!(union > bytes);
        assert!(
            union < bytes + 2048,
            "unchanged dense nodes only count once: {bytes}/{union}"
        );
        assert!(union < before.heap_bytes() + after.heap_bytes());
    }
    #[test]
    fn dense_single_object_walk_checks_cooperatively_and_exposes_budget_before_finish() {
        let mut obj = Obj::new();
        for at in 0..6000 {
            obj.set(&format!("field{at}"), Value::str("retained"));
        }
        let value = Value::object(obj);
        let mut checks = 0;
        assert_eq!(
            retained_bytes_checked(&[&value], |_| {
                checks += 1;
                if checks == 3 { Err("cancel") } else { Ok(()) }
            }),
            Err("cancel")
        );
        assert_eq!(checks, 3);
        let mut charges = Vec::new();
        let bytes = retained_bytes_checked(&[&value], |charge| {
            charges.push(charge);
            Ok::<_, ()>(())
        })
        .unwrap();
        assert!(charges.len() > 10);
        assert!(charges.windows(2).all(|pair| pair[0] <= pair[1]));
        assert_eq!(charges.last(), Some(&bytes));
    }
}
