//! The presentation's numbers and plural forms against today's runtime: `Intl.NumberFormat(locale)` and
//! `Intl.PluralRules(locale).select` in an Electron 39 renderer for every catalogue locale (captured by
//! `engine/crates/styk-app/automation/inspector-reference/intl.cjs` into `support/intl_electron.json`).
use styk_core::i18n::{Msg, Presentation, locales};
use styk_doc::json;

const INTL: &str = include_str!("support/intl_electron.json");

#[test]
fn numbers_and_plural_forms_match_electron_in_every_locale() {
    let intl = json::parse(INTL.as_bytes()).unwrap();
    let numbers: Vec<f64> = intl.get("numbers").unwrap().numbers().unwrap();
    let mut differences = Vec::new();
    for (id, _) in locales() {
        let presentation = Presentation::new(id).unwrap();
        let expected = intl.path(&["locales", id]).unwrap_or_else(|| panic!("{id} was captured"));
        // Electron's ICU has no number data for Kazakh: `Intl.NumberFormat('kk')` writes the system locale's numbers
        // (the capture's machine is Italian). The presentation writes Kazakh's own (CLDR 44); its plural forms compare.
        let own_numbers = expected.get("numberLocale").and_then(|locale| locale.as_str()).is_some_and(|locale| locale.split('-').next() == id.split('-').next());
        assert!(own_numbers || id == "kk", "{id}: Electron writes its numbers as another locale's");
        for (index, number) in numbers.iter().enumerate() {
            let text = expected.get("numbers").unwrap().item(index).unwrap();
            let plural = expected.get("plurals").unwrap().item(index).unwrap();
            let (text, plural) = (text.as_str().unwrap(), plural.as_str().unwrap());
            if own_numbers && presentation.number(*number) != text {
                differences.push(format!("{id} {number}: number {:?}, Electron {text:?}", presentation.number(*number)));
            }
            if presentation.plural(*number) != plural {
                differences.push(format!("{id} {number}: plural {:?}, Electron {plural:?}", presentation.plural(*number)));
            }
        }
    }
    assert!(differences.is_empty(), "{} differences:\n{}", differences.len(), differences.join("\n"));
}

#[test]
fn a_message_uses_its_locale_s_text_numbers_and_direction() {
    let german = Presentation::new("de").unwrap();
    assert_eq!(german.text(&Msg::new("common.cancel")), "Abbrechen");
    assert_eq!(german.number(1234.5), "1.234,5");
    let arabic = Presentation::new("ar").unwrap();
    assert_eq!(arabic.direction(), styk_core::i18n::Direction::Rtl);
    // A message the locale lacks falls back to English, with English's plural rules.
    let english = Presentation::english().text(&Msg::count("counts.figures", 2.0));
    assert_eq!(english, "2 figures");
}
