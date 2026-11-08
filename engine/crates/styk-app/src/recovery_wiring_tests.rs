//! The window's recovery wiring (`docs/native/recovery.md`, "The views"): the band's wiring the window mounts, started over a real
//! local store that holds one copy an earlier run left. The documents host's workers wake the window, the window polls, the core
//! offers the copy as the stage's message, the overlay layer draws it, a press on `Restore` reaches `Core::dispatch` and from there
//! the documents host, and closing goes through the host's quit.

use crate::top_band::{Message, Request, TopBand};
use iced::Size;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use styk_core::overlay::host::message_button_id;
use styk_core::overlay::messages::Do;
use styk_core::recovery::model::Event;
use styk_design::Theme;
use styk_design::widgets::testing::Driver;
use styk_services::Cancel;
use styk_services::recovery::Recovery;

const STARTUP: &[u8] = include_bytes!("../../../tests/edit/startup.document.json");
const WINDOW: Size = Size::new(900.0, 600.0);

/// A private store root, emptied of the files this test wrote when it ends.
struct Root(std::path::PathBuf);
impl Root {
    fn new(label: &str) -> Root {
        static SERIAL: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!("styk-app-recovery-{label}-{}-{}", std::process::id(), SERIAL.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&path).unwrap();
        Root(path)
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        if let Ok(entries) = std::fs::read_dir(&self.0) {
            for entry in entries.filter_map(Result::ok) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        let _ = std::fs::remove_dir(&self.0);
    }
}

fn seed(root: &Root, name: &str) {
    let store = styk_platform::recovery::LocalRecovery::new(root.0.clone());
    let cancel = Cancel::new();
    pollster::block_on(async {
        let lease = store.create(&cancel).await.unwrap();
        lease.write(None, STARTUP, name, &cancel).await.unwrap();
    });
}

fn band(root: &Root, woken: &Arc<AtomicUsize>) -> TopBand {
    let woken = woken.clone();
    match TopBand::new(WINDOW, Arc::new(styk_platform::clock::SystemClock::new()), None, Arc::new(styk_platform::spawn::ThreadSpawner), Arc::new(move || {
        woken.fetch_add(1, Ordering::SeqCst);
    }), Some(root.0.clone())) {
        Ok(band) => band,
        Err(error) => panic!("{error}"),
    }
}

/// What the window does on each wake of the documents host: polls it. Returns what the window was asked for.
fn pump_until(band: &mut TopBand, done: impl Fn(&TopBand) -> bool) -> Vec<Request> {
    let mut asked = Vec::new();
    for _ in 0..15_000 {
        let (requests, _task) = band.update(Message::Documents);
        asked.extend(requests);
        if done(band) {
            return asked;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    panic!("the documents host did not answer in 15 s");
}

#[test]
fn the_window_offers_the_copy_a_store_holds_and_restore_reaches_the_core_and_the_documents_host() {
    let root = Root::new("offer");
    seed(&root, "Rooftop fight");
    let woken = Arc::new(AtomicUsize::new(0));
    let mut band = band(&root, &woken);
    assert!(woken.load(Ordering::SeqCst) > 0, "the first listing is asked for with the window's wake");

    // The window's loop takes what the lane listed; the core offers it as the stage's message.
    pump_until(&mut band, |band| band.core.overlays().messages().current().is_some());
    let message = band.core.overlays().messages().current().expect("the offer").clone();
    assert_eq!(message.title, "Restore unsaved work");
    assert!(message.text.starts_with("in Rooftop fight from "), "{}", message.text);
    let restore = message.actions.iter().position(|action| action.command == Do::Recovery(Event::Restore)).expect("Restore is an action");
    assert!(woken.load(Ordering::SeqCst) > 1, "the lane's finished listing woke the window again");

    // The overlay layer the window mounts draws the message: its Restore button is in the tree, and a press on it is a message.
    let button = message_button_id(message.id, restore);
    let sent = {
        let mut driver = Driver::new(band.overlay_layer(Theme::Light), WINDOW, &styk_design::fonts::ALL);
        let bounds = driver.snapshot().bounds_of(button).expect("the offer's Restore reached the layer");
        let at = iced::Point::new(bounds.x + bounds.width / 2.0, bounds.y + bounds.height / 2.0);
        driver.point_at(at);
        driver.events(&[iced::Event::Mouse(iced::mouse::Event::CursorMoved { position: at })]);
        driver.events(&[iced::Event::Mouse(iced::mouse::Event::ButtonPressed(iced::mouse::Button::Left))]);
        driver.events(&[iced::Event::Mouse(iced::mouse::Event::ButtonReleased(iced::mouse::Button::Left))]);
        driver.messages()
    };
    assert!(!sent.is_empty(), "the press produced messages");
    let tabs = band.core.documents.tabs().len();
    for message in sent {
        let _ = band.update(message);
    }
    // `Core::dispatch` ran the action: the documents host has the restore in flight.
    assert!(band.core.documents.recovery_view().is_some_and(|view| view.busy), "Restore reached the documents host");
    pump_until(&mut band, |band| band.core.documents.tabs().len() > tabs);
    assert!(band.core.documents.active().is_some_and(|document| document.dirty()), "the copy opened as an edited project");
}

#[test]
fn closing_goes_through_the_documents_host_and_ends_when_the_lane_is_done() {
    let root = Root::new("quit");
    let woken = Arc::new(AtomicUsize::new(0));
    let mut band = band(&root, &woken);
    pump_until(&mut band, |band| band.core.documents.recovery_view().is_some());
    let (ready, _task) = band.ask_to_quit();
    assert!(!ready, "with recovery attached the program ends once the lane has finished its copies");
    let mut asked = Vec::new();
    for _ in 0..15_000 {
        let (requests, _task) = band.update(Message::Documents);
        asked.extend(requests);
        if asked.iter().any(|request| matches!(request, Request::QuitReady)) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    panic!("the window was never told it may end: {asked:?}");
}
