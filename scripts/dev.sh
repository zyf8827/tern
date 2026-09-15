#!/usr/bin/env bash
# Tern 开发调试管理脚本 —— 不走 Docker，直接在宿主机管理 server(管理端) 与 worker 进程。
# 依赖安装步骤与 docker/*.Dockerfile 保持一致（pnpm@10.30.2 + npmmirror 源 +
# better-sqlite3 编译工具链 + Playwright Chromium + 中文字体），只是不做 apt 换源。
#
# 用法:
#   scripts/dev.sh deps                安装/校验依赖（与镜像构建一致，幂等，可重复执行）
#   scripts/dev.sh up [N]              启动 server + N 个 worker（默认 1；WORKER_MAX_SLOTS 覆盖并发槽）
#   scripts/dev.sh down                停止 server 与全部 worker
#   scripts/dev.sh restart [N]         down + up
#   scripts/dev.sh status              进程状态 + 平台健康（/api/v1/meta 与 worker 心跳）
#   scripts/dev.sh logs [目标] [-f]    跟踪日志：server / worker-N（缺省 server）
#   scripts/dev.sh webdev              前台启动 Web vite dev（5173，/api、/ws 代理到 server）
#
# 环境变量（与 docker-compose.yml 同名同义）: PORT HOST DATA_DIR REPOS_DIR WORKER_TOKEN
# PULL_INTERVAL_SEC LOG_LEVEL WORKER_MAX_SLOTS NPM_REGISTRY PLAYWRIGHT_DOWNLOAD_HOST SYNC_WATCH
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RUN_DIR="$ROOT/.runs/dev"            # pid/日志（.runs/ 已 gitignore）
DATA_DIR="${DATA_DIR:-$ROOT/data}"
REPOS_DIR="${REPOS_DIR:-$ROOT/repos}"
TOKEN_FILE="$DATA_DIR/.worker-token"
PORT="${PORT:-7430}"
HOST="${HOST:-0.0.0.0}"
SERVER_URL="http://127.0.0.1:${PORT}"
LOG_LEVEL="${LOG_LEVEL:-info}"
PNPM_VERSION="$(node -p "require('./package.json').packageManager.split('@')[1]")"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST:-}"

C_G='\033[32m'; C_Y='\033[33m'; C_R='\033[31m'; C_D='\033[2m'; C_0='\033[0m'
info() { printf "${C_G}[dev]${C_0} %s\n" "$*"; }
warn() { printf "${C_Y}[dev]${C_0} %s\n" "$*"; }
die()  { printf "${C_R}[dev]${C_0} %s\n" "$*" >&2; exit 1; }

mkdir -p "$RUN_DIR"

