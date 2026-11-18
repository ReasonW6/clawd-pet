//! Chatting with an AI model in bubbles above the pet. The front end keeps the
//! conversation, as plain text, only while the chat is open, and sends all of it with
//! each message; nothing is written anywhere. Replies stream back as `ai` events
//! `{ id, kind, text }`: kind is "text" (more of the reply), "look" (taking a
//! screenshot), "blind" (the model can't take images), "done" or "error".
//!
//! Two wire formats cover the providers: OpenAI's chat completions, which most of them
//! speak, and Anthropic's messages. When the user allows it, the model gets a tool that
//! takes a screenshot of the pet's monitor (screen.rs) and decides itself when to use it.
//! A screenshot only lives for the turn it was taken in.

use crate::config::{AiConfig, AiProfile};
use crate::screen;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Wire {
    OpenAi,
    Anthropic,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: &'static str,
    pub name: &'static str,
    pub group: &'static str,
    pub wire: Wire,
    /// Empty for the custom ones, where the user gives it.
    pub base_url: &'static str,
    /// Used until the user picks one. Empty: pick from the provider's own list.
    pub model: &'static str,
    /// A few to choose from before the provider's full list is fetched.
    pub models: &'static [&'static str],
    /// Where to get an API key.
    pub key_url: &'static str,
    pub needs_key: bool,
    /// JSON merged into every chat request: turns off slow "thinking" where the
    /// provider lets every one of its models do without.
    #[serde(skip)]
    pub extra: &'static str,
}

const BASE: Provider = Provider {
    id: "",
    name: "",
    group: "",
    wire: Wire::OpenAi,
    base_url: "",
    model: "",
    models: &[],
    key_url: "",
    needs_key: true,
    extra: "",
};

