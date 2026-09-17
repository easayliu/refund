//! 管理界面登录鉴权（可选）。
//!
//! 密码以 sha256 存于 SQLite（`admin_password_sha256`），或由 `REFUND_ADMIN_PASSWORD` 环境接管。
//! 未设置时中间件放行（本机 dev 友好）；设置后 `/api/admin/*` 需带 `Authorization: Bearer <密码>`。
//!
//! **用户侧退款接口不走这里**——那是给终端用户公开提交自己 AT 的路径，见 [`crate::web`] 的
//! `public` 路由。只有母号管理与任务查看这类「管理员才该看到的东西」挂在鉴权后面。

use axum::{
    Json,
    extract::{Request, State},
    http::{StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::store;
use crate::web::AppState;

type ApiError = (StatusCode, String);

/// sha256 十六进制。
pub fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    let digest = h.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// 生效的管理密码哈希：环境接管优先，否则用库中存的哈希；都无则 None（未启用鉴权）。
fn admin_hash(state: &AppState) -> Option<String> {
    if let Some(pw) = &state.admin_env {
        return Some(sha256_hex(pw));
    }
    state.store.get_setting(store::ADMIN_PASSWORD).ok().flatten().filter(|s| !s.is_empty())
}

/// 中间件：未设密码放行；已设则校验 `Authorization: Bearer <密码>`。
pub async fn require_admin(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let Some(hash) = admin_hash(&state) else {
        return next.run(req).await;
    };
    let ok = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|pw| sha256_hex(pw.trim()) == hash)
        .unwrap_or(false);
    if ok {
        next.run(req).await
    } else {
        (StatusCode::UNAUTHORIZED, "需要管理密码").into_response()
    }
}

#[derive(Serialize)]
pub struct StateResp {
    /// 是否已设置管理密码（true = 需登录）。
    configured: bool,
    /// 是否由环境变量接管（true = 网页不可改）。
    env_managed: bool,
}

/// 鉴权状态（公开）。
pub async fn state(State(state): State<AppState>) -> Json<StateResp> {
    Json(StateResp {
        configured: admin_hash(&state).is_some(),
        env_managed: state.admin_env.is_some(),
    })
}

#[derive(Deserialize)]
pub struct PwReq {
    password: String,
}

fn ok_json() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

fn internal(e: impl std::fmt::Display) -> ApiError {
    let msg = e.to_string();
    tracing::error!(error = %msg, "auth 接口内部错误");
    (StatusCode::INTERNAL_SERVER_ERROR, msg)
}

/// 校验密码（供前端登录确认，公开）。
pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<PwReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    match admin_hash(&state) {
        None => Err((StatusCode::BAD_REQUEST, "尚未设置管理密码".into())),
        Some(h) if sha256_hex(req.password.trim()) == h => {
            tracing::info!("管理登录成功");
            Ok(ok_json())
        }
        _ => {
            tracing::warn!("管理登录失败：密码错误");
            Err((StatusCode::UNAUTHORIZED, "密码错误".into()))
        }
    }
}

/// 首次设置密码（仅未配置时，公开）。谁先访问到谁把密码定下来，故留一行日志。
pub async fn setup(
    State(state): State<AppState>,
    Json(req): Json<PwReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if admin_hash(&state).is_some() {
        return Err((StatusCode::BAD_REQUEST, "管理密码已设置".into()));
    }
    let pw = req.password.trim();
    if pw.len() < 4 {
        return Err((StatusCode::BAD_REQUEST, "密码至少 4 位".into()));
    }
    state.store.set_setting(store::ADMIN_PASSWORD, &sha256_hex(pw)).map_err(internal)?;
    tracing::info!("首次设置管理密码");
    Ok(ok_json())
}

/// 修改/清除密码（已鉴权；环境接管时禁止）。空串 = 清除。
pub async fn change_password(
    State(state): State<AppState>,
    Json(req): Json<PwReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if state.admin_env.is_some() {
        return Err((StatusCode::BAD_REQUEST, "管理密码由环境变量接管，网页不可修改".into()));
    }
    let pw = req.password.trim();
    if pw.is_empty() {
        state.store.delete_setting(store::ADMIN_PASSWORD).map_err(internal)?;
    } else {
        if pw.len() < 4 {
            return Err((StatusCode::BAD_REQUEST, "密码至少 4 位".into()));
        }
        state.store.set_setting(store::ADMIN_PASSWORD, &sha256_hex(pw)).map_err(internal)?;
    }
    tracing::info!("管理密码已变更");
    Ok(ok_json())
}
