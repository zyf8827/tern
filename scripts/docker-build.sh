#!/usr/bin/env bash
# 构建 e2e-platform Docker 镜像（server + worker），默认走中国源
set -euo pipefail
cd "$(dirname "$0")/.."

# 读取 .env（存在时）
if [ -f .env ]; then
  set -a; source .env; set +a
fi

APT_MIRROR="${APT_MIRROR:-}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
PLAYWRIGHT_IMAGE="${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.59.0-jammy}"
SERVER_IMAGE="${SERVER_IMAGE:-tern-server:latest}"
WORKER_IMAGE="${WORKER_IMAGE:-tern-worker:latest}"

# 校验 playwright 版本与 worker 依赖一致（防止浏览器/驱动版本漂移）
DEP_VERSION=$(node -e "console.log(require('./apps/worker/package.json').dependencies['@playwright/test'])")
BASE_VERSION=$(echo "$PLAYWRIGHT_IMAGE" | grep -o 'v[0-9.]*' | head -1 | sed 's/^v//')
if [ "$DEP_VERSION" != "$BASE_VERSION" ]; then
  echo "错误: PLAYWRIGHT_IMAGE($BASE_VERSION) 与 apps/worker 的 @playwright/test($DEP_VERSION) 不一致" >&2
  exit 1
fi

echo "== 构建 server 镜像: ${SERVER_IMAGE} =="
docker build \
  --build-arg "APT_MIRROR=${APT_MIRROR}" \
  --build-arg "NPM_REGISTRY=${NPM_REGISTRY}" \
  -f docker/server.Dockerfile \
  -t "${SERVER_IMAGE}" .

echo "== 构建 worker 镜像: ${WORKER_IMAGE}（含中文字体） =="
docker build \
  --build-arg "PLAYWRIGHT_IMAGE=${PLAYWRIGHT_IMAGE}" \
  --build-arg "APT_MIRROR=${APT_MIRROR}" \
  --build-arg "NPM_REGISTRY=${NPM_REGISTRY}" \
  -f docker/worker.Dockerfile \
  -t "${WORKER_IMAGE}" .

echo "== 完成 =="
echo "启动: docker compose up -d   # 若尚未生成实例配置，先运行: bash scripts/init-compose.sh"
