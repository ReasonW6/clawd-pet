//! API keys, kept in the Windows Credential Manager: one generic credential per key,
//! under `clawd-pet/<provider id>`, and `clawd-pet/exa` for Exa's. config.json holds a
//! key only while the vault couldn't take it (`migrate`); such a key goes before the
//! vault's. The front end never sees a key: `hide` takes them out of the config it gets,
//! `keep` puts back the ones config.json holds when it sends the config back, and
//! `status` tells the settings page which keys there are, by their last characters.

use crate::config::{AiConfig, Config};
use serde_json::{json, Map, Value};
use std::sync::Mutex;

/// What `which` is for Exa's key; anything else is a provider id.
pub const EXA: &str = "exa";

const PREFIX: &str = "clawd-pet/";

/// Why the vault last turned a key down at startup, for the settings page.
static TROUBLE: Mutex<Option<String>> = Mutex::new(None);

fn target(which: &str) -> String {
    format!("{PREFIX}{which}")
}

/// The key config.json holds for `which`, if there is a place for one.
fn plain_mut<'a>(ai: &'a mut AiConfig, which: &str) -> Option<&'a mut String> {
    if which == EXA {
        Some(&mut ai.exa_key)
    } else {
        ai.profiles.get_mut(which).map(|p| &mut p.api_key)
    }
}

/// The key for `which`: the one config.json still holds (`plain`), or the vault's;
/// empty for none.
pub fn key(plain: &str, which: &str) -> String {
    match plain.trim() {
        "" => cred::read(&target(which)).ok().flatten().unwrap_or_default().trim().to_owned(),
        plain => plain.to_owned(),
    }
}

/// Writes `key` for `which` and reads it back: only a key the vault gives back as
/// written counts as kept.
fn store(which: &str, key: &str) -> Result<(), String> {
    let target = target(which);
    cred::write(&target, key)?;
    match cred::read(&target)? {
        Some(back) if back == key => Ok(()),
        _ => Err("写进去的和读出来的对不上".into()),
    }
}

/// Moves the keys config.json still holds into the vault, taking each out of `ai` only
/// once the vault has it. Gives back whether `ai` changed (and wants saving).
pub fn migrate(ai: &mut AiConfig) -> bool {
    let mut changed = false;
    let mut trouble = None;
    let plains = ai.profiles.iter_mut().map(|(id, p)| (id.as_str(), &mut p.api_key));
    for (which, plain) in plains.chain([(EXA, &mut ai.exa_key)]) {
        if plain.trim().is_empty() {
            continue;
        }
        match store(which, plain.trim()) {
            Ok(()) => {
                plain.clear();
                changed = true;
            }
            Err(e) => trouble = Some(e),
        }
    }
    *TROUBLE.lock().unwrap() = trouble;
    changed
}

/// Puts `key` in the vault for `which`, or with an empty one, takes it out; either way
/// config.json no longer holds one for it. Gives back whether `ai` changed.
pub fn set(ai: &mut AiConfig, which: &str, key: &str) -> Result<bool, String> {
    let key = key.trim();
    if key.is_empty() {
        cred::delete(&target(which)).map_err(|e| format!("没能从 Windows 凭据管理器里删掉：{e}"))?;
    } else {
        store(which, key).map_err(|e| format!("没能存进 Windows 凭据管理器：{e}"))?;
    }
    Ok(plain_mut(ai, which).is_some_and(|p| !std::mem::take(p).is_empty()))
}

/// Moves the key of provider `from` to provider `to` (the settings page turning a
/// template's settings into a provider of the user's own). Gives back whether `ai` changed.
pub fn rename(ai: &mut AiConfig, from: &str, to: &str) -> Result<bool, String> {
    if let Some(key) = cred::read(&target(from))? {
        store(to, &key)?;
        cred::delete(&target(from))?;
    }
    let key = plain_mut(ai, from).map(std::mem::take).unwrap_or_default();
    if key.is_empty() {
        return Ok(false);
    }
    ai.profiles.entry(to.to_owned()).or_default().api_key = key;
    Ok(true)
}

/// Gives `ai`, as the settings page sent it (without keys), the keys config.json holds
/// in `from` for the providers it still has.
pub fn keep(ai: &mut AiConfig, from: &AiConfig) {
    for (id, p) in ai.profiles.iter_mut() {
        p.api_key = from.profiles.get(id).map(|o| o.api_key.clone()).unwrap_or_default();
    }
    ai.exa_key = from.exa_key.clone();
}

/// The config without any key in it, for the front end.
pub fn hide(mut cfg: Config) -> Config {
    for p in cfg.ai.profiles.values_mut() {
        p.api_key.clear();
    }
    cfg.ai.exa_key.clear();
    cfg
}

