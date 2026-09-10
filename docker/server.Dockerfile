# syntax=docker/dockerfile:1
# e2e-platform Server 镜像（多阶段：builder 全量构建 → runtime 仅运行时依赖）
ARG NODE_IMAGE=node:22-bookworm-slim
# 可选镜像源配置（默认走官方上游源；中国镜像可通过 build-arg 覆盖：mirrors.aliyun.com / mirrors.tuna.tsinghua.edu.cn 等）
ARG APT_MIRROR=""
ARG NPM_REGISTRY=https://registry.npmjs.org

# ---------- builder ----------
FROM ${NODE_IMAGE} AS builder
ARG APT_MIRROR
ARG NPM_REGISTRY

# apt 安装 better-sqlite3 编译工具链（若指定 APT_MIRROR 则配置镜像）
RUN set -eux; \
    if [ -n "${APT_MIRROR}" ]; then \
      if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
      fi; \
      if [ -f /etc/apt/sources.list ]; then \
        sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list; \
      fi; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends python3 make g++ ca-certificates; \
    rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.30.2 --activate \
    && npm config set registry "${NPM_REGISTRY}"

WORKDIR /build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

# 安装依赖（onlyBuiltDependencies 允许 better-sqlite3/esbuild 构建脚本）并全量构建（含 web 静态资源）
# 注：lockfile 在上层 COPY，依赖不变时本层走缓存；不用 RUN --mount 缓存（需 BuildKit/buildx，部分部署主机没有）
RUN pnpm install --frozen-lockfile \
    && pnpm -r build \
    && pnpm --filter @tern/server deploy --prod --legacy /out \
    && cp -r apps/server/public /out/public \
    # 自托管 Playwright trace viewer（F3）：从 workspace 内 playwright-core 提取，
    # 版本随 worker 的 @playwright/test（docker-build.sh 已校验一致）
    && TRACE_VIEWER=$(ls -d node_modules/.pnpm/playwright-core@*/node_modules/playwright-core/lib/vite/traceViewer | head -1) \
    && cp -r "$TRACE_VIEWER" /out/trace-viewer \
    # tsconfig.json 仅构建期需要：esbuild 会从用例目录向上解析它，
    # 其 extends 指向仓库根的 base 文件，运行时容器中不存在会产生无害告警
    && rm -f /out/tsconfig.json

# ---------- runtime ----------
FROM ${NODE_IMAGE}
ARG APT_MIRROR
RUN set -eux; \
    if [ -n "${APT_MIRROR}" ]; then \
      if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
      fi; \
      if [ -f /etc/apt/sources.list ]; then \
        sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list; \
      fi; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends git openssh-client ca-certificates tini; \
    rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    DATA_DIR=/data \
    REPOS_DIR=/app/repos \
    TRACE_VIEWER_DIR=/app/trace-viewer \
    PORT=7430 \
    HOST=0.0.0.0
WORKDIR /app
COPY --from=builder /out /app

VOLUME /data
EXPOSE 7430

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7430)+'/api/v1/meta').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