pub const PROVIDERS: &[Provider] = &[
    Provider {
        id: "anthropic",
        name: "Anthropic Claude",
        group: "国际",
        wire: Wire::Anthropic,
        base_url: "https://api.anthropic.com",
        model: "claude-opus-5-5",
        models: &["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
        key_url: "https://platform.claude.com/settings/keys",
        ..BASE
    },
    Provider {
        id: "openai",
        name: "OpenAI",
        group: "国际",
        base_url: "https://api.openai.com/v1",
        model: "gpt-6.1-terra",
        models: &["gpt-6.1-terra", "gpt-6-luna", "gpt-6.1-sol"],
        key_url: "https://platform.openai.com/api-keys",
        ..BASE
    },
    Provider {
        id: "gemini",
        name: "Google Gemini",
        group: "国际",
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        model: "gemini-4-hydrogen",
        models: &["gemini-4-hydrogen", "gemini-3.8-flash", "gemini-3.5-flash-lite"],
        key_url: "https://aistudio.google.com/apikey",
        ..BASE
    },
    Provider {
        id: "xai",
        name: "xAI Grok",
        group: "国际",
        base_url: "https://api.x.ai/v1",
        key_url: "https://console.x.ai",
        ..BASE
    },
    Provider {
        id: "mistral",
        name: "Mistral",
        group: "国际",
        base_url: "https://api.mistral.ai/v1",
        model: "mistral-small-latest",
        models: &["mistral-small-latest", "mistral-medium-latest"],
        key_url: "https://console.mistral.ai/api-keys",
        ..BASE
    },
    Provider {
        id: "groq",
        name: "Groq",
        group: "国际",
        base_url: "https://api.groq.com/openai/v1",
        key_url: "https://console.groq.com/keys",
        ..BASE
    },
    Provider {
        id: "openrouter",
        name: "OpenRouter",
        group: "国际",
        base_url: "https://openrouter.ai/api/v1",
        model: "openrouter/auto",
        models: &["openrouter/auto"],
        key_url: "https://openrouter.ai/keys",
        ..BASE
    },
    Provider {
        id: "deepseek",
        name: "DeepSeek 深度求索",
        group: "国内",
        base_url: "https://api.deepseek.com",
        model: "deepseek-flash",
        models: &["deepseek-flash", "deepseek-v4-pro"],
        key_url: "https://platform.deepseek.com/api_keys",
        extra: r#"{"thinking":{"type":"disabled"}}"#,
        ..BASE
    },
    Provider {
        id: "moonshot",
        name: "月之暗面 Kimi",
        group: "国内",
        base_url: "https://api.moonshot.cn/v1",
        model: "kimi-k3.1-pro",
        models: &["kimi-k3.1-pro", "kimi-k3"],
        key_url: "https://platform.moonshot.cn/console/api-keys",
        ..BASE
    },
    Provider {
        id: "zhipu",
        name: "智谱 GLM",
        group: "国内",
        base_url: "https://open.bigmodel.cn/api/paas/v4",
        model: "glm-5.3-flash",
        models: &["glm-5.3-flash", "glm-5.3-flashx", "glm-4.6v-flash"],
        key_url: "https://open.bigmodel.cn/usercenter/apikeys",
        ..BASE
    },
    Provider {
        id: "qwen",
        name: "阿里云百炼 · 通义千问",
        group: "国内",
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3.8-flash",
        models: &["qwen3.8-flash", "qwen3.7-plus", "qwen4-max"],
        key_url: "https://bailian.console.aliyun.com/?tab=model#/api-key",
        extra: r#"{"enable_thinking":false}"#,
        ..BASE
    },
    Provider {
        id: "doubao",
        name: "火山方舟 · 豆包",
        group: "国内",
        base_url: "https://ark.cn-beijing.volces.com/api/v3",
        key_url: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
        ..BASE
    },
    Provider {
        id: "siliconflow",
        name: "硅基流动",
        group: "国内",
        base_url: "https://api.siliconflow.cn/v1",
        key_url: "https://cloud.siliconflow.cn/account/ak",
        ..BASE
    },
    Provider {
        id: "minimax",
        name: "MiniMax",
        group: "国内",
        base_url: "https://api.minimaxi.com/v1",
        key_url: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
        ..BASE
    },
    Provider {
        id: "hunyuan",
        name: "腾讯混元",
        group: "国内",
        base_url: "https://api.hunyuan.cloud.tencent.com/v1",
        key_url: "https://console.cloud.tencent.com/hunyuan/api-key",
        ..BASE
    },
    Provider {
        id: "qianfan",
        name: "百度千帆",
        group: "国内",
        base_url: "https://qianfan.baidubce.com/v2",
        key_url: "https://console.bce.baidu.com/iam/#/iam/apikey/list",
        ..BASE
    },
    Provider {
        id: "stepfun",
        name: "阶跃星辰",
        group: "国内",
        base_url: "https://api.stepfun.com/v1",
        key_url: "https://platform.stepfun.com/interface-key",
        ..BASE
    },
    Provider { id: "ollama", name: "Ollama", group: "本地", base_url: "http://localhost:11434/v1", needs_key: false, ..BASE },
    Provider { id: "lmstudio", name: "LM Studio", group: "本地", base_url: "http://localhost:1234/v1", needs_key: false, ..BASE },
    Provider { id: "custom", name: "自定义（OpenAI 兼容）", group: "自定义", needs_key: false, ..BASE },
    Provider {
        id: "custom-anthropic",
        name: "自定义（Anthropic 兼容）",
        group: "自定义",
        wire: Wire::Anthropic,
        needs_key: false,
        ..BASE
    },
];

const ANTHROPIC_VERSION: &str = "2026-10-21";
/// Models that take server-side fallbacks on the Anthropic API: on a policy decline
/// the request reruns on another model instead of just stopping.
const FALLBACK_MODELS: &[&str] = &["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"];
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
/// Claude models that take an effort level; chat goes quicker on a low one.
const EFFORT_MODELS: &[&str] = &["claude-opus-5", "claude-sonnet-5", "claude-haiku-5", "claude-fable-5", "claude-mythos-5"];

const TOOL: &str = "look_at_screen";
const TOOL_DESC: &str = "截一张用户当前屏幕的图来看（图里没有你自己）。只在要看用户屏幕上的东西才能回答时用。";
/// Rounds of tool calls in one turn, and screenshots among them.
const MAX_ROUNDS: usize = 4;
const MAX_SHOTS: usize = 2;

/// One message of the conversation so far.
#[derive(Deserialize)]
pub struct Turn {
    role: String,
    text: String,
}

/// Where the pet is, for taking a screenshot of its monitor without it.
pub struct Eye {
    pub hwnd: isize,
    pub x: i32,
    pub y: i32,
}

/// The chat whose events still go out; anything else has been closed.
static CURRENT: AtomicU64 = AtomicU64::new(0);

/// Models that turned the screenshot tool down, as "address model": asked without it
/// from then on, until the pet restarts.
static NO_TOOLS: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// Models that turned a screenshot down, same keys: asked without the screenshot
/// tool from then on, until the pet restarts.
static NO_IMAGES: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// The task answering the current chat, aborted when another starts or the chat
/// closes, so that a reply nobody will see stops streaming (and billing).
static TASK: Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = Mutex::new(None);

fn knows(set: &Mutex<BTreeSet<String>>, key: &str) -> bool {
    set.lock().is_ok_and(|m| m.contains(key))
}

fn remember(set: &Mutex<BTreeSet<String>>, key: String) {
    if let Ok(mut m) = set.lock() {
        m.insert(key);
    }
}

/// Local servers (Ollama, LM Studio) skip the system proxy: hyper-util doesn't honor
/// its `<local>` bypass, so a proxy would get loopback requests it can't reach.
fn loopback(url: &str) -> bool {
    let Ok(u) = reqwest::Url::parse(url) else { return false };
    let host = u.host_str().unwrap_or("").trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => ip.is_loopback(),
        Err(_) => host == "localhost" || host.ends_with(".localhost"),
    }
}

