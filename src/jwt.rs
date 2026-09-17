//! 从 access_token（AT）里解出账号信息，对齐 pro20x.py 的 `decode_jwt` / `get_user_info`。
//!
//! AT 是 `auth.openai.com` 签发的三段式 JWT。ChatGPT 专有信息挂在两个带命名空间的 claim 里：
//! - `https://api.openai.com/auth`：`chatgpt_user_id` / `chatgpt_account_id` / `chatgpt_plan_type`
//! - `https://api.openai.com/profile`：`email` / `name`
//!
//! **刻意不验签**：这里只是从用户自己粘进来的 token 里读出用来发请求的字段，真正的判决权在
//! 上游——account_id / user_id 对不对，最终由邀请/转移/踢人那几个接口的响应说了算。验签需要
//! 上游公钥且与目的无关。但**签发方那一道必须留着**（见 [`decode_payload`]），用来拦「粘错了
//! 文件」——一个别处签的 JWT 里一样能有这些字段，照单全收等于让任何字符串冒充一份凭证。

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;

use crate::config;

/// 从一份 AT 里解出的账号信息。字段与 pro20x.py 的 `get_user_info` 一一对应。
#[derive(Debug, Clone, Serialize)]
pub struct UserInfo {
    /// `chatgpt_user_id`——踢人（步骤4）时拼进 URL 的那个 id，缺了整条流程无从进行。
    pub user_id: Option<String>,
    pub email: Option<String>,
    pub name: Option<String>,
    /// `chatgpt_account_id`——母号侧即团队 id；用户侧即其个人/所在空间 id。
    pub account_id: Option<String>,
    pub plan_type: Option<String>,
}

/// 把用户粘进来的东西规整成裸 token。
///
/// 实际粘贴来源几乎只有一个：`chatgpt.com/api/auth/session` 的整段 JSON——用户多半是整页复制，
/// 而不是精确挑出 `accessToken` 字段的值。故这里接受三种形态：
/// - 裸 token；
/// - 前面带 `Bearer ` 或被引号包着的 token（从请求头/JSON 片段里抠出来的）；
/// - 整段 session JSON（取其 `accessToken`）。
/// 其余原样返回，让 [`parse`] 报「不是三段式」。
pub fn extract_token(raw: &str) -> String {
    let s = raw.trim();
    if s.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(s) {
            if let Some(t) =
                v.get("accessToken").or_else(|| v.get("access_token")).and_then(|x| x.as_str())
            {
                return t.trim().to_string();
            }
        }
        // JSON 解析失败（比如复制时截断了）：尽力用正则式的方式抠 accessToken 字段。
        if let Some(pos) = s.find("\"accessToken\"") {
            let rest = &s[pos + "\"accessToken\"".len()..];
            if let Some(q1) = rest.find('"') {
                let after = &rest[q1 + 1..];
                if let Some(q2) = after.find('"') {
                    return after[..q2].trim().to_string();
                }
            }
        }
    }
    let s = s.strip_prefix("Bearer ").or_else(|| s.strip_prefix("bearer ")).unwrap_or(s);
    s.trim().trim_matches(|c| c == '"' || c == '\'' || c == ',').trim().to_string()
}

/// 解析一份 AT。任何一步失败（格式错、base64 错、签发方不符）都返回 `Err`，由调用点
/// 按「这份 token 无效」拒绝，而不是拿一份半空的信息往下跑——那只会在后续某一步 401，
/// 报错还指不到「其实是 token 一开始就不对」。
pub fn parse(at: &str) -> Result<UserInfo, String> {
    let payload = decode_payload(at)?;

    let auth = payload.get("https://api.openai.com/auth");
    let profile = payload.get("https://api.openai.com/profile");

    let claim = |obj: Option<&serde_json::Value>, key: &str| -> Option<String> {
        obj.and_then(|o| o.get(key)).and_then(|v| v.as_str()).map(str::to_owned)
    };

    Ok(UserInfo {
        user_id: claim(auth, "chatgpt_user_id"),
        email: claim(profile, "email"),
        name: claim(profile, "name"),
        account_id: claim(auth, "chatgpt_account_id"),
        plan_type: claim(auth, "chatgpt_plan_type"),
    })
}

/// 解出 JWT 的 payload 段并做签发方校验。
///
/// 三段式：`header.payload.signature`，只取中间段 base64url 解码。padding 交给
/// `URL_SAFE_NO_PAD`（OpenAI 的 token 本就不带 `=` 填充）。
///
/// **签发方那一道**：payload 里的 `iss` 必须是 [`config::ISSUER`]，否则整条不认——这是拦
/// 误粘的唯一屏障，去掉它 `parse` 会对任何三段式 base64 都返回 `Ok`。
fn decode_payload(token: &str) -> Result<serde_json::Value, String> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err("无效的 JWT 格式（不是三段式）".into());
    }
    let raw = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| "JWT payload 段无法 base64 解码".to_string())?;
    let v: serde_json::Value =
        serde_json::from_slice(&raw).map_err(|_| "JWT payload 不是合法 JSON".to_string())?;
    if v.get("iss").and_then(|x| x.as_str()) != Some(config::ISSUER) {
        return Err(format!("签发方不是 {}，这不是一份 ChatGPT 的 access_token", config::ISSUER));
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    #[test]
    fn extract_token_accepts_session_json_and_wrappers() {
        assert_eq!(extract_token("  a.b.c "), "a.b.c");
        assert_eq!(extract_token("Bearer a.b.c"), "a.b.c");
        assert_eq!(extract_token("\"a.b.c\","), "a.b.c");
        let json = r#"{"user":{"id":"u"},"accessToken":"a.b.c","sessionToken":"zzz"}"#;
        assert_eq!(extract_token(json), "a.b.c");
        // 截断的 JSON 也能抠出来。
        let truncated = r#"{"user":{"id":"u"}, "accessToken": "a.b.c", "sessionToken": "zz"#;
        assert_eq!(extract_token(truncated), "a.b.c");
        // 没有 accessToken 的 JSON 原样返回，交给 parse 报错。
        assert_eq!(extract_token(r#"{"x":1}"#), r#"{"x":1}"#);
    }

    fn make_jwt(payload: serde_json::Value) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
        let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        format!("{header}.{body}.sig")
    }

    #[test]
    fn parses_nested_claims() {
        let at = make_jwt(serde_json::json!({
            "iss": config::ISSUER,
            "https://api.openai.com/auth": {
                "chatgpt_user_id": "user-1",
                "chatgpt_account_id": "acct-123",
                "chatgpt_plan_type": "team",
            },
            "https://api.openai.com/profile": { "email": "a@b.com", "name": "Alice" },
        }));
        let info = parse(&at).unwrap();
        assert_eq!(info.user_id.as_deref(), Some("user-1"));
        assert_eq!(info.account_id.as_deref(), Some("acct-123"));
        assert_eq!(info.email.as_deref(), Some("a@b.com"));
        assert_eq!(info.plan_type.as_deref(), Some("team"));
    }

    #[test]
    fn rejects_wrong_issuer() {
        let at = make_jwt(serde_json::json!({ "iss": "https://evil.example" }));
        assert!(parse(&at).is_err());
    }

    #[test]
    fn rejects_malformed() {
        for s in ["", "not-a-jwt", "a.b", "a.!!!.c"] {
            assert!(parse(s).is_err(), "input: {s}");
        }
    }
}
