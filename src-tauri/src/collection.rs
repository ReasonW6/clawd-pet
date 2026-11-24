//! The animations the user has seen the pet play, for the settings page's gallery: played
//! on the pet while it was shown, not previewed from the gallery. Kept in
//! `~/.clawd-pet/collection.json`, written by the background loop's flush, not per play:
//! right away when something is collected, play counts alone at most once a minute.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// The pet celebrates every this many animations collected, and having them all.
const STEP: usize = 50;
/// Everything is new on the first day, so its haul is not cheered milestone by milestone:
/// the first new one after it cheers the highest milestone reached, once.
const FIRST_DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// Play counts that changed alone wait this long to be written.
const COUNTS_EVERY: Duration = Duration::from_secs(60);

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
    /// A milestone reached and not yet celebrated: the pet waits for a quiet moment with
    /// the user around, which may not come before it quits.
    pending: usize,
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
        if reached == 0 || reached <= self.cheered.max(self.pending) || now.saturating_sub(self.since) < FIRST_DAY_MS {
            return (true, None);
        }
        self.pending = reached;
        (true, Some(reached))
    }

    /// The pet celebrated `milestone`.
    fn cheer(&mut self, milestone: usize) {
        self.cheered = self.cheered.max(milestone);
        if self.pending <= self.cheered {
            self.pending = 0;
        }
    }
}

struct Store {
    path: PathBuf,
    record: Record,
    known: HashSet<String>,
    /// `record` changed since it was last written, other than play counts.
    dirty: bool,
    /// Play counts changed since it was last written.
    counted: bool,
    last_write: Instant,
    /// False when the file there couldn't be read: it is left alone until the next start.
    writable: bool,
}

static STORE: Mutex<Option<Store>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn with<R>(f: impl FnOnce(&mut Store) -> R) -> Option<R> {
    STORE.lock().unwrap().as_mut().map(f)
}

/// Reads the collection, at startup. Starts afresh only when there is none: one that can't
/// be read now (held open by a virus scan or a sync) is not written over this time, and one
/// that doesn't parse is kept beside it as `collection.json.bad`.
pub fn load(path: PathBuf) {
    let (mut record, writable) = match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Record>(&text) {
            Ok(record) => (record, true),
            Err(e) => {
                eprintln!("collection.json doesn't parse, set aside: {e}");
                (Record::default(), std::fs::rename(&path, path.with_extension("json.bad")).is_ok())
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Record::default(), true),
        Err(e) => {
            eprintln!("collection.json can't be read, left alone until the next start: {e}");
            (Record::default(), false)
        }
    };
    let dirty = record.since == 0;
    if dirty {
        record.since = now_ms();
    }
    *STORE.lock().unwrap() =
        Some(Store { path, record, known: HashSet::new(), dirty, counted: false, last_write: Instant::now(), writable });
}

/// Writes the collection if it changed. Called every couple of seconds, play counts alone
/// only once in a while; with `all`, on quitting, whatever changed.
pub fn flush(all: bool) {
    with(|s| {
        let due = s.dirty || (s.counted && (all || s.last_write.elapsed() >= COUNTS_EVERY));
        if !due || !s.writable {
            return;
        }
        let Ok(text) = serde_json::to_string_pretty(&s.record) else { return };
        // Kept dirty if it doesn't go through: the next flush tries again.
        if crate::memory::write(&s.path, &text).is_ok() {
            s.dirty = false;
            s.counted = false;
            s.last_write = Instant::now();
        }
    });
}

/// From the pet, as it starts: the animations there are. Gives the milestone still to
/// celebrate from before, if any.
#[tauri::command]
pub fn collection_known(slugs: Vec<String>) -> Option<usize> {
    with(|s| {
        s.known = slugs.into_iter().collect();
        Some(s.record.pending).filter(|&m| m > s.record.cheered)
    })
    .flatten()
}

#[derive(Serialize, Clone)]
struct Collected<'a> {
    slug: &'a str,
    #[serde(flatten)]
    seen: Seen,
}

/// From the pet: `slug` started playing while it was shown. Gives the milestone to
/// celebrate, if any; the pet says when it has with `collection_cheered`.
#[tauri::command]
pub fn collection_seen(slug: String, app: AppHandle) -> Option<usize> {
    let (cheer, seen) = with(|s| {
        if !s.known.contains(&slug) {
            return None;
        }
        let (fresh, cheer) = s.record.see(&slug, &s.known, now_ms());
        if fresh || cheer.is_some() {
            s.dirty = true;
        } else {
            s.counted = true;
        }
        Some((cheer, s.record.seen[&slug].clone()))
    })??;
    // The gallery, if open, keeps its counts up to date; a fresh one shows up there.
    let _ = app.emit_to("settings", "collected", Collected { slug: &slug, seen });
    cheer
}

/// From the pet: it celebrated `milestone` with the user there to see it.
#[tauri::command]
pub fn collection_cheered(milestone: usize) {
    with(|s| {
        s.record.cheer(milestone);
        s.dirty = true;
    });
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
    fn a_milestone_waits_until_it_is_cheered() {
        let k = known(200);
        let mut r = record(0);
        let cheers: Vec<_> = (0..60).filter_map(|i| r.see(&format!("a{i}"), &k, DAY).1).collect();
        assert_eq!(cheers, vec![50]);
        // Not cheered yet: still owed, and not handed out twice.
        assert_eq!((r.pending, r.cheered), (50, 0));
        r.cheer(50);
        assert_eq!((r.pending, r.cheered), (0, 50));
        let cheers: Vec<_> = (60..100).filter_map(|i| r.see(&format!("a{i}"), &k, DAY).1).collect();
        assert_eq!(cheers, vec![100]);
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