fn client(url: &str) -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    static LOCAL: OnceLock<reqwest::Client> = OnceLock::new();
    let local = loopback(url);
    (if local { &LOCAL } else { &CLIENT }).get_or_init(|| {
        let mut b = reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).read_timeout(Duration::from_secs(120));
        if local {
            b = b.no_proxy();
        }
        b.build().expect("http client")
    })
}

// ---------------------------------------------------------------- where to send it

struct Target {
    wire: Wire,
    base: String,
    key: String,
    model: String,
    /// Anthropic's own API, which takes the extras that only it knows.
    official: bool,
    extra: Option<Value>,
}

fn target(ai: &AiConfig, provider: &str, need_model: bool) -> Result<Target, String> {
    let p = PROVIDERS.iter().find(|p| p.id == provider).ok_or("不认识这个服务商")?;
    let empty = AiProfile::default();
    let profile = ai.profiles.get(provider).unwrap_or(&empty);
    let own = profile.base_url.trim().trim_end_matches('/');
    let base = if own.is_empty() { p.base_url } else { own };
    if base.is_empty() {
        return Err("先在设置里填上 API 地址吧～".into());
    }
    let key = profile.api_key.trim();
    if p.needs_key && key.is_empty() {
        return Err("先在设置里填上 API 密钥吧～".into());
    }
    let model = Some(profile.model.trim()).filter(|m| !m.is_empty()).unwrap_or(p.model);
    if need_model && model.is_empty() {
        return Err("先在设置里选个模型吧～".into());
    }
    // Whatever the user pasted: the base, or the base with the endpoint on it.
    let base = match p.wire {
        Wire::OpenAi => base.trim_end_matches("/chat/completions").trim_end_matches("/models"),
        Wire::Anthropic => base.trim_end_matches("/messages").trim_end_matches("/models").trim_end_matches("/v1"),
    };
    Ok(Target {
        wire: p.wire,
        base: base.to_string(),
        key: key.to_string(),
        model: model.to_string(),
        official: p.id == "anthropic" && base == p.base_url,
        extra: serde_json::from_str(p.extra).ok(),
    })
}

impl Target {
    fn url(&self, path: &str) -> String {
        match self.wire {
            Wire::OpenAi => format!("{}/{path}", self.base),
            Wire::Anthropic => format!("{}/v1/{path}", self.base),
        }
    }

    fn authed(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let mut rb = rb;
        match self.wire {
            Wire::OpenAi if !self.key.is_empty() => rb = rb.bearer_auth(&self.key),
            Wire::OpenAi => {}
            Wire::Anthropic => {
                rb = rb.header("anthropic-version", ANTHROPIC_VERSION);
                if !self.key.is_empty() {
                    rb = rb.header("x-api-key", &self.key);
                    // Compatible services differ on which one they read.
                    if !self.official {
                        rb = rb.bearer_auth(&self.key);
                    }
                }
            }
        }
        rb
    }

    /// Which model at which address, for remembering what it can't do.
    fn key(&self) -> String {
        format!("{} {}", self.base, self.model)
    }

    fn fallbacks(&self) -> bool {
        self.official && FALLBACK_MODELS.contains(&self.model.as_str())
    }
}

// ---------------------------------------------------------------- failures

enum Fail {
    /// The chat was closed meanwhile.
    Stopped,
    /// The model doesn't do tools, so the screenshot tool has to go.
    NoTools,
    Status(u16, String),
    Other(String),
}

fn net(e: reqwest::Error) -> Fail {
    Fail::Other(if e.is_timeout() {
        "等了半天没回音，网络可能不太好".into()
    } else if e.is_connect() {
        "连不上服务器，看看网络或代理？".into()
    } else {
        format!("网络出错了：{e}")
    })
}

