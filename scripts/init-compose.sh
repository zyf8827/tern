#!/usr/bin/env bash
# 交互式生成 docker-compose.yml + .env（两文件均已 gitignore，不入库）
# 模板: docker-compose.example.yml / .env.example；变量说明见 .env.example
#
# 用法:
#   bash scripts/init-compose.sh          # 交互问答，回车 = 使用括号内默认值
#   bash scripts/init-compose.sh --yes    # 非交互，全部用已有 .env 值/默认值（CI、脚本可用）
#   docker compose up -d                  # 生成后从仓库根启动
#
# 再次运行会以当前 .env 为默认值沿用已有配置；重新生成会覆盖 docker-compose.yml 与 .env。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/.env"
COMPOSE_FILE="$ROOT/docker-compose.yml"
COMPOSE_EXAMPLE="$ROOT/docker-compose.example.yml"

ASSUME_YES=0
for arg in "$@"; do
    case "$arg" in
        -y|--yes) ASSUME_YES=1 ;;
        -h|--help) sed -n '2,11p' "${BASH_SOURCE[0]}"; exit 0 ;;
        *) echo "[ERROR] 未知参数: $arg（支持 --yes）" >&2; exit 2 ;;
    esac
done

if (( ! ASSUME_YES )) && [[ ! -t 0 ]]; then
    echo "[ERROR] 请在终端交互运行，或用 --yes 以默认值非交互生成: bash scripts/init-compose.sh --yes" >&2
    exit 2
fi
[[ -f "$COMPOSE_EXAMPLE" ]] || { echo "[ERROR] 找不到模板: $COMPOSE_EXAMPLE" >&2; exit 2; }

# ---------------------------------------------------------------------------
# 读已有 .env 作默认（再次初始化时沿用已有配置）
# ---------------------------------------------------------------------------
if [[ -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    set -a; source "$ENV_FILE"; set +a
fi

# ---------------------------------------------------------------------------
# 问答工具（回车 = 默认）
# ---------------------------------------------------------------------------
ask() {  # ask <varname> <prompt> <default>
    local _n="$1" _p="$2" _d="$3" _v
    if [[ -n "$_d" ]]; then
        read -r -p "$_p [$_d]: " _v || true
    else
        read -r -p "$_p: " _v || true
    fi
    printf -v "$_n" '%s' "${_v:-$_d}"
}

ask_yn() {  # ask_yn <varname> <prompt> <default y|n>
    local _n="$1" _p="$2" _d="$3" _v _hint
    if [[ "$_d" == "y" ]]; then _hint="Y/n"; else _hint="y/N"; fi
    while :; do
        read -r -p "$_p [$_hint]: " _v || true
        _v="$(echo "${_v:-$_d}" | tr '[:upper:]' '[:lower:]')"
        case "$_v" in
            y|yes) printf -v "$_n" 'y'; return 0 ;;
            n|no)  printf -v "$_n" 'n'; return 0 ;;
        esac
        echo "  请输入 y 或 n"
    done
}

rand_hex() {  # 32 位十六进制随机串（WORKER_TOKEN / API_TOKEN 默认值）
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 16
    else
        head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'
    fi
}

detect_host_ip() {  # 宿主机局域网 IP（对外访问地址默认值用）
    local ip
    ip="$(ip -4 route get 1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
    [[ -n "$ip" ]] || ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    printf '%s' "$ip"
}

