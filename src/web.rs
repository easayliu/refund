//! 网页服务：用户提交退款、管理员管理母号，其余路径由内嵌前端 SPA 兜底。
//!
//! 路由分三层：
//! - **公开**：鉴权状态/登录/首次设置密码，以及**用户侧退款提交与任务查询**——后者是给终端
//!   用户公开粘贴自己 AT 的入口，不该挡在管理密码后面。
//! - **管理**（`/api/admin/*`，走 [`crate::auth::require_admin`]）：母号增删改、任务列表、改密码。
//! - **SPA 兜底**：前端静态资源与路由。

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    middleware,
    routing::{delete, get, post},
};
use serde::{Deserialize, Serialize};

use crate::admin_ui;
use crate::auth;
use crate::flow::{self, FlowInput};
use crate::jwt;
use crate::store::Store;

type ApiError = (StatusCode, String);

/// 服务共享状态。
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    /// 管理密码（环境接管，明文；None 表示未由环境设置）。
    pub admin_env: Option<Arc<String>>,
    /// 出站 HTTP 客户端。四步流程都用它打 chatgpt.com。
    pub http: reqwest::Client,
    /// **按母号串行**的队列锁：`admin_id → 该母号的执行锁`。
    ///
    /// 同一母号上不能并发跑流程：四步里三步拿母号 AT 打同一个团队（邀请、查成员、踢人），
    /// 并发时上游对同一团队的成员变更会互相踩（席位数、邀请落库的传播延迟），且母号 AT 打得
    /// 太密容易触发限流——一旦母号被限流，所有排在它后面的用户一起遭殃。因此每个母号一把
    /// `tokio::sync::Mutex`（FIFO 公平，先提交先执行），任务在拿到锁之前一直是 `pending`。
    /// 不同母号之间互不影响，可以并行。
    pub queues: Arc<parking_lot::Mutex<HashMap<i64, Arc<tokio::sync::Mutex<()>>>>>,
}

impl AppState {
    /// 取（或建）某母号的执行锁。锁对象常驻内存不回收——母号个位数，无所谓。
    fn admin_queue(&self, admin_id: i64) -> Arc<tokio::sync::Mutex<()>> {
        self.queues.lock().entry(admin_id).or_default().clone()
    }
}

/// 启动网页服务。
pub async fn run(
    host: &str,
    port: u16,
    open_browser: bool,
    store: Arc<Store>,
    admin_password: Option<String>,
) -> Result<()> {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .context("构建 HTTP 客户端失败")?;

    let state =
        AppState { store, admin_env: admin_password.map(Arc::new), http, queues: Arc::default() };

    // 公开接口（无需登录）。
    let public = Router::new()
        .route("/auth/state", get(auth::state))
        .route("/auth/login", post(auth::login))
        .route("/auth/setup", post(auth::setup))
        // 服务是否就绪（是否已配置可用母号）——用户页据此提示。
        .route("/service/status", get(service_status))
        // 用户提交退款、按 id 轮询任务。
        .route("/refund/submit", post(submit_refund))
        .route("/refund/jobs/{id}", get(get_job));

    // 需管理鉴权的接口（未设密码时中间件放行）。
    let protected = Router::new()
        .route("/admin/admins", get(list_admins).post(add_admin))
        .route("/admin/admins/{id}", delete(delete_admin))
        .route("/admin/admins/{id}/disabled", post(set_admin_disabled))
        .route("/admin/jobs", get(list_jobs))
        .route("/admin/password", post(auth::change_password))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::require_admin));

    let api = public.merge(protected);

    let app = Router::new()
        .nest("/api", api)
        .route("/", get(admin_ui::fallback).post(admin_ui::redirect_root_post))
        .fallback_service(get(admin_ui::fallback))
        .with_state(state);

    let bind = format!("{host}:{port}");
    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .with_context(|| format!("绑定 {bind} 失败（端口可能被占用）"))?;

    let shown = if host == "0.0.0.0" || host == "::" { "127.0.0.1" } else { host };
    let url = format!("http://{shown}:{port}/");
    tracing::info!(addr = %bind, url = %url, "refund 已启动");
    tracing::info!("用户页: {url}   管理页: {url}#/admin");
    if open_browser {
        open_in_browser(&url);
    }

    axum::serve(listener, app.into_make_service())
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("网页服务异常退出")?;
    Ok(())
}

