//! SQLite 持久化：管理员（母号）凭证、退款任务、以及少量设置项。
//!
//! 单连接 + `parking_lot::Mutex` 串行化；WAL + `synchronous=NORMAL`；STRICT 表。数据量很小
//! （母号个位数、任务按天计），不做 coban 那套内存缓存与限流窗口——那是转发热路径才需要的。

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;

/// 设置项：管理密码的 sha256。与 coban 同名，语义一致。
pub const ADMIN_PASSWORD: &str = "admin_password_sha256";

/// 当前 Unix 秒。
pub fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// 管理员（母号）凭证。`access_token` 是明文存的——它就是发请求要用的东西，加密存了每次用还得
/// 解，而这台服务能读库就能读到它，加密只是把钥匙和锁放在同一个抽屉。库文件本身按敏感文件对待
/// （见 `.gitignore`）。
#[derive(Debug, Clone, Serialize)]
pub struct AdminCred {
    pub id: i64,
    pub label: String,
    pub email: Option<String>,
    pub account_id: String,
    pub plan_type: Option<String>,
    /// **不序列化给前端**：列表接口不该把母号 token 回吐到浏览器。
    #[serde(skip)]
    pub access_token: String,
    pub disabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 一次退款任务。`steps_json` 是 [`crate::flow::StepResult`] 数组的 JSON，前端逐条渲染。
#[derive(Debug, Clone, Serialize)]
pub struct Job {
    pub id: i64,
    pub user_email: Option<String>,
    pub user_id: Option<String>,
    pub user_plan: Option<String>,
    pub admin_id: Option<i64>,
    pub admin_email: Option<String>,
    /// `pending` | `running` | `success` | `failed`。
    pub status: String,
    /// 步骤日志（JSON 数组字符串），前端 `JSON.parse` 后逐条展示。
    pub steps_json: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// SQLite 存储。
pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    /// 数据库文件路径。默认 `~/.refund/refund.db`；`REFUND_HOME` 可覆盖基目录（Docker 里挂卷用）。
    pub fn db_path() -> Result<PathBuf> {
        let base = match std::env::var_os("REFUND_HOME") {
            Some(dir) => PathBuf::from(dir),
            None => dirs::home_dir().context("无法确定用户主目录")?.join(".refund"),
        };
        Ok(base.join("refund.db"))
    }

    /// 在默认路径打开（或新建）库并初始化 schema。
    pub fn open_default() -> Result<Self> {
        let path = Self::db_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("无法创建目录: {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("无法打开数据库: {}", path.display()))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        init_schema(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// 内存库（仅测试）。
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        init_schema(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    // ---------- 设置 ----------

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock();
        Ok(conn
            .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
            .optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn delete_setting(&self, key: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
        Ok(())
    }

    // ---------- 管理员（母号）凭证 ----------

    /// 新增或更新一个母号。按 `account_id` 去重：同一个母号重复添加时更新那一行（换了新 token
    /// 的常见场景），而不是攒出一串各持一份旧 token 的重复行。
    pub fn upsert_admin(
        &self,
        label: &str,
        email: Option<&str>,
        account_id: &str,
        plan_type: Option<&str>,
        access_token: &str,
    ) -> Result<i64> {
        let conn = self.conn.lock();
        let now = now_secs();
        conn.execute(
            "INSERT INTO admins (label, email, account_id, plan_type, access_token, disabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?6)
             ON CONFLICT(account_id) DO UPDATE SET
                label = excluded.label,
                email = excluded.email,
                plan_type = excluded.plan_type,
                access_token = excluded.access_token,
                updated_at = excluded.updated_at",
            params![label, email, account_id, plan_type, access_token, now],
        )?;
        let id: i64 = conn.query_row(
            "SELECT id FROM admins WHERE account_id = ?1",
            params![account_id],
            |r| r.get(0),
        )?;
        Ok(id)
    }

    pub fn list_admins(&self) -> Result<Vec<AdminCred>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, label, email, account_id, plan_type, access_token, disabled, created_at, updated_at
             FROM admins ORDER BY id ASC",
        )?;
        let rows = stmt.query_map([], row_to_admin)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_admin(&self, id: i64) -> Result<Option<AdminCred>> {
        let conn = self.conn.lock();
        Ok(conn
            .query_row(
                "SELECT id, label, email, account_id, plan_type, access_token, disabled, created_at, updated_at
                 FROM admins WHERE id = ?1",
                params![id],
                row_to_admin,
            )
            .optional()?)
    }

    /// 选一个可用母号：未停用且**当前排队最少**（pending/running 任务数最少）的那个，同负载
    /// 按添加顺序取最早的。同一母号上的任务是串行跑的（见 [`crate::web`] 的按母号排队），
    /// 多个母号时把新任务分到最空闲的一个，才不会所有人都排在第一个母号后面。
    pub fn pick_active_admin(&self) -> Result<Option<AdminCred>> {
        let conn = self.conn.lock();
        Ok(conn
            .query_row(
                "SELECT a.id, a.label, a.email, a.account_id, a.plan_type, a.access_token, a.disabled,
                        a.created_at, a.updated_at
                 FROM admins a
                 WHERE a.disabled = 0
                 ORDER BY (SELECT COUNT(*) FROM jobs j
                           WHERE j.admin_id = a.id AND j.status IN ('pending', 'running')) ASC,
                          a.id ASC
                 LIMIT 1",
                [],
                row_to_admin,
            )
            .optional()?)
    }

    pub fn set_admin_disabled(&self, id: i64, disabled: bool) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE admins SET disabled = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, disabled as i64, now_secs()],
        )?;
        Ok(())
    }

