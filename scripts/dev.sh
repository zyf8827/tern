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
#   scripts/dev.sh logs [目标] [-f]    跟踪日志：server / worker-N / demo-site（缺省 server）
#   scripts/dev.sh webdev              前台启动 Web vite dev（5173，/api、/ws 代理到 server）
#   scripts/dev.sh demo                快速载入内置 demo 项目（portal）与启动演示站点
#
# 环境变量（与 docker-compose.yml 同名同义）: PORT HOST DATA_DIR REPOS_DIR WORKER_TOKEN
# PULL_INTERVAL_SEC LOG_LEVEL WORKER_MAX_SLOTS NPM_REGISTRY PLAYWRIGHT_DOWNLOAD_HOST SYNC_WATCH
# DEMO_SITE_PORT API_TOKEN
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
API_TOKEN="${API_TOKEN:-}"
DEMO_SITE_PORT="${DEMO_SITE_PORT:-7501}"
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
  local node_flags=()
  node -e "if(typeof WebSocket==='undefined')process.exit(1)" 2>/dev/null || node_flags+=(--experimental-websocket)
  for i in $(seq 1 "$n"); do
    if pgid_of "$RUN_DIR/worker-$i.pid" >/dev/null; then info "worker-$i 已在运行"; continue; fi
    info "启动 worker-$i（MAX_SLOTS=$slots）"
    start_bg "worker-$i" \
      SERVER_URL="$SERVER_URL" WORKER_TOKEN="$token" WORKER_NAME="dev-w$i" \
      MAX_SLOTS="$slots" LOG_LEVEL="$LOG_LEVEL" \
      -- node "${node_flags[@]}" apps/worker/dist/index.js
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
  if [ -e "$RUN_DIR/demo-site.pid" ]; then stop_pidfile "$RUN_DIR/demo-site.pid"; stopped=1; fi
  if [ -e "$RUN_DIR/server.pid" ]; then stop_pidfile "$RUN_DIR/server.pid"; stopped=1; fi
  [ "$stopped" = 1 ] && info "已停止" || info "没有在运行的进程"
}

cmd_status() {
  local pid ok=0
  printf "${C_D}%-14s %-8s %s${C_0}\n" "进程" "状态" "pid"
  for name in server demo-site worker-1 worker-2 worker-3 worker-4; do
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
    demo-site) tail ${2:+-$2} -n 200 "$RUN_DIR/demo-site.log" 2>/dev/null || die "还没有 demo-site 日志";;
    all) tail -n 200 -F "$RUN_DIR"/server.log "$RUN_DIR"/worker-*.log "$RUN_DIR"/demo-site.log 2>/dev/null || die "还没有日志";;
    worker-*) tail ${2:+-$2} -n 200 -F "$RUN_DIR/$target.log" 2>/dev/null || die "还没有 $target 日志";;
    *) die "logs 目标: server | worker-N | demo-site | all";;
  esac
}

cmd_webdev() {
  need_build
  info "Web vite dev：http://localhost:5173（/api、/ws 代理到 $SERVER_URL）"
  ( cd apps/web && SERVER_URL="$SERVER_URL" pnpm dev )
}

