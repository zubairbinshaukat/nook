// Which edge of the display the island hangs from, and where that puts the
// window. All of it is plain arithmetic on rectangles in physical pixels, so
// island.rs only has to ask the display and apply the answer, and every dock
// and every taskbar position can be tested without a window.
//
// The top dock is what Nook always did: the window hangs from the display's top
// edge, centred on the whole display, over a top taskbar if there is one. The
// others sit inside the work area (what the taskbar leaves free), flush with the
// edge they dock to. With an auto-hiding taskbar the work area is the whole
// display, so the island then sits at the display's own edge.

use serde::Serialize;

use crate::island::{PANEL_MAX_H, PANEL_MAX_W, PANEL_MIN_H, PANEL_MIN_W, SCREEN_MARGIN_H, SCREEN_MARGIN_W, STRIP_H, STRIP_W};

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Dock {
    Top,
    Bottom,
    Left,
    Right,
}

/// What `Settings::dock` can say: the first is the default.
pub const DOCKS: &[&str] = &["top", "bottom", "left", "right"];

impl Dock {
    pub fn as_str(self) -> &'static str {
        match self {
            Dock::Top => "top",
            Dock::Bottom => "bottom",
            Dock::Left => "left",
            Dock::Right => "right",
        }
    }

    /// The dock a word names; the top for any other.
    pub fn parse(said: &str) -> Self {
        match said {
            "bottom" => Dock::Bottom,
            "left" => Dock::Left,
            "right" => Dock::Right,
            _ => Dock::Top,
        }
    }

    /// Docked to a side, not to the top or bottom.
    pub fn vertical(self) -> bool {
        matches!(self, Dock::Left | Dock::Right)
    }
}

/// A rectangle in physical screen pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    fn right(&self) -> i32 {
        self.x + self.w as i32
    }
    fn bottom(&self) -> i32 {
        self.y + self.h as i32
    }
}

/// Everything `apply_geometry` needs to put the window down.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    /// The full window's logical size, as the page is told it (whole physical pixels).
    pub panel: (f64, f64),
    /// The window's physical size now: the panel, or the wake strip.
    pub size: (u32, u32),
    /// Its top-left corner, physical.
    pub pos: (i32, i32),
}

/// The full window's logical size on this display: the large panel, or what of
/// it fits. The top dock measures from the display's top edge down to where the
/// work area ends; the bottom from the work area's top to its bottom; a side dock
/// keeps the landscape window, narrowed to the work area's width.
pub fn panel_size(dock: Dock, monitor: Rect, work: Rect, scale: f64) -> (f64, f64) {
    let (room_w, room_h) = match dock {
        Dock::Top => (monitor.w as f64, (work.bottom() - monitor.y).max(0) as f64),
        Dock::Bottom => (monitor.w as f64, work.h as f64),
        Dock::Left | Dock::Right => (work.w as f64, work.h as f64),
    };
    (
        (room_w / scale - SCREEN_MARGIN_W).clamp(PANEL_MIN_W, PANEL_MAX_W),
        (room_h / scale - SCREEN_MARGIN_H).clamp(PANEL_MIN_H, PANEL_MAX_H),
    )
}

/// The wake strip's physical size: thin across the edge it is docked to.
pub fn strip_size(dock: Dock, scale: f64) -> (u32, u32) {
    let (long, thin) = ((STRIP_W * scale).round().max(1.0) as u32, (STRIP_H * scale).round().max(1.0) as u32);
    if dock.vertical() { (thin, long) } else { (long, thin) }
}

/// Where a window of this physical size goes. Top and bottom are centred on the
/// whole display, a side dock on the work area; each is flush with its edge. A
/// window larger than the room it has is kept on the display at its far edge.
pub fn window_pos(dock: Dock, monitor: Rect, work: Rect, size: (u32, u32)) -> (i32, i32) {
    let (pw, ph) = (size.0 as i32, size.1 as i32);
    let across = monitor.x + (monitor.w as i32 - pw) / 2;
    let down = work.y + (work.h as i32 - ph) / 2;
    match dock {
        Dock::Top => (across, monitor.y),
        Dock::Bottom => (across, (work.bottom() - ph).max(monitor.y)),
        Dock::Left => (work.x, down.max(monitor.y)),
        Dock::Right => ((work.right() - pw).max(monitor.x), down.max(monitor.y)),
    }
}

