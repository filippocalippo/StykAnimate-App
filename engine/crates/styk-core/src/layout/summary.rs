//! Per-solve subtree summaries. Folding touches only the leaf and its ancestors.
use super::*;
use std::collections::HashMap;

// A counted radix trie makes maximum replacement bounded by the 64-bit key width,
// rather than rescanning all siblings (a wide split otherwise becomes quadratic).
#[derive(Default)]
struct Branch {
    children: [usize; 2],
    count: usize,
}
#[derive(Default)]
struct Maximum {
    nodes: Vec<Branch>,
    free: Vec<usize>,
}
impl Maximum {
    fn add(&mut self, value: f64) {
        if self.nodes.is_empty() {
            self.nodes.push(Branch::default());
            self.nodes.push(Branch::default());
        }
        let mut at = 1;
        self.nodes[at].count += 1;
        for bit in (0..64).rev() {
            let side = ((value.max(0.).to_bits() >> bit) & 1) as usize;
            if self.nodes[at].children[side] == 0 {
                let child = if let Some(i) = self.free.pop() {
                    self.nodes[i] = Branch::default();
                    i
                } else {
                    self.nodes.push(Branch::default());
                    self.nodes.len() - 1
                };
                self.nodes[at].children[side] = child;
            }
            at = self.nodes[at].children[side];
            self.nodes[at].count += 1;
        }
    }
    fn remove(&mut self, value: f64) {
        let mut at = 1;
        self.nodes[at].count -= 1;
        for bit in (0..64).rev() {
            let side = ((value.max(0.).to_bits() >> bit) & 1) as usize;
            let child = self.nodes[at].children[side];
            self.nodes[child].count -= 1;
            if self.nodes[child].count == 0 {
                self.nodes[at].children[side] = 0;
                self.free.push(child);
            }
            at = child;
        }
    }
    fn get(&self) -> f64 {
        if self.nodes.is_empty() || self.nodes[1].count == 0 {
            return 0.;
        }
        let mut at = 1;
        let mut key = 0u64;
        for bit in (0..64).rev() {
            let side = usize::from(self.nodes[at].children[1] != 0);
            key |= (side as u64) << bit;
            at = self.nodes[at].children[side];
        }
        f64::from_bits(key)
    }
}
pub(super) struct Item<'a> {
    pub node: &'a Node,
    pub children: Vec<usize>,
    pub min: Size,
    pub expanded: bool,
    pub stage: bool,
    parent: Option<usize>,
    sum: f64,
    cross: Maximum,
    expanded_children: usize,
}
pub(super) struct Summaries<'a> {
    pub items: Vec<Item<'a>>,
    pub indices: HashMap<u32, usize>,
}
fn visit() {
    #[cfg(test)]
    super::solve::WORK.with(|c| c.set(c.get() + 1));
}
impl<'a> Summaries<'a> {
    pub fn new(root: &'a Node, gap: f64) -> Self {
        let mut s = Self {
            items: vec![],
            indices: HashMap::new(),
        };
        s.build(root, None, gap);
        s
    }
    fn build(&mut self, node: &'a Node, parent: Option<usize>, gap: f64) -> usize {
        visit();
        let index = self.items.len();
        self.indices.insert(node.id(), index);
        self.items.push(Item {
            node,
            children: vec![],
            min: Size::default(),
            expanded: true,
            stage: false,
            parent,
            sum: 0.,
            cross: Maximum::default(),
            expanded_children: 0,
        });
        match node {
            Node::Tabs(g) => {
                self.items[index].min = super::solve::group_min(g);
                self.items[index].stage = g.tabs.iter().any(|p| p.kind == "stage");
            }
            Node::Split { axis, kids, .. } => {
                let gutter = if *axis == Axis::Horizontal && gap > 0. {
                    8.
                } else {
                    gap
                };
                self.items[index].sum = gutter * kids.len().saturating_sub(1) as f64;
                for k in kids {
                    let child = self.build(&k.node, Some(index), gap);
                    let min = self.items[child].min;
                    let stage = self.items[child].stage;
                    let item = &mut self.items[index];
                    item.children.push(child);
                    item.stage |= stage;
                    item.sum += super::solve::axis(min, *axis);
                    item.cross.add(if *axis == Axis::Horizontal {
                        min.h
                    } else {
                        min.w
                    });
                    item.expanded_children += 1;
                }
                self.aggregate(index);
            }
        }
        index
    }
    fn aggregate(&mut self, index: usize) {
        let item = &mut self.items[index];
        if let Node::Split { axis, .. } = item.node {
            item.min = if *axis == Axis::Horizontal {
                Size {
                    w: item.sum.max(0.),
                    h: item.cross.get(),
                }
            } else {
                Size {
                    w: item.cross.get(),
                    h: item.sum.max(0.),
                }
            };
            item.expanded = item.expanded_children > 0;
        }
    }
    pub fn fold(&mut self, index: usize, fold: Fold, side: Side) {
        let min = match fold {
            Fold::Sheet => Size::default(),
            Fold::Header => Size {
                w: match self.items[index].node {
                    Node::Tabs(g) => super::solve::group_min(g).w,
                    _ => 0.,
                },
                h: 44.,
            },
            Fold::Strip if side.axis() == Axis::Horizontal => Size { w: 40., h: 0. },
            Fold::Strip => Size { w: 0., h: 40. },
        };
        let mut at = index;
        let mut old = self.items[at].min;
        let mut was_expanded = self.items[at].expanded;
        self.items[at].min = min;
        self.items[at].expanded = false;
        loop {
            visit();
            let now = self.items[at].min;
            let expanded = self.items[at].expanded;
            if old == now && was_expanded == expanded {
                break;
            }
            let Some(parent) = self.items[at].parent else {
                break;
            };
            let item = &mut self.items[parent];
            let Node::Split { axis, .. } = item.node else {
                break;
            };
            item.sum += super::solve::axis(now, *axis) - super::solve::axis(old, *axis);
            item.cross.remove(if *axis == Axis::Horizontal {
                old.h
            } else {
                old.w
            });
            item.cross.add(if *axis == Axis::Horizontal {
                now.h
            } else {
                now.w
            });
            item.expanded_children =
                item.expanded_children - usize::from(was_expanded) + usize::from(expanded);
            old = item.min;
            was_expanded = item.expanded;
            self.aggregate(parent);
            at = parent;
        }
    }
    pub fn positions(
        &self,
        at: usize,
        side: Side,
        out: &mut std::collections::BTreeMap<u32, Side>,
    ) {
        let item = &self.items[at];
        match item.node {
            Node::Tabs(g) => {
                out.insert(g.id, side);
            }
            Node::Split { axis, .. } => {
                let stage = item.children.iter().position(|i| self.items[*i].stage);
                for (i, child) in item.children.iter().enumerate() {
                    let next = match stage {
                        Some(at) if i != at => match (*axis, i < at) {
                            (Axis::Horizontal, true) => Side::Left,
                            (Axis::Horizontal, false) => Side::Right,
                            (Axis::Vertical, true) => Side::Top,
                            _ => Side::Bottom,
                        },
                        _ => side,
                    };
                    self.positions(*child, next, out);
                }
            }
        }
    }
    pub fn candidates(&self) -> Vec<usize> {
        let mut indices: Vec<_> = self
            .items
            .iter()
            .enumerate()
            .filter_map(|(i, item)| {
                matches!(item.node, Node::Tabs(_))
                    .then_some(i)
                    .filter(|_| !item.stage)
            })
            .collect();
        let mut scratch = vec![0; indices.len()];
        // Stable byte passes preserve the existing priority then NodeId ordering in linear work.
        for pass in 0..5 {
            let key = |i: usize| {
                let Node::Tabs(g) = self.items[i].node else {
                    return 0;
                };
                if pass < 4 {
                    ((g.id >> (pass * 8)) & 255) as usize
                } else {
                    g.tabs
                        .iter()
                        .filter_map(|p| spec(&p.kind))
                        .map(|s| s.keep)
                        .max()
                        .unwrap_or(0) as usize
                }
            };
            let mut counts = [0usize; 256];
            for i in &indices {
                counts[key(*i)] += 1;
            }
            let mut at = 0;
            for c in &mut counts {
                let n = *c;
                *c = at;
                at += n;
            }
            for i in &indices {
                let k = key(*i);
                scratch[counts[k]] = *i;
                counts[k] += 1;
            }
            std::mem::swap(&mut indices, &mut scratch);
        }
        indices
    }
}
