//! 去除个人空间的四步流程，逐字对应 pro20x.py：
//! 邀请 → 接受邀请 → 去个人空间（账户转移）→ 踢出。
//!
//! PRO20X 账号加入团队空间后上游会自动退款，这四步把「用户被拉进团队、转走个人空间、再被
//! 移出」跑完。每一步都记一条 [`StepResult`] 存进任务日志，前端逐条展示——上游报错往往指不到
//! 是哪一步，逐步留痕是排查的唯一抓手。
//!
//! **容错策略与 pro20x 不同的一点**：脚本版遇到「用户已在团队里」时靠人手加 `--skip-invite`，
//! 网页版没有这个人工介入的时机，故邀请/接受两步失败时回退查一次团队成员列表——真的已在团队
//! 就当这两步已完成、继续往下，而不是把一个其实能跑通的请求判成失败。转移与踢出两步没有这种
//! 「其实已完成」的等价态，失败即失败。

use std::time::Duration;

use serde::Serialize;

use crate::config;

/// 一步的结果。`step` 是稳定的机器标识（`invite`/`accept`/`transfer`/`kick`/`check`），
/// 前端按它配文案与图标；`detail` 是给人看的一句话（含上游状态码与响应摘要）。
#[derive(Debug, Clone, Serialize)]
pub struct StepResult {
    pub step: String,
    pub ok: bool,
    /// 上游 HTTP 状态码；本地就失败（如构造请求出错）时为 None。
    pub status: Option<u16>,
    pub detail: String,
}

impl StepResult {
    fn ok(step: &str, status: u16, detail: impl Into<String>) -> Self {
        Self { step: step.into(), ok: true, status: Some(status), detail: detail.into() }
    }
    fn fail(step: &str, status: Option<u16>, detail: impl Into<String>) -> Self {
        Self { step: step.into(), ok: false, status, detail: detail.into() }
    }
}

/// 跑一趟流程要的全部输入。account_id / user_id / email 都是调用点从两份 AT 解出来的
/// （见 [`crate::jwt`]），这里不再解一遍。
pub struct FlowInput {
    /// 母号（管理员）AT。用于邀请与踢人。
    pub admin_at: String,
    /// 团队 id（= 母号的 account_id）。四条路径里三条要拼它。
    pub team_account_id: String,
    /// 用户 AT。用于接受邀请与转移个人空间。
    pub user_at: String,
    /// 用户 id（= 用户的 chatgpt_user_id）。踢人时拼进 URL。
    pub user_id: String,
    /// 用户邮箱。邀请时用。
    pub user_email: String,
}

/// 一趟流程的总结果。
pub struct FlowOutcome {
    pub ok: bool,
    pub steps: Vec<StepResult>,
}

// 步骤间的等待，对齐 pro20x.py：邀请后 3s、接受后 2s、转移后 5s。上游对这几个动作有传播
// 延迟，太快跟上一步会撞上「邀请还没落库」这类瞬时态。
const WAIT_AFTER_INVITE: Duration = Duration::from_secs(3);
const WAIT_AFTER_ACCEPT: Duration = Duration::from_secs(2);
const WAIT_AFTER_TRANSFER: Duration = Duration::from_secs(5);

/// 跑完整趟流程。任一硬失败即停并返回已跑的步骤（`ok=false`）。
///
/// `skip_invite=true` 时跳过邀请与接受，仅在调用点已确认用户在团队里时用（对齐脚本的
/// `--skip-invite`）——网页默认不跳。
pub async fn run(client: &reqwest::Client, input: &FlowInput, skip_invite: bool) -> FlowOutcome {
    let mut steps = Vec::new();

    if skip_invite {
        let in_team = check_user_in_team(client, input).await;
        steps.push(in_team.clone());
        if !in_team.ok {
            return FlowOutcome { ok: false, steps };
        }
    } else {
        // 步骤1：邀请。失败时回退查成员列表——已在团队就当邀请这步无须再做。
        let invite = step_invite(client, input).await;
        let invite_ok = invite.ok;
        steps.push(invite);
        if !invite_ok {
            let check = check_user_in_team(client, input).await;
            let already = check.ok;
            steps.push(check);
            if !already {
                return FlowOutcome { ok: false, steps };
            }
        } else {
            tokio::time::sleep(WAIT_AFTER_INVITE).await;

            // 步骤2：接受邀请。同样地，已在团队即视作已接受。
            let accept = step_accept(client, input).await;
            let accept_ok = accept.ok;
            steps.push(accept);
            if !accept_ok {
                let check = check_user_in_team(client, input).await;
                let already = check.ok;
                steps.push(check);
                if !already {
                    return FlowOutcome { ok: false, steps };
                }
            } else {
                tokio::time::sleep(WAIT_AFTER_ACCEPT).await;
            }
        }
    }

    // 步骤3：去个人空间（账户转移）。这一步没有「其实已完成」的等价态，失败即停。
    let transfer = step_transfer(client, input).await;
    let transfer_ok = transfer.ok;
    steps.push(transfer);
    if !transfer_ok {
        return FlowOutcome { ok: false, steps };
    }
    tokio::time::sleep(WAIT_AFTER_TRANSFER).await;

    // 步骤4：踢出。
    let kick = step_kick(client, input).await;
    let kick_ok = kick.ok;
    steps.push(kick);

    FlowOutcome { ok: kick_ok, steps }
}

