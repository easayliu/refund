//! refund —— ChatGPT Team 去除个人空间自动化。
//!
//! 把 `pro20x.py` 的四步手动流程（邀请 → 接受邀请 → 去个人空间 → 踢出）做成常驻网页服务：
//! 终端用户在网页粘贴自己的 access_token 即可触发退款流程；管理员在管理页配置一个或多个母号
//! （admin AT），流程用其中一个可用母号执行。
//!
//! 架构参考同目录的 luban / coban：axum + rust-embed 内嵌前端 + SQLite。

mod admin_ui;
mod auth;
mod config;
mod flow;
mod jwt;
mod store;
mod web;

use std::sync::Arc;

use anyhow::Result;
use clap::{Parser, Subcommand};

use store::Store;

#[derive(Parser)]
#[command(name = "refund", version, about = "ChatGPT Team 去除个人空间自动化")]
struct Cli {
    /// 网页服务绑定地址（0.0.0.0 对外可达；仅本机用 127.0.0.1）。
    #[arg(long, default_value = "0.0.0.0")]
    host: String,
    /// 网页服务端口。
    #[arg(long, default_value_t = 4800)]
    port: u16,
    /// 管理密码；也可用 REFUND_ADMIN_PASSWORD。设置后管理接口需鉴权，环境值优先且使网页只读。
    #[arg(long, env = "REFUND_ADMIN_PASSWORD")]
    admin_password: Option<String>,
    /// 启动后打开浏览器（默认关）。
    #[arg(long)]
    open: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// 列出已配置的母号。
    Admins,
    /// 清空所有母号。
    ClearAdmins,
}

#[tokio::main]
async fn main() -> Result<()> {
    init_logging();
    let cli = Cli::parse();
    let store = Arc::new(Store::open_default()?);

    match cli.command {
        None => {
            // 空串按「没设」处理：compose 里 `REFUND_ADMIN_PASSWORD=` 很常见。
            let admin_password = cli.admin_password.filter(|k| !k.trim().is_empty());
            // 上个进程没跑完的任务在内存里已经没了执行体，先收尾，免得永远「执行中」。
            match store.fail_interrupted_jobs() {
                Ok(0) => {}
                Ok(n) => tracing::warn!(count = n, "已将上次未完成的任务标记为中断"),
                Err(e) => tracing::error!(error = %e, "清理未完成任务失败"),
            }
            web::run(&cli.host, cli.port, cli.open, store, admin_password).await
        }
        Some(Command::Admins) => list_admins(&store),
        Some(Command::ClearAdmins) => clear_admins(&store),
    }
}

/// 初始化日志：本地时间、干净格式、非终端自动关 ANSI 颜色。默认 info，`RUST_LOG` 可覆盖。
fn init_logging() {
    use std::io::IsTerminal;
    use tracing_subscriber::{EnvFilter, fmt::time::ChronoLocal};
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_timer(ChronoLocal::new("%Y-%m-%d %H:%M:%S%.3f".to_owned()))
        .with_target(false)
        .with_ansi(std::io::stdout().is_terminal())
        .init();
}

fn list_admins(store: &Store) -> Result<()> {
    let list = store.list_admins()?;
    if list.is_empty() {
        println!("尚未配置母号。运行 `refund`（不带子命令）打开网页，在管理页添加。");
        return Ok(());
    }
    println!("已配置母号（{}）：", list.len());
    for a in &list {
        let state = if a.disabled { "停用" } else { "启用" };
        println!(
            "  #{:<3} {:<28} {:<6} {:<8} {}",
            a.id,
            a.label,
            a.plan_type.as_deref().unwrap_or("-"),
            state,
            a.email.as_deref().unwrap_or("-"),
        );
    }
    Ok(())
}

fn clear_admins(store: &Store) -> Result<()> {
    let list = store.list_admins()?;
    let n = list.len();
    for a in list {
        store.delete_admin(a.id)?;
    }
    println!("已清空 {n} 个母号。");
    Ok(())
}