/// Sizes and places the window; `collapsed` picks the wake strip over the panel.
pub fn place(dock: Dock, monitor: Rect, work: Rect, scale: f64, collapsed: bool) -> Placement {
    let (w, h) = panel_size(dock, monitor, work, scale);
    // In whole physical pixels, and told to the front end as it really is.
    let full_pw = (w * scale).round().max(1.0);
    let full_ph = (h * scale).round().max(1.0);
    let size = if collapsed { strip_size(dock, scale) } else { (full_pw as u32, full_ph as u32) };
    Placement { panel: (full_pw / scale, full_ph / scale), size, pos: window_pos(dock, monitor, work, size) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, w: u32, h: u32) -> Rect {
        Rect { x, y, w, h }
    }

    /// Placement as it was written before docks existed.
    fn old_formulas(monitor: Rect, work: Rect, scale: f64, collapsed: bool) -> ((f64, f64), (u32, u32), (i32, i32)) {
        let free_h = (work.y + work.h as i32 - monitor.y).max(0) as f64 / scale;
        let panel = (
            (monitor.w as f64 / scale - 32.0).clamp(720.0, 1136.0),
            (free_h - 24.0).clamp(320.0, 654.0),
        );
        let full_pw = (panel.0 * scale).round().max(1.0);
        let full_ph = (panel.1 * scale).round().max(1.0);
        let (pw, ph) = if collapsed {
            ((240.0 * scale).round().max(1.0) as u32, (6.0 * scale).round().max(1.0) as u32)
        } else {
            (full_pw as u32, full_ph as u32)
        };
        let x = monitor.x + (monitor.w as i32 - pw as i32) / 2;
        ((full_pw / scale, full_ph / scale), (pw, ph), (x, monitor.y))
    }

    /// 1920 × 1080 at 100 %, taskbar 48 px.
    const MON: Rect = Rect { x: 0, y: 0, w: 1920, h: 1080 };

    fn bottom_taskbar() -> Rect {
        rect(0, 0, 1920, 1032)
    }

    #[test]
    fn the_names_round_trip_and_an_unknown_one_is_the_top() {
        for name in DOCKS {
            assert_eq!(Dock::parse(name).as_str(), *name);
        }
        assert_eq!(Dock::parse(""), Dock::Top);
        assert_eq!(Dock::parse("Bottom"), Dock::Top);
        assert_eq!(Dock::parse("diagonal"), Dock::Top);
        assert_eq!(serde_json::to_string(&Dock::Bottom).unwrap(), "\"bottom\"");
    }

    #[test]
    fn the_top_dock_places_the_window_exactly_as_it_always_was() {
        let monitors = [
            (MON, bottom_taskbar()),
            (MON, rect(0, 48, 1920, 1032)),
            (MON, rect(48, 0, 1872, 1080)),
            (MON, MON),
            (rect(2560, 0, 2560, 1440), rect(2560, 0, 2560, 1380)),
            (rect(-1920, -200, 1920, 1080), rect(-1920, -200, 1920, 1032)),
            (rect(0, -1080, 1920, 1080), rect(0, -1080, 1920, 1032)),
            (rect(0, 0, 1024, 600), rect(0, 0, 1024, 560)),
            (rect(0, 0, 640, 360), rect(0, 0, 640, 320)),
        ];
        for (monitor, work) in monitors {
            for scale in [1.0, 1.25, 1.5, 1.75, 2.0] {
                for collapsed in [false, true] {
                    let got = place(Dock::Top, monitor, work, scale, collapsed);
                    let (panel, size, pos) = old_formulas(monitor, work, scale, collapsed);
                    assert_eq!((got.panel, got.size, got.pos), (panel, size, pos), "{monitor:?} {work:?} {scale} {collapsed}");
                }
            }
        }
    }

    #[test]
    fn the_top_dock_measures_down_to_the_end_of_the_work_area() {
        // Bottom taskbar: 1032 free, minus the margin.
        assert_eq!(panel_size(Dock::Top, MON, bottom_taskbar(), 1.0), (1136.0, 654.0));
        // A small laptop at 150 %: 1024 × 640 logical, 600 free above the taskbar.
        let laptop = rect(0, 0, 1536, 960);
        assert_eq!(panel_size(Dock::Top, laptop, rect(0, 0, 1536, 900), 1.5), (1024.0 - 32.0, 600.0 - 24.0));
        // A top taskbar does not shorten it: the window hangs over it, from the display's edge.
        assert_eq!(panel_size(Dock::Top, MON, rect(0, 48, 1920, 1032), 1.0), (1136.0, 654.0));
        // Too small: the normal panel.
        assert_eq!(panel_size(Dock::Top, rect(0, 0, 700, 300), rect(0, 0, 700, 300), 1.0), (720.0, 320.0));
    }

    #[test]
    fn the_bottom_dock_sits_on_the_work_area_and_is_centred_on_the_display() {
        // Taskbar at the bottom: just above it, never over it.
        let p = place(Dock::Bottom, MON, bottom_taskbar(), 1.0, false);
        assert_eq!(p.panel, (1136.0, 654.0));
        assert_eq!(p.size, (1136, 654));
        assert_eq!(p.pos, ((1920 - 1136) / 2, 1032 - 654));
        // The strip hugs the same edge.
        let s = place(Dock::Bottom, MON, bottom_taskbar(), 1.0, true);
        assert_eq!((s.size, s.pos), ((240, 6), (840, 1026)));
        assert_eq!(s.panel, p.panel);
        // Taskbar on top: the island is at the display's bottom, with the work area's height to grow in.
        let top_bar = rect(0, 48, 1920, 1032);
        let p = place(Dock::Bottom, MON, top_bar, 1.0, false);
        assert_eq!((p.size, p.pos), ((1136, 654), (392, 1080 - 654)));
        assert_eq!(place(Dock::Bottom, MON, top_bar, 1.0, true).pos, (840, 1074));
        // Taskbar on a side: the full height, and still centred on the display.
        let p = place(Dock::Bottom, MON, rect(48, 0, 1872, 1080), 1.0, false);
        assert_eq!(p.pos, (392, 1080 - 654));
        // No taskbar, or an auto-hiding one: work area is the display.
        let p = place(Dock::Bottom, MON, MON, 1.0, false);
        assert_eq!(p.pos, (392, 1080 - 654));
        // Room is the work area's height: 500 free gives 500 - 24.
        assert_eq!(panel_size(Dock::Bottom, rect(0, 0, 1920, 600), rect(0, 40, 1920, 500), 1.0).1, 476.0);
    }

    #[test]
    fn the_side_docks_are_flush_with_the_work_area_and_centred_on_it() {
        // Taskbar on the left: the window starts where it ends.
        let left_bar = rect(48, 0, 1872, 1080);
        let p = place(Dock::Left, MON, left_bar, 1.0, false);
        assert_eq!((p.size, p.pos), ((1136, 654), (48, (1080 - 654) / 2)));
        let p = place(Dock::Right, MON, left_bar, 1.0, false);
        assert_eq!(p.pos, (1920 - 1136, (1080 - 654) / 2));
        // Taskbar on the right.
        let right_bar = rect(0, 0, 1872, 1080);
        assert_eq!(place(Dock::Right, MON, right_bar, 1.0, false).pos.0, 1872 - 1136);
        assert_eq!(place(Dock::Left, MON, right_bar, 1.0, false).pos.0, 0);
        // Taskbar at the bottom or top: centred on what is left.
        assert_eq!(place(Dock::Left, MON, bottom_taskbar(), 1.0, false).pos, (0, (1032 - 654) / 2));
        assert_eq!(place(Dock::Right, MON, rect(0, 48, 1920, 1032), 1.0, false).pos, (1920 - 1136, 48 + (1032 - 654) / 2));
        // Width is held to the work area's.
        assert_eq!(panel_size(Dock::Left, rect(0, 0, 1000, 1080), rect(0, 0, 1000, 1080), 1.0).0, 1000.0 - 32.0);
        // The strip is thin across the edge and long along it, centred on the work area.
        let s = place(Dock::Left, MON, left_bar, 1.0, true);
        assert_eq!((s.size, s.pos), ((6, 240), (48, 420)));
        let s = place(Dock::Right, MON, left_bar, 1.0, true);
        assert_eq!((s.size, s.pos), ((6, 240), (1914, 420)));
    }

    #[test]
    fn the_strip_is_flat_for_top_and_bottom_and_upright_for_the_sides() {
        assert_eq!(strip_size(Dock::Top, 1.0), (240, 6));
        assert_eq!(strip_size(Dock::Bottom, 1.0), (240, 6));
        assert_eq!(strip_size(Dock::Left, 1.0), (6, 240));
        assert_eq!(strip_size(Dock::Right, 1.5), (9, 360));
        assert_eq!(strip_size(Dock::Top, 1.25), (300, 8));
        // 6 × 1.1 = 6.6 rounds up, and never to nothing.
        assert_eq!(strip_size(Dock::Top, 1.1).1, 7);
        assert_eq!(strip_size(Dock::Top, 0.0001).1, 1);
    }

    #[test]
    fn a_secondary_display_with_a_negative_origin_is_placed_in_its_own_coordinates() {
        // Left of the primary, taskbar at the bottom.
        let mon = rect(-1920, 0, 1920, 1080);
        let work = rect(-1920, 0, 1920, 1032);
        assert_eq!(place(Dock::Bottom, mon, work, 1.0, false).pos, (-1920 + 392, 1032 - 654));
        assert_eq!(place(Dock::Top, mon, work, 1.0, false).pos, (-1920 + 392, 0));
        assert_eq!(place(Dock::Left, mon, work, 1.0, false).pos.0, -1920);
        assert_eq!(place(Dock::Right, mon, work, 1.0, false).pos.0, -1136);
        // Above the primary.
        let mon = rect(0, -1080, 1920, 1080);
        let work = rect(0, -1080, 1920, 1032);
        assert_eq!(place(Dock::Bottom, mon, work, 1.0, false).pos, (392, -48 - 654));
        assert_eq!(place(Dock::Top, mon, work, 1.0, false).pos, (392, -1080));
        assert_eq!(place(Dock::Left, mon, work, 1.0, false).pos, (0, -1080 + (1032 - 654) / 2));
    }

    #[test]
    fn physical_rounding_holds_at_every_common_scale() {
        // 2560 × 1440 physical, taskbar 48 logical px (rounded), at each scale.
        for scale in [1.0, 1.25, 1.5, 1.75] {
            let taskbar = (48.0f64 * scale).round() as u32;
            let mon = rect(0, 0, 2560, 1440);
            let work = rect(0, 0, 2560, 1440 - taskbar);
            for dock in [Dock::Top, Dock::Bottom, Dock::Left, Dock::Right] {
                let p = place(dock, mon, work, scale, false);
                // The size told to the page is the physical size over the scale, exactly.
                assert_eq!(p.panel, (p.size.0 as f64 / scale, p.size.1 as f64 / scale), "{dock:?} {scale}");
                assert!(p.panel.0 >= PANEL_MIN_W && p.panel.1 >= PANEL_MIN_H);
                assert!(p.size.0 as f64 <= PANEL_MAX_W * scale + 0.5 && p.size.1 as f64 <= PANEL_MAX_H * scale + 0.5);
            }
            let p = place(Dock::Bottom, mon, work, scale, false);
            // The flush edge lands on the work area's last physical pixel, whatever the scale.
            assert_eq!(p.pos.1 + p.size.1 as i32, work.bottom(), "{scale}");
            assert_eq!(p.pos.0, (2560 - p.size.0 as i32) / 2);
            let s = place(Dock::Bottom, mon, work, scale, true);
            assert_eq!(s.pos.1 + s.size.1 as i32, work.bottom(), "{scale}");
        }
        // 1.25: 1136 × 1.25 = 1420 exactly, 654 × 1.25 = 817.5 rounds to 818.
        let p = place(Dock::Bottom, rect(0, 0, 2560, 1440), rect(0, 0, 2560, 1380), 1.25, false);
        assert_eq!(p.size, (1420, 818));
        assert_eq!(p.pos, (570, 1380 - 818));
    }

    #[test]
    fn a_window_larger_than_its_room_is_kept_on_the_display() {
        // 320 logical is the least the panel is, and the work area is only 200 tall.
        let mon = rect(0, 0, 1280, 240);
        let work = rect(0, 40, 1280, 200);
        let p = place(Dock::Bottom, mon, work, 1.0, false);
        assert_eq!(p.size.1, 320);
        assert_eq!(p.pos.1, 0);
        // Wider than the display, a side dock stays on its edge, not off it.
        let narrow = rect(100, 0, 400, 1080);
        assert_eq!(place(Dock::Right, narrow, narrow, 1.0, false).pos.0, 100);
        assert_eq!(place(Dock::Left, narrow, narrow, 1.0, false).pos.0, 100);
        // Taller than the display, a side dock starts at its top.
        let short = rect(0, 0, 1920, 200);
        assert_eq!(place(Dock::Left, short, short, 1.0, false).pos.1, 0);
    }

    #[test]
    fn without_a_taskbar_top_and_bottom_are_the_same_panel_at_opposite_edges() {
        // Work area is the display: top and bottom are the same panel at opposite edges.
        let t = place(Dock::Top, MON, MON, 1.0, false);
        let b = place(Dock::Bottom, MON, MON, 1.0, false);
        assert_eq!((t.panel, t.size), (b.panel, b.size));
        assert_eq!((t.pos.0, t.pos.1, b.pos.1), (b.pos.0, 0, 1080 - 654));
    }
}