// ============ 公开接口 ============

#[derive(Serialize)]
struct ServiceStatus {
    /// 是否已配置至少一个可用母号——false 时用户页应提示「服务未就绪」。
    ready: bool,
}

/// 服务就绪状态：有没有可用母号。
async fn service_status(State(state): State<AppState>) -> Result<Json<ServiceStatus>, ApiError> {
    let ready = state.store.pick_active_admin().map_err(internal)?.is_some();
    Ok(Json(ServiceStatus { ready }))
}

#[derive(Deserialize)]
struct SubmitReq {
    /// 用户自己的 access_token。
    user_at: String,
}

#[derive(Serialize)]
struct SubmitResp {
    job_id: i64,
}

/// 用户提交退款：解析 user AT → 选一个可用母号 → 建任务 → 后台跑四步流程 → 返回 job_id。
///
/// **不持久化 user AT**：它只在内存里传给后台任务，跑完即弃。库里只留任务的步骤日志与用户的
/// 邮箱/id（用于展示与去重排查），不留可复用的凭证。
async fn submit_refund(
    State(state): State<AppState>,
    Json(req): Json<SubmitReq>,
) -> Result<Json<SubmitResp>, ApiError> {
    // 接受整段 session JSON / 带 Bearer 前缀等形态，见 [`jwt::extract_token`]。
    let user_at = jwt::extract_token(&req.user_at);
    if user_at.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "user AT 不能为空".into()));
    }

    // 解析用户 AT。踢人这一步要 user_id，缺了整条流程无从收尾，故此刻就拦。
    let user = jwt::parse(&user_at)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("用户 AT 无效: {e}")))?;
    let Some(user_id) = user.user_id.clone() else {
        return Err((StatusCode::BAD_REQUEST, "用户 AT 里缺少 chatgpt_user_id".into()));
    };
    let Some(user_email) = user.email.clone() else {
        return Err((StatusCode::BAD_REQUEST, "用户 AT 里缺少 email".into()));
    };

    // 同一用户已有未完成任务 → 直接把那个任务还给它，不再排第二趟。
    if let Some(job_id) = state.store.find_open_job_for_user(&user_id).map_err(internal)? {
        tracing::info!(job_id, user = %user_email, "用户已有进行中的任务，复用");
        return Ok(Json(SubmitResp { job_id }));
    }

    // 选一个可用母号（排队最少的那个）。
    let admin = state
        .store
        .pick_active_admin()
        .map_err(internal)?
        .ok_or((StatusCode::SERVICE_UNAVAILABLE, "服务未就绪：管理员尚未配置母号".to_string()))?;

    // 建任务。
    let job_id = state
        .store
        .create_job(
            Some(&user_email),
            Some(&user_id),
            user.plan_type.as_deref(),
            Some(admin.id),
            admin.email.as_deref(),
        )
        .map_err(internal)?;

    // 后台跑流程。任务状态与步骤日志落库，前端轮询。
    // 先排进该母号的队列：拿到锁才从 pending 变 running，锁在流程跑完（含失败）后自动释放。
    let store = state.store.clone();
    let http = state.http.clone();
    let queue = state.admin_queue(admin.id);
    let admin_id = admin.id;
    let input = FlowInput {
        admin_at: admin.access_token.clone(),
        team_account_id: admin.account_id.clone(),
        user_at,
        user_id,
        user_email: user_email.clone(),
    };
    tokio::spawn(async move {
        let _guard = queue.lock().await;
        tracing::info!(job_id, admin_id, user = %user_email, "退款流程开始");
        let _ = store.update_job(job_id, "running", "[]");
        let outcome = flow::run(&http, &input, false).await;
        let steps_json = serde_json::to_string(&outcome.steps).unwrap_or_else(|_| "[]".into());
        let status = if outcome.ok { "success" } else { "failed" };
        if let Err(e) = store.update_job(job_id, status, &steps_json) {
            tracing::error!(job_id, error = %e, "写回任务结果失败");
        }
        tracing::info!(job_id, status, user = %user_email, "退款流程结束");
    });

    Ok(Json(SubmitResp { job_id }))
}

