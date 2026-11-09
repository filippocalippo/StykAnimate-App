//! The existing event-loop harness proves these wires without synthetic redraw/poll ticks.
use super::*;
use styk_core::inspector::property::PropertyKey;

#[test]
fn queued_open_and_a_mounted_properties_edit_publish_without_an_unrelated_event() {
    let mut rt = Runtime::new(); rt.settled();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/startup.document.json");
    rt.app.band.open_all(&[fixture]);
    assert!(rt.next(), "queuing an open must wake the production subscription");
    rt.until(|app| app.band.core.stage().is_some() && !app.band.core.inspector().pending());
    rt.drain();
    let before = rt.app.band.core.documents.published().unwrap();
    rt.inspector_field(PropertyKey::RootX, false, "520");
    assert!(rt.messages.iter().any(|message| matches!(message, Message::Band(top_band::Message::Editor(styk_ui::Message::PollDocuments)))), "the mounted field must schedule publication through the effect adapter");
    rt.until(|app| app.band.core.documents.published().is_some_and(|p| p.1 > before.1) && !app.band.core.inspector().pending());
    assert_eq!(rt.app.band.core.inspector().model().unwrap().number(PropertyKey::RootX).unwrap().value, 520.);
    assert_eq!(rt.app.band.core.documents.active().unwrap().view().unwrap().history.undo, 1);
    rt.drain(); // no unbounded poll loop after publication finishes
}

#[test]
fn a_mounted_tab_click_keeps_the_release_from_the_presses_event_batch() {
    use iced::advanced::subscription::{Event as RuntimeEvent, into_recipes};
    let mut rt = Runtime::new(); rt.settled();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/startup.document.json");
    rt.app.band.open_all(std::slice::from_ref(&fixture));
    rt.until(|app| app.band.core.stage().is_some() && !app.band.core.file_pending() && !app.band.core.inspector().pending()); rt.drain();
    let first = rt.app.band.core.documents.tabs()[0].id();
    let stage = rt.app.band.core.stage().unwrap();
    rt.app.band.open_all(&[fixture]);
    rt.until(|app| app.band.core.documents.tabs().len() == 2 && !app.band.core.file_pending() && !app.band.core.inspector().pending()); rt.drain();
    assert_ne!(rt.app.band.core.documents.active().unwrap().id(), first);
    // Keep exactly the subscriptions that existed BEFORE the press, as an OS event batch does.
    let release = RuntimeEvent::Interaction { window: iced_window::Id::unique(), event: iced::Event::Mouse(iced::mouse::Event::ButtonReleased(iced::mouse::Button::Left)), status: iced::event::Status::Ignored };
    let mut streams: Vec<_> = into_recipes(rt.app.band.subscription()).into_iter().map(|recipe| recipe.stream(Box::pin(iced::futures::stream::iter([release.clone()])))).collect();
    let sent = {
        let ready = warm_up::install_bundled(Default::default());
        let element = rt.app.band.view(Theme::Light, ready, MaxButtonState::Idle, iced::widget::Space::new().boxed());
        let mut driver = Driver::new(element, WINDOW, &styk_design::fonts::ALL);
        let bounds = driver.snapshot().bounds_of(styk_core::shell::ids::tab(first)).expect("mounted first tab");
        driver.point_at(bounds.center()); driver.click(bounds.center()); driver.messages()
    };
    for message in sent { rt.message(Message::Band(message)); }
    for stream in &mut streams {
        if let Poll::Ready(Some(message)) = stream.as_mut().poll_next(&mut Context::from_waker(std::task::Waker::noop())) { rt.message(Message::Band(message)); }
    }
    rt.drain();
    assert_eq!(rt.app.band.core.documents.active().unwrap().id(), first, "the mounted press and always-subscribed release must activate the tab");
    rt.until(|app| !app.band.core.file_pending() && !app.band.core.inspector().pending());
    assert!(Arc::ptr_eq(&stage, &rt.app.band.core.stage().unwrap()));
    assert_eq!(rt.app.band.core.inspector().model().unwrap().number(PropertyKey::RootX).unwrap().value, 480.);
}
