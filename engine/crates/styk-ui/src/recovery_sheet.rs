//! The recovery screens: the start-up offer, the chooser (with its copies, busy, and with an error) and the close prompt with
//! its recovery failure (`stykanimate --screen recovery-offer`, `recovery-chooser`, `recovery-busy`, `recovery-error`,
//! `close-prompt`, each in both themes).
//!
//! Each scene is a small page with the overlay in the state a person would see it, drawn from the models the core builds
//! (`styk_core::recovery::model`) over fixed copies. Nothing here is behaviour: every control sends [`Message::Noop`].

use crate::component_sheet::Message;
use iced::widget::{container, stack};
use iced::{Element, Length, Padding, Size, Widget as _};
use std::rc::Rc;
use styk_core::i18n::{Label, Presentation};
use styk_core::recovery::model;
use styk_core::services::recovery::{Record, Slot};
use styk_design::widgets::layer::Layer;
use styk_design::widgets::toast;
use styk_design::{Palette, Theme};

/// The recovery screens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoveryScreen {
    /// The stage's message that offers to restore the one copy there is.
    Offer,
    /// The chooser over three copies, the newest selected.
    Chooser,
    /// The chooser while a restore or a discard runs: its submit buttons are busy.
    Busy,
    /// The chooser after a restore the host refused.
    Error,
    /// The close prompt after the recovery copy could not be written: Retry shows beside the others.
    ClosePrompt,
}

impl RecoveryScreen {
    pub const ALL: [RecoveryScreen; 5] = [RecoveryScreen::Offer, RecoveryScreen::Chooser, RecoveryScreen::Busy, RecoveryScreen::Error, RecoveryScreen::ClosePrompt];

    /// The ID of the light screen (the dark one adds `-dark`).
    pub const fn id(self) -> &'static str {
        match self {
            RecoveryScreen::Offer => "recovery-offer",
            RecoveryScreen::Chooser => "recovery-chooser",
            RecoveryScreen::Busy => "recovery-busy",
            RecoveryScreen::Error => "recovery-error",
            RecoveryScreen::ClosePrompt => "close-prompt",
        }
    }

    /// The window the scene is drawn in, in logical pixels.
    pub const fn size(self) -> (u32, u32) {
        match self {
            RecoveryScreen::Offer => (640, 140),
            RecoveryScreen::Chooser | RecoveryScreen::Busy | RecoveryScreen::Error => (520, 360),
            RecoveryScreen::ClosePrompt => (520, 300),
        }
    }
}

fn copy(n: u8, name: &str, saved_at: &str, size: usize) -> Record {
    let slot = Slot::named(&format!("00000000-0000-4000-8000-{n:012x}")).unwrap_or_else(Slot::legacy);
    let mut version = [0; 32];
    version[0] = n;
    Record { slot, name: name.into(), saved_at: saved_at.into(), size, version, selection: Some(version) }
}

/// The copies the screens list: three projects, one of them unnamed, newest first.
pub fn copies() -> Vec<Record> {
    vec![copy(1, "Rooftop fight", "2026-11-08T14:03:00.000Z", 48_213), copy(2, "Chase", "2026-11-08T13:41:00.000Z", 20_480), copy(3, "", "2026-11-07T22:15:00.000Z", 9_104)]
}

/// The chooser model of a screen.
pub fn chooser_model(screen: RecoveryScreen) -> model::Chooser {
    let copies = copies();
    let error = (screen == RecoveryScreen::Error).then_some("Owned");
    model::chooser(&copies, copies.first().map(|copy| &copy.slot), screen == RecoveryScreen::Busy, error, 0)
}

/// The close prompt's model: Chase has unsaved changes and the disk is full.
pub fn closing_model() -> model::Closing {
    model::closing(&["Chase".to_string()], Some("The disk is full."))
}

/// The offer's model: the one copy there is.
pub fn offer_model() -> model::Offer {
    let copies = copies();
    model::offer(&copies[..1], &Label::plain("Untitled"), 0).unwrap_or_else(|| model::Offer { title: model::words::OFFER_TITLE, text: Label::plain(""), manage: false })
}

/// The state of a recovery screen.
pub struct Page {
    screen: RecoveryScreen,
    theme: Theme,
    presentation: Presentation,
}

impl Page {
    pub fn new(screen: RecoveryScreen, theme: Theme) -> Page {
        Page { screen, theme, presentation: Presentation::english() }
    }