fn describe(f: Fail) -> String {
    match f {
        Fail::Stopped => String::new(),
        Fail::NoTools => "这个模型用不了工具".into(),
        Fail::Other(m) => m,
        Fail::Status(code, msg) => {
            let hint = match code {
                401 | 403 => "API 密钥不对，或者没有权限",
                402 => "余额不足",
                404 => "找不到这个模型或地址",
                429 => "请求太频繁，或者额度用完了",
                500..=599 => "服务商那边出错了",
                _ => "请求被拒绝了",
            };
            if msg.is_empty() {
                format!("{hint}（{code}）")
            } else {
                format!("{hint}（{code}）：{msg}")
            }
        }
    }
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() > n {
        s.chars().take(n).collect::<String>() + "…"
    } else {
        s.to_string()
    }
}

/// The message in an error response, whichever shape the provider gives it.
fn error_message(body: &str) -> String {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let msg = [&v["error"]["message"], &v["error"], &v["message"], &v["msg"]]
        .iter()
        .find_map(|x| x.as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| body.trim().to_owned());
    clip(&msg, 160)
}

/// A request turned down for what it asks, rather than for the key, the balance or the rate.
fn turned_down(code: u16) -> bool {
    (400..500).contains(&code) && !matches!(code, 401 | 402 | 403 | 429)
}

/// A model that doesn't do tools (many local ones) turns down any request offering
/// them, and says so.
fn refuses_tools(f: &Fail) -> bool {
    match f {
        Fail::Status(code, msg) if turned_down(*code) => {
            let m = msg.to_lowercase();
            m.contains("tool") || m.contains("function")
        }
        _ => false,
    }
}

// ---------------------------------------------------------------- streaming

fn stopped(id: u64) -> bool {
    CURRENT.load(Ordering::SeqCst) != id
}

fn emit(app: &AppHandle, id: u64, kind: &str, text: &str) {
    if !stopped(id) {
        let _ = app.emit_to("main", "ai", json!({ "id": id, "kind": kind, "text": text }));
    }
}

async fn post(t: &Target, path: &str, body: &Value, beta: Option<&str>) -> Result<reqwest::Response, Fail> {
    let url = t.url(path);
    let mut rb = t.authed(client(&url).post(&url)).header("content-type", "application/json");
    if let Some(beta) = beta {
        rb = rb.header("anthropic-beta", beta);
    }
    let resp = rb.body(body.to_string()).send().await.map_err(net)?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(Fail::Status(status.as_u16(), error_message(&text)));
    }
    Ok(resp)
}

/// Hands each server-sent event's data to `on_data` until it returns true or the
/// stream ends.
async fn each_event(id: u64, mut resp: reqwest::Response, mut on_data: impl FnMut(&str) -> Result<bool, Fail>) -> Result<(), Fail> {
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(net)? {
        if stopped(id) {
            return Err(Fail::Stopped);
        }
        buf.extend_from_slice(&chunk);
        while let Some(end) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line);
            if let Some(data) = line.trim_end().strip_prefix("data:") {
                if on_data(data.trim_start())? {
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}

/// What one request gave back.
struct Round {
    /// Tool calls: (id, name).
    calls: Vec<(String, String)>,
    /// The model's message, to send back along with the tool results.
    assistant: Value,
    wrote: bool,
    refused: bool,
}

/// Streams text deltas to the front end, starting a new line if an earlier round of
/// the same turn already said something.
struct Speaker<'a> {
    app: &'a AppHandle,
    id: u64,
    newline: bool,
    wrote: bool,
}

impl Speaker<'_> {
    fn say(&mut self, s: &str) {
        if s.is_empty() {
            return;
        }
        if std::mem::take(&mut self.newline) {
            emit(self.app, self.id, "text", "\n");
        }
        self.wrote = true;
        emit(self.app, self.id, "text", s);
    }
}