/// The last four characters of a key long enough not to give much away by them.
fn tail(key: &str) -> String {
    let chars: Vec<char> = key.trim().chars().collect();
    if chars.len() < 12 {
        return String::new();
    }
    chars[chars.len() - 4..].iter().collect()
}

/// The keys there are, for the settings page: `{ keys: { <which>: { tail, plain } },
/// trouble }`, where `plain` marks a key config.json still holds because the vault
/// turned it down, and `trouble` says why.
pub fn status(ai: &AiConfig) -> Value {
    let mut keys = Map::new();
    let mut trouble = TROUBLE.lock().unwrap().clone();
    match cred::list(PREFIX) {
        Ok(list) => {
            for (which, key) in list {
                keys.insert(which, json!({ "tail": tail(&key), "plain": false }));
            }
        }
        Err(e) => trouble = Some(e),
    }
    let plains = ai.profiles.iter().map(|(id, p)| (id.as_str(), &p.api_key));
    for (which, key) in plains.chain([(EXA, &ai.exa_key)]) {
        if !key.trim().is_empty() {
            keys.insert(which.to_owned(), json!({ "tail": tail(key), "plain": true }));
        }
    }
    json!({ "keys": keys, "trouble": trouble })
}

/// The Win32 credential calls. A key goes in as UTF-16, as cmdkey writes one.
#[cfg(windows)]
mod cred {
    use windows_sys::Win32::Foundation::ERROR_NOT_FOUND;
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredEnumerateW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_MAX_CREDENTIAL_BLOB_SIZE,
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    /// The last error, worded for the settings page: "拒绝访问，错误码 5".
    fn last_error() -> String {
        let e = std::io::Error::last_os_error();
        let text = e.to_string();
        let text = text.split(" (os error").next().unwrap_or_default().trim().trim_end_matches(['。', '.']);
        format!("{text}，错误码 {}", e.raw_os_error().unwrap_or_default())
    }

    /// The last error, unless it is that there is no such credential.
    fn failed() -> Option<String> {
        (std::io::Error::last_os_error().raw_os_error() != Some(ERROR_NOT_FOUND as i32)).then(last_error)
    }