    pub fn view(&self) -> Element<'_, Message> {
        let palette = self.theme.palette();
        let (width, height) = self.screen.size();
        let window = Size::new(width as f32, height as f32);
        let wires = || super::recovery::Wires::<Message> { send: Rc::new(|_| Message::Noop), open: Rc::new(|_| Message::Noop) };
        match self.screen {
            RecoveryScreen::Offer => {
                let message = model::message(&offer_model(), 1, &self.presentation);
                let pill = toast::toast(palette, &message, 1.0, 1.0, |_| Message::Noop);
                // Today's message sits where the page's slot puts it: 16 px in and 8 px down.
                page(palette, container(pill).padding(Padding { top: 8.0, left: 16.0, ..Padding::ZERO }).boxed())
            }
            RecoveryScreen::Chooser | RecoveryScreen::Busy | RecoveryScreen::Error => {
                let placed = super::recovery::chooser(palette, &self.presentation, &chooser_model(self.screen), 1, window, 1.0, &wires());
                page(palette, stack![container(iced::widget::Space::new()).width(Length::Fill).height(Length::Fill).boxed(), Layer::new(vec![placed]).boxed()].boxed())
            }
            RecoveryScreen::ClosePrompt => {
                let placed = super::recovery::closing(palette, &self.presentation, &closing_model(), 1, window, 1.0, &wires());
                page(palette, stack![container(iced::widget::Space::new()).width(Length::Fill).height(Length::Fill).boxed(), Layer::new(vec![placed]).boxed()].boxed())
            }
        }
    }
}

/// The window the scenes sit in: the raised surface, filling it.
fn page<'a>(palette: &'static Palette, content: Element<'a, Message>) -> Element<'a, Message> {
    let fill = palette.surface;
    container(content).width(Length::Fill).height(Length::Fill).padding(Padding::ZERO).style(move |_| container::Style { background: Some(iced::Background::Color(fill.into())), ..container::Style::default() }).boxed()
}

#[cfg(test)]
mod tests {
    use super::*;
    use iced::Size as WindowSize;
    use styk_design::widgets::testing::Driver;

    #[test]
    fn every_scene_draws_in_both_themes() {
        for screen in RecoveryScreen::ALL {
            for theme in [Theme::Light, Theme::Dark] {
                let page = Page::new(screen, theme);
                let (width, height) = screen.size();
                let mut driver = Driver::new(page.view(), WindowSize::new(width as f32, height as f32), &styk_design::fonts::ALL);
                let (pixels, size) = driver.render(&iced::Theme::Light, iced::Color::from(theme.palette().surface), 1.0);
                assert_eq!(pixels.len(), (size.width * size.height * 4) as usize);
                let distinct = pixels.chunks(4).map(|p| [p[0], p[1], p[2]]).take(400_000).collect::<std::collections::HashSet<_>>().len();
                assert!(distinct > 6, "{} {theme:?} drew something: {distinct} colours", screen.id());
            }
        }
    }

    #[test]
    fn the_catalogue_names_each_scene_in_both_themes() {
        for scene in RecoveryScreen::ALL {
            assert_eq!(crate::screens::Screen::Recovery(scene, false).id(), scene.id());
            assert_eq!(crate::screens::Screen::Recovery(scene, true).id(), format!("{}-dark", scene.id()));
            assert_eq!(crate::screens::Screen::from_id(scene.id()), Some(crate::screens::Screen::Recovery(scene, false)));
            assert_eq!(crate::screens::Screen::Recovery(scene, true).theme(), Theme::Dark);
        }
    }

    /// Every word a scene shows is in the catalogue: a missing key would be drawn as the key.
    #[test]
    fn every_key_a_scene_shows_is_in_the_catalogue() {
        let english = Presentation::english();
        for label in [model::words::OFFER_TITLE, model::words::NOT_NOW, model::words::MANAGE, model::words::RESTORE, model::words::CHOOSER_TITLE, model::words::FIELD, model::words::NOTE, model::words::CANCEL, model::words::DISCARD_COPY, model::words::CHOOSER_RESTORE, model::words::DONT_SAVE, model::words::SAVE, model::words::RETRY, model::words::UNTITLED] {
            let Label::Msg(msg) = &label else { continue };
            assert!(styk_core::i18n::has(&msg.key), "{} is in the catalogue", msg.key);
        }
        let chooser = chooser_model(RecoveryScreen::Error);
        assert_eq!(english.label(chooser.error.as_ref().unwrap()), "This recovery copy is open in another tab.");
        assert_eq!(chooser.rows.iter().map(|row| row.text(&english.label(&row.name))).collect::<Vec<_>>(), ["Rooftop fight \u{b7} 11/8/26, 2:03 PM", "Chase \u{b7} 11/8/26, 1:41 PM", "Untitled \u{b7} 11/7/26, 10:15 PM"]);
        assert_eq!(english.label(&offer_model().text), "in Rooftop fight from 02:03 PM?");
        let closing = closing_model();
        assert_eq!(english.label(&closing.title), "Save changes to Chase?");
        assert_eq!(english.label(closing.warning.as_ref().unwrap()), "Recovery copy could not be written: The disk is full.");
    }
}