async fn openai_round(t: &Target, system: &str, msgs: &[Value], tools: bool, last: bool, out: &mut Speaker<'_>) -> Result<Round, Fail> {
    let mut all = vec![json!({ "role": "system", "content": system })];
    all.extend_from_slice(msgs);
    let mut body = json!({ "model": t.model, "stream": true, "messages": all });
    if tools {
        body["tools"] = json!([{
            "type": "function",
            "function": { "name": TOOL, "description": TOOL_DESC, "parameters": { "type": "object", "properties": {} } },
        }]);
        if last {
            body["tool_choice"] = "none".into();
        }
    }
    if let Some(Value::Object(extra)) = &t.extra {
        for (k, v) in extra {
            body[k] = v.clone();
        }
    }
    let resp = post(t, "chat/completions", &body, None).await?;

    let mut text = String::new();
    let mut reasoning = String::new();
    let mut calls: Vec<Value> = Vec::new();
    each_event(out.id, resp, |data| {
        if data == "[DONE]" {
            return Ok(true);
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else { return Ok(false) };
        if let Some(e) = v.get("error") {
            return Err(Fail::Other(clip(e["message"].as_str().unwrap_or(&e.to_string()), 160)));
        }
        let delta = &v["choices"][0]["delta"];
        if let Some(s) = delta["content"].as_str() {
            text.push_str(s);
            out.say(s);
        }
        if let Some(s) = delta["reasoning_content"].as_str() {
            reasoning.push_str(s);
        }
        for tc in delta["tool_calls"].as_array().into_iter().flatten() {
            merge_call(&mut calls, tc);
        }
        Ok(false)
    })
    .await?;

    for (i, c) in calls.iter_mut().enumerate() {
        if c["id"].as_str().unwrap_or("").is_empty() {
            c["id"] = format!("call_{i}").into();
        }
    }
    let content = if text.is_empty() { Value::Null } else { Value::String(text) };
    let mut assistant = json!({ "role": "assistant", "content": content });
    if !calls.is_empty() {
        assistant["tool_calls"] = Value::Array(calls.clone());
    }
    // Models that think aloud want their thinking back within the turn.
    if !reasoning.is_empty() {
        assistant["reasoning_content"] = reasoning.into();
    }
    Ok(Round {
        calls: calls
            .iter()
            .map(|c| (c["id"].as_str().unwrap_or("").to_owned(), c["function"]["name"].as_str().unwrap_or("").to_owned()))
            .collect(),
        assistant,
        wrote: out.wrote,
        refused: false,
    })
}

/// Pieces a streamed tool call together. Anything a provider adds to it (Gemini's
/// thought signatures) is kept, to be sent back as it came.
fn merge_call(calls: &mut Vec<Value>, tc: &Value) {
    let i = tc["index"].as_u64().unwrap_or(0) as usize;
    while calls.len() <= i {
        calls.push(json!({ "id": "", "type": "function", "function": { "name": "", "arguments": "" } }));
    }
    let c = &mut calls[i];
    for (k, v) in tc.as_object().into_iter().flatten() {
        match k.as_str() {
            "index" | "type" => {}
            "id" => {
                if v.as_str().is_some_and(|s| !s.is_empty()) {
                    c["id"] = v.clone();
                }
            }
            "function" => {
                if let Some(name) = v["name"].as_str().filter(|s| !s.is_empty()) {
                    c["function"]["name"] = name.into();
                }
                if let Some(args) = v["arguments"].as_str() {
                    let all = c["function"]["arguments"].as_str().unwrap_or("").to_owned() + args;
                    c["function"]["arguments"] = all.into();
                }
            }
            _ => c[k] = v.clone(),
        }
    }
}

fn append(block: &mut Value, field: &str, s: &str) {
    let all = block[field].as_str().unwrap_or("").to_owned() + s;
    block[field] = all.into();
}

async fn anthropic_round(t: &Target, system: &str, msgs: &[Value], tools: bool, last: bool, out: &mut Speaker<'_>) -> Result<Round, Fail> {
    let mut body = json!({
        "model": t.model,
        "max_tokens": if t.official { 16000 } else { 8192 },
        "stream": true,
        "system": system,
        "messages": msgs,
    });
    if tools {
        body["tools"] = json!([{ "name": TOOL, "description": TOOL_DESC, "input_schema": { "type": "object", "properties": {} } }]);
        // The tools stay listed even then: the history has tool_use blocks in it.
        if last {
            body["tool_choice"] = json!({ "type": "none" });
        }
    }
    if EFFORT_MODELS.iter().any(|m| t.model.starts_with(m)) {
        body["output_config"] = json!({ "effort": "low" });
    }
    let beta = t.fallbacks().then(|| {
        body["fallbacks"] = "default".into();
        FALLBACK_BETA
    });
    let resp = post(t, "messages", &body, beta).await?;

    // Every block as it came, thinking and signatures included: a turn that goes on
    // after a tool call has to send them back unchanged.
    let mut blocks: Vec<Value> = Vec::new();
    let mut partial: Vec<String> = Vec::new();
    let mut stop = String::new();
    each_event(out.id, resp, |data| {
        let Ok(v) = serde_json::from_str::<Value>(data) else { return Ok(false) };
        let i = v["index"].as_u64().unwrap_or(0) as usize;
        if blocks.len() <= i {
            blocks.resize(i + 1, Value::Null);
            partial.resize(i + 1, String::new());
        }
        match v["type"].as_str().unwrap_or("") {
            "content_block_start" => blocks[i] = v["content_block"].clone(),
            "content_block_delta" => {
                let d = &v["delta"];
                match d["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        let s = d["text"].as_str().unwrap_or("");
                        append(&mut blocks[i], "text", s);
                        out.say(s);
                    }
                    "thinking_delta" => append(&mut blocks[i], "thinking", d["thinking"].as_str().unwrap_or("")),
                    "signature_delta" => blocks[i]["signature"] = d["signature"].clone(),
                    "input_json_delta" => partial[i].push_str(d["partial_json"].as_str().unwrap_or("")),
                    _ => {}
                }
            }
            "content_block_stop" => {
                if !partial[i].is_empty() {
                    blocks[i]["input"] = serde_json::from_str(&partial[i]).unwrap_or_else(|_| json!({}));
                }
            }
            "message_delta" => {
                if let Some(s) = v["delta"]["stop_reason"].as_str() {
                    stop = s.to_owned();
                }
            }
            "message_stop" => return Ok(true),
            "error" => {
                let e = &v["error"];
                return Err(Fail::Other(clip(e["message"].as_str().unwrap_or(&e.to_string()), 160)));
            }
            _ => {}
        }
        Ok(false)
    })
    .await?;

    blocks.retain(|b| !b.is_null());
    let calls = blocks
        .iter()
        .filter(|b| b["type"] == "tool_use")
        .map(|b| (b["id"].as_str().unwrap_or("").to_owned(), b["name"].as_str().unwrap_or("").to_owned()))
        .collect();
    Ok(Round { calls, assistant: json!({ "role": "assistant", "content": blocks }), wrote: out.wrote, refused: stop == "refusal" })
}