    unsafe fn secret(c: &CREDENTIALW) -> String {
        if c.CredentialBlob.is_null() || c.CredentialBlobSize == 0 {
            return String::new();
        }
        let blob = std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize);
        let units: Vec<u16> = blob.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
        String::from_utf16_lossy(&units)
    }

    unsafe fn text(p: *const u16) -> String {
        if p.is_null() {
            return String::new();
        }
        let len = (0..).take_while(|&i| *p.add(i) != 0).count();
        String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
    }

    pub fn read(target: &str) -> Result<Option<String>, String> {
        let name = wide(target);
        let mut c: *mut CREDENTIALW = std::ptr::null_mut();
        unsafe {
            if CredReadW(name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut c) == 0 {
                return failed().map_or(Ok(None), Err);
            }
            let s = secret(&*c);
            CredFree(c.cast());
            Ok(Some(s))
        }
    }

    pub fn write(target: &str, secret: &str) -> Result<(), String> {
        let mut blob: Vec<u8> = secret.encode_utf16().flat_map(u16::to_le_bytes).collect();
        if blob.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize {
            return Err("密钥太长了".into());
        }
        let (mut name, mut user) = (wide(target), wide("clawd-pet"));
        let c = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: name.as_mut_ptr(),
            UserName: user.as_mut_ptr(),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        if unsafe { CredWriteW(&c, 0) } == 0 {
            return Err(last_error());
        }
        Ok(())
    }

    /// Deleting one there isn't counts as done.
    pub fn delete(target: &str) -> Result<(), String> {
        let name = wide(target);
        if unsafe { CredDeleteW(name.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0 {
            return failed().map_or(Ok(()), Err);
        }
        Ok(())
    }

    /// Every generic credential under `prefix`: (the rest of its target, its secret).
    pub fn list(prefix: &str) -> Result<Vec<(String, String)>, String> {
        let filter = wide(&format!("{prefix}*"));
        let (mut n, mut all): (u32, *mut *mut CREDENTIALW) = (0, std::ptr::null_mut());
        unsafe {
            if CredEnumerateW(filter.as_ptr(), 0, &mut n, &mut all) == 0 {
                return failed().map_or(Ok(Vec::new()), Err);
            }
            let list = std::slice::from_raw_parts(all, n as usize)
                .iter()
                .map(|&c| &*c)
                .filter(|c| c.Type == CRED_TYPE_GENERIC)
                .filter_map(|c| Some((text(c.TargetName).strip_prefix(prefix)?.to_owned(), secret(c))))
                .collect();
            CredFree(all.cast());
            Ok(list)
        }
    }
}

#[cfg(not(windows))]
mod cred {
    const NONE: &str = "只有 Windows 上有凭据管理器";

    pub fn read(_: &str) -> Result<Option<String>, String> {
        Err(NONE.into())
    }

    pub fn write(_: &str, _: &str) -> Result<(), String> {
        Err(NONE.into())
    }

    pub fn delete(_: &str) -> Result<(), String> {
        Err(NONE.into())
    }

    pub fn list(_: &str) -> Result<Vec<(String, String)>, String> {
        Err(NONE.into())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::config::AiProfile;

    /// A provider id of the test's own, so that tests running side by side don't meet.
    fn which(name: &str) -> String {
        format!("test-{}-{name}", std::process::id())
    }

    fn cleanup(names: &[&str]) {
        for n in names {
            let _ = cred::delete(&target(n));
        }
    }

    #[test]
    fn round_trip() {
        let w = which("round");
        assert_eq!(cred::read(&target(&w)), Ok(None));
        cred::write(&target(&w), "sk-ünï-密钥-0123").unwrap();
        assert_eq!(cred::read(&target(&w)).unwrap().as_deref(), Some("sk-ünï-密钥-0123"));
        assert!(cred::list(PREFIX).unwrap().iter().any(|(t, k)| *t == w && k == "sk-ünï-密钥-0123"));
        cred::delete(&target(&w)).unwrap();
        assert_eq!(cred::read(&target(&w)), Ok(None));
        // Deleting one there isn't is no failure.
        cred::delete(&target(&w)).unwrap();
        assert!(cred::write(&target(&w), &"k".repeat(2000)).is_err());
    }

    #[test]
    fn migrates_and_strips() {
        let w = which("migrate");
        let mut ai = AiConfig::default();
        ai.profiles.insert(w.clone(), AiProfile { api_key: " sk-abcdefghijklmnop ".into(), model: "m".into(), ..Default::default() });
        ai.profiles.insert(which("empty"), AiProfile::default());
        assert!(migrate(&mut ai));
        assert_eq!(ai.profiles[&w].api_key, "");
        assert_eq!(ai.profiles[&w].model, "m");
        assert_eq!(key("", &w), "sk-abcdefghijklmnop");
        // A key config.json holds goes first.
        assert_eq!(key("sk-plain", &w), "sk-plain");
        assert!(!migrate(&mut ai));
        let s = status(&ai);
        assert_eq!(s["keys"][&w], json!({ "tail": "mnop", "plain": false }));
        cleanup(&[&w]);
    }

    #[test]
    fn sets_renames_and_removes() {
        let (a, b) = (which("from"), which("to"));
        let mut ai = AiConfig::default();
        ai.profiles.insert(a.clone(), AiProfile { api_key: "sk-old".into(), ..Default::default() });
        // Setting a key takes the plain one out.
        assert!(set(&mut ai, &a, "sk-new-key-1234").unwrap());
        assert_eq!(ai.profiles[&a].api_key, "");
        assert!(!rename(&mut ai, &a, &b).unwrap());
        assert_eq!(key("", &a), "");
        assert_eq!(key("", &b), "sk-new-key-1234");
        // A plain key moves along too.
        ai.profiles.get_mut(&a).unwrap().api_key = "sk-plain".into();
        assert!(rename(&mut ai, &a, &b).unwrap());
        assert_eq!(ai.profiles[&b].api_key, "sk-plain");
        assert!(set(&mut ai, &b, "").unwrap());
        assert_eq!(key("", &b), "");
        assert_eq!(ai.profiles[&b].api_key, "");
        cleanup(&[&a, &b]);
    }

    #[test]
    fn hides_and_keeps() {
        let mut cfg = Config::default();
        cfg.ai.profiles.insert("deepseek".into(), AiProfile { api_key: "sk-secret".into(), ..Default::default() });
        cfg.ai.exa_key = "exa-secret".into();
        let shown = hide(cfg.clone());
        let text = serde_json::to_string(&shown).unwrap();
        assert!(!text.contains("secret") && !text.contains("apiKey") && !text.contains("exaKey"));
        let mut back = shown.ai.clone();
        keep(&mut back, &cfg.ai);
        assert_eq!(back.profiles["deepseek"].api_key, "sk-secret");
        assert_eq!(back.exa_key, "exa-secret");
        assert_eq!(tail("short"), "");
    }
}
