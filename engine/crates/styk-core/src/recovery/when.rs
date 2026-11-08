//! The time of a recovery copy as today's app writes it for English (`Intl.DateTimeFormat('en-US')`): the offer's
//! `02:03 PM` (`hour: '2-digit', minute: '2-digit'`) and the chooser's `11/8/26, 2:03 PM` (`dateStyle` and `timeStyle`
//! `short`). The copy's `savedAt` is an ISO-8601 UTC timestamp; `offset` is the person's UTC offset in minutes, which the
//! platform supplies (`Core::set_utc_offset`). Other languages read the English layout until the catalogue has date
//! formats (`docs/native/recovery.md`).

/// A calendar time to the minute.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Minute {
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
}

/// Days from 1970-01-01 to the civil date (proleptic Gregorian, H. Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let shifted = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * shifted + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The civil date of a day count (`civil_from_days`).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted + 2) / 5 + 1;
    let month = if shifted < 10 { shifted + 3 } else { shifted - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn number(text: &str) -> Option<i64> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// `YYYY-MM-DDTHH:MM…` read as UTC and moved by `offset` minutes.
fn parse(iso: &str, offset: i32) -> Option<Minute> {
    let (date, time) = iso.split_once('T')?;
    let mut date = date.splitn(3, '-');
    let (year, month, day) = (number(date.next()?)?, number(date.next()?)?, number(date.next()?)?);
    let (hour, minute) = (number(time.get(0..2)?)?, number(time.get(3..5)?)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || time.as_bytes().get(2) != Some(&b':') {
        return None;
    }
    let total = days_from_civil(year, month, day) * 1_440 + hour * 60 + minute + i64::from(offset);
    let (year, month, day) = civil_from_days(total.div_euclid(1_440));
    let of_day = total.rem_euclid(1_440);
    Some(Minute { year, month, day, hour: of_day / 60, minute: of_day % 60 })
}

fn meridiem(hour: i64) -> &'static str {
    if hour < 12 { "AM" } else { "PM" }
}

fn hour12(hour: i64) -> i64 {
    match hour % 12 {
        0 => 12,
        other => other,
    }
}

/// The offer's time: `02:03 PM`.
pub fn clock(iso: &str, offset: i32) -> Option<String> {
    let at = parse(iso, offset)?;
    Some(format!("{:02}:{:02} {}", hour12(at.hour), at.minute, meridiem(at.hour)))
}

/// The chooser's date and time: `11/8/26, 2:03 PM`.
pub fn short(iso: &str, offset: i32) -> Option<String> {
    let at = parse(iso, offset)?;
    Some(format!("{}/{}/{:02}, {}:{:02} {}", at.month, at.day, at.year.rem_euclid(100), hour12(at.hour), at.minute, meridiem(at.hour)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_two_layouts_read_as_intl_writes_them() {
        assert_eq!(clock("2026-11-08T14:03:09.000Z", 0).as_deref(), Some("02:03 PM"));
        assert_eq!(short("2026-11-08T14:03:09.000Z", 0).as_deref(), Some("11/8/26, 2:03 PM"));
        assert_eq!(short("2026-01-02T00:07:00.000Z", 0).as_deref(), Some("1/2/26, 12:07 AM"));
        assert_eq!(short("2026-01-02T12:00:00.000Z", 0).as_deref(), Some("1/2/26, 12:00 PM"));
    }

    #[test]
    fn the_offset_moves_the_day_and_the_year() {
        assert_eq!(short("2026-12-31T23:30:00Z", 90).as_deref(), Some("1/1/27, 1:00 AM"));
        assert_eq!(short("2026-03-01T00:10:00Z", -20).as_deref(), Some("2/28/26, 11:50 PM"));
        assert_eq!(short("2028-03-01T00:10:00Z", -20).as_deref(), Some("2/29/28, 11:50 PM"));
    }

    #[test]
    fn a_stamp_that_is_not_a_time_reads_as_nothing() {
        for bad in ["", "yesterday", "2026-13-01T10:00:00Z", "2026-11-08T25:00:00Z", "2026-11-08T10-00", "2026-xx-08T10:00:00Z"] {
            assert_eq!(clock(bad, 0), None, "{bad}");
        }
    }
}
