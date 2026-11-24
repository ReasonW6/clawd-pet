//! A private recap of the work the user and Claude did together, for the settings page's
//! recap and the card the pet holds up once a week. All of it is one file,
//! `~/.clawd-pet/recap.json`, kept whatever the AI chat and memory switches say, and
//! never sent anywhere.
//!
//! Only counts, durations, times of day and project folder names go in: no session
//! titles (the desktop app makes them from what the user said), prompts or file
//! contents. No score, no streaks. A day missing from the file, or an hour missing from
//! a day's `seen`, means the pet wasn't running then: no data, which the page shows
//! apart from a zero. Days start at 05:00, as memory counts them; the front end works
//! the day out (`memDay()`) and sends it along with the time of day.

use crate::memory::day_number;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Days kept, counting back from the latest: about half a year.
const KEEP_DAYS: i64 = 190;
/// Project folders kept for one day; more than that only count in the totals.
const MAX_PROJECTS: usize = 30;
const MAX_NAME: usize = 60;

/// One day, from 05:00 to 05:00. Hours are of the clock, 0 to 23.
#[derive(Clone, Default, PartialEq, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Day {
    /// Seconds some session was at work (not waiting for the user), by hour.
    pub busy: [u32; 24],
    /// Tasks finished (turns, a session and those it started counting once), by hour.
    pub done: [u32; 24],
    /// The hours the pet was running in, as bits: an hour without is no data, not zero.
    pub seen: u32,
    /// When the day's last task finished, "HH:MM"; after midnight is later than the evening.
    pub last: String,
    /// Sessions that started work.
    pub sessions: u32,
    /// Permission requests answered, in the bubble or, where the pet could tell, in Claude Code.
    pub approvals: u32,
    /// Tool calls that failed, and turns an API error ended.
    pub errors: u32,
    /// Tasks finished and the minutes they took, by project folder.
    pub projects: BTreeMap<String, [u32; 2]>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct State {
    days: BTreeMap<String, Day>,
    /// The Monday of the last week the pet held up its card for.
    card_week: String,
}

struct Store {
    path: PathBuf,
    state: State,
    dirty: bool,
}

static STORE: Mutex<Option<Store>> = Mutex::new(None);
/// The day of the week to show, for a settings page that is about to open on it.
static OPEN: Mutex<Option<String>> = Mutex::new(None);

pub fn load(path: PathBuf) {
    let state = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    *STORE.lock().unwrap() = Some(Store { path, state, dirty: false });
}

/// Writes the file if it changed, whole or not at all. Called every couple of seconds
/// and on quitting.
pub fn flush() {
    let mut store = STORE.lock().unwrap();
    let Some(s) = store.as_mut().filter(|s| s.dirty) else { return };
    let Ok(text) = serde_json::to_string(&s.state) else { return };
    let tmp = s.path.with_extension("tmp");
    // Kept dirty if it doesn't go through: the next flush tries again.
    s.dirty = std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, &s.path)).is_err();
}

/// Minutes after 05:00 for "HH:MM": the order times come in within one day.
fn day_minute(hm: &str) -> Option<u32> {
    let (h, m) = hm.split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then(|| (h * 60 + m + 24 * 60 - 5 * 60) % (24 * 60))
}

/// Counts something that happened on `day` at `at` ("HH:MM"). Kinds: "time" ({ busy },
/// seconds at work since the last one, which also marks the hour as seen), "task"
/// ({ project, minutes }), "session", "approval", "error".
pub fn event(kind: &str, detail: &Value, day: &str, at: &str) {
    let (Some(n), Some(_)) = (day_number(day), day_minute(at)) else { return };
    let hour = at[..at.find(':').unwrap_or(0)].parse::<usize>().unwrap_or(0);
    let mut store = STORE.lock().unwrap();
    let Some(s) = store.as_mut() else { return };
    if !s.state.days.contains_key(day) {
        // A new day: the oldest go.
        s.state.days.retain(|d, _| day_number(d).is_some_and(|d| d > n - KEEP_DAYS));
    }
    let d = s.state.days.entry(day.to_owned()).or_default();
    match kind {
        "time" => {
            let secs = detail["busy"].as_u64().unwrap_or(0).min(300) as u32;
            d.busy[hour] = (d.busy[hour] + secs).min(3600);
            d.seen |= 1 << hour;
        }
        "task" => {
            d.done[hour] += 1;
            d.seen |= 1 << hour;
            if day_minute(&d.last) < day_minute(at) {
                d.last = at.to_owned();
            }
            let name: String = detail["project"].as_str().unwrap_or_default().chars().take(MAX_NAME).collect();
            let minutes = detail["minutes"].as_u64().unwrap_or(0).min(24 * 60) as u32;
            if !name.is_empty() && (d.projects.len() < MAX_PROJECTS || d.projects.contains_key(&name)) {
                let p = d.projects.entry(name).or_default();
                p[0] += 1;
                p[1] += minutes;
            }
        }
        "session" => d.sessions += 1,
        "approval" => d.approvals += 1,
        "error" => d.errors += 1,
        _ => return,
    }
    s.dirty = true;
}