cmd_demo() {
  local demo_repo="$ROOT/.runs/demo-cases-repo"
  local demo_git_url="file://${demo_repo}"
  local demo_port="${DEMO_SITE_PORT:-7501}"

  info "1/4 检查并就绪服务进程..."
  if ! wait_health 1; then
    need_build
    info "server 未就绪，自动启动 server 与 1 个 worker..."
    start_server
    start_workers 1
  elif ! pgid_of "$RUN_DIR/worker-1.pid" >/dev/null 2>&1; then
    info "worker 未运行，启动 1 个 worker..."
    start_workers 1
  fi

  info "2/4 准备本地 Git 用例种子仓库 ($demo_repo)..."
  mkdir -p "$ROOT/.runs"
  (
    unset GIT_DIR GIT_WORK_TREE
    if [ ! -d "$demo_repo/.git" ]; then
      rm -rf "$demo_repo"
      mkdir -p "$demo_repo"
      cp -R "$ROOT/tests/fixtures/demo-cases-repo/." "$demo_repo/"
      git -C "$demo_repo" init >/dev/null 2>&1
      git -C "$demo_repo" checkout -B main >/dev/null 2>&1 || git -C "$demo_repo" branch -M main >/dev/null 2>&1
      git -C "$demo_repo" config user.name "Tern Demo"
      git -C "$demo_repo" config user.email "demo@tern.local"
      git -C "$demo_repo" add -A
      git -C "$demo_repo" commit -m "demo seed" >/dev/null 2>&1
      info "种子 Git 仓库初始化完成 (分支: main)"
    else
      cp -R "$ROOT/tests/fixtures/demo-cases-repo/." "$demo_repo/"
      git -C "$demo_repo" add -A
      if ! git -C "$demo_repo" diff-index --quiet HEAD -- 2>/dev/null; then
        git -C "$demo_repo" -c user.name="Tern Demo" -c user.email="demo@tern.local" commit -m "update demo seed" >/dev/null 2>&1
        info "种子 Git 仓库已更新并提交最新 fixture"
      else
        info "种子 Git 仓库已是最新"
      fi
    fi
  )

  info "3/4 注册/同步项目 portal..."
  local auth_header=()
  [ -n "${API_TOKEN:-}" ] && auth_header+=(-H "Authorization: Bearer $API_TOKEN")

  local portal_id
  portal_id="$(curl -fsS "${auth_header[@]}" "$SERVER_URL/api/v1/projects" 2>/dev/null | node -e '
let d="";
process.stdin.on("data", c => d += c).on("end", () => {
  try {
    const list = JSON.parse(d);
    const p = list.find(x => x.name === "portal");
    if (p) process.stdout.write(String(p.id));
  } catch {}
});' || true)"

  if [ -n "$portal_id" ]; then
    info "项目 portal 已注册 (id=$portal_id)，触发重新同步..."
    local sync_res
    sync_res="$(curl -fsS -X POST "${auth_header[@]}" "$SERVER_URL/api/v1/projects/$portal_id/sync" 2>/dev/null || true)"
    info "项目 portal 同步完成"
    if [ -n "$sync_res" ]; then
      node -e '
        try {
          const s = JSON.parse(process.argv[1]);
          console.log(`[dev] 用例同步结果: 新增 ${s.added}，更新 ${s.updated}，失效 ${s.invalid}`);
        } catch {}
      ' "$sync_res" 2>/dev/null || true
    fi
  else
    if [ -d "$REPOS_DIR/portal" ]; then
      warn "检测到未在平台注册的旧目录 $REPOS_DIR/portal，先清理"
      rm -rf "$REPOS_DIR/portal"
    fi
    info "通过 API 注册项目 portal ($demo_git_url)..."
    local res http_code body
    res="$(curl -sS -w "\n%{http_code}" \
      -H "Content-Type: application/json" \
      "${auth_header[@]}" \
      -d "{\"gitUrl\":\"$demo_git_url\"}" \
      "$SERVER_URL/api/v1/projects")"
    http_code="$(echo "$res" | tail -n 1)"
    body="$(echo "$res" | sed '$d')"
    if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
      info "项目 portal 注册并同步成功"
      node -e '
        try {
          const s = JSON.parse(process.argv[1])?.sync;
          if (s) console.log(`[dev] 用例同步结果: 新增 ${s.added}，更新 ${s.updated}，失效 ${s.invalid}`);
        } catch {}
      ' "$body" 2>/dev/null || true
    elif [ "$http_code" -eq 409 ]; then
      portal_id="$(curl -fsS "${auth_header[@]}" "$SERVER_URL/api/v1/projects" 2>/dev/null | node -e '
let d="";
process.stdin.on("data", c => d += c).on("end", () => {
  try {
    const list = JSON.parse(d);
    const p = list.find(x => x.name === "portal");
    if (p) process.stdout.write(String(p.id));
  } catch {}
});' || true)"
      if [ -n "$portal_id" ]; then
        curl -fsS -X POST "${auth_header[@]}" "$SERVER_URL/api/v1/projects/$portal_id/sync" >/dev/null
        info "项目 portal 已存在，同步完成"
      else
        warn "项目已存在但未获取到 id: $body"
      fi
    else
      die "注册 demo 项目失败 (HTTP $http_code): $body"
    fi
  fi

  info "4/4 检查并启动演示站点 (demo-site)..."
  local demo_url="http://127.0.0.1:${demo_port}"
  if curl -fsS "$demo_url/public" >/dev/null 2>&1; then
    info "demo-site 已在运行（$demo_url）"
  elif pgid_of "$RUN_DIR/demo-site.pid" >/dev/null 2>&1; then
    info "demo-site 已在运行（pid $(cat "$RUN_DIR/demo-site.pid")）"
  elif (exec 3<>"/dev/tcp/127.0.0.1/$demo_port") 2>/dev/null; then
    exec 3>&- 3<&- || true
    warn "端口 $demo_port 已被其他进程占用，跳过启动 demo-site"
  else
    info "启动 demo-site: $demo_url"
    start_bg demo-site PORT="$demo_port" -- node scripts/demo-site.mjs "$demo_port"
    local demo_ok=0
    for _ in $(seq 1 10); do
      if curl -fsS "$demo_url/public" >/dev/null 2>&1; then demo_ok=1; break; fi
      sleep 0.5
    done
    if [ "$demo_ok" = 1 ]; then
      info "demo-site 健康（$demo_url）"
    else
      warn "demo-site 未能及时就绪，查看日志: scripts/dev.sh logs demo-site"
    fi
  fi

  echo
  printf "${C_G}==================== Demo 就绪 ====================${C_0}\n"
  printf "1. 控制台访问:    ${C_G}http://127.0.0.1:%s${C_0}\n" "$PORT"
  printf "   - 项目列表中已载入 ${C_G}portal${C_0}，涵盖登录配方、媒体、反向代理等演示用例\n"
  printf "2. 被测演示站点:  ${C_G}%s${C_0}\n" "$demo_url"
  printf "   - 默认账号: demo-user / demo-pass\n"
  printf "3. 推荐环境变量配置（在 portal 项目「环境配置」或发起单次运行时提供）:\n"
  printf "   - BASE_URL:          %s\n" "$demo_url"
  printf "   - CLIENT_ID:         dfe87d72-e89d-4941-8de1-92dffeeb1211  (default 账号)\n"
  printf "   - ADMIN_CLIENT_ID:   0b7fd2e6-1c52-4a7e-9a44-6f5f2f9f0a01  (admin 账号)\n"
  printf "   - AUDITOR_CLIENT_ID: 7c1f3a58-92d0-4d3e-b1c7-2a8e5d4c6b02  (auditor 账号)\n"
  printf "4. 下一步运行用例:\n"
  printf "   - Web 控制台: 打开 portal 用例列表，勾选用例后点击「发起运行」\n"
  printf "   - Coding Agent / MCP: 通过 list_cases / run_cases 驱动执行与回传诊断\n"
  printf "${C_G}====================================================${C_0}\n"
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
  demo)    cmd_demo;;
  *) awk 'NR>1{if($0 !~ /^#/)exit; sub(/^# ?/,""); print}' "$0"; exit 1;;
esac