// ---------------------------------------------------------------- a turn of the chat

/// What the model is told about seeing the screen.
#[derive(Clone, Copy)]
enum Sight {
    /// It has the screenshot tool.
    Tool,
    /// The user hasn't allowed it.
    Off,
    /// Allowed, but the model doesn't do tools.
    NoTools,
    /// Allowed, but the model doesn't take images.
    NoImages,
}

fn system_prompt(nickname: &str, now: &str, sight: Sight) -> String {
    let mut s = String::from(
        "你是 Clawd，一只住在用户电脑桌面上的橙色像素小螃蟹桌宠。用户双击你，在你头顶的聊天气泡里和你说话。\n\n\
         说话方式：\n\
         - 像跟熟人发消息：口语、自然、简短。一般一两句话，最多三四句，别写长段落。\n\
         - 不客套，不说“作为 AI”，不列清单，不用 Markdown、标题和代码块（气泡里显示不出来）。要给命令或代码时，原样写成一行。\n\
         - 有问题就直接给答案，需要步骤也压成一小段。\n\
         - 用户用什么语言，你就用什么语言回。\n",
    );
    if !nickname.is_empty() {
        s += &format!("- 你管用户叫“{nickname}”。\n");
    }
    if !now.is_empty() {
        s += &format!("- 现在是 {now}。\n");
    }
    s += match sight {
        Sight::Tool => "- 你有一个 look_at_screen 工具，能截一张用户当前屏幕的图。只在问题和屏幕上的东西有关（比如“这个报错啥意思”“帮我看看这个”），或者不看答不上来时才用，闲聊别用。之前截的图不会留着，要再看就再截一次。\n",
        Sight::Off => "- 你看不到用户的屏幕。用户让你看屏幕时，告诉对方可以在设置的「AI 聊天」里打开「允许它看屏幕」。\n",
        Sight::NoTools => "- 你看不到用户的屏幕：现在用的这个模型不支持工具调用，截不了图。用户让你看屏幕时，告诉对方换个支持工具调用的模型才行。\n",
        Sight::NoImages => "- 你看不到用户的屏幕：现在用的这个模型不支持看图。用户让你看屏幕时，告诉对方换个能看图的模型才行。\n",
    };
    s
}

async fn look(eye: &Eye) -> Result<String, String> {
    let (hwnd, x, y) = (eye.hwnd, eye.x, eye.y);
    let jpeg = tauri::async_runtime::spawn_blocking(move || screen::capture(hwnd, x, y)).await.map_err(|e| e.to_string())??;
    Ok(base64::engine::general_purpose::STANDARD.encode(jpeg))
}