/// Everything there is, for the settings page, with the week to open on if the weekly
/// card was just clicked.
pub fn snapshot() -> Value {
    let open = OPEN.lock().unwrap().take();
    let store = STORE.lock().unwrap();
    let Some(s) = store.as_ref() else { return json!({ "days": {}, "cardWeek": "", "open": open }) };
    json!({ "days": s.state.days, "cardWeek": s.state.card_week, "open": open })
}

/// The pet held up its card for the week starting on Monday `week`.
pub fn card_shown(week: &str) {
    if day_number(week).is_none() {
        return;
    }
    if let Some(s) = STORE.lock().unwrap().as_mut() {
        s.state.card_week = week.to_owned();
        s.dirty = true;
    }
}

/// Opens the settings on the recap of the week starting on Monday `week`.
pub fn open(app: &AppHandle, week: String) {
    if app.get_webview_window("settings").is_some() {
        let _ = app.emit_to("settings", "recap-open", week);
    } else {
        // The page asks for it as it starts.
        *OPEN.lock().unwrap() = Some(week);
    }
    crate::show_settings(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() {
        *STORE.lock().unwrap() = Some(Store { path: PathBuf::new(), state: State::default(), dirty: false });
    }

    fn day(d: &str) -> Day {
        STORE.lock().unwrap().as_ref().unwrap().state.days.get(d).cloned().unwrap_or_default()
    }

    #[test]
    fn times_of_day_go_from_five_to_five() {
        assert_eq!(day_minute("05:00"), Some(0));
        assert_eq!(day_minute("04:59"), Some(24 * 60 - 1));
        assert!(day_minute("23:59") < day_minute("00:10"));
        assert_eq!(day_minute("24:00"), None);
        assert_eq!(day_minute(""), None);
    }

    // One test for everything that goes through the one store, so that tests running
    // side by side don't see each other's days.
    #[test]
    fn events_add_up() {
        fresh();
        event("task", &json!({ "project": "pet", "minutes": 3 }), "2026-11-20", "23:40");
        event("task", &json!({ "project": "pet", "minutes": 7 }), "2026-11-20", "02:13");
        event("task", &json!({ "project": "web", "minutes": 1 }), "2026-11-20", "18:00");
        event("time", &json!({ "busy": 60 }), "2026-11-20", "14:05");
        event("time", &json!({ "busy": 9999 }), "2026-11-20", "14:06");
        event("approval", &Value::Null, "2026-11-20", "14:06");
        event("nonsense", &Value::Null, "2026-11-20", "14:06");
        event("error", &Value::Null, "not a day", "14:06");
        let d = day("2026-11-20");
        assert_eq!(d.last, "02:13");
        assert_eq!(d.done[23] + d.done[2] + d.done[18], 3);
        assert_eq!(d.projects["pet"], [2, 10]);
        assert_eq!(d.busy[14], 360);
        assert_eq!(d.seen, 1 << 14 | 1 << 23 | 1 << 2 | 1 << 18);
        assert_eq!((d.approvals, d.errors), (1, 0));

        // An hour holds an hour at most.
        for _ in 0..20 {
            event("time", &json!({ "busy": 300 }), "2026-11-20", "15:00");
        }
        assert_eq!(day("2026-11-20").busy[15], 3600);

        // Only so many projects a day.
        for i in 0..40 {
            event("task", &json!({ "project": format!("p{i}"), "minutes": 1 }), "2026-11-21", "10:00");
        }
        assert_eq!(day("2026-11-21").projects.len(), MAX_PROJECTS);
        assert_eq!(day("2026-11-21").done[10], 40);

        // Half a year on, the old days are gone.
        event("session", &Value::Null, "2027-07-01", "09:00");
        assert_eq!(day("2026-11-20"), Day::default());
        assert_eq!(day("2027-07-01").sessions, 1);
    }
}
