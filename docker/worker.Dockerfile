# syntax=docker/dockerfile:1
# e2e-platform Worker 镜像
# 基础镜像 = 官方 Playwright 镜像（浏览器与系统依赖版本与 @playwright/test 严格一致），
# 在其上安装中文字体（避免网页中文渲染为乱码/方块），全部安装走中国源。
# 注意：基础镜像 tag 必须与 apps/worker/package.json 中 @playwright/test 版本一致。
# （v1.59.0 仅提供 jammy 变体；noble 变体并非每个版本都有，可用 PLAYWRIGHT_IMAGE 覆盖）
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.59.0-jammy
ARG NODE_IMAGE=node:22-bookworm-slim
# 可选镜像源配置（默认走官方上游源；中国镜像可通过 build-arg 覆盖：mirrors.aliyun.com / mirrors.tuna.tsinghua.edu.cn 等）
ARG APT_MIRROR=""
ARG NPM_REGISTRY=https://registry.npmjs.org

# ---------- builder：构建 worker 及其 workspace 依赖 ----------
FROM ${NODE_IMAGE} AS builder
ARG APT_MIRROR
ARG NPM_REGISTRY

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

# 注：lockfile 在上层 COPY，依赖不变时本层走缓存；不用 RUN --mount 缓存（需 BuildKit/buildx，部分部署主机没有）
RUN pnpm install --frozen-lockfile \
    && pnpm --filter @tern/worker^... run build \
    && pnpm --filter @tern/worker run build \
    && pnpm --filter @tern/worker deploy --prod --legacy /out

# ---------- runtime：Playwright 官方镜像 + 中文字体 ----------
FROM ${PLAYWRIGHT_IMAGE}
ARG APT_MIRROR=""
ARG NPM_REGISTRY=https://registry.npmjs.org

USER root
# 安装常见字体（重点：中文字体，防止页面中文乱码/方块）：
#   fonts-noto-cjk        Noto Sans/Serif CJK（简繁日韩全量覆盖，首选）
#   fonts-noto-cjk-extra  Noto CJK 加粗等扩展字重
#   fonts-wqy-microhei / fonts-wqy-zenhei  文泉驿微米黑/正黑（常见站点回退）
#   fonts-droid-fallback  Droid Sans Fallback（老页面回退）
#   fonts-noto-color-emoji 彩色 emoji
RUN set -eux; \
    if [ -n "${APT_MIRROR}" ]; then \
      if [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then \
        sed -i "s|http://archive.ubuntu.com/ubuntu/|http://${APT_MIRROR}/ubuntu/|g; s|http://security.ubuntu.com/ubuntu/|http://${APT_MIRROR}/ubuntu/|g; s|https://archive.ubuntu.com/ubuntu/|http://${APT_MIRROR}/ubuntu/|g; s|https://security.ubuntu.com/ubuntu/|http://${APT_MIRROR}/ubuntu/|g" /etc/apt/sources.list.d/ubuntu.sources; \
      fi; \
      if [ -f /etc/apt/sources.list ]; then \
        sed -i "s|archive.ubuntu.com|${APT_MIRROR}|g; s|security.ubuntu.com|${APT_MIRROR}|g" /etc/apt/sources.list; \
      fi; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      fonts-noto-cjk \
      fonts-noto-cjk-extra \
      fonts-wqy-microhei \
      fonts-wqy-zenhei \
      fonts-droid-fallback \
      fonts-noto-color-emoji \
      fontconfig \
      tini; \
    rm -rf /var/lib/apt/lists/*; \
    fc-cache -f

# 构建期自检：确认中文字体已就位（数量 > 0）
RUN echo "zh fonts: $(fc-list :lang=zh | wc -l)" && test "$(fc-list :lang=zh | wc -l)" -gt 10

# npm 换中国源；浏览器若需补装走 npmmirror 的 playwright 镜像仓库
RUN npm config set registry "${NPM_REGISTRY}"
ENV PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright \
    NODE_ENV=production \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    RUNS_DIR=/data/runs

WORKDIR /app
COPY --from=builder /out /app

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