const SHOT_SENT: &str = "截好了，图在下一条消息里。";
const BLIND: &str = "截图发不过去：当前模型不支持看图。告诉用户你看不了屏幕，换个能看图的模型才行。";

/// Adds the results of a round's tool calls. Returns where screenshots went, with
/// what to put there instead if the model turns out not to take images (None: drop
/// that message).
fn push_results(wire: Wire, msgs: &mut Vec<Value>, results: Vec<(String, Result<String, String>)>) -> Vec<(usize, Option<Value>)> {
    let mut slots = Vec::new();
    match wire {
        Wire::OpenAi => {
            // Tool messages can't carry images; the shot follows as the user's.
            // Blind, the tool message says so itself and the image goes: some providers
            // (Mistral's) want nothing between the tool results and the next reply.
            let mut shot = None;
            for (id, r) in results {
                let content = match r {
                    Ok(b64) => {
                        shot = Some(b64);
                        slots.push((msgs.len(), Some(json!({ "role": "tool", "tool_call_id": id, "content": BLIND }))));
                        SHOT_SENT.to_owned()
                    }
                    Err(e) => e,
                };
                msgs.push(json!({ "role": "tool", "tool_call_id": id, "content": content }));
            }
            if let Some(b64) = shot {
                slots.push((msgs.len(), None));
                msgs.push(json!({ "role": "user", "content": [
                    { "type": "text", "text": "（刚截的屏幕）" },
                    { "type": "image_url", "image_url": { "url": format!("data:image/jpeg;base64,{b64}") } },
                ] }));
            }
        }
        Wire::Anthropic => {
            let result = |id: &str, r: &Result<String, String>, blind: bool| match r {
                Ok(_) if blind => json!({ "type": "tool_result", "tool_use_id": id, "content": BLIND, "is_error": true }),
                Ok(b64) => json!({ "type": "tool_result", "tool_use_id": id, "content": [
                    { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": b64 } },
                ] }),
                Err(e) => json!({ "type": "tool_result", "tool_use_id": id, "content": e, "is_error": true }),
            };
            let seeing: Vec<Value> = results.iter().map(|(id, r)| result(id, r, false)).collect();
            if results.iter().any(|(_, r)| r.is_ok()) {
                let blind: Vec<Value> = results.iter().map(|(id, r)| result(id, r, true)).collect();
                slots.push((msgs.len(), Some(json!({ "role": "user", "content": blind }))));
            }
            msgs.push(json!({ "role": "user", "content": seeing }));
        }
    }
    slots
}

/// On the `last` round the model may not call a tool any more, so that the turn ends
/// with an answer instead of a call nobody will run.
async fn send(t: &Target, system: &str, msgs: &[Value], tools: bool, last: bool, out: &mut Speaker<'_>) -> Result<Round, Fail> {
    match t.wire {
        Wire::OpenAi => openai_round(t, system, msgs, tools, last, out).await,
        Wire::Anthropic => anthropic_round(t, system, msgs, tools, last, out).await,
    }
}

async fn converse(app: &AppHandle, id: u64, t: &Target, system: &str, history: &[Turn], eye: Option<&Eye>) -> Result<(), Fail> {
    let mut msgs: Vec<Value> = history
        .iter()
        .filter(|h| !h.text.trim().is_empty())
        .map(|h| json!({ "role": if h.role == "user" { "user" } else { "assistant" }, "content": h.text }))
        .collect();
    let mut slots: Vec<(usize, Option<Value>)> = Vec::new();
    let mut shots = 0;
    // Turned a screenshot down earlier in this turn: no more of them.
    let mut blind = false;
    let mut out = Speaker { app, id, newline: false, wrote: false };
    let tools = eye.is_some();
    for n in 0..MAX_ROUNDS {
        // Closed while a tool ran: nothing more goes out, a screenshot least of all.
        if stopped(id) {
            return Err(Fail::Stopped);
        }
        let last = n + 1 == MAX_ROUNDS;
        let round = match send(t, system, &msgs, tools, last, &mut out).await {
            Err(f) if tools && n == 0 && refuses_tools(&f) => return Err(Fail::NoTools),
            // Most likely a model that doesn't take images: tell it so and try again.
            Err(Fail::Status(code, _)) if turned_down(code) && !slots.is_empty() => {
                // From the back, so that a dropped message doesn't move the rest.
                slots.sort_by_key(|(i, _)| *i);
                for (i, blind) in slots.drain(..).rev() {
                    match blind {
                        Some(v) => msgs[i] = v,
                        None => {
                            msgs.remove(i);
                        }
                    }
                }
                emit(app, id, "blind", "");
                let round = send(t, system, &msgs, tools, last, &mut out).await?;
                // That was it: no more screenshots for this model.
                remember(&NO_IMAGES, t.key());
                blind = true;
                round
            }
            r => r?,
        };
        if round.calls.is_empty() {
            if round.refused && !round.wrote {
                out.say("这个我不太方便聊～");
            }
            return Ok(());
        }
        msgs.push(round.assistant);
        let mut results = Vec::new();
        for (call, name) in round.calls {
            let r = match eye {
                _ if name != TOOL => Err(format!("没有 {name} 这个工具")),
                _ if blind => Err(BLIND.into()),
                _ if shots >= MAX_SHOTS => Err("这一轮已经看过屏幕了，直接回答吧".into()),
                _ if stopped(id) => return Err(Fail::Stopped),
                Some(eye) => {
                    shots += 1;
                    emit(app, id, "look", "");
                    look(eye).await
                }
                None => Err("用户没让你看屏幕".into()),
            };
            results.push((call, r));
        }
        slots.extend(push_results(t.wire, &mut msgs, results));
        out.newline = out.wrote;
    }
    Ok(())
}

/// Starts answering the conversation `history` (ending with the user's message) as
/// chat `id`. Any chat still answering is dropped.
pub fn start(app: AppHandle, ai: AiConfig, nickname: String, now: String, id: u64, history: Vec<Turn>, eye: Option<Eye>) {
    CURRENT.store(id, Ordering::SeqCst);
    let task = tauri::async_runtime::spawn(async move {
        let result = match target(&ai, &ai.provider, true) {
            Ok(t) => {
                let model = t.key();
                let sight = match &eye {
                    None => Sight::Off,
                    Some(_) if knows(&NO_TOOLS, &model) => Sight::NoTools,
                    Some(_) if knows(&NO_IMAGES, &model) => Sight::NoImages,
                    Some(_) => Sight::Tool,
                };
                let tool_eye = if let Sight::Tool = sight { eye.as_ref() } else { None };
                let mut r = converse(&app, id, &t, &system_prompt(&nickname, &now, sight), &history, tool_eye).await;
                // Turned down for offering the screenshot tool: once more without it.
                if let Err(Fail::NoTools) = r {
                    remember(&NO_TOOLS, model);
                    r = converse(&app, id, &t, &system_prompt(&nickname, &now, Sight::NoTools), &history, None).await;
                }
                r.map_err(describe)
            }
            Err(e) => Err(e),
        };
        match result {
            Ok(()) => emit(&app, id, "done", ""),
            Err(e) if !e.is_empty() => emit(&app, id, "error", &e),
            Err(_) => {}
        }
    });
    if let Some(old) = TASK.lock().ok().and_then(|mut t| t.replace(task)) {
        old.abort();
    }
}

/// Drops the chat that is answering, if any.
pub fn stop() {
    CURRENT.store(0, Ordering::SeqCst);
    if let Some(old) = TASK.lock().ok().and_then(|mut t| t.take()) {
        old.abort();
    }
}

/// The models the provider offers, with the key and address in `ai` (the settings
/// being edited, which may not be saved yet).
pub async fn models(ai: AiConfig, provider: String) -> Result<Vec<String>, String> {
    let t = target(&ai, &provider, false)?;
    let url = match t.wire {
        Wire::OpenAi => t.url("models"),
        Wire::Anthropic => t.url("models?limit=1000"),
    };
    let resp = t.authed(client(&url).get(&url)).send().await.map_err(|e| describe(net(e)))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| describe(net(e)))?;
    if !status.is_success() {
        return Err(describe(Fail::Status(status.as_u16(), error_message(&text))));
    }
    let v: Value = serde_json::from_str(&text).map_err(|_| "看不懂服务商返回的模型列表".to_string())?;
    let mut ids: Vec<String> = Vec::new();
    for m in v["data"].as_array().or(v["models"].as_array()).into_iter().flatten() {
        // Gemini names them "models/…".
        let id = m["id"].as_str().or(m["name"].as_str()).unwrap_or("").trim_start_matches("models/");
        if !id.is_empty() && !ids.iter().any(|x| x == id) {
            ids.push(id.to_owned());
        }
    }
    Ok(ids)
}

/// Opens the page where the provider hands out API keys.
pub fn open_key_page(provider: &str) {
    let Some(p) = PROVIDERS.iter().find(|p| p.id == provider && !p.key_url.is_empty()) else { return };
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        let (verb, url) = (wide("open"), wide(p.key_url));
        ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), url.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL);
    }
}