port_in_use() {  # <port> 返回 0=有监听; ss > netstat > /dev/tcp 逐级兜底
    local port="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -ltnH 2>/dev/null | awk '{print $4}' | grep -q ":${port}\$"
    elif command -v netstat >/dev/null 2>&1; then
        netstat -ltn 2>/dev/null | awk '{print $4}' | grep -q ":${port}\$"
    else
        (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null
    fi
}

env_quote() {
    local s="$1"
    s="${s//\'/\'\\\'}"
    printf "'%s'" "$s"
}

# ---------------------------------------------------------------------------
# 非默认问题逐个问（--yes 跳过）
# ---------------------------------------------------------------------------
ask_all() {
    echo "======================================================================"
    echo " Tern Compose 初始化   仓库: $ROOT"
    echo " 选择/输入后回车确认；回车 = 使用括号内默认值；生成: docker-compose.yml 与 .env"
    echo "======================================================================"
    echo

    ask WORKER_TOKEN "Worker 接入凭证（server 与所有 worker 必须一致）" "${WORKER_TOKEN:-$(rand_hex)}"
    ask SERVER_PORT "Server 对外端口" "${SERVER_PORT:-7430}"
    ask PUBLIC_URL "对外访问地址（钉钉通知等消息里的链接用它拼；空=用 localhost）" "${PUBLIC_URL:-http://$(detect_host_ip):${SERVER_PORT:-7430}}"
    ask HOST_DATA_DIR "宿主机数据目录（SQLite/执行产物, 相对路径=仓库根）" "${HOST_DATA_DIR:-./data}"
    ask HOST_REPOS_DIR "宿主机用例项目目录（git clone/本地放置）" "${HOST_REPOS_DIR:-./repos}"
    ask WORKER_REPLICAS "worker 副本数（后续改 .env 或 --scale worker=N 也可调）" "${WORKER_REPLICAS:-1}"
    ask WORKER_MAX_SLOTS "每个 worker 的并发执行槽" "${WORKER_MAX_SLOTS:-1}"
    ask PLAYWRIGHT_IMAGE "worker 基础镜像（须与 apps/worker 的 @playwright/test 版本一致）" "${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.59.0-jammy}"
    local _mount_def="n"
    [[ "${SOURCE_MOUNT:-}" == "true" ]] && _mount_def="y"
    ask_yn MOUNT_ON "源码热替换（挂载宿主机构建产物进容器, 宿主机 pnpm -r build 后 restart 即生效, 不需重建镜像）?" "$_mount_def"

    ask_yn MORE "配置更多项（镜像源/镜像 tag/拉取间隔/日志/API 防护/用例默认凭据）?" "n"
    APT_MIRROR="${APT_MIRROR:-}"
    NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
    SERVER_IMAGE="${SERVER_IMAGE:-tern-server:latest}"
    WORKER_IMAGE="${WORKER_IMAGE:-tern-worker:latest}"
    PULL_INTERVAL_SEC="${PULL_INTERVAL_SEC:-300}"
    LOG_LEVEL="${LOG_LEVEL:-info}"
    API_TOKEN=""
    DEMO_USER=""
    DEMO_PASS=""
    if [[ "$MORE" == "y" ]]; then
        ask APT_MIRROR "  apt 镜像源（默认官方，中国源可选 mirrors.aliyun.com 等）" "$APT_MIRROR"
        ask NPM_REGISTRY "  npm registry（默认 https://registry.npmjs.org，可选 https://registry.npmmirror.com）" "$NPM_REGISTRY"
        ask SERVER_IMAGE "  server 镜像 tag" "$SERVER_IMAGE"
        ask WORKER_IMAGE "  worker 镜像 tag" "$WORKER_IMAGE"
        ask PULL_INTERVAL_SEC "  git 用例项目自动拉取间隔秒（0=仅手动）" "$PULL_INTERVAL_SEC"
        ask LOG_LEVEL "  日志级别 (debug/info/warn/error)" "$LOG_LEVEL"
        ask_yn API_ON "  启用 API 写操作 Bearer 认证?（内网工具可不启）" "n"
        if [[ "$API_ON" == "y" ]]; then
            ask API_TOKEN "    API_TOKEN" "$(rand_hex)"
        fi
        ask_yn DEMO_ON "  注入用例默认凭据 DEMO_USER/DEMO_PASS（供 tern.yaml 的 \${ENV:XXX} 占位符）?" "n"
        if [[ "$DEMO_ON" == "y" ]]; then
            ask DEMO_USER "    DEMO_USER" "${DEMO_USER:-}"
            ask DEMO_PASS "    DEMO_PASS" "${DEMO_PASS:-}"
        fi
    fi
}

ask_all_non_interactive() {
    WORKER_TOKEN="${WORKER_TOKEN:-$(rand_hex)}"
    SERVER_PORT="${SERVER_PORT:-7430}"
    PUBLIC_URL="${PUBLIC_URL:-http://$(detect_host_ip):${SERVER_PORT}}"
    HOST_DATA_DIR="${HOST_DATA_DIR:-./data}"
    HOST_REPOS_DIR="${HOST_REPOS_DIR:-./repos}"
    WORKER_REPLICAS="${WORKER_REPLICAS:-1}"
    WORKER_MAX_SLOTS="${WORKER_MAX_SLOTS:-1}"
    PLAYWRIGHT_IMAGE="${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.59.0-jammy}"
    SOURCE_MOUNT="${SOURCE_MOUNT:-false}"
    MOUNT_ON="n"
    [[ "$SOURCE_MOUNT" == "true" ]] && MOUNT_ON="y"
    APT_MIRROR="${APT_MIRROR:-}"
    NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
    SERVER_IMAGE="${SERVER_IMAGE:-tern-server:latest}"
    WORKER_IMAGE="${WORKER_IMAGE:-tern-worker:latest}"
    PULL_INTERVAL_SEC="${PULL_INTERVAL_SEC:-300}"
    LOG_LEVEL="${LOG_LEVEL:-info}"
    API_TOKEN="${API_TOKEN:-}"
    DEMO_USER="${DEMO_USER:-}"
    DEMO_PASS="${DEMO_PASS:-}"
}

if (( ASSUME_YES )); then
    ask_all_non_interactive
else
    ask_all
fi

# ---------------------------------------------------------------------------
# 校验
# ---------------------------------------------------------------------------
if [[ ! "$SERVER_PORT" =~ ^[0-9]+$ ]] || (( SERVER_PORT < 1 || SERVER_PORT > 65535 )); then
    echo "[ERROR] SERVER_PORT 必须是 1-65535 的整数: $SERVER_PORT" >&2
    exit 2
fi
if [[ ! "$WORKER_REPLICAS" =~ ^[0-9]+$ ]] || (( WORKER_REPLICAS < 1 )); then
    echo "[ERROR] worker 副本数必须是正整数: $WORKER_REPLICAS" >&2
    exit 2
fi
if [[ -z "$WORKER_TOKEN" ]]; then
    echo "[ERROR] WORKER_TOKEN 不能为空" >&2
    exit 2
fi

# 源码热替换：预检宿主机构建产物（缺失只告警，不阻断；构建命令见提示）
if [[ "$MOUNT_ON" == "y" ]]; then
    MISSING=()
    for d in apps/server/dist apps/server/public packages/sdk/dist packages/case-bundler/dist apps/worker/dist packages/exec-kit/dist; do
        [[ -d "$d" ]] || MISSING+=("$d")
    done
    if (( ${#MISSING[@]} > 0 )); then
        echo "[WARN] 宿主机缺少构建产物: ${MISSING[*]}" >&2
        echo "       热替换要求宿主机先执行: pnpm install && pnpm -r build（否则容器内对应目录为空，服务起不来）" >&2
    fi
fi

# 宿主机资源映射目录：预创建（缺失时 dockerd 会以 root 创建，属主不受控，先建好）
for d in "$HOST_DATA_DIR" "$HOST_REPOS_DIR"; do
    if [[ ! -d "$d" ]]; then
        mkdir -p "$d" 2>/dev/null || echo "[WARN] 无法创建目录 $d, up 时由 dockerd 以 root 创建" >&2
    fi
done

# playwright 版本与 worker 依赖一致性（与 docker-build.sh 同规则；此处仅警告）
DEP_VERSION="$(node -e "console.log(require('./apps/worker/package.json').dependencies['@playwright/test'])" 2>/dev/null || true)"
if [[ -n "$DEP_VERSION" ]]; then
    BASE_VERSION="$(echo "$PLAYWRIGHT_IMAGE" | grep -o 'v[0-9.]*' | head -1 | sed 's/^v//')"
    if [[ "$DEP_VERSION" != "$BASE_VERSION" ]]; then
        echo "[WARN] PLAYWRIGHT_IMAGE($BASE_VERSION) 与 apps/worker 的 @playwright/test($DEP_VERSION) 不一致，构建/握手可能失败（docker-build.sh 会硬校验）" >&2
    fi
fi

if port_in_use "$SERVER_PORT"; then
    echo "[WARN] 端口 $SERVER_PORT 已被占用，up 时会端口绑定失败；请先停占用方或换端口重新 init" >&2
fi

# ---------------------------------------------------------------------------
# 确认并写入
# ---------------------------------------------------------------------------
if (( ! ASSUME_YES )); then
    echo
    echo "----------------------------------------------------------------------"
    echo " WORKER_TOKEN: ${WORKER_TOKEN:0:6}****"
    echo " 端口:         $SERVER_PORT（对外 $PUBLIC_URL）   worker 副本: $WORKER_REPLICAS × $WORKER_MAX_SLOTS 槽"
    echo " 资源映射:     data=$HOST_DATA_DIR  repos=$HOST_REPOS_DIR"
    echo " worker 镜像:  $PLAYWRIGHT_IMAGE"
    echo " 镜像源:       apt=$APT_MIRROR npm=$NPM_REGISTRY"
    echo " 热替换:       $([[ "$MOUNT_ON" == "y" ]] && echo "开启（挂载宿主 dist/public，宿主机构建 + restart 生效）" || echo 关闭)"
    echo " API 防护:     $([[ -n "$API_TOKEN" ]] && echo 开启 || echo 关闭)"
    echo " 默认凭据:     $([[ -n "$DEMO_USER" ]] && echo "$DEMO_USER/****" || echo 未注入)"
    echo "----------------------------------------------------------------------"
    ask_yn OK "写入 $COMPOSE_FILE 与 $ENV_FILE ?" "y"
    [[ "$OK" == "y" ]] || { echo "已取消"; exit 0; }
fi

# .env：全部单引号包裹，可被本脚本与 docker compose 直接 source/读取
{
    echo "# generated by scripts/init-compose.sh $(date '+%F %T')"
    echo "# Worker 接入凭证（server 与所有 worker 必须一致）"
    echo "WORKER_TOKEN=$(env_quote "$WORKER_TOKEN")"
    echo ""
    echo "# 对外端口 / 对外访问地址（钉钉通知链接）/ 宿主机资源映射目录 / worker 副本数 / 每 worker 并发槽"
    echo "SERVER_PORT=$(env_quote "$SERVER_PORT")"
    echo "PUBLIC_URL=$(env_quote "$PUBLIC_URL")"
    echo "HOST_DATA_DIR=$(env_quote "$HOST_DATA_DIR")"
    echo "HOST_REPOS_DIR=$(env_quote "$HOST_REPOS_DIR")"
    echo "WORKER_REPLICAS=$(env_quote "$WORKER_REPLICAS")"
    echo "WORKER_MAX_SLOTS=$(env_quote "$WORKER_MAX_SLOTS")"
    echo ""
    echo "# worker 基础镜像（必须与 apps/worker/package.json 的 @playwright/test 版本一致）"
    echo "PLAYWRIGHT_IMAGE=$(env_quote "$PLAYWRIGHT_IMAGE")"
    echo ""
    echo "# 镜像源与产物 tag"
    echo "APT_MIRROR=$(env_quote "$APT_MIRROR")"
    echo "NPM_REGISTRY=$(env_quote "$NPM_REGISTRY")"
    echo "SERVER_IMAGE=$(env_quote "$SERVER_IMAGE")"
    echo "WORKER_IMAGE=$(env_quote "$WORKER_IMAGE")"
    echo ""
    echo "# 源码热替换（true = compose 挂载宿主机构建产物，改码后宿主机 pnpm -r build 再 restart 即生效）"
    echo "SOURCE_MOUNT=$(env_quote "$([[ "$MOUNT_ON" == "y" ]] && echo true || echo false)")"
    echo ""
    echo "# git 用例项目默认自动拉取间隔（秒）；0 = 仅手动更新"
    echo "PULL_INTERVAL_SEC=$(env_quote "$PULL_INTERVAL_SEC")"
    echo ""
    echo "LOG_LEVEL=$(env_quote "$LOG_LEVEL")"
    if [[ -n "$API_TOKEN" ]]; then
        echo ""
        echo "# API 写操作 Bearer 认证"
        echo "API_TOKEN=$(env_quote "$API_TOKEN")"
    fi
    if [[ -n "$DEMO_USER" || -n "$DEMO_PASS" ]]; then
        echo ""
        echo "# 用例登录凭据（tern.yaml 中 \${ENV:XXX} 占位符的解析来源，也可逐批次参数提供）"
        echo "DEMO_USER=$(env_quote "$DEMO_USER")"
        echo "DEMO_PASS=$(env_quote "$DEMO_PASS")"
    fi
} > "$ENV_FILE"

# docker-compose.yml：模板正文（去掉头部模板说明注释）+ 生成头；按选择取消 API_TOKEN/凭据注释行
GEN_HDR="# generated by scripts/init-compose.sh $(date '+%F %T')
# port=$SERVER_PORT public_url=$PUBLIC_URL data=$HOST_DATA_DIR repos=$HOST_REPOS_DIR replicas=$WORKER_REPLICAS slots=$WORKER_MAX_SLOTS source_mount=$([[ "$MOUNT_ON" == "y" ]] && echo on || echo off) api_auth=$([[ -n "$API_TOKEN" ]] && echo on || echo off)
# 重新运行 scripts/init-compose.sh 会覆盖本文件；模板见 docker-compose.example.yml，改 .env 即可换配置
"
{
    echo "$GEN_HDR"
    sed -n '/^services:/,$p' "$COMPOSE_EXAMPLE"
} > "$COMPOSE_FILE"
if [[ -n "$API_TOKEN" ]]; then
    sed -i -E 's|^([[:space:]]*)# (API_TOKEN: )|\1\2|' "$COMPOSE_FILE"
fi
if [[ -n "$DEMO_USER" || -n "$DEMO_PASS" ]]; then
    sed -i -E 's|^([[:space:]]*)# (DEMO_USER: )|\1\2|; s|^([[:space:]]*)# (DEMO_PASS: )|\1\2|' "$COMPOSE_FILE"
fi
# 源码热替换：取消模板中热替换挂载注释行（形如 "      # - ./..."，server/worker 两块同款缩进）
if [[ "$MOUNT_ON" == "y" ]]; then
    sed -i -E 's|^([[:space:]]*)# (- \./)|\1\2|' "$COMPOSE_FILE"
fi

echo
echo "已写入:"
echo "  $ENV_FILE"
echo "  $COMPOSE_FILE"
echo
echo "下一步:"
echo "  bash scripts/docker-build.sh          # 构建镜像（校验 playwright 版本一致性）"
echo "  docker compose up -d                  # 1 server + $WORKER_REPLICAS worker"
echo "  curl http://127.0.0.1:${SERVER_PORT}/api/v1/meta"
if [[ "$MOUNT_ON" == "y" ]]; then
    echo ""
    echo "源码热替换已开启:"
    echo "  首次启用: pnpm install && pnpm -r build 后 docker compose up -d（重建容器使挂载生效）"
    echo "  日常更新: 宿主机改代码 → pnpm -r build → docker compose restart server worker（不需重建镜像）"
fi