    pub fn delete_admin(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM admins WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ---------- 退款任务 ----------

    /// 建一条任务，初始状态 `pending`，返回 id。
    pub fn create_job(
        &self,
        user_email: Option<&str>,
        user_id: Option<&str>,
        user_plan: Option<&str>,
        admin_id: Option<i64>,
        admin_email: Option<&str>,
    ) -> Result<i64> {
        let conn = self.conn.lock();
        let now = now_secs();
        conn.execute(
            "INSERT INTO jobs (user_email, user_id, user_plan, admin_id, admin_email, status, steps_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'pending', '[]', ?6, ?6)",
            params![user_email, user_id, user_plan, admin_id, admin_email, now],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// 更新任务的状态与步骤日志。
    pub fn update_job(&self, id: i64, status: &str, steps_json: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE jobs SET status = ?2, steps_json = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, status, steps_json, now_secs()],
        )?;
        Ok(())
    }

    /// 同一用户是否已有未完成（pending/running）的任务。用户重复点提交、或开两个标签页各交
    /// 一次，不该在同一母号上排两趟一样的流程——第二趟必然撞上「已在团队」或「已被踢出」。
    pub fn find_open_job_for_user(&self, user_id: &str) -> Result<Option<i64>> {
        let conn = self.conn.lock();
        Ok(conn
            .query_row(
                "SELECT id FROM jobs
                 WHERE user_id = ?1 AND status IN ('pending', 'running')
                 ORDER BY id ASC LIMIT 1",
                params![user_id],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// 该任务在其母号队列里前面还有几个未完成任务。任务已结束时恒为 0。前端用它显示
    /// 「排队中，前面还有 N 个」。
    pub fn queue_ahead(&self, job: &Job) -> Result<i64> {
        if job.status != "pending" && job.status != "running" {
            return Ok(0);
        }
        let conn = self.conn.lock();
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM jobs
             WHERE admin_id IS ?1 AND id < ?2 AND status IN ('pending', 'running')",
            params![job.admin_id, job.id],
            |r| r.get(0),
        )?)
    }

    /// 启动时把上次进程留下的 pending/running 任务全部判为失败。这些任务的执行体只存在于
    /// 上一个进程的内存里，重启后没有任何东西会再去推进它们；不收尾的话它们会永远显示
    /// 「执行中」，还会一直占着 [`Self::pick_active_admin`] 的负载计数。
    pub fn fail_interrupted_jobs(&self) -> Result<usize> {
        let conn = self.conn.lock();
        let note = serde_json::json!({
            "step": "interrupted",
            "ok": false,
            "status": null,
            "detail": "服务重启，任务中断；请重新提交。",
        })
        .to_string();
        let n = conn.execute(
            "UPDATE jobs
             SET status = 'failed',
                 steps_json = json_insert(steps_json, '$[#]', json(?1)),
                 updated_at = ?2
             WHERE status IN ('pending', 'running')",
            params![note, now_secs()],
        )?;
        Ok(n)
    }

    pub fn get_job(&self, id: i64) -> Result<Option<Job>> {
        let conn = self.conn.lock();
        Ok(conn
            .query_row(
                "SELECT id, user_email, user_id, user_plan, admin_id, admin_email, status, steps_json, created_at, updated_at
                 FROM jobs WHERE id = ?1",
                params![id],
                row_to_job,
            )
            .optional()?)
    }

    /// 最近的若干条任务，倒序。
    pub fn list_jobs(&self, limit: i64) -> Result<Vec<Job>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, user_email, user_id, user_plan, admin_id, admin_email, status, steps_json, created_at, updated_at
             FROM jobs ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], row_to_job)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

fn row_to_admin(r: &Row) -> rusqlite::Result<AdminCred> {
    Ok(AdminCred {
        id: r.get(0)?,
        label: r.get(1)?,
        email: r.get(2)?,
        account_id: r.get(3)?,
        plan_type: r.get(4)?,
        access_token: r.get(5)?,
        disabled: r.get::<_, i64>(6)? != 0,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
    })
}

fn row_to_job(r: &Row) -> rusqlite::Result<Job> {
    Ok(Job {
        id: r.get(0)?,
        user_email: r.get(1)?,
        user_id: r.get(2)?,
        user_plan: r.get(3)?,
        admin_id: r.get(4)?,
        admin_email: r.get(5)?,
        status: r.get(6)?,
        steps_json: r.get(7)?,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
    })
}

/// 建表 / 迁移。每次启动都跑，幂等。
fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS admins (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            label        TEXT    NOT NULL DEFAULT '',
            email        TEXT,
            -- 团队 id，四条路径里三条要拼它；也是去重键。
            account_id   TEXT    NOT NULL,
            plan_type    TEXT,
            access_token TEXT    NOT NULL,
            disabled     INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)),
            created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
        ) STRICT;

        -- 同一个母号只存一行，重复添加走 upsert 更新。
        CREATE UNIQUE INDEX IF NOT EXISTS uq_admins_account_id ON admins(account_id);

        CREATE TABLE IF NOT EXISTS jobs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_email  TEXT,
            user_id     TEXT,
            user_plan   TEXT,
            admin_id    INTEGER,
            admin_email TEXT,
            status      TEXT    NOT NULL DEFAULT 'pending',
            steps_json  TEXT    NOT NULL DEFAULT '[]',
            created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);",
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_upsert_dedupes_by_account_id() {
        let s = Store::open_in_memory().unwrap();
        let id1 = s.upsert_admin("t1", Some("a@b.com"), "acct-1", Some("team"), "tok1").unwrap();
        let id2 =
            s.upsert_admin("t1-new", Some("a@b.com"), "acct-1", Some("team"), "tok2").unwrap();
        assert_eq!(id1, id2, "同一个 account_id 应更新同一行");
        let admins = s.list_admins().unwrap();
        assert_eq!(admins.len(), 1);
        assert_eq!(admins[0].access_token, "tok2");
    }

    #[test]
    fn pick_active_skips_disabled() {
        let s = Store::open_in_memory().unwrap();
        let id = s.upsert_admin("t", None, "acct-1", None, "tok").unwrap();
        assert!(s.pick_active_admin().unwrap().is_some());
        s.set_admin_disabled(id, true).unwrap();
        assert!(s.pick_active_admin().unwrap().is_none());
    }

    #[test]
    fn pick_active_prefers_least_loaded() {
        let s = Store::open_in_memory().unwrap();
        let a1 = s.upsert_admin("a1", None, "acct-1", None, "tok").unwrap();
        let a2 = s.upsert_admin("a2", None, "acct-2", None, "tok").unwrap();
        // 空载时按添加顺序。
        assert_eq!(s.pick_active_admin().unwrap().unwrap().id, a1);
        // a1 上排了一个未完成任务 → 该选 a2。
        s.create_job(None, Some("u1"), None, Some(a1), None).unwrap();
        assert_eq!(s.pick_active_admin().unwrap().unwrap().id, a2);
        // 两边各一个 → 回到添加顺序。
        s.create_job(None, Some("u2"), None, Some(a2), None).unwrap();
        assert_eq!(s.pick_active_admin().unwrap().unwrap().id, a1);
        // 完成的任务不计负载。
        let j3 = s.create_job(None, Some("u3"), None, Some(a1), None).unwrap();
        assert_eq!(s.pick_active_admin().unwrap().unwrap().id, a2);
        s.update_job(j3, "success", "[]").unwrap();
        assert_eq!(s.pick_active_admin().unwrap().unwrap().id, a1);
    }

    #[test]
    fn queue_ahead_and_dedupe() {
        let s = Store::open_in_memory().unwrap();
        let j1 = s.create_job(None, Some("u1"), None, Some(1), None).unwrap();
        let j2 = s.create_job(None, Some("u2"), None, Some(1), None).unwrap();
        let j3 = s.create_job(None, Some("u3"), None, Some(2), None).unwrap();
        let get = |id| s.get_job(id).unwrap().unwrap();
        assert_eq!(s.queue_ahead(&get(j1)).unwrap(), 0);
        assert_eq!(s.queue_ahead(&get(j2)).unwrap(), 1, "同母号前面有 j1");
        assert_eq!(s.queue_ahead(&get(j3)).unwrap(), 0, "不同母号互不排队");
        s.update_job(j1, "success", "[]").unwrap();
        assert_eq!(s.queue_ahead(&get(j2)).unwrap(), 0);
        assert_eq!(s.find_open_job_for_user("u2").unwrap(), Some(j2));
        assert_eq!(s.find_open_job_for_user("u1").unwrap(), None, "已完成的不算");
    }

    #[test]
    fn interrupted_jobs_fail_on_restart() {
        let s = Store::open_in_memory().unwrap();
        let j1 = s.create_job(None, Some("u1"), None, Some(1), None).unwrap();
        let j2 = s.create_job(None, Some("u2"), None, Some(1), None).unwrap();
        s.update_job(j1, "running", r#"[{"step":"invite","ok":true,"status":200,"detail":"x"}]"#)
            .unwrap();
        let j3 = s.create_job(None, Some("u3"), None, Some(1), None).unwrap();
        s.update_job(j3, "success", "[]").unwrap();
        assert_eq!(s.fail_interrupted_jobs().unwrap(), 2);
        let j1 = s.get_job(j1).unwrap().unwrap();
        assert_eq!(j1.status, "failed");
        let steps: Vec<serde_json::Value> = serde_json::from_str(&j1.steps_json).unwrap();
        assert_eq!(steps.len(), 2, "原有步骤保留，末尾追加中断说明");
        assert_eq!(steps[1]["step"], "interrupted");
        assert_eq!(s.get_job(j2).unwrap().unwrap().status, "failed");
        assert_eq!(s.get_job(j3).unwrap().unwrap().status, "success");
    }

    #[test]
    fn job_lifecycle() {
        let s = Store::open_in_memory().unwrap();
        let id = s
            .create_job(Some("u@b.com"), Some("user-1"), Some("plus"), Some(1), Some("a@b.com"))
            .unwrap();
        s.update_job(id, "running", "[]").unwrap();
        s.update_job(id, "success", r#"[{"step":"kick","ok":true}]"#).unwrap();
        let job = s.get_job(id).unwrap().unwrap();
        assert_eq!(job.status, "success");
        assert_eq!(s.list_jobs(10).unwrap().len(), 1);
    }
}
