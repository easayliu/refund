# ---------- 前端构建 ----------
FROM node:22-alpine AS frontend
WORKDIR /app/admin-ui
COPY admin-ui/package.json admin-ui/pnpm-lock.yaml ./
RUN npm install -g pnpm@10 && pnpm install --frozen-lockfile
# vite.config.ts 从 Cargo.toml 读版本号注入页脚，故这一阶段先把 Cargo.toml 拷进来（放在
# COPY admin-ui 之前：它变得比前端源码少，这一层能一直命中缓存）。
COPY Cargo.toml /app/Cargo.toml
COPY admin-ui ./
RUN pnpm build

# ---------- Rust 构建 ----------
FROM rust:1-slim-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
      pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# 依赖预编译层：只拷清单、空 main 先把依赖编出来，改业务代码不失效。
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs \
    && cargo build --release \
    && rm -rf src

# 真实构建。rust-embed 编译期读 admin-ui/dist（相对 crate 根）。
COPY src ./src
COPY --from=frontend /app/admin-ui/dist ./admin-ui/dist
RUN rm -f target/release/refund target/release/deps/refund-* \
    && cargo build --release

# ---------- 运行时 ----------
FROM debian:bookworm-slim
# libssl3：openssl-sys 动态链接系统 OpenSSL，运行时需要它；ca-certificates 提供根证书。
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/refund /usr/local/bin/refund

# 数据持久化目录（挂载卷）。
ENV REFUND_HOME=/app/config
VOLUME ["/app/config"]

EXPOSE 4800
CMD ["refund", "--host", "0.0.0.0", "--port", "4800"]
