#!/usr/bin/env bash
#
# refund 一键安装脚本（Docker 版），照抄同目录 luban 的 install.sh。
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/easayliu/refund/main/install.sh | bash
#   bash install.sh
#
# 环境变量：
#   INSTALL_DIR            安装目录，默认 ~/refund
#   IMAGE_OWNER            镜像 owner，默认 easayliu
#   IMAGE_TAG              镜像 tag，默认 latest（由 v* tag 触发的 CI 构建产出）
#   IMAGE_REG              镜像 registry，默认 ghcr.io；国内可用 ghcr.nju.edu.cn
#   PORT                   宿主机监听端口，默认 4800
#   REFUND_ADMIN_PASSWORD  管理页密码，默认留空（首次打开管理页时在网页上设置）
#   AUTO_START             安装后是否立即启动，默认 yes
#

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/refund}"
IMAGE_OWNER="${IMAGE_OWNER:-easayliu}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
IMAGE_REG="${IMAGE_REG:-ghcr.io}"
PORT="${PORT:-4800}"
REFUND_ADMIN_PASSWORD="${REFUND_ADMIN_PASSWORD:-}"
AUTO_START="${AUTO_START:-yes}"

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'; BOLD=$'\033[1m'; RESET=$'\033[0m'

info()  { printf '%s[info]%s %s\n'  "$BLUE"   "$RESET" "$*"; }
warn()  { printf '%s[warn]%s %s\n'  "$YELLOW" "$RESET" "$*"; }
error() { printf '%s[error]%s %s\n' "$RED"    "$RESET" "$*" >&2; }
ok()    { printf '%s[ok]%s %s\n'    "$GREEN"  "$RESET" "$*"; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { error "缺少依赖：$1，请先安装"; exit 1; }
}

detect_compose() {
  if docker compose version >/dev/null 2>&1; then
    echo "docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    echo "docker-compose"
  else
    error "未检测到 docker compose / docker-compose"
    exit 1
  fi
}

main() {
  require_cmd docker
  local COMPOSE
  COMPOSE="$(detect_compose)"
  ok "docker 就绪；compose 命令：$COMPOSE"

  mkdir -p "$INSTALL_DIR/config"
  info "安装目录：$INSTALL_DIR"

  # ---------- docker-compose.yml ----------
  # 密码不直接写进 compose，而是放 .env 让 compose 读取：compose 文件可能被随手分享，.env 不会。
  local COMPOSE_PATH="$INSTALL_DIR/docker-compose.yml"
  cat > "$COMPOSE_PATH" <<EOF2
services:
  refund:
    image: ${IMAGE_REG}/${IMAGE_OWNER}/refund:${IMAGE_TAG}
    container_name: refund
    init: true
    ports:
      - "${PORT}:4800"
    environment:
      # 设置后管理页需登录且网页不可改；留空则首次打开管理页时在网页上设置密码。
      - REFUND_ADMIN_PASSWORD=\${REFUND_ADMIN_PASSWORD:-}
    volumes:
      - ./config/:/app/config/
    restart: unless-stopped
EOF2
  ok "已写入 $COMPOSE_PATH"

  local ENV_PATH="$INSTALL_DIR/.env"
  if [[ -n "$REFUND_ADMIN_PASSWORD" ]]; then
    ( umask 077; printf 'REFUND_ADMIN_PASSWORD=%s\n' "$REFUND_ADMIN_PASSWORD" > "$ENV_PATH" )
    ok "已写入 ${ENV_PATH}（管理密码，权限 600）"
  elif [[ ! -f "$ENV_PATH" ]]; then
    : > "$ENV_PATH"
  fi

  if [[ "$AUTO_START" != "yes" ]]; then
    info "AUTO_START=no，跳过启动"
    print_summary
    return
  fi

  (
    cd "$INSTALL_DIR"
    info "拉取镜像 ${IMAGE_REG}/${IMAGE_OWNER}/refund:${IMAGE_TAG} ..."
    $COMPOSE pull
    info "启动容器 ..."
    $COMPOSE up -d
  )

  ok "启动完成"
  print_summary
}

print_summary() {
  cat <<EOF2

${BOLD}${GREEN}✓ refund 安装完成${RESET}

  目录:      ${INSTALL_DIR}
  用户页:    http://127.0.0.1:${PORT}/
  管理页:    http://127.0.0.1:${PORT}/#/admin

后续步骤（浏览器打开管理页）:
  1. 首次进入设置管理密码（若已通过 REFUND_ADMIN_PASSWORD 指定则直接登录）
  2. 「母号」里粘贴团队管理员的 access_token（或整段 chatgpt.com/api/auth/session JSON）
  3. 把用户页链接发给需要去除个人空间的用户

常用命令（在 ${INSTALL_DIR} 目录下执行）:
  查看日志   ${BOLD}docker compose logs -f${RESET}
  停止       ${BOLD}docker compose down${RESET}
  升级       ${BOLD}docker compose pull && docker compose up -d${RESET}

  数据库持久化在 ${INSTALL_DIR}/config/（含母号明文 token，按敏感文件对待，重启不丢）。
  远程服务器部署：本机 ${BOLD}ssh -L ${PORT}:127.0.0.1:${PORT} <user>@<server>${RESET} 后访问上面的网页。

EOF2
}

main "$@"
