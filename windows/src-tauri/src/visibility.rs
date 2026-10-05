// Hiding the island altogether, and showing it again.
//
// The island is in the way of the top of a window now and then (a browser's tab
// strip): a shortcut or the tray hides the window — not folded, hidden: no
// pixel, no mouse, the polls parked — and the same again brings it back. It is
// never saved: Nook always starts with the island on show.
//
// A request — a permission, or a question — that comes while the island is
// hidden shows it, so it is seen; once every such request is over, it hides
// again, but only if it was that request that showed it. What a person did by
// hand is never undone: a hide or a show with the shortcut or the tray while
// a request holds the island up is theirs, and there is no moment after it
// when the island goes the other way by itself.
//
// A request counts from the island saying its card is on screen (`Reply::Ack`,
// pipe.rs) to the end of the relay's wait, whatever ends it: a click, the
// terminal, a timeout, a relay that went away. One the island declines — it is
// paused, or the request is too long to show — is never counted, so Pause keeps
// winning and nothing shows for it.
//
// Nothing here answers or clicks anything: showing the window is all it does.

use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::island;

/// How long the island waits after the last request ended before it hides again
/// (when it came up for a request). Back-to-back prompts then keep it up instead
/// of hiding and showing it each time. Only automatic: a hand action is instant.
pub const HIDE_DELAY: Duration = Duration::from_millis(600);

/// What a change in the state asks the window to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    Nothing,
    Show,
    Hide,
    /// Hide after `HIDE_DELAY`, unless the generation moved on by then: the
    /// number goes back to `Tracker::hide_if_current`.
    HideLater(u64),
}

/// Where the island stands, apart from the window and the OS, so every case can
/// be tested.
#[derive(Debug, Default)]
pub struct Tracker {
    hidden: bool,
    /// It is on show because a request came, and nobody has touched it since.
    auto_shown: bool,
    /// Requests whose card is up, and not yet over.
    up: usize,
    /// Moves on whenever something could cancel a scheduled hide: a request
    /// coming, a hand action, a hide being scheduled.
    generation: u64,
    /// Moves on each time `hidden` flips; the window follows it (see `apply`).
    rev: u64,
}

impl Tracker {
    #[cfg(test)]
    pub fn hidden(&self) -> bool {
        self.hidden
    }

    fn set_hidden(&mut self, hidden: bool) {
        self.hidden = hidden;
        self.rev += 1;
    }

    /// The shortcut, or the tray's Hide / Show: the other way from what it is,
    /// and the person's own choice from then on.
    pub fn toggle(&mut self) -> Change {
        self.auto_shown = false;
        self.generation += 1;
        self.set_hidden(!self.hidden);
        if self.hidden { Change::Hide } else { Change::Show }
    }

    /// "Open Nook": on show, if it was hidden — and left on show.
    pub fn open(&mut self) -> Change {
        self.auto_shown = false;
        self.generation += 1;
        if !self.hidden {
            return Change::Nothing;
        }
        self.set_hidden(false);
        Change::Show
    }

    /// A request's card is up. Cancels a hide that was waiting.
    pub fn request_up(&mut self) -> Change {
        self.up += 1;
        self.generation += 1;
        if !self.hidden {
            return Change::Nothing;
        }
        self.set_hidden(false);
        self.auto_shown = true;
        Change::Show
    }

    /// A request is over. When it was the last, and the island came up for a
    /// request, the island goes — after `HIDE_DELAY`, see `hide_if_current`.
    pub fn request_done(&mut self) -> Change {
        self.up = self.up.saturating_sub(1);
        if self.up > 0 || !self.auto_shown {
            return Change::Nothing;
        }
        self.generation += 1;
        Change::HideLater(self.generation)
    }

    /// The delay is over: hide, if nothing happened since it was scheduled.
    pub fn hide_if_current(&mut self, generation: u64) -> Change {
        if generation != self.generation || self.up > 0 || !self.auto_shown {
            return Change::Nothing;
        }
        self.auto_shown = false;
        self.set_hidden(true);
        Change::Hide
    }
}

/// The tray item's words, for what a press does.
pub fn label(hidden: bool) -> &'static str {
    if hidden { "Show island" } else { "Hide island" }
}

#[derive(Default)]
pub struct Visibility(Mutex<Tracker>);

