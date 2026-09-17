# refund

ChatGPT Team「去除个人空间」自动化。把 `pro20x.py` 的四步手动流程做成常驻网页服务：

1. **邀请** 用户加入团队
2. 用户 **接受邀请**
3. 用户 **去除个人空间**（账户转移）
4. 把用户 **踢出团队**

PRO20X 账号加入团队空间后上游会自动退款。架构参考同目录的 `luban` / `coban`：
Rust（axum）后端 + rust-embed 内嵌前端 + SQLite；前端 React + Vite + Tailwind v4。

## 两类角色

- **终端用户**：打开首页 `/`，粘贴自己的 `access_token`，点开始。系统用一个可用母号跑完
  四步流程，页面实时显示每一步的结果。用户 token 只用于本次流程，**不落库**。
- **管理员**：打开 `/#/admin`，配置一个或多个母号（团队管理员的 `access_token`）。用户提交时
  自动选一个未停用的母号执行。管理页可用管理密码保护。

## 本地运行

后端：

```bash
cargo run                       # 默认 0.0.0.0:4800
cargo run -- --port 4800 --open # 启动后打开浏览器
REFUND_ADMIN_PASSWORD=xxx cargo run   # 用环境变量设置管理密码
```

前端（开发时热更新，`/api` 代理到 4800）：

```bash
cd admin-ui
pnpm install
pnpm dev
```

构建正式包（前端产物会被 rust-embed 编进二进制）：

```bash
cd admin-ui && pnpm build && cd ..
cargo build --release
```

## 一键安装（Docker）

```bash
curl -fsSL https://raw.githubusercontent.com/easayliu/refund/main/install.sh | bash
```

脚本会在 `~/refund` 写好 `docker-compose.yml`，拉取 GHCR 上由 CI 发布的镜像并启动。
可用环境变量定制：`INSTALL_DIR`（安装目录）、`PORT`（默认 4800）、`IMAGE_TAG`（默认 latest）、
`IMAGE_REG`（国内可换 `ghcr.nju.edu.cn`）、`REFUND_ADMIN_PASSWORD`（管理密码，不设则首次进管理页时在网页上设）、
`AUTO_START=no`（只写配置不启动）。例如：

```bash
PORT=9000 REFUND_ADMIN_PASSWORD=yourpass bash install.sh
```

## Docker（本地构建）

```bash
REFUND_ADMIN_PASSWORD=yourpass docker compose up -d --build
# 访问 http://localhost:4800
```

数据库落在挂载卷 `./config`（含母号明文 token，按敏感文件对待）。

## 命令行

```bash
refund              # 启动网页服务
refund admins       # 列出已配置母号
refund clear-admins # 清空所有母号
```

## 数据存放

默认 `~/.refund/refund.db`；`REFUND_HOME` 可覆盖基目录（Docker 里设为 `/app/config`）。

## 安全说明

这是一个会拿真实凭证对 `chatgpt.com/backend-api` 发起邀请/转移/踢人动作的工具，仅用于对
**你自己拥有或获授权的账号** 操作。母号 token 明文存于本地 SQLite，请把库文件与部署环境
按敏感数据保护，并给管理页设置密码。
