# CLAUDE.md

给未来的 Claude / 贡献者：这个仓库怎么搭、改哪里、注意什么。

## 是什么

`refund` 把 `pro20x.py`（ChatGPT Team 去除个人空间的四步手动脚本）做成常驻网页服务。
终端用户在网页提交自己的 `access_token`（user AT），管理员配置母号 `access_token`（admin AT），
后端按「邀请 → 接受邀请 → 去个人空间 → 踢出」跑完流程，PRO20X 账号加入空间后上游自动退款。

架构照抄同目录 `luban` / `coban` 的约定：axum 后端 + rust-embed 内嵌前端 + SQLite；
前端 React 19 + Vite + Tailwind v4；代码里用中文文档注释解释「为什么」。

## 后端（`src/`）

- `main.rs`：CLI（clap）、日志、启动。子命令 `admins` / `clear-admins`。
- `config.rs`：上游端点与请求头常量，取自 pro20x.py。改上游路径/头/TOS 版本看这里。
- `jwt.rs`：从 AT 解出 account_id / user_id / email（不验签，只校验签发方）。
- `flow.rs`：四步流程本体（`invite` / `accept` / `transfer` / `kick`，外加 `check` 兜底）。
  每步一条 `StepResult` 存进任务日志。步骤间的等待秒数对齐脚本。
- `store.rs`：SQLite。表：`settings`（管理密码哈希）、`admins`（母号，按 account_id 去重）、
  `jobs`（任务，`steps_json` 存步骤数组）。
- `auth.rs`：管理密码鉴权（sha256 存库或 `REFUND_ADMIN_PASSWORD` 环境接管）。
- `web.rs`：路由与 handler。公开区（鉴权状态、用户提交/查任务、服务就绪）+ 管理区
  （`/api/admin/*`，走 `require_admin`）+ SPA 兜底。
- `admin_ui.rs`：rust-embed 提供 `admin-ui/dist`。

**同一母号串行**：`web.rs` 里每个 `admin_id` 一把 `tokio::sync::Mutex`（FIFO），任务拿到锁才从
`pending` 变 `running`；不同母号并行。`pick_active_admin` 选排队最少的母号；同一用户已有未完成
任务时提交直接复用；启动时 `fail_interrupted_jobs` 把上次遗留的 pending/running 判为失败。
`/api/refund/jobs/:id` 额外返回 `queue_ahead`（同母号前面还有几个），用户页据此显示排队。

**批量提交**：`POST /api/refund/submit-batch` 接 `user_ats` 数组（上限 `MAX_BATCH`=50），逐条走
与单条同一个 `enqueue_refund`，返回按位置对应的 `{index, job_id | error}`，一条无效不影响其余。
`GET /api/refund/jobs?ids=1,2,3` 一次查一批（查不到的略过）。用户页输入框里扫到多个 JWT
（`lib/jwt.ts` 的 `splitTokens`）就自动切批量模式：本地预检（格式/签发方/过期/缺邮箱）没过的
行不发后端，直接标失败原因；整批进度记在 localStorage `refund_batch`，与单条的 `refund_job_id` 互斥。

**用户 token 不落库**：`enqueue_refund` 只把它在内存里传给后台任务，跑完即弃。库里只留
任务的步骤日志与用户邮箱/id。母号 token 明文存库（要用来发请求），按敏感文件对待。

## 前端（`admin-ui/src/`）

- `App.tsx`：极简 hash 路由。`#/admin` → 管理页（登录门控）；其余 → 用户提交页。
- `components/user-page.tsx`：公开提交页，提交后轮询任务、用 `step-list` 展示进度。
- `components/admin-page.tsx`：母号增删改 + 任务历史。
- `components/login-page.tsx`：首次设置密码 / 登录，样式对齐 coban。
- `components/app-header.tsx`：两页共用的顶栏。
- `components/ui/`：自带的最小 UI 原语（Button/Card/Input/Badge），不引 shadcn/base-ui。
  视觉按 Cloudflare 控制台的风格：浅灰底、白卡片 1px 实线边框小圆角、卡片分「标题区 / 内容 /
  页脚（操作按钮右对齐）」、主按钮 Cloudflare 蓝、品牌橙只用于标识与侧栏当前项指示条、列表用
  表格（`.data-table`）。令牌全在 `index.css`，改配色只动那里。
- `api/`：axios 封装。`client.ts` 自动带管理密码、401 回登录。

## 开发

```bash
cargo run                 # 后端 :4800
cd admin-ui && pnpm dev   # 前端热更新，/api 代理到 4800
cargo test                # 后端单测（jwt/store/admin_ui）
cd admin-ui && pnpm build # 产物进 dist，被 rust-embed 编进二进制
```

改前端后要 `pnpm build` 再 `cargo build`，二进制里才是新前端。

## 约定

- 端口默认 4800（luban/coban 用 4700）。
- 数据库默认 `~/.refund/refund.db`，`REFUND_HOME` 可覆盖。
- 目标目录可能是全局的 `~/.cargo/target`（本机 cargo 配置），二进制在那儿。
