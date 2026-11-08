//! The window's view state the features depend on, owned here and nowhere else.
//!
//! What the document's session already owns (the selection, the selected joint, the playhead, the active layer, the
//! history) is never copied here: it is read from the session. This holds what today's app keeps in `state` beside the
//! editor: the workspace tab, the tool, the Inspector's context override, Edit together and its frames. Every change goes
//! through [`ViewState`]'s methods, which bump [`ViewState::version`], the half of a view model's cache key the
//! document's revision does not cover.

/// The Properties panel's tab (`state.inspectorTab`): Design shows the selection, Animation its timing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum InspectorTab {
    #[default]
    Design,
    Animation,
}

/// What the Inspector describes when not left to the selection (`state.inspectorContext`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum InspectorContext {
    #[default]
    Auto,
    Scene,
    Camera,
    Layer,
    Frame,
    Figure,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ViewState {
    version: u64,
    tab: InspectorTab,
    context: InspectorContext,
    /// Edit together (`state.applyRange`).
    apply_range: bool,
    /// The frames chosen on the timeline, which Edit together reaches: ticks on a layer sheet (`timelineUI.selectedTicks`),
    /// keyframe indices on a classic document (`state.rangeIndices`).
    range: Vec<usize>,
    /// A Draw tool is active: the Inspector shows its options.
    drawing: Option<&'static str>,
}

impl ViewState {
    pub fn new() -> ViewState {
        ViewState::default()
    }

    /// Changes whenever anything here changes; a view model's cache key holds it.
    pub fn version(&self) -> u64 {
        self.version
    }

    fn bump(&mut self) {
        self.version = self.version.wrapping_add(1);
    }

    pub fn tab(&self) -> InspectorTab {
        self.tab
    }
    pub fn context(&self) -> InspectorContext {
        self.context
    }
    pub fn apply_range(&self) -> bool {
        self.apply_range
    }
    pub fn range(&self) -> &[usize] {
        &self.range
    }
    pub fn drawing(&self) -> Option<&'static str> {
        self.drawing
    }

    pub fn set_tab(&mut self, tab: InspectorTab) {
        if self.tab != tab {
            self.tab = tab;
            self.bump();
        }
    }

    pub fn set_context(&mut self, context: InspectorContext) {
        if self.context != context {
            self.context = context;
            self.bump();
        }
    }

    pub fn set_apply_range(&mut self, on: bool) {
        if self.apply_range != on {
            self.apply_range = on;
            self.bump();
        }
    }

    /// The frames chosen on the timeline, in the order the timeline reports them; duplicates collapse.
    pub fn set_range(&mut self, chosen: Vec<usize>) {
        let mut frames: Vec<usize> = Vec::with_capacity(chosen.len());
        for frame in chosen {
            if !frames.contains(&frame) {
                frames.push(frame);
            }
        }
        if self.range != frames {
            self.range = frames;
            self.bump();
        }
    }

    pub fn set_drawing(&mut self, tool: Option<&'static str>) {
        if self.drawing != tool {
            self.drawing = tool;
            self.bump();
        }
    }

    /// `rangeFrames()`: the frames an edit reaches while Edit together is on and two or more are chosen.
    pub fn range_frames(&self) -> Option<&[usize]> {
        (self.apply_range && self.range.len() > 1).then_some(self.range.as_slice())
    }
}
