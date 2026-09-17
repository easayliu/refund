//! 上游端点与请求头常量。
//!
//! 取值来源是 `pro20x.py`（久雾 vov 那份手动跑通的脚本）里的字面量。写死在这里而不是
//! 让调用点各写一遍：邀请/接受/转移/踢人四条路径的拼法、必带的头、必带的 body 字段，
//! 任何一处对不上上游都回 4xx，而报错信息往往指不到是哪一段错了——集中一处便于逐条核对。

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

/// ChatGPT 后端 API 基址。四条动作路径都拼在它后面。
pub const BASE_URL: &str = "https://chatgpt.com/backend-api";

/// id_token / access_token 的签发方（JWT 的 `iss`）。
///
/// 解析 AT 时用它拦「粘错了文件」这类情况：别处签的 JWT 里一样可以有个 `chatgpt_account_id`，
/// 但签发方对不上就整条不认。拦不住伪造（不验签），拦得住误粘。见 [`crate::jwt`]。
pub const ISSUER: &str = "https://auth.openai.com";

/// 接受邀请时报的 TOS 版本。上游要 body 里带这个字段，缺了 422。
///
/// 取自 pro20x.py 里跑通的那次（`2024-12-17`）。上游若上调 TOS 版本这里要跟着改——
/// 表现是接受邀请那一步 4xx，而其余三步照常。
pub const ACCEPTED_TOS_VERSION: &str = "2024-12-17";

/// 邀请新成员时的角色。
pub const INVITE_ROLE: &str = "standard-user";

/// 邀请新成员时的席位类型。
pub const INVITE_SEAT_TYPE: &str = "default";

/// 出站 User-Agent。对齐 pro20x.py 那份（Safari on macOS），不是随手挑的：上游对
/// 「一个非浏览器 UA 在批量邀请/踢人」比对浏览器 UA 更敏感，用一份真实浏览器串少一层风险。
pub const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
     (KHTML, like Gecko) Version/26.5 Safari/605.1.15";

/// 构造一份不含鉴权的基础请求头，对齐 pro20x.py 的 `BASE_HEADERS`。
///
/// `Authorization` 与 `chatgpt-account-id` 由 [`auth_headers`] 在此基础上追加——它们逐动作
/// 不同（有的用 admin AT、有的用 user AT），不放进这份公共头里。
pub fn base_headers() -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert("content-type", HeaderValue::from_static("application/json"));
    h.insert("accept", HeaderValue::from_static("*/*"));
    h.insert("user-agent", HeaderValue::from_static(USER_AGENT));
    h.insert("origin", HeaderValue::from_static("https://chatgpt.com"));
    h.insert("referer", HeaderValue::from_static("https://chatgpt.com/"));
    h.insert("oai-language", HeaderValue::from_static("zh-CN"));
    h
}

/// 在基础头上追加 `Authorization: Bearer <at>`，可选地带上 `chatgpt-account-id`。
///
/// **哪些动作要带 account_id 是有讲究的**：转移个人空间（步骤3）实测必须带，缺了上游按
/// 「转到哪个空间」无从判断；邀请/踢人（母号侧）也带着母号的 account_id 才对得上团队。
/// 只有「接受邀请」那一步是拿 user AT 打、且不带 account_id——那一步的语境里用户还不属于
/// 任何团队，见 pro20x.py 的 `step2_accept_invite`。
pub fn auth_headers(at: &str, account_id: Option<&str>) -> HeaderMap {
    let mut h = base_headers();
    if let Ok(v) = HeaderValue::from_str(&format!("Bearer {at}")) {
        h.insert(reqwest::header::AUTHORIZATION, v);
    }
    if let Some(id) = account_id
        && let (Ok(name), Ok(val)) =
            (HeaderName::from_bytes(b"chatgpt-account-id"), HeaderValue::from_str(id))
    {
        h.insert(name, val);
    }
    h
}