/// 把一次响应压成一行摘要：状态码 + 截断后的响应体。响应体可能很长（或是一大段 HTML 错误页），
/// 留 400 字够定位又不至于把日志撑爆。
fn summarize(status: u16, body: &str) -> String {
    let body = body.trim();
    let shown: String = body.chars().take(400).collect();
    let ellipsis = if body.chars().count() > 400 { "…" } else { "" };
    format!("HTTP {status} · {shown}{ellipsis}")
}

async fn step_invite(client: &reqwest::Client, input: &FlowInput) -> StepResult {
    let url = format!("{}/accounts/{}/invites", config::BASE_URL, input.team_account_id);
    let headers = config::auth_headers(&input.admin_at, Some(&input.team_account_id));
    let payload = serde_json::json!({
        "email_addresses": [input.user_email],
        "role": config::INVITE_ROLE,
        "seat_type": config::INVITE_SEAT_TYPE,
    });
    match client.post(&url).headers(headers).json(&payload).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            if (200..300).contains(&status) {
                StepResult::ok("invite", status, summarize(status, &body))
            } else {
                StepResult::fail("invite", Some(status), summarize(status, &body))
            }
        }
        Err(e) => StepResult::fail("invite", None, format!("请求发送失败: {e}")),
    }
}

async fn step_accept(client: &reqwest::Client, input: &FlowInput) -> StepResult {
    // 接受邀请是拿 user AT 打的，且**不带** account_id——此刻用户还不属于任何团队。
    let url = format!("{}/accounts/{}/invites/accept", config::BASE_URL, input.team_account_id);
    let headers = config::auth_headers(&input.user_at, None);
    let payload = serde_json::json!({ "accepted_tos_version": config::ACCEPTED_TOS_VERSION });
    match client.post(&url).headers(headers).json(&payload).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            if (200..300).contains(&status) {
                StepResult::ok("accept", status, summarize(status, &body))
            } else {
                StepResult::fail("accept", Some(status), summarize(status, &body))
            }
        }
        Err(e) => StepResult::fail("accept", None, format!("请求发送失败: {e}")),
    }
}

async fn step_transfer(client: &reqwest::Client, input: &FlowInput) -> StepResult {
    // 转移必须带 account_id，且 body 里要有 workspace_id（pro20x 里由一次 422 报错得知）。
    let url = format!("{}/accounts/transfer", config::BASE_URL);
    let headers = config::auth_headers(&input.user_at, Some(&input.team_account_id));
    let payload = serde_json::json!({ "workspace_id": input.team_account_id });
    match client.post(&url).headers(headers).json(&payload).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            if (200..300).contains(&status) {
                StepResult::ok("transfer", status, summarize(status, &body))
            } else {
                StepResult::fail("transfer", Some(status), summarize(status, &body))
            }
        }
        Err(e) => StepResult::fail("transfer", None, format!("请求发送失败: {e}")),
    }
}

async fn step_kick(client: &reqwest::Client, input: &FlowInput) -> StepResult {
    let url =
        format!("{}/accounts/{}/users/{}", config::BASE_URL, input.team_account_id, input.user_id);
    let headers = config::auth_headers(&input.admin_at, Some(&input.team_account_id));
    match client.delete(&url).headers(headers).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            if (200..300).contains(&status) {
                StepResult::ok("kick", status, summarize(status, &body))
            } else {
                StepResult::fail("kick", Some(status), summarize(status, &body))
            }
        }
        Err(e) => StepResult::fail("kick", None, format!("请求发送失败: {e}")),
    }
}

/// 查团队成员列表，确认用户是否已在团队里。兼容上游几种可能的返回结构（对齐 pro20x 的
/// `check_user_in_team`：`items` / `users` / `account_users` / 顶层数组都试）。
async fn check_user_in_team(client: &reqwest::Client, input: &FlowInput) -> StepResult {
    let url = format!("{}/accounts/{}/users", config::BASE_URL, input.team_account_id);
    let headers = config::auth_headers(&input.admin_at, Some(&input.team_account_id));
    let resp = match client.get(&url).headers(headers).send().await {
        Ok(r) => r,
        Err(e) => return StepResult::fail("check", None, format!("请求发送失败: {e}")),
    };
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return StepResult::fail("check", Some(status), summarize(status, &body));
    }
    let data: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return StepResult::fail("check", Some(status), "成员列表响应无法解析为 JSON"),
    };
    let items = data
        .get("items")
        .or_else(|| data.get("users"))
        .or_else(|| data.get("account_users"))
        .or(if data.is_array() { Some(&data) } else { None })
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let found = items.iter().any(|u| {
        let uid = u
            .get("user_id")
            .or_else(|| u.get("id"))
            .or_else(|| u.get("user").and_then(|x| x.get("id")))
            .or_else(|| u.get("user").and_then(|x| x.get("user_id")))
            .and_then(|v| v.as_str());
        uid == Some(input.user_id.as_str())
    });

    if found {
        StepResult::ok("check", status, format!("用户已在团队中（成员数 {}）", items.len()))
    } else {
        StepResult::fail(
            "check",
            Some(status),
            format!("用户不在团队成员列表中（成员数 {}）", items.len()),
        )
    }
}