/// 任务 + 排队信息。`queue_ahead` 是同母号队列里排在它前面的未完成任务数，前端据此显示
/// 「前面还有 N 个」；任务开始/结束后恒为 0。
#[derive(Serialize)]
struct JobView {
    #[serde(flatten)]
    job: crate::store::Job,
    queue_ahead: i64,
}

/// 按 id 查任务（公开——凭 id 查询自己的任务，前端轮询用）。
async fn get_job(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<JobView>, ApiError> {
    let job = state
        .store
        .get_job(id)
        .map_err(internal)?
        .ok_or((StatusCode::NOT_FOUND, "任务不存在".to_string()))?;
    let queue_ahead = state.store.queue_ahead(&job).map_err(internal)?;
    Ok(Json(JobView { job, queue_ahead }))
}

// ============ 管理接口 ============

/// 母号列表（不含 access_token，见 [`crate::store::AdminCred`] 的 serde skip）。
async fn list_admins(
    State(state): State<AppState>,
) -> Result<Json<Vec<crate::store::AdminCred>>, ApiError> {
    Ok(Json(state.store.list_admins().map_err(internal)?))
}

#[derive(Deserialize)]
struct AddAdminReq {
    /// 母号 access_token。
    access_token: String,
    /// 可选备注名；不填时用邮箱、再退回 account_id 前缀。
    #[serde(default)]
    label: Option<String>,
}

/// 添加母号：解析 AT → 取 account_id/email/plan → upsert。
async fn add_admin(
    State(state): State<AppState>,
    Json(req): Json<AddAdminReq>,
) -> Result<Json<crate::store::AdminCred>, ApiError> {
    let at = jwt::extract_token(&req.access_token);
    let at = at.as_str();
    if at.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "母号 AT 不能为空".into()));
    }
    let info =
        jwt::parse(at).map_err(|e| (StatusCode::BAD_REQUEST, format!("母号 AT 无效: {e}")))?;
    let Some(account_id) = info.account_id.clone() else {
        return Err((StatusCode::BAD_REQUEST, "母号 AT 里缺少 chatgpt_account_id".into()));
    };

    let label = req
        .label
        .filter(|s| !s.trim().is_empty())
        .or_else(|| info.email.clone())
        .or_else(|| info.name.clone())
        .unwrap_or_else(|| format!("team-{}", account_id.chars().take(8).collect::<String>()));

    let id = state
        .store
        .upsert_admin(&label, info.email.as_deref(), &account_id, info.plan_type.as_deref(), at)
        .map_err(internal)?;

    let admin = state
        .store
        .get_admin(id)
        .map_err(internal)?
        .ok_or_else(|| internal("刚写入的母号读不回"))?;
    tracing::info!(id, account_id = %account_id, "添加母号");
    Ok(Json(admin))
}

#[derive(Deserialize)]
struct DisabledReq {
    disabled: bool,
}

async fn set_admin_disabled(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<DisabledReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state.store.set_admin_disabled(id, req.disabled).map_err(internal)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn delete_admin(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state.store.delete_admin(id).map_err(internal)?;
    tracing::info!(id, "删除母号");
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 最近任务列表（管理员查看全量历史）。
async fn list_jobs(
    State(state): State<AppState>,
) -> Result<Json<Vec<crate::store::Job>>, ApiError> {
    Ok(Json(state.store.list_jobs(200).map_err(internal)?))
}

// ============ 工具 ============

fn internal(e: impl std::fmt::Display) -> ApiError {
    let msg = e.to_string();
    tracing::error!(error = %msg, "接口内部错误");
    (StatusCode::INTERNAL_SERVER_ERROR, msg)
}

/// 尽力打开浏览器；失败静默（服务器/无头环境常态）。
fn open_in_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd").args(["/C", "start", url]).spawn();
}

/// Ctrl-C / SIGTERM 优雅退出。
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.expect("安装 Ctrl-C 处理器失败");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("安装 SIGTERM 处理器失败")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("收到退出信号，正在停止…");
}
