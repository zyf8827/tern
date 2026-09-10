#!/usr/bin/env bash
# Docker 部署冒烟验证：字体检查 → compose 拉起 → 本地项目发现 → 登录用例（容器→宿主 demo 站）→ 失败截图中文核对
set -euo pipefail
cd "$(dirname "$0")/.."

# 实例文件（init-compose 生成）优先，缺失时退回 example 模板（冒烟不依赖本地化配置）
if [ -f docker-compose.yml ]; then
  export COMPOSE_FILE=docker-compose.yml
else
  export COMPOSE_FILE=docker-compose.example.yml
  echo "未找到 docker-compose.yml，使用模板 docker-compose.example.yml（正式部署先运行 scripts/init-compose.sh）"
fi
if [ -f .env ]; then
  set -a; source .env; set +a
else
  echo "未找到 .env，使用 .env.example 默认值（正式部署先运行 scripts/init-compose.sh）"
  set -a; source .env.example; set +a
fi

PORT="${SERVER_PORT:-7430}"
SITE_PORT=7501
SMOKE_ROOT=$(mktemp -d /tmp/tern-smoke.XXXXXX)
trap 'docker compose down -v >/dev/null 2>&1 || true; [ -n "${DEMO_PID:-}" ] && kill "$DEMO_PID" 2>/dev/null || true; rm -rf "$SMOKE_ROOT"' EXIT

echo "== 1. 中文字体检查（worker 容器内） =="
FONT_COUNT=$(docker compose run --rm --no-deps worker fc-list :lang=zh | wc -l)
echo "worker 容器内中文字体数量: $FONT_COUNT"
[ "$FONT_COUNT" -gt 10 ] || { echo "中文字体不足"; exit 1; }

echo "== 2. 准备演示站点与用例项目（本地放置 → 自动发现） =="
node scripts/demo-site.mjs $SITE_PORT &
DEMO_PID=$!
rm -rf repos/portal
mkdir -p repos
cp -r tests/fixtures/demo-cases-repo repos/portal
for i in $(seq 1 15); do curl -sf http://127.0.0.1:$SITE_PORT/public >/dev/null && break; sleep 1; done
echo "demo-site OK（http://127.0.0.1:$SITE_PORT，worker 经 host.docker.internal 访问）"

echo "== 3. 启动服务 =="
docker compose up -d --scale worker=1

echo "== 4. 等待 server 就绪并发现项目 =="
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:$PORT/api/v1/meta > /dev/null 2>&1; then break; fi
  [ "$i" = 30 ] && { echo "server 未就绪"; docker compose logs server; exit 1; }
  sleep 2
done
CASES=0
for i in $(seq 1 30); do
  CASES=$(curl -s http://127.0.0.1:$PORT/api/v1/meta | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.parse(d).stats.activeCases)})")
  [ "${CASES:-0}" -ge 8 ] && break
  sleep 2
done
[ "${CASES:-0}" -ge 8 ] || { echo "项目未被自动发现/同步（activeCases=$CASES）"; docker compose logs server | tail -30; exit 1; }
echo "项目 portal 已发现并同步 $CASES 条用例"

echo "== 5. 等待 worker 接入 =="
for i in $(seq 1 30); do
  ONLINE=$(curl -s http://127.0.0.1:$PORT/api/v1/workers | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.parse(d).filter(w=>w.status==='online').length)})")
  [ "$ONLINE" -ge 1 ] && break
  [ "$i" = 30 ] && { echo "worker 未接入"; docker compose logs worker; exit 1; }
  sleep 2
done
echo "worker OK"

echo "== 6. 执行 smoke 批次（含表单登录：worker 容器 → 宿主 demo 站） =="
PARAMS="{\"BASE_URL\":\"http://host.docker.internal:$SITE_PORT\",\"DEMO_USER\":\"demo-user\",\"DEMO_PASS\":\"demo-pass\",\"DEMO_SESSION\":\"s3cret\",\"DEMO_HOST\":\"host.docker.internal\"}"
BATCH=$(curl -s -X POST http://127.0.0.1:$PORT/api/v1/batches -H 'content-type: application/json' \
  -d "{\"title\":\"docker-smoke\",\"tags\":[\"smoke\"],\"params\":$PARAMS}")
BID=$(echo "$BATCH" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.parse(d).batch.id)})")
STATUS=""
for i in $(seq 1 60); do
  STATUS=$(curl -s http://127.0.0.1:$PORT/api/v1/batches/$BID | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.parse(d).status)})")
  [ "$STATUS" = "completed" ] && break
  [ "$i" = 60 ] && { echo "批次未完成（$STATUS）"; exit 1; }
  sleep 2
done
PASSED=$(curl -s http://127.0.0.1:$PORT/api/v1/batches/$BID | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const b=JSON.parse(d);console.log(b.passed+'/'+b.total)})")
echo "smoke 批次 $STATUS: $PASSED 通过"
[ "$PASSED" = "2/2" ] || { echo "smoke 批次未全部通过"; exit 1; }

echo "== 7. 失败用例截图（中文页面）供人工核对 =="
BATCH2=$(curl -s -X POST http://127.0.0.1:$PORT/api/v1/batches -H 'content-type: application/json' \
  -d "{\"title\":\"docker-smoke-fail\",\"caseIds\":[\"portal/negative/deliberate-fail\"],\"params\":$PARAMS}")
BID2=$(echo "$BATCH2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.parse(d).batch.id)})")
for i in $(seq 1 60); do
  STATUS=$(curl -s http://127.0.0.1:$PORT/api/v1/batches/$BID2 | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.parse(d).status)})")
  [ "$STATUS" = "completed" ] && break
  sleep 2
done
RUN_ID=$(curl -s http://127.0.0.1:$PORT/api/v1/batches/$BID2 | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.parse(d).items[0].finalRunId)})")
SHOT=$(curl -s http://127.0.0.1:$PORT/api/v1/runs/$RUN_ID | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d).artifacts.screenshots;console.log(a&&a[0]||'')})")
if [ -n "$SHOT" ]; then
  curl -s "http://127.0.0.1:$PORT${SHOT}" -o /tmp/tern-docker-failure.png
  echo "失败截图已保存: /tmp/tern-docker-failure.png（请打开确认「用户名或密码错误」中文非方块乱码）"
else
  echo "未找到失败截图"; exit 1
fi

echo "== 冒烟通过 =="