impl Visibility {
    /// A lock that a panic elsewhere cannot poison for good: `Card::drop` (pipe.rs)
    /// runs this, and a drop must not panic.
    fn lock(&self) -> MutexGuard<'_, Tracker> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Decides a change of state under the lock, and puts it on the window and the
/// tray outside it.
///
/// The window and the menu calls wait for the main thread when they come from
/// another one, and the shortcut and the tray run on the main thread and need the
/// lock: holding the lock across those calls could freeze the app. So the lock is
/// held for the decision only. Two changes at nearly the same moment cannot
/// cross for it: the window follows the state's `rev` and, after each time it
/// has been put on, looks again — if the state has moved on meanwhile, it is put
/// on again, so the last state is always the one that stays.
fn apply(app: &AppHandle, change: impl FnOnce(&mut Tracker) -> Change) {
    let change = change(&mut app.state::<Visibility>().lock());
    run(app, change);
}

fn run(app: &AppHandle, change: Change) {
    match change {
        Change::Nothing => {}
        Change::Show | Change::Hide => sync(app),
        Change::HideLater(generation) => {
            let app = app.clone();
            // A timer, not a sleeping thread; a request or a hand action in the
            // meantime moves the generation on and this does nothing.
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(HIDE_DELAY).await;
                let change = app.state::<Visibility>().lock().hide_if_current(generation);
                run(&app, change);
            });
        }
    }
}

fn sync(app: &AppHandle) {
    let visibility = app.state::<Visibility>();
    loop {
        let (hidden, rev) = {
            let tracker = visibility.lock();
            (tracker.hidden, tracker.rev)
        };
        island::set_shown(app, !hidden);
        crate::tray::say_hidden(app, hidden);
        if visibility.lock().rev == rev {
            break;
        }
    }
}

/// The shortcut, or the tray.
pub fn toggle(app: &AppHandle) {
    apply(app, Tracker::toggle);
}

/// "Open Nook", and a second launch of Nook.
pub fn open(app: &AppHandle) {
    apply(app, Tracker::open);
}

/// A request's card is on screen.
pub fn request_up(app: &AppHandle) {
    apply(app, Tracker::request_up);
}

/// A request is over.
pub fn request_done(app: &AppHandle) {
    apply(app, Tracker::request_done);
}
#[cfg(test)]
mod tests {
    use super::*;

    fn done(island: &mut Tracker) -> Change {
        match island.request_done() {
            Change::HideLater(g) => island.hide_if_current(g),
            other => other,
        }
    }

    #[test]
    fn it_starts_on_show_and_the_shortcut_goes_back_and_forth() {
        let mut island = Tracker::default();
        assert!(!island.hidden());
        assert_eq!(island.toggle(), Change::Hide);
        assert!(island.hidden());
        assert_eq!(island.toggle(), Change::Show);
        assert_eq!(island.toggle(), Change::Hide);
        // Hidden by hand with nothing asking: it stays so, whatever else is said.
        assert_eq!(island.request_done(), Change::Nothing);
        assert!(island.hidden());
    }

    #[test]
    fn a_request_shows_a_hidden_island_and_its_end_hides_it_again() {
        let mut island = Tracker::default();
        island.toggle();
        assert_eq!(island.request_up(), Change::Show);
        assert!(!island.hidden());
        assert_eq!(done(&mut island), Change::Hide);
        assert!(island.hidden());
        // Nothing left to end: no second hide, no count below zero.
        assert_eq!(island.request_done(), Change::Nothing);
        assert_eq!(island.request_up(), Change::Show);
    }

    #[test]
    fn a_request_on_an_island_on_show_changes_nothing_then_or_after() {
        let mut island = Tracker::default();
        assert_eq!(island.request_up(), Change::Nothing);
        assert_eq!(island.request_done(), Change::Nothing);
        assert!(!island.hidden());
    }

    #[test]
    fn several_requests_hide_it_only_after_the_last() {
        let mut island = Tracker::default();
        island.toggle();
        assert_eq!(island.request_up(), Change::Show);
        assert_eq!(island.request_up(), Change::Nothing);
        assert_eq!(island.request_up(), Change::Nothing);
        assert_eq!(island.request_done(), Change::Nothing);
        assert_eq!(island.request_done(), Change::Nothing);
        assert!(!island.hidden());
        assert_eq!(done(&mut island), Change::Hide);
        assert!(island.hidden());
    }

    #[test]
    fn a_request_just_after_the_last_one_ended_shows_it_again() {
        let mut island = Tracker::default();
        island.toggle();
        island.request_up();
        assert_eq!(done(&mut island), Change::Hide);
        assert_eq!(island.request_up(), Change::Show);
        // And this one is a popup too: its end hides it.
        assert_eq!(done(&mut island), Change::Hide);
    }

    #[test]
    fn the_shortcut_on_a_popup_hides_it_at_once_and_it_does_not_come_back_by_itself() {
        let mut island = Tracker::default();
        island.toggle();
        island.request_up();
        assert_eq!(island.toggle(), Change::Hide);
        // The request ends later: the island is hidden already, and says nothing.
        assert_eq!(island.request_done(), Change::Nothing);
        assert!(island.hidden());
    }