# ---------- 进程管理原语（setsid 让每组进程独立成组，停的时候整组带走） ----------
pgid_of() { local pid; pid="$(cat "$1" 2>/dev/null || true)"; [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo "$pid"; }

start_bg() { # start_bg <名字> <env...> -- <cmd...>
  local name="$1"; shift; local envs=();
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  ( cd "$ROOT" && exec env "${envs[@]}" setsid "$@" ) >"$RUN_DIR/$name.log" 2>&1 &
  echo $! > "$RUN_DIR/$name.pid"
}

stop_pidfile() { # stop_pidfile <pidfile>
  local pid; pid="$(pgid_of "$1")" || return 0
  [ -z "$pid" ] && { rm -f "$1"; return 0; }
  local grp; grp="$(ps -o pgid= -p "$pid" | tr -d ' ')"
  kill -TERM "-- -$grp" "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  if kill -0 "$pid" 2>/dev/null; then warn "$(basename "$1") 5s 未退出，强制 kill"; kill -KILL "-- -$grp" "$pid" 2>/dev/null || true; fi
  rm -f "$1"
}

wait_health() { # wait_health <秒>
  for _ in $(seq 1 "$1"); do
    curl -fsS "$SERVER_URL/api/v1/meta" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

have_build() {
  [ -f apps/server/dist/index.js ] && [ -f apps/worker/dist/index.js ] && [ -f apps/server/public/index.html ]
}
need_build() { # 产物缺失时提示先 deps
  have_build || die "构建产物缺失，先执行: scripts/dev.sh deps"
}

worker_token() {
  if [ -s "$TOKEN_FILE" ]; then cat "$TOKEN_FILE"
  elif [ -n "${WORKER_TOKEN:-}" ]; then echo "$WORKER_TOKEN"
  else die "找不到 worker token（$TOKEN_FILE 不存在且未设 WORKER_TOKEN），先启动 server"; fi
}

# ---------- deps：与镜像构建对齐的依赖安装 ----------
cmd_deps() {
  info "1/6 检查 Node ≥ 20 与构建工具链（同 server.Dockerfile: python3/make/g++/git）"
  local vmajor; vmajor="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$vmajor" -ge 20 ] || die "Node $(node -v) 过旧，需要 ≥ 20（镜像内是 node:22）"
  local missing=()
  for t in python3 make g++ git; do command -v "$t" >/dev/null || missing+=("$t"); done
  if [ "${#missing[@]}" -gt 0 ]; then
    if [ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null; then
      warn "缺 ${missing[*]}，尝试 apt 安装（同镜像 builder 层）"
      sudo -n apt-get update -qq && sudo -n apt-get install -y -qq --no-install-recommends "${missing[@]}" ca-certificates
    else
      die "缺 ${missing[*]}（better-sqlite3 编译 / server clone 用例仓库必需）。请手动: sudo apt-get install -y python3 make g++ git ca-certificates"
    fi
  fi

  info "2/6 启用 corepack 并固定 pnpm@$PNPM_VERSION（同 Dockerfile；npmmirror 拉取）"
  corepack enable >/dev/null 2>&1 || warn "corepack enable 失败（可能已有全局 pnpm，继续）"
  if COREPACK_NPM_REGISTRY="$NPM_REGISTRY" corepack prepare "pnpm@$PNPM_VERSION" --activate >/dev/null 2>&1 \
     || COREPACK_NPM_REGISTRY="$NPM_REGISTRY" corepack pnpm --version >/dev/null 2>&1; then
    export COREPACK_NPM_REGISTRY="$NPM_REGISTRY"
    PNPM=(corepack pnpm)
  elif command -v pnpm >/dev/null 2>&1 && [ "$(pnpm --version)" = "$PNPM_VERSION" ]; then
    PNPM=(pnpm); warn "corepack 不可用（网络受限），使用现有 pnpm $PNPM_VERSION"
  else
    die "无法获得 pnpm@$PNPM_VERSION：corepack 拉取失败且无匹配的全局 pnpm（可设 NPM_REGISTRY 为可达镜像后重试）"
  fi

  info "3/6 pnpm install --frozen-lockfile（registry=$NPM_REGISTRY，与镜像一致；只作用于本次命令）"
  npm_config_registry="$NPM_REGISTRY" "${PNPM[@]}" install --frozen-lockfile

  info "4/6 pnpm -r build（全量构建，含 web 管理端静态资源 → apps/server/public）"
  if ! "${PNPM[@]}" -r build; then
    if have_build; then
      warn "全量构建失败（源码当前有类型错误？），但已存在可用的构建产物，沿用旧产物继续"
    else
      die "全量构建失败且无既有产物，请先修复上面的编译错误"
    fi
  fi

  info "5/6 Playwright Chromium（版本对齐 @playwright/test@$(node -p "require('./apps/worker/package.json').dependencies['@playwright/test']")，下载源=$PLAYWRIGHT_DOWNLOAD_HOST）"
  ( cd apps/worker && PLAYWRIGHT_DOWNLOAD_HOST="$PLAYWRIGHT_DOWNLOAD_HOST" npx playwright install chromium )
  if [ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null; then
    ( cd apps/worker && sudo -n -E env "PATH=$PATH" npx playwright install-deps chromium >/dev/null 2>&1 ) \
      || warn "系统依赖安装跳过（playwright install-deps）；用例报缺 .so 时手动: cd apps/worker && sudo npx playwright install-deps chromium"
  else
    warn "无免密 sudo，跳过系统依赖安装；用例报缺 .so 时手动: cd apps/worker && sudo npx playwright install-deps chromium"
  fi

  info "6/6 中文字体（同 worker.Dockerfile，防页面中文乱码）"
  local zh; zh="$(fc-list :lang=zh 2>/dev/null | wc -l)"
  if [ "${zh:-0}" -gt 10 ]; then
    info "已有 $zh 个中文字体，跳过"
  elif [ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null; then
    warn "缺中文字体，尝试安装 fonts-noto-cjk / fonts-wqy-microhei"
    sudo -n apt-get install -y -qq --no-install-recommends fonts-noto-cjk fonts-wqy-microhei fontconfig && fc-cache -f
  else
    warn "缺中文字体（页面中文可能乱码）。手动: sudo apt-get install -y fonts-noto-cjk fonts-wqy-microhei fontconfig"
  fi

  info "依赖就绪。启动: scripts/dev.sh up [worker数]"
}

# ---------- server / worker ----------
start_server() {
  if pgid_of "$RUN_DIR/server.pid" >/dev/null; then info "server 已在运行（pid $(cat "$RUN_DIR/server.pid")）"; return 0; fi
  need_build
  command -v curl >/dev/null || die "需要 curl 做健康检查"
  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then exec 3>&- 3<&- || true; die "端口 $PORT 已被其他进程占用（可用 PORT=xxxx 换端口）"; fi
  info "启动 server: $SERVER_URL （管理端由 server 托管）"
  start_bg server \
    PORT="$PORT" HOST="$HOST" DATA_DIR="$DATA_DIR" REPOS_DIR="$REPOS_DIR" \
    SYNC_WATCH="${SYNC_WATCH:-true}" PULL_INTERVAL_SEC="${PULL_INTERVAL_SEC:-300}" \
    LOG_LEVEL="$LOG_LEVEL" ${WORKER_TOKEN:+WORKER_TOKEN="$WORKER_TOKEN"} \
    -- node apps/server/dist/index.js
  if wait_health 30; then
    info "server 健康（$SERVER_URL）；WORKER_TOKEN: ${TOKEN_FILE#"$ROOT"/}"
  else
    die "server 30s 未就绪，看日志: scripts/dev.sh logs server"
  fi
}

start_workers() { # start_workers <N>
  local n="${1:-1}" token; token="$(worker_token)"
  local slots="${WORKER_MAX_SLOTS:-1}"
  for i in $(seq 1 "$n"); do
    if pgid_of "$RUN_DIR/worker-$i.pid" >/dev/null; then info "worker-$i 已在运行"; continue; fi
    info "启动 worker-$i（MAX_SLOTS=$slots）"
    start_bg "worker-$i" \
      SERVER_URL="$SERVER_URL" WORKER_TOKEN="$token" WORKER_NAME="dev-w$i" \
      MAX_SLOTS="$slots" LOG_LEVEL="$LOG_LEVEL" \
      -- node apps/worker/dist/index.js
  done
  echo "$n" > "$RUN_DIR/workers.count"
}

cmd_up() {
  start_server
  start_workers "${1:-$(cat "$RUN_DIR/workers.count" 2>/dev/null || echo 1)}"
  cmd_status
}

cmd_down() {
  local stopped=0
  for f in "$RUN_DIR"/worker-*.pid; do [ -e "$f" ] || continue; stop_pidfile "$f"; stopped=1; done
  if [ -e "$RUN_DIR/server.pid" ]; then stop_pidfile "$RUN_DIR/server.pid"; stopped=1; fi
  [ "$stopped" = 1 ] && info "已停止" || info "没有在运行的进程"
}

cmd_status() {
  local pid ok=0
  printf "${C_D}%-14s %-8s %s${C_0}\n" "进程" "状态" "pid"
  for name in server worker-1 worker-2 worker-3 worker-4; do
    local f="$RUN_DIR/$name.pid"; [ -e "$f" ] || continue
    if pid="$(pgid_of "$f")"; then printf "%-14s ${C_G}%-8s${C_0} %s\n" "$name" running "$pid"; [ "$name" = server ] && ok=1
    else printf "%-14s ${C_R}%-8s${C_0} %s\n" "$name" dead "-"; fi
  done
  [ -e "$RUN_DIR/server.pid" ] || printf "${C_D}server 未启动${C_0}\n"
  if [ "$ok" = 1 ]; then
    echo
    curl -fsS "$SERVER_URL/api/v1/meta" 2>/dev/null | head -c 200; echo
    curl -fsS "$SERVER_URL/api/v1/workers" 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const w=JSON.parse(d).items??JSON.parse(d);for(const x of w)console.log(\`worker: \${x.name}  \${x.status}  slots \${x.activeSlots??'-'}/\${x.maxSlots??'-'}\`)}catch{console.log('(workers 解析失败)')}})" 2>/dev/null || true
  fi
}

cmd_logs() {
  local target="${1:-server}"
  case "$target" in
    server) tail ${2:+-$2} -n 200 "$RUN_DIR/server.log" 2>/dev/null || die "还没有 server 日志";;
    all) tail -n 200 -F "$RUN_DIR"/server.log "$RUN_DIR"/worker-*.log 2>/dev/null || die "还没有日志";;
    worker-*) tail ${2:+-$2} -n 200 -F "$RUN_DIR/$target.log" 2>/dev/null || die "还没有 $target 日志";;
    *) die "logs 目标: server | worker-N | all";;
  esac
}

cmd_webdev() {
  need_build
  info "Web vite dev：http://localhost:5173（/api、/ws 代理到 $SERVER_URL）"
  ( cd apps/web && SERVER_URL="$SERVER_URL" pnpm dev )
}

case "${1:-}" in
  deps)    shift; cmd_deps "$@";;
  up)      shift; cmd_up "$@";;
  down)    cmd_down;;
  stop)    cmd_down;;
  restart) shift; cmd_down; sleep 1; cmd_up "$@";;
  status)  cmd_status;;
  logs)    shift; cmd_logs "$@";;
  webdev)  cmd_webdev;;
  *) awk 'NR>1{if($0 !~ /^#/)exit; sub(/^# ?/,""); print}' "$0"; exit 1;;
esac
