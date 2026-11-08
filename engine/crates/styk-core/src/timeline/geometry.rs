//! Logical-pixel navigation, including the pinned system rows and Simple cards.
//! Constants and arithmetic follow timeline-rows.mjs and timeline-navigation.mjs.
use std::ops::Range;
#[derive(Clone, Debug, PartialEq)]
pub struct Geometry {
    pub width: f64,
    pub height: f64,
    pub scroll_x: f64,
    pub scroll_y: f64,
    pub tick_width: f64,
    pub row_height: f64,
    pub ruler_height: f64,
    pub label_width: f64,
    pub card_width: f64,
    pub card_scroll: f64,
    edge_rest: f64,
}
impl Default for Geometry {
    fn default() -> Self {
        Self {
            width: 800.,
            height: 240.,
            scroll_x: 0.,
            scroll_y: 0.,
            tick_width: 14.,
            row_height: 32.,
            ruler_height: 32.,
            label_width: 220.,
            card_width: 112.,
            card_scroll: 0.,
            edge_rest: 0.,
        }
    }
}
impl Geometry {
    pub fn viewport(&mut self, width: f64, height: f64) -> bool {
        if !width.is_finite() || !height.is_finite() || width < 0. || height < 0. {
            return false;
        }
        self.width = width;
        self.height = height;
        true
    }
    pub fn pinned(&self, rows: usize) -> bool {
        let system = rows.min(2) as f64 * 24.;
        let room = (self.height - self.ruler_height).max(0.);
        system > 0. && system <= (room / 2.).max(room - 3. * self.row_height)
    }
    pub fn row_top(&self, row: usize) -> f64 {
        row.min(2) as f64 * 24. + row.saturating_sub(2) as f64 * self.row_height
    }
    pub fn row_size(&self, row: usize) -> f64 {
        if row < 2 { 24. } else { self.row_height }
    }
    pub fn row_y(&self, row: usize, rows: usize) -> f64 {
        self.ruler_height + self.row_top(row) - if row < 2 && self.pinned(rows) { 0. } else { self.scroll_y }
    }
    pub fn scroll(&mut self, x: f64, y: f64, rows: usize, ticks: u32) {
        if !x.is_finite() || !y.is_finite() {
            return;
        }
        self.scroll_x =
            x.clamp(0., (f64::from(ticks.saturating_add(60)) * self.tick_width - (self.width - self.label_width).max(0.)).max(0.));
        self.scroll_y = y.clamp(0., (self.row_top(rows) - (self.height - self.ruler_height).max(0.)).max(0.));
    }
    pub fn tick(&self, x: f64) -> Option<u32> {
        x.is_finite().then(|| ((x - self.label_width + self.scroll_x) / self.tick_width).floor().clamp(0., 9_999_999.) as u32)
    }
    pub fn row(&self, y: f64, rows: usize) -> Option<usize> {
        if !y.is_finite() || y < self.ruler_height || y >= self.height {
            return None;
        }
        let system = rows.min(2) as f64 * 24.;
        let y = y - self.ruler_height;
        let y = if self.pinned(rows) && y < system { y } else { y + self.scroll_y };
        let row = if y < system { (y / 24.).floor() as usize } else { rows.min(2) + ((y - system) / self.row_height).floor() as usize };
        (row < rows).then_some(row)
    }
    pub fn rows(&self, count: usize) -> Vec<usize> {
        let mut out = Vec::new();
        if self.pinned(count) {
            out.extend(0..count.min(2));
        }
        let system = count.min(2) as f64 * 24.;
        let start = self.scroll_y + if self.pinned(count) { system } else { 0. };
        let first = if start < system {
            (start / 24.).floor() as usize
        } else {
            count.min(2) + ((start - system) / self.row_height).floor() as usize
        };
        let mut row = first;
        while row < count && self.row_y(row, count) < self.height {
            out.push(row);
            row += 1;
        }
        out
    }
    pub fn ticks(&self) -> Range<u32> {
        let first = (self.scroll_x / self.tick_width).floor() as u32;
        first..((self.scroll_x + (self.width - self.label_width).max(0.)) / self.tick_width).ceil().min(10_000_000.) as u32
    }
    pub fn reveal(&mut self, tick: f64, row: Option<usize>, rows: usize, total: u32) {
        let left = tick * self.tick_width;
        let width = (self.width - self.label_width).max(self.tick_width);
        let x = if left < self.scroll_x {
            left
        } else if left > self.scroll_x + width - 30. {
            left - width + 60.
        } else {
            self.scroll_x
        };
        let y = row.map_or(self.scroll_y, |row| {
            if row < 2 && self.pinned(rows) {
                return self.scroll_y;
            }
            let top = self.row_top(row);
            let size = self.row_size(row);
            let pinned = if self.pinned(rows) { rows.min(2) as f64 * 24. } else { 0. };
            let height = (self.height - self.ruler_height).max(size);
            if top < self.scroll_y + pinned {
                top - pinned
            } else if top + size > self.scroll_y + height {
                top + size - height
            } else {
                self.scroll_y
            }
        });
        self.scroll(x, y, rows, total.max(tick as u32));
    }
    pub fn cards(&self, count: usize) -> Range<usize> {
        let first = ((self.card_scroll / self.card_width).floor() as usize).saturating_sub(1).min(count);
        first..(first + (self.width / self.card_width).ceil() as usize + 3).min(count)
    }
    pub fn card(&self, x: f64, count: usize) -> Option<usize> {
        if !x.is_finite() || x < 0. || x >= self.width {
            return None;
        }
        let index = ((x + self.card_scroll) / self.card_width).floor() as usize;
        (index < count).then_some(index)
    }
    pub fn scroll_cards(&mut self, x: f64, count: usize) {
        if x.is_finite() {
            self.card_scroll = x.clamp(0., (count as f64 * self.card_width - self.width).max(0.));
        }
    }
    pub fn reveal_card(&mut self, index: usize, count: usize) {
        let left = index as f64 * self.card_width;
        let x = if left < self.card_scroll {
            left
        } else if left + self.card_width > self.card_scroll + self.width {
            left + self.card_width - self.width
        } else {
            self.card_scroll
        };
        self.scroll_cards(x, count);
    }
    pub fn reset_edge(&mut self) {
        self.edge_rest = 0.;
    }
    pub fn edge_active(&self, x: f64, origin: f64) -> bool {
        (x < self.label_width + 28. && x < origin) || (x > self.width - 28. && x > origin)
    }
    /// Same 28px zone, 120..1200px/s, 50ms elapsed cap and fractional carry as today's edgeStep.
    pub fn scrub_edge(&mut self, x: f64, elapsed_ms: u64, rows: usize, total: u32) -> bool {
        if !x.is_finite() {
            return false;
        }
        let speed = if x < self.label_width + 28. {
            -(120. + 1080. * ((self.label_width + 28. - x) / 28.).clamp(0., 1.))
        } else if x > self.width - 28. {
            120. + 1080. * ((x - self.width + 28.) / 28.).clamp(0., 1.)
        } else {
            self.edge_rest = 0.;
            return false;
        };
        let moved = self.edge_rest + speed * elapsed_ms.min(50) as f64 / 1000.;
        let whole = moved.trunc();
        self.edge_rest = moved - whole;
        let old = self.scroll_x;
        self.scroll(old + whole, self.scroll_y, rows, total);
        self.scroll_x != old
    }
}