    #[test]
    fn shown_by_hand_over_a_popup_it_stays_until_the_shortcut() {
        let mut island = Tracker::default();
        island.toggle();
        island.request_up();
        // Hidden by hand, shown by hand, with the request still up.
        island.toggle();
        assert_eq!(island.toggle(), Change::Show);
        assert_eq!(island.request_done(), Change::Nothing);
        assert!(!island.hidden());
        // Open Nook over a popup is as much the person's.
        let mut island = Tracker::default();
        island.toggle();
        island.request_up();
        assert_eq!(island.open(), Change::Nothing);
        assert_eq!(island.request_done(), Change::Nothing);
        assert!(!island.hidden());
    }

    #[test]
    fn shown_by_hand_with_nothing_asking_it_stays() {
        let mut island = Tracker::default();
        island.toggle();
        assert_eq!(island.toggle(), Change::Show);
        assert_eq!(island.request_up(), Change::Nothing);
        assert_eq!(island.request_done(), Change::Nothing);
        assert!(!island.hidden());
    }

    #[test]
    fn open_shows_a_hidden_island_and_leaves_one_on_show_alone() {
        let mut island = Tracker::default();
        assert_eq!(island.open(), Change::Nothing);
        island.toggle();
        assert_eq!(island.open(), Change::Show);
        assert_eq!(island.request_up(), Change::Nothing);
        assert_eq!(island.request_done(), Change::Nothing);
        assert!(!island.hidden());
    }

    #[test]
    fn a_request_that_comes_while_one_is_up_and_the_island_was_hidden_by_hand_shows_it_again() {
        let mut island = Tracker::default();
        island.toggle();
        island.request_up();
        island.toggle();
        assert_eq!(island.request_up(), Change::Show);
        assert_eq!(island.request_done(), Change::Nothing);
        assert_eq!(done(&mut island), Change::Hide);
    }

    #[test]
    fn the_last_request_ending_schedules_a_hide_and_does_not_hide_yet() {
        let mut island = Tracker::default();
        island.toggle();
        island.request_up();
        let Change::HideLater(g) = island.request_done() else { panic!("no delayed hide") };
        assert!(!island.hidden());
        assert_eq!(island.hide_if_current(g), Change::Hide);
        assert!(island.hidden());
        // Once is enough.
        assert_eq!(island.hide_if_current(g), Change::Nothing);
    }

    #[test]
    fn a_request_within_the_delay_cancels_the_hide() {
        let mut island = Tracker::default();
        island.toggle();
        island.request_up();
        let Change::HideLater(g) = island.request_done() else { panic!("no delayed hide") };
        // The next prompt: the island is up already, nothing to show.
        assert_eq!(island.request_up(), Change::Nothing);
        assert_eq!(island.hide_if_current(g), Change::Nothing);
        assert!(!island.hidden());
        // Its own end schedules a new hide, which does work.
        let Change::HideLater(g2) = island.request_done() else { panic!("no delayed hide") };
        assert_ne!(g, g2);
        assert_eq!(island.hide_if_current(g2), Change::Hide);
    }

    #[test]
    fn a_hand_action_within_the_delay_cancels_the_hide_and_wins() {
        for act in [Tracker::toggle, Tracker::open] {
            let mut island = Tracker::default();
            island.toggle();
            island.request_up();
            let Change::HideLater(g) = island.request_done() else { panic!("no delayed hide") };
            act(&mut island);
            assert_eq!(island.hide_if_current(g), Change::Nothing);
        }
        // Open Nook leaves it on show for good.
        let mut island = Tracker::default();
        island.toggle();
        island.request_up();
        let Change::HideLater(g) = island.request_done() else { panic!("no delayed hide") };
        island.open();
        assert_eq!(island.hide_if_current(g), Change::Nothing);
        assert!(!island.hidden());
    }

    #[test]
    fn a_stale_generation_never_hides() {
        let mut island = Tracker::default();
        island.toggle();
        island.request_up();
        let Change::HideLater(old) = island.request_done() else { panic!("no delayed hide") };
        island.request_up();
        let Change::HideLater(new) = island.request_done() else { panic!("no delayed hide") };
        assert_eq!(island.hide_if_current(old), Change::Nothing);
        assert_eq!(island.hide_if_current(new), Change::Hide);
    }

    #[test]
    fn a_stray_end_does_not_cancel_a_waiting_hide() {
        let mut island = Tracker::default();
        island.toggle();
        island.request_up();
        let Change::HideLater(g) = island.request_done() else { panic!("no delayed hide") };
        // An end with nothing left to end moves nothing on a hand-less island.
        let after = island.request_done();
        let g = if let Change::HideLater(g2) = after { g2 } else { g };
        assert_eq!(island.hide_if_current(g), Change::Hide);
    }

    #[test]
    fn rev_moves_only_when_the_island_flips() {
        let mut island = Tracker::default();
        let r0 = island.rev;
        island.request_up();
        island.open();
        assert_eq!(island.rev, r0);
        island.toggle();
        assert_eq!(island.rev, r0 + 1);
    }
    #[test]
    fn the_tray_says_what_a_press_does() {
        assert_eq!(label(false), "Hide island");
        assert_eq!(label(true), "Show island");
    }
}
