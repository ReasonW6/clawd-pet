//! The animations the user has seen the pet play, for the settings page's gallery: played
//! on the pet while it was shown, not previewed from the gallery. Kept in
//! `~/.clawd-pet/collection.json`, written by the background loop's flush, not per play.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// The pet celebrates every this many animations collected, and having them all.
const STEP: usize = 50;
/// Everything is new on the first day, so its haul is not cheered milestone by milestone:
/// the first new one after it cheers the highest milestone reached, once.
const FIRST_DAY_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Seen {
    /// First played on the pet (ms since the epoch).
    first: u64,
    /// Times it started playing on the pet since.
    count: u64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Record {
    /// When the collection started (ms).
    since: u64,
    /// When the gallery was last opened (ms); what came in after is new there.
    visited: u64,
    /// The highest milestone celebrated.
    cheered: usize,
    seen: BTreeMap<String, Seen>,
}

impl Record {
    /// Counts a play of `slug`, one of `known` (the animations there are; empty while
    /// the pet hasn't said). Gives the milestone to celebrate, if this one reached one.
    fn see(&mut self, slug: &str, known: &HashSet<String>, now: u64) -> (bool, Option<usize>) {
        let fresh = !self.seen.contains_key(slug);
        let e = self.seen.entry(slug.to_string()).or_insert(Seen { first: now, count: 0 });
        e.count = e.count.saturating_add(1);
        if !fresh || known.is_empty() {
            return (fresh, None);
        }
        // Animations since renamed or removed don't count.
        let have = self.seen.keys().filter(|s| known.contains(*s)).count();
        let reached = if have >= known.len() { have } else { have / STEP * STEP };
        if reached == 0 || reached <= self.cheered || now.saturating_sub(self.since) < FIRST_DAY_MS {
            return (true, None);
        }
        self.cheered = reached;
        (true, Some(reached))
    }
}

struct Store {
    path: PathBuf,
    record: Record,
    known: HashSet<String>,
    /// `record` changed since it was last written.
    dirty: bool,
}

static STORE: Mutex<Option<Store>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn with<R>(f: impl FnOnce(&mut Store) -> R) -> Option<R> {
    STORE.lock().unwrap().as_mut().map(f)
}

/// Reads the collection, at startup.
pub fn load(path: PathBuf) {
    let mut record: Record = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let dirty = record.since == 0;
    if dirty {
        record.since = now_ms();
    }
    *STORE.lock().unwrap() = Some(Store { path, record, known: HashSet::new(), dirty });
}

/// Writes the collection if it changed. Called every couple of seconds and on quitting.
pub fn flush() {
    with(|s| {
        if !s.dirty {
            return;
        }
        let Ok(text) = serde_json::to_string_pretty(&s.record) else { return };
        // Kept dirty if it doesn't go through: the next flush tries again.
        s.dirty = crate::memory::write(&s.path, &text).is_err();
    });
}

/// From the pet, as it starts: the animations there are.
#[tauri::command]
pub fn collection_known(slugs: Vec<String>) {
    with(|s| s.known = slugs.into_iter().collect());
}

/// From the pet: `slug` started playing while it was shown. Gives the milestone to
/// celebrate, if any.
#[tauri::command]
pub fn collection_seen(slug: String, app: AppHandle) -> Option<usize> {
    let (fresh, cheer) = with(|s| {
        if !s.known.contains(&slug) {
            return (false, None);
        }
        s.dirty = true;
        s.record.see(&slug, &s.known, now_ms())
    })?;
    if fresh {
        let _ = app.emit_to("settings", "collected", &slug);
    }
    cheer
}

/// From the settings page: the whole collection.
#[tauri::command]
pub fn collection_get() -> Option<Record> {
    with(|s| s.record.clone())
}

/// From the settings page: the gallery is open now.
#[tauri::command]
pub fn collection_visit() {
    with(|s| {
        s.record.visited = now_ms();
        s.dirty = true;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u64 = FIRST_DAY_MS;

    fn known(n: usize) -> HashSet<String> {
        (0..n).map(|i| format!("a{i}")).collect()
    }

    fn record(since: u64) -> Record {
        Record { since, ..Default::default() }
    }

    #[test]
    fn counts_plays_and_keeps_the_first_time() {
        let k = known(3);
        let mut r = record(0);
        assert_eq!(r.see("a1", &k, 5), (true, None));
        assert_eq!(r.see("a1", &k, 9), (false, None));
        assert_eq!(r.seen["a1"], Seen { first: 5, count: 2 });
    }

    #[test]
    fn cheers_every_step_after_the_first_day() {
        let k = known(200);
        let mut r = record(0);
        let mut cheers = vec![];
        for i in 0..120 {
            if let (_, Some(m)) = r.see(&format!("a{i}"), &k, DAY + i as u64) {
                cheers.push(m);
            }
        }
        assert_eq!(cheers, vec![50, 100]);
    }

    #[test]
    fn the_first_day_is_cheered_once_afterwards() {
        let k = known(200);
        let mut r = record(1000);
        for i in 0..130 {
            assert_eq!(r.see(&format!("a{i}"), &k, 1000 + i as u64).1, None);
        }
        // Seen again: not a new one, nothing to cheer.
        assert_eq!(r.see("a0", &k, 1000 + DAY).1, None);
        assert_eq!(r.see("a130", &k, 1000 + DAY).1, Some(100));
        assert_eq!(r.see("a131", &k, 1000 + DAY).1, None);
        assert_eq!(r.see("a150", &k, 1000 + DAY).1, None);
    }

    #[test]
    fn cheers_having_them_all() {
        let k = known(52);
        let mut r = record(0);
        let cheers: Vec<_> = (0..52).filter_map(|i| r.see(&format!("a{i}"), &k, DAY).1).collect();
        assert_eq!(cheers, vec![50, 52]);
    }

    #[test]
    fn gone_animations_dont_count() {
        let k = known(50);
        let mut r = record(0);
        r.see("old", &k, DAY);
        let cheers: Vec<_> = (0..49).filter_map(|i| r.see(&format!("a{i}"), &k, DAY).1).collect();
        assert!(cheers.is_empty());
        assert_eq!(r.see("a49", &k, DAY).1, Some(50));
    }
}
