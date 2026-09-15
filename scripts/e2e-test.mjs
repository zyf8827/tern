#!/usr/bin/env node
// Tern 端到端测试：拉起 demo 站点 + server + worker，
// 验证 git 项目接入 / 同步 / 多维筛选 / 登录态管理（auth-design：mockLogin 主路径、会话复用、
// 账号切换、AUTH_ACCOUNT、auth:none、失效重登、失败路径、旧 yaml 兼容）/ 指定 worker / 执行 /
// 实时 / 产物 / 取消 / 重派 / 自动拉取 / MCP / CLI / Web
import { spawn, execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7555;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE_PORT = 7501;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const TOKEN = 'e2etest-token';
const DATA = path.join(ROOT, 'data-e2etest');
const REPOS = path.join(DATA, 'repos');
const SOURCE_REPO = path.join(DATA, 'source-repo');
const SOURCE_REPO_LEGACY = path.join(DATA, 'source-repo-legacy');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'demo-cases-repo');
const FIXTURE_LEGACY = path.join(ROOT, 'tests', 'fixtures', 'demo-cases-repo-legacy');

// demo-site 的「设备 → 账号」绑定（clientId 即身份）
const CLIENT_ID = 'dfe87d72-e89d-4941-8de1-92dffeeb1211';
const ADMIN_CLIENT_ID = '0b7fd2e6-1c52-4a7e-9a44-6f5f2f9f0a01';
const AUDITOR_CLIENT_ID = '7c1f3a58-92d0-4d3e-b1c7-2a8e5d4c6b02';
const AUTH_PARAMS = {
  BASE_URL: SITE,
  CLIENT_ID,
  ADMIN_CLIENT_ID,
  AUDITOR_CLIENT_ID,
  BROKEN_CLIENT_ID: '00000000-0000-4000-8000-000000000000', // 未绑定设备 → mock-login success:false
  DEMO_USER: 'demo-user',
  DEMO_PASS: 'demo-pass',
  DEMO_SESSION: 's3cret',
  DEMO_HOST: '127.0.0.1',
};

let passCount = 0;
let failCount = 0;
const failures = [];
const children = new Set();
process.on('exit', () => {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* ignore */ }
  }
  try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch { /* ignore */ }
  try { execSync(`fuser -k ${SITE_PORT}/tcp 2>/dev/null || true`); } catch { /* ignore */ }
});
function check(name, cond, detail = '') {
  if (cond) {
    passCount++;
    console.log(`  ✓ ${name}`);
  } else {
    failCount++;
    failures.push(name);
    console.log(`  ✗ ${name} ${detail}`);
  }
}

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: res.status, json };
}

async function waitUntil(fn, timeoutMs, everyMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error('waitUntil 超时');
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

function spawnProc(name, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => console.error(`[${name}][stderr]`, d.toString().slice(0, 400)));
  return child;
}

async function cancelRunQuietly(runId) {
  await api('POST', `/api/v1/runs/${runId}/cancel?force=true`).catch(() => {});
}

async function createRun(payload) {
  const r = await api('POST', '/api/v1/runs', payload);
  if (r.status !== 201 && r.status !== 200) throw new Error(`创建测试运行失败 ${r.status}: ${JSON.stringify(r.json)}`);
  return r.json.run;
}

async function waitRun(runId, timeoutMs = 120000) {
  return waitUntil(async () => {
    const { json } = await api('GET', `/api/v1/runs/${runId}`);
    if (json.status === 'completed' || json.status === 'cancelled') return json;
    return null;
  }, timeoutMs, 500);
}

/** app 通道 WS：订阅并收集事件 */
function connectWs(topics, onEvent) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/app`);
  const received = [];
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'subscribe', topics }));
  });
  ws.addEventListener('error', (e) => console.log('  [ws-error]', e.message ?? String(e)));
  ws.addEventListener('close', (e) => console.log(`  [ws-close] code=${e.code}`));
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.type === 'event') {
      received.push(msg);
      onEvent?.(msg);
    }
  });
  return { ws, received };
}

function gitSource(args) {
  execSync(`git -c user.email=e2e@tern -c user.name=e2e ${args}`, { cwd: SOURCE_REPO, stdio: 'pipe' });
}
function gitSourceLegacy(args) {
  execSync(`git -c user.email=e2e@tern -c user.name=e2e ${args}`, { cwd: SOURCE_REPO_LEGACY, stdio: 'pipe' });
}

/** 生成最小合法 WAV（44B 头 + 正弦波 PCM，16k/mono/16bit） */
function makeWavFile(file, seconds, sampleRate = 16000) {
  const n = seconds * sampleRate;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + n * 2, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(n * 2, 40);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000);
    pcm.writeInt16LE(v, i * 2);
  }
  writeFileSync(file, Buffer.concat([header, pcm]));
}

function resetSourceRepo() {
  rmSync(SOURCE_REPO, { recursive: true, force: true });
  cpSync(FIXTURE, SOURCE_REPO, { recursive: true });
  // 测试资产样本：devices.mic 推流 + ternAsset 播种共用
  mkdirSync(path.join(SOURCE_REPO, 'cases', '_assets', 'audio'), { recursive: true });
  makeWavFile(path.join(SOURCE_REPO, 'cases', '_assets', 'audio', 'tone.wav'), 5);
  execSync('git init -b main', { cwd: SOURCE_REPO, stdio: 'pipe' });
  gitSource('add -A');
  gitSource('commit -m init --quiet');
}

function resetSourceRepoLegacy() {
  rmSync(SOURCE_REPO_LEGACY, { recursive: true, force: true });
  cpSync(FIXTURE_LEGACY, SOURCE_REPO_LEGACY, { recursive: true });
  execSync('git init -b main', { cwd: SOURCE_REPO_LEGACY, stdio: 'pipe' });
  gitSourceLegacy('add -A');
  gitSourceLegacy('commit -m init --quiet');
}

/** demo-site 的 mock-login 调用统计（断言「同一账号只登一次」等） */
async function mockLoginTotal() {
  const res = await fetch(`${SITE}/api/auth/_stats`);
  return (await res.json()).total;
}

const serverLog = [];
const workerLog = [];

async function main() {
  console.log('== Tern 端到端测试 ==\n');
  try { execSync('pkill -f "apps/worker/d[i]st" 2>/dev/null || true'); } catch { /* ignore */ }
  try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch { /* ignore */ }
  // 清掉残留的 demo-site（上一轮测试或手动启动），避免占用 SITE_PORT 提供旧路由
  try { execSync(`fuser -k ${SITE_PORT}/tcp 2>/dev/null || true`); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 800));
  await rm(DATA, { recursive: true, force: true });
  await rm(path.join(ROOT, '.runs'), { recursive: true, force: true });
  await rm('/tmp/tern-runs', { recursive: true, force: true });
  await rm('/tmp/tern-auth', { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  resetSourceRepo();
  resetSourceRepoLegacy();

  // ---- 演示站点（登录目标）----
  console.log('[0] 启动演示站点（登录目标）');
  spawnProc('demo-site', ['scripts/demo-site.mjs', String(SITE_PORT)], {});
  // 就绪以 /api/auth/_stats 为准：确保不是残留的旧版 demo-site
  await waitUntil(async () => (await fetch(`${SITE}/api/auth/_stats`)).ok, 5000);
  check('演示站点启动（mockLogin 模拟端点可访问）', true);

  // ---- 启动 server（空项目状态）----
  console.log('[1] 启动 server（初始无项目）');
  const server = spawnProc('server', ['apps/server/dist/index.js'], {
    PORT: String(PORT),
    DATA_DIR: DATA,
    REPOS_DIR: REPOS,
    SYNC_WATCH: 'false',
    PULL_INTERVAL_SEC: '5',
    WORKER_TOKEN: TOKEN,
    TERN_LEASE_MS: '5000',
    TERN_HEARTBEAT_TIMEOUT_MS: '5000',
    TERN_ORPHAN_GRACE_MS: '5000',
  });
  server.stdout.on('data', (d) => serverLog.push(d.toString()));
  const meta0 = await waitUntil(async () => {
    const { json } = await api('GET', '/api/v1/meta');
    return json?.status === 'ok' && json;
  }, 20000);
  check('server 启动（空库，无项目）', meta0.stats.projects === 0 && meta0.stats.activeCases === 0, JSON.stringify(meta0.stats));
  check('meta 返回 reposDir', typeof meta0.reposDir === 'string');

  // ---- 添加 git 项目 ----
  console.log('[2] 添加 git 用例项目（clone + 自动同步）');
  const addResp = await api('POST', '/api/v1/projects', {
    gitUrl: `file://${SOURCE_REPO}`,
    credential: { type: 'password', username: 'alice', secret: 's3cret-git' },
  });
  check('添加 git 项目返回 200', addResp.status === 200, JSON.stringify(addResp.json).slice(0, 300));
  const project = addResp.json.project;
  check('项目注册（source=git，tern.yaml name 生效）', project?.name === 'portal' && project?.source === 'git');
  check('首次同步入库 14 个用例', addResp.json.sync?.added === 14, JSON.stringify(addResp.json.sync));
  check('项目记录 lastCommit', typeof project?.lastCommit === 'string' && project.lastCommit.length >= 7);
  check('clone 目录落地 repos/portal', existsSync(path.join(REPOS, 'portal', 'tern.yaml')));
  check(
    'git 凭据摘要回显 type/username 且 hasSecret，secret 不回显',
    project?.credential?.type === 'password' &&
      project?.credential?.username === 'alice' &&
      project?.credential?.hasSecret === true &&
      !JSON.stringify(addResp.json).includes('s3cret-git'),
    JSON.stringify(project?.credential),
  );
  const dupResp = await api('POST', '/api/v1/projects', { gitUrl: `file://${SOURCE_REPO}` });
  check('重复添加同名项目被拒绝（409）', dupResp.status === 409);
  const badRepo = await api('POST', '/api/v1/projects', { gitUrl: 'file:///nonexistent-repo' });
  check('无效 git 地址报错', badRepo.status === 500 || badRepo.status === 400);
  const sshNoKey = await api('POST', '/api/v1/projects', { gitUrl: 'git@example.com:team/portal.git' });
  check(
    'SSH 无私钥被拒绝（容器内不用宿主机密钥）',
    sshNoKey.status === 400 && sshNoKey.json?.error?.code === 'GIT_SSH_KEY_REQUIRED',
    JSON.stringify(sshNoKey.json).slice(0, 200),
  );

  // ---- 同步与多维字段 ----
  console.log('[3] 用例字段与多维度筛选');
  const casesResp = await api('GET', '/api/v1/cases?status=active');
  const cases = casesResp.json.items;
  check('14 个用例全部 active', cases.length === 14, `got ${cases.length}`);
  check('caseId 带 project 前缀', cases.every((c) => c.caseId.startsWith('portal/')));
  const selfcheck = cases.find((c) => c.caseId === 'portal/platform/selfcheck');
  check('version/module 字段解析', selfcheck?.version === 'v1' && selfcheck?.module === 'platform', JSON.stringify(selfcheck));
  check('defaultTags 合并（tern.yaml demo）', selfcheck?.tags.includes('demo') && selfcheck.tags.includes('smoke'));
  const authAdmin = cases.find((c) => c.caseId === 'portal/auth/workbench-admin');
  check('auth 用例识别（frontmatter auth: admin）', authAdmin?.module === 'auth' && authAdmin?.version === 'v2');

  const facets = (await api('GET', '/api/v1/facets')).json;
  check(
    'facets 返回 version/module 维度',
    ['v1', 'v2', 'v1.5'].every((v) => facets.versions.some((x) => x.value === v)) &&
      ['platform', 'auth', 'misc'].every((m) => facets.modules.some((x) => x.value === m)),
    JSON.stringify(facets),
  );
  const v2Cases = (await api('GET', '/api/v1/cases?version=v2&status=active')).json;
  check('version=v2 筛选命中 7 条（auth 用例）', v2Cases.total === 7, `got ${v2Cases.total}`);
  const moduleCases = (await api('GET', '/api/v1/cases?module=platform&status=active')).json;
  check('module=platform 筛选命中 2 条', moduleCases.total === 2, `got ${moduleCases.total}`);
  const combo = (await api('GET', '/api/v1/cases?version=v1&module=auth&status=active')).json;
  check('version+module 组合筛选命中 1 条', combo.total === 1 && combo.items[0].caseId === 'portal/auth/login-bad-password');
  const page = (await api('GET', '/api/v1/cases?status=active&limit=3&offset=0')).json;
  check(
    '用例库分页（limit=3）',
    page.items.length === 3 && page.total === 14 && page.limit === 3 && page.offset === 0,
    JSON.stringify({ n: page.items.length, total: page.total, limit: page.limit }),
  );
  const defaultPage = (await api('GET', '/api/v1/cases?status=active')).json;
  check('用例库默认一页 20 条', defaultPage.limit === 20 && defaultPage.items.length === 14);

  // ---- lint 校验 + 强制更新 ----
  console.log('[4] 用例 lint 与强制更新（reset --hard + clean）');
  writeFileSync(
    path.join(SOURCE_REPO, 'cases', 'BadName.spec.ts'),
    '/**\n * @tern\n * tags: [x]\n */\nimport { test } from "@playwright/test";\n',
  );
  gitSource('add -A');
  gitSource('commit -m bad --quiet');
  const sync1 = await api('POST', `/api/v1/projects/${project.id}/sync`);
  check('更新项目返回 200 且发现 invalid', sync1.status === 200 && sync1.json.invalid >= 1, JSON.stringify(sync1.json).slice(0, 200));
  const invalidCase = (await api('GET', '/api/v1/cases?status=invalid')).json.items.find((c) => c.caseId === 'portal/BadName');
  check('命名违规用例被标记 invalid', !!invalidCase && !!invalidCase.lastError);

  // 本地人工修改 clone（脏文件 + 改动 tracked 文件）→ 强制更新后应被清空
  const cloneDir = path.join(REPOS, 'portal');
  writeFileSync(path.join(cloneDir, 'dirty-local.txt'), 'manual edit');
  const specFile = path.join(cloneDir, 'cases', 'platform', 'selfcheck.spec.ts');
  writeFileSync(specFile, readFileSync(specFile, 'utf8') + '\n// 本地篡改\n');
  gitSource('rm -q cases/BadName.spec.ts');
  gitSource('commit -m remove-bad --quiet');
  const sync2 = await api('POST', `/api/v1/projects/${project.id}/sync`);
  check('强制更新清除本地脏文件', !existsSync(path.join(cloneDir, 'dirty-local.txt')));
  check('强制更新还原被篡改文件', !readFileSync(specFile, 'utf8').includes('本地篡改'));
  check('远端删除的用例转为 deleted', (await api('GET', '/api/v1/cases/portal/BadName')).json.status === 'deleted');

  // 内容变更传播：改源仓库 title → commit → 更新 → 用例元数据变化
  const sourceSpec = path.join(SOURCE_REPO, 'cases', 'platform', 'selfcheck.spec.ts');
  writeFileSync(
    sourceSpec,
    readFileSync(sourceSpec, 'utf8').replace('title: 平台自检 - 基础断言链路', 'title: 平台自检 - 基础断言链路（改）'),
  );
  gitSource('add -A');
  gitSource('commit -m title --quiet');
  await api('POST', `/api/v1/projects/${project.id}/sync`);
  check('远端 title 变更同步到用例', (await api('GET', '/api/v1/cases/portal/platform/selfcheck')).json.title.includes('（改）'));

  // ---- 启动 worker ----
  console.log('[5] 启动 worker');
  let worker = spawnProc('worker', ['apps/worker/dist/index.js'], {
    SERVER_URL: BASE,
    WORKER_TOKEN: TOKEN,
    WORKER_NAME: 'e2e-worker-1',
  });
  worker.stdout.on('data', (d) => workerLog.push(d.toString()));
  const workerInfo = await waitUntil(async () => {
    const { json } = await api('GET', '/api/v1/workers');
    return json.length === 1 && json[0].status !== 'offline' && json[0];
  }, 20000);
  check('worker 注册上线', workerInfo?.name === 'e2e-worker-1');

  // ---- 运行1：smoke（默认登录用例）+ 实时事件 + 实时画面 ----
  console.log('[6] 测试运行：smoke 用例（默认 mockLogin 登录）、实时进度、实时画面');
  const events = [];
  let ws;
  const noProject = await api('POST', '/api/v1/runs', { title: 'no-project', tags: ['smoke'], createdBy: 'e2etest' });
  check(
    '未指定 project 创建运行被拒绝',
    noProject.status === 400 && noProject.json?.error?.code === 'PROJECT_REQUIRED',
    JSON.stringify(noProject.json).slice(0, 200),
  );
  const beforeSmoke = await mockLoginTotal();
  const batch1 = await createRun({
    title: 'e2e-smoke',
    project: 'portal',
    tags: ['smoke'],
    params: AUTH_PARAMS,
    createdBy: 'e2etest',
  });
  const wsPromise = new Promise((resolve) => {
    ws = connectWs([`run:${batch1.id}`], (msg) => {
      events.push(msg);
      if (msg.event.type === 'execution.started' && msg.event.payload?.runId) {
        ws.ws.send(JSON.stringify({ type: 'subscribe', topics: [`execution:${msg.event.payload.runId}`] }));
      }
      if (msg.event.type === 'run.updated' && ['completed', 'cancelled'].includes(msg.event.payload?.status)) {
        resolve();
      }
    });
    setTimeout(resolve, 150000);
  });
  await wsPromise;
  ws.ws.close();
  const b1 = await api('GET', `/api/v1/runs/${batch1.id}`).then((r) => r.json);
  check('smoke 运行完成，全部通过（含默认登录用例）', b1.status === 'completed' && b1.passed === b1.total && b1.total === 2 && b1.project === 'portal', JSON.stringify(b1));
  check('两条用例同一账号：mockLogin 只打一次（worker 会话复用）', (await mockLoginTotal()) - beforeSmoke === 1, `mockLogin 次数 ${(await mockLoginTotal()) - beforeSmoke}`);
  check('收到实时 run.item.updated 事件', events.some((e) => e.event.type === 'run.item.updated'));
  check('收到实时 execution.log 事件（含登录过程日志）', events.some((e) => e.event.type === 'execution.log'));
  check('收到实时画面帧 execution.frame（只读 screencast）', events.some((e) => e.event.type === 'execution.frame'));

  // ---- 运行2：账号切换 / AUTH_ACCOUNT / auth:none / 失效重登 ----
  console.log('[7] 登录态管理：账号、AUTH_ACCOUNT、auth:none、validate 重登');
  // admin 账号用例 + AUTH_ACCOUNT 覆盖默认账号
  const beforeAdmin = await mockLoginTotal();
  const batchAdmin = await createRun({
    title: 'e2e-auth-account',
    caseIds: ['portal/platform/selfcheck', 'portal/auth/workbench-auditor'],
    params: { ...AUTH_PARAMS, AUTH_ACCOUNT: 'admin' }, // 覆盖「未写 auth」的 selfcheck → admin；auditor 不被覆盖
    createdBy: 'e2etest',
  });
  const bAdmin = await waitRun(batchAdmin.id);
  check(
    'AUTH_ACCOUNT=admin 覆盖未写 auth 的用例；写了 auth: auditor 的仍走 auditor',
    bAdmin.status === 'completed' && bAdmin.passed === 2 && bAdmin.total === 2,
    JSON.stringify(bAdmin.items.map((i) => [i.caseId, i.status, i.lastError])),
  );
  const adminCalls = (await fetch(`${SITE}/api/auth/_stats`).then((r) => r.json())).calls.slice(beforeAdmin);
  check(
    '本运行登录了 admin 与 auditor 各一次（clientId 证据）',
    adminCalls.filter((c) => c === ADMIN_CLIENT_ID).length === 1 && adminCalls.filter((c) => c === AUDITOR_CLIENT_ID).length === 1,
    JSON.stringify(adminCalls),
  );
  const batchSpec = await createRun({
    title: 'e2e-auth-named',
    caseIds: ['portal/auth/workbench-admin'],
    params: AUTH_PARAMS,
    createdBy: 'e2etest',
  });
  const bSpec = await waitRun(batchSpec.id);
  check('auth: admin 用例使用 ADMIN_CLIENT_ID 登录并通过', bSpec.status === 'completed' && bSpec.passed === 1, JSON.stringify(bSpec.items.map((i) => [i.status, i.lastError])));
  // auth: none 不触发登录
  const beforeNone = await mockLoginTotal();
  const batchNone = await createRun({
    title: 'e2e-auth-none',
    caseIds: ['portal/auth/login-page'],
    params: AUTH_PARAMS,
    createdBy: 'e2etest',
  });
  const bNone = await waitRun(batchNone.id);
  check('auth: none 用例通过（未登录访问落在登录页）', bNone.status === 'completed' && bNone.passed === 1, JSON.stringify(bNone.items.map((i) => [i.status, i.lastError])));
  check('auth: none 不触发 mockLogin', (await mockLoginTotal()) - beforeNone === 0, `mockLogin 次数 ${(await mockLoginTotal()) - beforeNone}`);
  // 会话失效 → validate 失败 → 按原配方重登
  const beforeExpire = await mockLoginTotal();
  const batchExpire = await createRun({
    title: 'e2e-auth-relogin',
    caseIds: ['portal/auth/session-expire-relogin', 'portal/misc/version-module'],
    params: AUTH_PARAMS,
    createdBy: 'e2etest',
  });
  const bExpire = await waitRun(batchExpire.id);
  check(
    '会话失效后 validate 失败 → 重新登录，后续用例仍通过',
    bExpire.status === 'completed' && bExpire.passed === 2 && bExpire.total === 2,
    JSON.stringify(bExpire.items.map((i) => [i.caseId, i.status, i.lastError])),
  );
  check('失效重登恰好多打一次 mockLogin', (await mockLoginTotal()) - beforeExpire === 2, `mockLogin 次数 ${(await mockLoginTotal()) - beforeExpire}`);

  // ---- 运行3：登录失败路径（success:false / 缺变量）----
  console.log('[8] 登录失败路径：未授权设备 / 缺少凭据变量');
  const batchDenied = await createRun({
    title: 'e2e-auth-denied',
    caseIds: ['portal/auth/device-unauthorized'],
    params: AUTH_PARAMS, // BROKEN_CLIENT_ID 未绑定设备 → success:false
    createdBy: 'e2etest',
  });
  const bDenied = await waitRun(batchDenied.id);
  check(
    'mockLogin success:false → execution 记 AuthError 且含 msg，不开始跑用例',
    bDenied.items[0].status === 'error' && (bDenied.items[0].lastError ?? '').includes('设备未授权'),
    JSON.stringify(bDenied.items[0]),
  );
  const batchNoEnv = await createRun({
    title: 'e2e-auth-noenv',
    caseIds: ['portal/auth/missing-env'],
    params: AUTH_PARAMS, // 未提供 GHOST_CLIENT_ID
    createdBy: 'e2etest',
  });
  const bNoEnv = await waitRun(batchNoEnv.id);
  check(
    '缺失凭据占位符报 AuthError（含变量名）',
    bNoEnv.items[0].status === 'error' && (bNoEnv.items[0].lastError ?? '').includes('GHOST_CLIENT_ID'),
    JSON.stringify(bNoEnv.items[0]),
  );

  // ---- 旧 yaml 兼容（嵌套 form/api/storage 多 profile）----
  console.log('[9] 旧格式 tern.yaml（嵌套 profile）兼容读取与执行');
  const addLegacy = await api('POST', '/api/v1/projects', { gitUrl: `file://${SOURCE_REPO_LEGACY}` });
  check('添加旧格式项目返回 200', addLegacy.status === 200, JSON.stringify(addLegacy.json).slice(0, 300));
  check('旧格式项目同步入库 3 个用例', addLegacy.json.sync?.added === 3, JSON.stringify(addLegacy.json.sync));
  const batchLegacy = await createRun({
    title: 'e2e-legacy-auth',
    project: 'portal-legacy',
    module: ['auth'],
    params: AUTH_PARAMS,
    createdBy: 'e2etest',
  });
  const bLegacy = await waitRun(batchLegacy.id);
  check(
    '旧嵌套 form/api/storage 登录全部通过（兼容层归一）',
    bLegacy.status === 'completed' && bLegacy.passed === 3 && bLegacy.total === 3,
    JSON.stringify(bLegacy.items.map((i) => [i.caseId, i.status, i.lastError])),
  );

  // ---- 运行4：失败用例产物 ----
  console.log('[10] 失败用例产物（截图/trace/日志）');
  const batch3 = await createRun({
    title: 'e2e-fail',
    caseIds: ['portal/negative/deliberate-fail'],
    params: AUTH_PARAMS,
    createdBy: 'e2etest',
  });
  const b3 = await waitRun(batch3.id);
  check('故意失败用例状态 failed', b3.status === 'completed' && b3.failed === 1);
  const failedItem = b3.items.find((i) => i.status === 'failed');
  const failedRun = await api('GET', `/api/v1/executions/${failedItem.executionId}`).then((r) => r.json);
  check('execution 包含错误信息', (failedRun.error?.message ?? '').includes('toHaveText'));
  check('execution 产物清单包含失败截图', (failedRun.artifacts?.screenshots?.length ?? 0) >= 1);
  check('execution 产物清单包含 trace', !!failedRun.artifacts?.trace);
  const shotResp = await fetch(BASE + failedRun.artifacts.screenshots[0]);
  check('失败截图可下载且为 PNG', shotResp.status === 200 && (await shotResp.arrayBuffer()).byteLength > 1000);
  const traceResp = await fetch(BASE + failedRun.artifacts.trace);
  check('trace.zip 可下载', traceResp.status === 200);
  const logResp = await fetch(BASE + `/api/v1/executions/${failedItem.executionId}/logs`).then((r) => r.json());
  check('run.log 包含断言日志', (logResp.logs ?? '').includes('✗'), JSON.stringify((logResp.logs ?? '').slice(-300)));
  const reportResp = await fetch(BASE + `/artifacts/${batch3.id}/batch-report.json`);
  check('batch-report.json 生成', reportResp.status === 200);

  // ---- 缺失登录凭据 → 明确报错（已在 [8] 用 missing-env 用例覆盖）----

  // ---- 指定 worker ----
  console.log('[11] 运行指定 worker');
  const ghost = await createRun({ title: 'e2e-ghost', caseIds: ['portal/platform/selfcheck'], workerId: 'ghost-worker' }).catch((e) => e);
  check('指定不存在的 worker 返回 404', ghost instanceof Error && ghost.message.includes('404'), String(ghost).slice(0, 120));
  const batchW = await createRun({
    title: 'e2e-pinned-worker',
    caseIds: ['portal/platform/selfcheck'],
    workerId: 'e2e-worker-1',
    params: AUTH_PARAMS,
    createdBy: 'e2etest',
  });
  const bW = await waitRun(batchW.id);
  check('指定 worker（按名称）执行成功', bW.status === 'completed' && bW.passed === 1 && bW.workerId === workerInfo.id, JSON.stringify(bW.workerId));

  // ---- 重试语义 ----
  console.log('[12] 重试语义（maxAttempts=2）');
  const batch5 = await createRun({
    title: 'e2e-retry',
    caseIds: ['portal/negative/deliberate-fail'],
    maxAttempts: 2,
    createdBy: 'e2etest',
  });
  const b5 = await waitRun(batch5.id);
  const item5 = b5.items[0];
  check('失败用例按 maxAttempts 重试了 2 次', item5.attempt === 2 && item5.status === 'failed', `attempt=${item5.attempt}`);

  // ---- 取消 ----
  console.log('[13] 测试运行取消');
  const batch6 = await createRun({ title: 'e2e-cancel', project: 'portal', tags: ['slow'], params: AUTH_PARAMS, createdBy: 'e2etest' });
  await waitUntil(async () => {
    const { json } = await api('GET', `/api/v1/runs/${batch6.id}`);
    return json.items[0].status === 'running';
  }, 30000);
  await api('POST', `/api/v1/runs/${batch6.id}/cancel?force=true`);
  const b6 = await waitRun(batch6.id, 30000);
  check(
    '测试运行被取消',
    b6.status === 'cancelled' && b6.cancelled === 1,
    JSON.stringify({ status: b6.status, cancelled: b6.cancelled }),
  );

  // ---- 强制结束（pre-run 阶段，不等 running）----
  console.log('[13b] 强制结束（创建后立即中断）');
  const batch6b = await createRun({ title: 'e2e-force-abort', project: 'portal', tags: ['slow'], params: AUTH_PARAMS, createdBy: 'e2etest' });
  // 不等待进入 running：此刻条目可能 pending/claimed/running，强制结束都必须立即收敛
  const aborted = await api('POST', `/api/v1/runs/${batch6b.id}/cancel?force=true`);
  check('强制结束返回 200', aborted.status === 200, JSON.stringify(aborted.json).slice(0, 200));
  const b6b = await waitRun(batch6b.id, 30000);
  check(
    '强制结束立即收敛 cancelled',
    b6b.status === 'cancelled' && b6b.cancelled === 1,
    JSON.stringify({ status: b6b.status, cancelled: b6b.cancelled }),
  );
  // 槽位/在途执行被真中断：紧随其后的运行必须能正常完成（[14] 的重派场景建立在 worker 可用之上）
  const afterAbort = await createRun({ title: 'e2e-after-abort', project: 'portal', caseIds: ['portal/platform/selfcheck'], params: AUTH_PARAMS, createdBy: 'e2etest' });
  const bAfter = await waitRun(afterAbort.id, 90000);
  check(
    '强制结束后 worker 槽位即释放（后续运行正常执行）',
    bAfter.status === 'completed' && bAfter.passed === 1,
    JSON.stringify({ status: bAfter.status, passed: bAfter.passed }),
  );

  // ---- worker 崩溃重派 ----
  console.log('[14] worker 崩溃 → 任务重派');
  const batch7 = await createRun({ title: 'e2e-requeue', project: 'portal', tags: ['slow'], maxAttempts: 2, params: AUTH_PARAMS, createdBy: 'e2etest' });
  await waitUntil(async () => {
    const { json } = await api('GET', `/api/v1/runs/${batch7.id}`);
    return json.items[0].status === 'running';
  }, 30000);
  worker.kill('SIGKILL');
  worker = spawnProc('worker', ['apps/worker/dist/index.js'], {
    SERVER_URL: BASE,
    WORKER_TOKEN: TOKEN,
    WORKER_NAME: 'e2e-worker-1',
  });
  worker.stdout.on('data', (d) => workerLog.push(d.toString()));
  const b7 = await waitRun(batch7.id, 90000);
  check('新 worker 接手并完成被中断的用例', b7.status === 'completed' && b7.passed === 1, JSON.stringify(b7.items.map((i) => i.status)));

  // ---- 重跑失败 ----
  console.log('[15] retry-failed');
  const retryRes = await api('POST', `/api/v1/runs/${batch3.id}/retry-failed`);
  check(
    'retry-failed 创建新运行',
    retryRes.status === 200 && retryRes.json?.run?.total === 1 && retryRes.json.run.project === 'portal',
    JSON.stringify(retryRes.json).slice(0, 300),
  );
  const b8 = await waitRun(retryRes.json.run.id);
  check('重跑失败运行仍能正确执行（依旧失败）', b8.failed === 1);

  // ---- 重跑（全量）----
  console.log('[15b] rerun 全量重跑');
  const mixed = await createRun({
    title: 'e2e-mixed',
    caseIds: ['portal/platform/selfcheck', 'portal/negative/deliberate-fail'],
    params: AUTH_PARAMS,
    createdBy: 'e2etest',
  });
  const bMixed = await waitRun(mixed.id);
  check('混合运行 1 通过 1 失败', bMixed.passed === 1 && bMixed.failed === 1, JSON.stringify({ p: bMixed.passed, f: bMixed.failed }));
  const rerunRes = await api('POST', `/api/v1/runs/${mixed.id}/rerun`);
  check(
    'rerun 复跑全部用例（total=2，含通过项）',
    rerunRes.status === 200 && rerunRes.json?.run?.total === 2 && rerunRes.json.run.project === 'portal' && rerunRes.json.run.title.includes('重跑'),
    JSON.stringify(rerunRes.json).slice(0, 300),
  );
  const b9 = await waitRun(rerunRes.json.run.id);
  check('重跑运行完整执行（1 通过 1 失败）', b9.status === 'completed' && b9.passed === 1 && b9.failed === 1, JSON.stringify({ p: b9.passed, f: b9.failed }));
  const rerunMissing = await api('POST', `/api/v1/runs/b_notexist/rerun`);
  check('rerun 不存在的运行返回 404', rerunMissing.status === 404, JSON.stringify(rerunMissing.json).slice(0, 200));
  const notTerminal = await createRun({ title: 'e2e-rerun-guard', project: 'portal', tags: ['slow'], params: AUTH_PARAMS, createdBy: 'e2etest' });
  const rerun409 = await api('POST', `/api/v1/runs/${notTerminal.id}/rerun`);
  check('运行未结束时 rerun 返回 409', rerun409.status === 409, JSON.stringify(rerun409.json).slice(0, 200));
  await api('POST', `/api/v1/runs/${notTerminal.id}/cancel?force=true`);
  await waitRun(notTerminal.id, 30000);

  const listed = (await api('GET', '/api/v1/runs?project=portal&limit=20')).json;
  check(
    '测试运行列表分页默认 20 + 按 project 筛选',
    listed.limit === 20 && listed.total >= 1 && listed.items.every((r) => r.project === 'portal'),
    JSON.stringify({ limit: listed.limit, total: listed.total, n: listed.items.length }),
  );
  const listedStatus = (await api('GET', '/api/v1/runs?status=completed&createdBy=e2etest')).json;
  check('测试运行可按 status/createdBy 筛选', listedStatus.items.every((r) => r.status === 'completed' && r.createdBy === 'e2etest'));

  // ---- 自动定期拉取 ----
  console.log('[16] 自动定期拉取（PULL_INTERVAL_SEC=5）');
  writeFileSync(
    path.join(SOURCE_REPO, 'cases', 'misc', 'auto-pulled.spec.ts'),
    `/**
 * @tern
 * title: 自动拉取验证用例
 * tags: [auto]
 * version: v3
 * module: misc
 */
import { test, expect } from '@playwright/test';
test('auto pulled', async ({ page }) => {
  await page.setContent('<i id="a">ok</i>');
  await expect(page.locator('#a')).toHaveText('ok');
});
`,
  );
  gitSource('add -A');
  gitSource('commit -m auto --quiet');
  const autoPulled = await waitUntil(async () => {
    const { json } = await api('GET', '/api/v1/cases/portal/misc/auto-pulled');
    return json?.status === 'active' && json;
  }, 60000, 1000).catch(() => null);
  check('远端新增用例被自动拉取入库', !!autoPulled, '60s 内未发现 auto-pulled 用例');

  // ---- 环境管理（F1）----
  console.log('[16.5] 环境管理 / 失败摘要 / run 删除 / 钉钉通知 / flaky 隔离 / 定时任务');
  const envVars = (await api('GET', `/api/v1/projects/${project.id}/env-variables`)).json;
  check(
    '变量清单镜像（来自 tern.yaml env.variables）',
    envVars.variables.length === 4 && envVars.variables.find((v) => v.key === 'CLIENT_ID')?.secret === true,
    JSON.stringify(envVars.variables?.map((v) => `${v.key}:${v.secret}`)),
  );
  // 不完整环境：fail-fast
  await api('POST', `/api/v1/projects/${project.id}/environments`, {
    name: 'incomplete', values: { BASE_URL: SITE },
  }).catch(() => {});
  const incompleteRun = await api('POST', '/api/v1/runs', { project: 'portal', env: 'incomplete', tags: ['smoke'] });
  check('缺值环境创建 run 即报 400 MISSING_ENV_VALUES', incompleteRun?.status === 400 && incompleteRun?.json?.error?.code === 'MISSING_ENV_VALUES', JSON.stringify(incompleteRun?.json?.error?.code));
  // 完整环境（secret 值加密存储）
  const envResp = (await api('POST', `/api/v1/projects/${project.id}/environments`, {
    name: 'local',
    values: { BASE_URL: SITE, CLIENT_ID, ADMIN_CLIENT_ID, AUDITOR_CLIENT_ID },
  })).json;
  check('创建环境 local（4 值配齐）', envResp.environment?.complete === true, JSON.stringify(envResp));
  const envList = (await api('GET', `/api/v1/projects/${project.id}/environments`)).json;
  const localEnv = envList.items.find((e) => e.name === 'local');
  check('环境列表 secret 不回显', localEnv?.values.CLIENT_ID === null && localEnv?.values.BASE_URL === SITE, JSON.stringify(localEnv?.values));
  const loginBefore = await mockLoginTotal();
  const envRun = await createRun({ project: 'portal', env: 'local', tags: ['smoke'] });
  const envDone = await waitRun(envRun.id);
  check('环境 run 全部通过（secret 经平台注入 worker）', envDone.status === 'completed' && envDone.passed === envDone.total, JSON.stringify({ s: envDone.status, p: envDone.passed, t: envDone.total }));
  check('run 关联环境名 + params 脱敏（无 CLIENT_ID，有 BASE_URL）', envDone.envName === 'local' && !('CLIENT_ID' in envDone.params) && envDone.params.BASE_URL === SITE, JSON.stringify(envDone.params));
  check('mockLogin 收到真实 secret clientId（次数增加）', (await mockLoginTotal()) > loginBefore);

  // ---- 测试集（docs/test-suite-design.md）----
  console.log('[16.6] 测试集：CRUD / 多环境并跑 /（用例×环境）去重 / rerun / 冲突');
  const suiteA = (await api('POST', `/api/v1/projects/${project.id}/suites`, { name: 'smoke', description: '冒烟', selector: { tags: ['smoke'] }, env: 'local' })).json;
  check('创建测试集 smoke（env local，健康度 ok）', suiteA.suite?.name === 'smoke' && suiteA.suite?.health?.resolvedCount > 0 && suiteA.suite?.health?.envStatus === 'ok', JSON.stringify(suiteA.suite?.health));
  await api('POST', `/api/v1/projects/${project.id}/environments`, { name: 'local2', values: { BASE_URL: SITE, CLIENT_ID, ADMIN_CLIENT_ID, AUDITOR_CLIENT_ID } });
  const suiteB = (await api('POST', `/api/v1/projects/${project.id}/suites`, { name: 'platform-suite', selector: { q: 'platform' }, env: 'local2', account: 'admin' })).json;
  check('创建测试集 platform-suite（env local2，账号 admin）', suiteB.suite?.health?.resolvedCount > 0, JSON.stringify(suiteB.suite?.health));
  const preview = (await api('POST', '/api/v1/runs/preview', { project: 'portal', suites: ['smoke', 'platform-suite'] })).json;
  check('runs/preview 按环境分组合计', preview.contexts?.length === 2 && preview.total > 0, JSON.stringify(preview.contexts?.map((c) => [c.env, c.caseCount])));
  const suiteRun = await createRun({ project: 'portal', suites: ['smoke', 'platform-suite'] });
  const suiteRunDetail = (await api('GET', `/api/v1/runs/${suiteRun.id}`)).json;
  check(
    '多环境 run：条目按（用例×环境）去重落位 + 条目 env 就位',
    suiteRunDetail.total === preview.total && new Set(suiteRunDetail.items.map((i) => i.env)).size === 2,
    JSON.stringify({ t: suiteRunDetail.total, envs: [...new Set(suiteRunDetail.items.map((i) => i.env))] }),
  );
  check('RunInfo.suites/envs 派生 + scope 快照 envContexts', suiteRunDetail.suites?.length === 2 && suiteRunDetail.envs?.length === 2 && Array.isArray(suiteRunDetail.scope?.envContexts) && suiteRunDetail.scope.envContexts.length === 2);
  const suiteDone = await waitRun(suiteRun.id);
  check('多环境 run 全部通过（各上下文 secret 注入 worker）', suiteDone.status === 'completed' && suiteDone.passed === suiteDone.total, JSON.stringify({ s: suiteDone.status, p: suiteDone.passed, t: suiteDone.total }));
  const suiteRerun = (await api('POST', `/api/v1/runs/${suiteRun.id}/rerun`)).json;
  const rerunDetail = (await api('GET', `/api/v1/runs/${suiteRerun.run.id}`)).json;
  check('rerun 保留（用例×环境）构成', rerunDetail.total === suiteRunDetail.total && new Set(rerunDetail.items.map((i) => i.env)).size === 2, JSON.stringify({ t: rerunDetail.total }));
  const suiteFiltered = (await api('GET', '/api/v1/runs?suite=smoke&limit=5')).json;
  check('runs?suite= 筛选命中', suiteFiltered.items?.some((r) => r.id === suiteRun.id));
  await api('POST', `/api/v1/projects/${project.id}/suites`, { name: 'admin-suite', selector: { tags: ['smoke'] }, env: 'local', account: 'admin' });
  await api('POST', `/api/v1/projects/${project.id}/suites`, { name: 'auditor-suite', selector: { tags: ['smoke'] }, env: 'local', account: 'auditor' });
  const conflict = await api('POST', '/api/v1/runs', { project: 'portal', suites: ['admin-suite', 'auditor-suite'] });
  check('同环境账号冲突 → 400 SUITE_ACCOUNT_CONFLICT', conflict?.status === 400 && conflict?.json?.error?.code === 'SUITE_ACCOUNT_CONFLICT', JSON.stringify(conflict?.json?.error?.code));
  const flat = await createRun({ project: 'portal', suites: ['admin-suite', 'auditor-suite'], env: 'local', params: { AUTH_ACCOUNT: 'admin' } });
  const flatDone = await waitRun(flat.id);
  check('run 显式 env 覆盖拉平 + AUTH_ACCOUNT 解冲突', flatDone.status === 'completed' && flatDone.envName === 'local', JSON.stringify({ s: flatDone.status, env: flatDone.envName, t: flatDone.total }));
  const renamed = (await api('PATCH', `/api/v1/projects/${project.id}/suites/smoke`, { name: 'smoke-v2' })).json;
  check('测试集改名', renamed.suite?.name === 'smoke-v2');
  const del = await api('DELETE', `/api/v1/projects/${project.id}/suites/smoke-v2`);
  check('测试集删除', del?.status === 200);

  // ---- 失败摘要（F4）----
  const failRun = await createRun({ project: 'portal', caseIds: ['portal/negative/deliberate-fail'] });
  const failDone = await waitRun(failRun.id);
  const summary = (await api('GET', `/api/v1/runs/${failRun.id}/failure-summary`)).json;
  check(
    '失败摘要按签名分组 + 跨 run 历史',
    summary.groups.length >= 1 && summary.groups[0].count >= 1 && summary.groups[0].history.occurrenceRuns >= 1 && summary.groups[0].items[0].executionId,
    JSON.stringify(summary.groups?.map((g) => [g.label, g.count, g.history])),
  );
  check('失败摘要 label 无 ANSI 色码', !String(summary.groups[0].label + (summary.groups[0].items[0].error?.message ?? '')).includes('\x1b['), JSON.stringify(summary.groups[0].label));

  // ---- trace 轻量查看（F3 修订：非 SW 依赖，http://<IP> 可用）----
  const failExecId = summary.groups[0].items[0].executionId;
  const traceView = (await api('GET', `/api/v1/executions/${failExecId}/trace-view`)).json;
  check(
    'trace-view API：动作时间线解析（before/after → actions）',
    Array.isArray(traceView.actions) && traceView.actions.length > 0,
    JSON.stringify({ n: traceView.actions?.length, first: traceView.actions?.[0]?.title }),
  );
  check('trace-view API：动作错误已清洗（无 ANSI）', (traceView.actions ?? []).every((a) => !String(a.error ?? '').includes('\x1b[')));

  // ---- 钉钉通知（F7）：本地假端点断言加签与 payload ----
  const dingHits = [];
  const dingServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      dingHits.push({ query: u.searchParams, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
    });
  });
  await new Promise((r) => dingServer.listen(7556, '127.0.0.1', r));
  const DING_SECRET = 'SECe2etest';
  await api('POST', '/api/v1/webhooks', { project: 'portal', url: 'http://127.0.0.1:7556/ding', secret: DING_SECRET, notifyOn: 'failure' });
  const notifyRun = await createRun({ project: 'portal', caseIds: ['portal/negative/deliberate-fail'], title: '通知验证' });
  await waitRun(notifyRun.id);
  const ding = await waitUntil(() => dingHits.find((h) => h.body?.markdown?.text?.includes('通知验证')), 20000, 500).catch(() => null);
  check('钉钉 webhook 收到 markdown 通知', !!ding, JSON.stringify(dingHits.length));
  if (ding) {
    const ts = ding.query.get('timestamp');
    const sign = ding.query.get('sign');
    // searchParams.get 已做一次 URL 解码，期望值为原始 base64
    const expect = crypto.createHmac('sha256', DING_SECRET).update(`${ts}\n${DING_SECRET}`).digest('base64');
    check('钉钉加签正确（HMAC-SHA256）', sign === expect, `sign=${sign?.slice(0, 20)}… expect=${expect.slice(0, 20)}…`);
    check('通知含统计与链接', ding.body.markdown.text.includes('✗1') && ding.body.markdown.text.includes('/runs/'), ding.body.markdown.text.slice(0, 120));
  }
  dingServer.close();

  // ---- flaky 隔离（F5）----
  await api('PATCH', '/api/v1/cases/portal/platform/slow-page', { quarantined: true });
  const quarantinedRun = await createRun({ project: 'portal', module: ['platform'] });
  check('隔离用例默认被排除（module=platform 命中 2 隔离 1 → total 1）', quarantinedRun.total === 1, JSON.stringify(quarantinedRun?.total));
  check('run scope 记录 excludedQuarantined', quarantinedRun.scope.excludedQuarantined === 1);
  await api('PATCH', '/api/v1/cases/portal/platform/slow-page', { quarantined: false });
  await cancelRunQuietly(quarantinedRun.id);

  // ---- run 删除（F2）----
  const delRunId = failRun.id;
  const delArtifactsDir = path.join(DATA, 'artifacts', delRunId);
  const runDelResp = (await api('DELETE', `/api/v1/runs/${delRunId}`)).json;
  const afterDel = await api('GET', `/api/v1/runs/${delRunId}`).catch((e) => e);
  check(
    '删除 run：记录 404 + 产物目录清理',
    runDelResp.removedExecutions >= 1 && afterDel?.status === 404 && !existsSync(delArtifactsDir),
    JSON.stringify({ removedExecutions: runDelResp.removedExecutions, http: afterDel?.status, dir: existsSync(delArtifactsDir) }),
  );

  // ---- 定时任务（F6）：创建/暂停/推进（不真等触发）----
  const sched = (await api('POST', '/api/v1/schedules', {
    project: 'portal', name: 'e2e 冒烟', cron: '0 3 * * *', env: 'local', scope: { tags: ['smoke'] },
  })).json;
  check('创建定时任务（next_run_at 为未来时间）', sched.schedule?.enabled === true && Date.parse(sched.schedule.nextRunAt) > Date.now(), JSON.stringify(sched.schedule?.nextRunAt));
  const paused = (await api('PATCH', `/api/v1/schedules/${sched.schedule.id}`, { enabled: false })).json;
  check('暂停定时任务', paused.schedule.enabled === false);
  check('定时任务列表可查', ((await api('GET', '/api/v1/schedules')).json.items ?? []).some((x) => x.id === sched.schedule.id));
  await api('DELETE', `/api/v1/schedules/${sched.schedule.id}`);

  // ---- 测试资产与设备输入（F8）----
  console.log('[16.55] 测试资产 / fake 设备推流');
  const assetList = (await api('GET', `/api/v1/projects/${project.id}/assets`)).json;
  const toneAsset = assetList.items.find((a) => a.path === 'audio/tone.wav');
  check('资产同步入库（audio/tone.wav）', !!toneAsset && toneAsset.bytes === 44 + 5 * 16000 * 2 && toneAsset.status === 'active', JSON.stringify(assetList.items));
  const assetResp = await fetch(`${BASE}/api/v1/assets/${toneAsset.hash}`, { headers: { 'x-worker-token': TOKEN } });
  check('资产下载端点（worker 鉴权，返回 RIFF/WAVE）', assetResp.ok && (await assetResp.arrayBuffer()).byteLength === toneAsset.bytes);
  const mediaCase = (await api('GET', '/api/v1/cases/portal/media/asset-seed-upload')).json;
  check('用例详情携带 assetRefs / devices', JSON.stringify(mediaCase.assetRefs) === JSON.stringify(['audio/tone.wav']) && mediaCase.devices === null, JSON.stringify({ refs: mediaCase.assetRefs, devices: mediaCase.devices }));
  const micCase = (await api('GET', '/api/v1/cases/portal/media/fake-mic-record')).json;
  check('devices.mic 用例解析', micCase.devices && micCase.devices.mic === 'audio/tone.wav', JSON.stringify(micCase.devices));

  // ternAsset 播种用例（node 侧读随行文件 → multipart 上传）
  const seedRun = await createRun({
    project: 'portal', caseIds: ['portal/media/asset-seed-upload'],
    params: { BASE_URL: SITE }, createdBy: 'e2etest',
  });
  const seedDone = await waitRun(seedRun.id);
  check('ternAsset 随行文件 + API 播种上传通过', seedDone.status === 'completed' && seedDone.passed === 1, JSON.stringify({ s: seedDone.status, p: seedDone.passed }));

  // devices.mic 文件推流：fake 麦克风采到真实音频（MediaRecorder 录到字节数）
  const micRun = await createRun({
    project: 'portal', caseIds: ['portal/media/fake-mic-record'],
    params: { BASE_URL: SITE }, createdBy: 'e2etest',
  });
  const micDone = await waitRun(micRun.id, 180000);
  check('fake 麦克风文件推流录到音频（bytes≥10000）', micDone.status === 'completed' && micDone.passed === 1, JSON.stringify({ s: micDone.status, p: micDone.passed, items: micDone.items?.map((i) => [i.status, i.lastError?.slice(0, 120)]) }));

  // ---- F9 设备反向代理（docs/device-proxy-design.md，环境级配置）----
  console.log('[16.56] 设备反向代理（环境级配置：HTTP 内网地址 → worker 本机 127.0.0.1，secure context）');
  const lanIface = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  const lanSite = lanIface ? `http://${lanIface.address}:${SITE_PORT}` : null;
  check('找到本机内网 IPv4（demo-site 监听 0.0.0.0）', !!lanSite, lanSite ?? '无内网地址（跳过仅提示）');
  if (lanSite) {
    check('环境默认 deviceProxy=auto', localEnv?.deviceProxy === 'auto', JSON.stringify(localEnv?.deviceProxy));

    // 内网 IP 直连是非安全源：无代理时 getUserMedia 被浏览器禁止，device 用例必挂；
    // 环境开启后 worker 自动经 127.0.0.1 代理访问 → secure context → 录音可用
    await api('PATCH', `/api/v1/projects/${project.id}/environments/local`, { deviceProxy: 'on' });
    const proxyRun = await createRun({
      project: 'portal', caseIds: ['portal/media/fake-mic-record'],
      env: 'local', params: { BASE_URL: lanSite }, createdBy: 'e2etest',
    });
    const proxyDone = await waitRun(proxyRun.id, 180000);
    check('内网 IP + 环境代理 on：fake 麦克风用例通过（secure context 经代理成立）', proxyDone.status === 'completed' && proxyDone.passed === 1, JSON.stringify({ s: proxyDone.status, p: proxyDone.passed, items: proxyDone.items?.map((i) => [i.status, i.lastError?.slice(0, 120)]) }));
    check('run 参数 BASE_URL 保持原始值（代理改写在 worker 侧进行，参数快照不动）', proxyDone.params.BASE_URL === lanSite, JSON.stringify(proxyDone.params));
    const proxiedItem = proxyDone.items?.find((i) => i.executionId);
    const proxiedExec = proxiedItem ? (await api('GET', `/api/v1/executions/${proxiedItem.executionId}`)).json : null;
    const proxyLogLine = (proxiedExec?.logTail ?? []).find((l) => String(l).includes('设备代理:'));
    check('执行日志记录设备代理事件（127.0.0.1 → 内网 origin）', !!proxyLogLine, String(proxyLogLine ?? '未找到'));

    // off 负向对照：非安全源直连，getUserMedia 被禁 → 用例失败（开关确实生效）
    await api('PATCH', `/api/v1/projects/${project.id}/environments/local`, { deviceProxy: 'off' });
    const directRun = await createRun({
      project: 'portal', caseIds: ['portal/media/fake-mic-record'],
      env: 'local', params: { BASE_URL: lanSite }, createdBy: 'e2etest',
    });
    const directDone = await waitRun(directRun.id, 240000);
    check('off 对照：内网 IP 直连 device 用例失败（无 secure context）', directDone.failed === 1, JSON.stringify({ s: directDone.status, f: directDone.failed }));
    await api('PATCH', `/api/v1/projects/${project.id}/environments/local`, { deviceProxy: 'auto' });
    const envListRestored = (await api('GET', `/api/v1/projects/${project.id}/environments`)).json;
    check('环境恢复 deviceProxy=auto', envListRestored.items.find((e) => e.name === 'local')?.deviceProxy === 'auto');
  }

  // ---- 用例级 trace 覆盖（frontmatter trace → cases.trace_mode → 下发 options.trace）----
  console.log('[16.57] 用例级 trace 覆盖');
  {
    const caseList = (await api('GET', `/api/v1/cases?project=${project.name}&status=active&limit=100`)).json;
    check('未声明 trace 的用例 traceMode=null（跟随运行级）', caseList.items.every((c) => c.traceMode == null));
    // 源仓库写入 trace: off / 非法值两个用例 → commit → sync → 元数据落库
    const offPath = path.join(SOURCE_REPO, 'cases', 'platform', 'trace-off.spec.ts');
    const badPath = path.join(SOURCE_REPO, 'cases', 'platform', 'trace-bad.spec.ts');
    writeFileSync(offPath, `/**
 * @tern
 * title: trace 覆盖检查用例
 * tags: [api]
 * trace: off
 */
import { test, expect } from '@playwright/test';
test('t', async () => { expect(1).toBe(1); });
`);
    writeFileSync(badPath, `/**
 * @tern
 * title: trace 非法值检查
 * tags: [api]
 * trace: whatever
 */
import { test, expect } from '@playwright/test';
test('t', async () => { expect(1).toBe(1); });
`);
    gitSource('add -A');
    gitSource('commit -m trace-cases --quiet');
    await api('POST', `/api/v1/projects/${project.id}/sync`);
    const after = (await api('GET', `/api/v1/cases?project=${project.name}&status=*&limit=100`)).json;
    const tc = after.items.find((c) => c.caseId === 'portal/platform/trace-off');
    check('frontmatter trace:off 同步后 traceMode=off', tc?.traceMode === 'off', JSON.stringify(tc?.traceMode));
    const bad = after.items.find((c) => c.caseId === 'portal/platform/trace-bad');
    check('trace 非法值 → 用例 invalid 且报错可读', bad?.status === 'invalid' && /trace 只允许/.test(bad?.lastError || ''), JSON.stringify({ s: bad?.status, e: (bad?.lastError || '').slice(0, 80) }));
    rmSync(offPath, { force: true });
    rmSync(badPath, { force: true });
    gitSource('add -A');
    gitSource('commit -m trace-cases-remove --quiet');
    await api('POST', `/api/v1/projects/${project.id}/sync`);
  }

  // ---- 项目移除 ----
  console.log('[17] 项目移除');
  const metaBefore = (await api('GET', '/api/v1/meta')).json;
  check('移除前用例数正确（18 = 14 + auto-pulled + 3 legacy）', metaBefore.stats.activeCases === 18, `got ${metaBefore.stats.activeCases}`);

  // ---- MCP ----
  console.log('[18] MCP 协议');
  const mcp = spawnProc('mcp', ['apps/mcp/dist/index.js'], { TERN_URL: BASE });
  const mcpResult = await (async () => {
    let buf = '';
    const pending = new Map();
    let nextId = 1;
    mcp.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
          }
        } catch { /* ignore */ }
      }
    });
    const rpc = (method, params) =>
      new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2etest', version: '0' },
    });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = await rpc('tools/list', {});
    const runCases = await rpc('tools/call', {
      name: 'tern_run_cases',
      arguments: { caseIds: ['portal/platform/selfcheck'], wait: true, title: 'mcp-batch', params: AUTH_PARAMS },
    });
    return { tools, runCases };
  })();
  const toolNames = (mcpResult.tools?.result?.tools ?? []).map((t) => t.name);
  check('MCP tools/list 返回 27 个工具（含项目管理/环境/失败摘要/定时任务/测试集）', toolNames.length === 27, `got ${toolNames.length}: ${toolNames.join(',')}`);
  check('MCP 含 tern_add_project / tern_list_runs / tern_get_execution', toolNames.includes('tern_add_project') && toolNames.includes('tern_list_runs') && toolNames.includes('tern_get_execution'));
  check('MCP 含测试集工具 tern_list_suites / tern_create_suite / tern_preview_run', toolNames.includes('tern_list_suites') && toolNames.includes('tern_create_suite') && toolNames.includes('tern_preview_run'));
  const runText = JSON.stringify(mcpResult.runCases);
  check('MCP tern_run_cases 执行成功（wait 语义）', runText.includes('passed=1'), runText.slice(0, 400));
  mcp.kill();

  // ---- CLI ----
  console.log('[19] tern CLI');
  const cliProjects = spawnProc('cli', ['packages/cli/dist/index.js', 'projects', 'list', '--json'], { TERN_URL: BASE });
  const projectsOut = await new Promise((resolve) => {
    let out = '';
    cliProjects.stdout.on('data', (d) => (out += d.toString()));
    cliProjects.on('exit', () => resolve(out));
  });
  check('CLI projects list 输出 portal', projectsOut.includes('"name": "portal"') || projectsOut.includes('portal'));
  const cliFilter = spawnProc('cli', ['packages/cli/dist/index.js', 'cases', 'list', '--version', 'v2', '--json'], { TERN_URL: BASE });
  const filterOut = await new Promise((resolve) => {
    let out = '';
    cliFilter.stdout.on('data', (d) => (out += d.toString()));
    cliFilter.on('exit', () => resolve(out));
  });
  check('CLI cases list --version v2 命中 10 条（portal 7 + legacy 3）', filterOut.includes('"total": 10'), filterOut.slice(-200));
  const cliRun = spawnProc('cli', ['packages/cli/dist/index.js', 'run', '--case', 'portal/platform/selfcheck', '--params', `BASE_URL=${SITE},CLIENT_ID=${CLIENT_ID}`, '--wait', '--json'], {
    TERN_URL: BASE,
  });
  const cliOut = await new Promise((resolve) => {
    let out = '';
    cliRun.stdout.on('data', (d) => (out += d.toString()));
    cliRun.on('exit', (code) => resolve({ code, out }));
  });
  check('CLI run --wait 退出码 0（全通过）', cliOut.code === 0, `code=${cliOut.code}`);
  check('CLI run 输出 JSON 包含 passed', cliOut.out.includes('"passed": 1'));
  const cliFail = spawnProc('cli', ['packages/cli/dist/index.js', 'failures', batch3.id], { TERN_URL: BASE });
  const cliFailCode = await new Promise((resolve) => cliFail.on('exit', resolve));
  check('CLI failures 对失败运行返回非零退出码', cliFailCode === 1, `code=${cliFailCode}`);

  // ---- Web 静态托管 ----
  console.log('[20] Web 管理端静态资源');
  const indexResp = await fetch(BASE + '/');
  const indexHtml = await indexResp.text();
  check('server 托管 Web 首页', indexResp.status === 200 && indexHtml.includes('<div id="root">'));
  const assetMatch = indexHtml.match(/src="(\/assets\/[^"]+\.js)"/);
  const assetOk = assetMatch ? (await fetch(BASE + assetMatch[1])).status === 200 : false;
  check('Web JS 资源可加载', assetOk);

  // ---- 项目改名（PATCH {name} → 自动重新同步，caseId 前缀切换）----
  console.log('[20b] 项目改名');
  const legacyRow = (await api('GET', '/api/v1/projects')).json.find((p) => p.name === 'portal-legacy');
  const legacyId = legacyRow.id;
  const badName = await api('PATCH', `/api/v1/projects/${legacyId}`, { name: 'Bad_Name' });
  check('非法项目名返回 400', badName.status === 400, JSON.stringify(badName.json).slice(0, 200));
  const dupName = await api('PATCH', `/api/v1/projects/${legacyId}`, { name: 'portal' });
  check('重名返回 409', dupName.status === 409, JSON.stringify(dupName.json).slice(0, 200));
  const projRenamed = await api('PATCH', `/api/v1/projects/${legacyId}`, { name: 'portal-legacy-2' });
  check(
    '改名返回 200 且带回重新同步结果',
    projRenamed.status === 200 && projRenamed.json?.project?.name === 'portal-legacy-2' && projRenamed.json?.sync?.added > 0,
    JSON.stringify(projRenamed.json).slice(0, 300),
  );
  check(
    'caseId 前缀随注册名切换（新前缀入索引、旧前缀下线）',
    projRenamed.json?.sync?.removed > 0 &&
      (await api('GET', '/api/v1/cases?project=portal-legacy-2')).json.total > 0 &&
      (await api('GET', '/api/v1/cases?project=portal-legacy')).json.total === 0,
    `sync=${JSON.stringify(projRenamed.json?.sync)}`,
  );
  const renamedBack = await api('PATCH', `/api/v1/projects/${legacyId}`, { name: 'portal-legacy' });
  check(
    '改回原名后 caseId 复原（软删除行复活计 updated）',
    renamedBack.status === 200 &&
      renamedBack.json?.sync?.updated > 0 &&
      renamedBack.json?.sync?.removed > 0 &&
      (await api('GET', '/api/v1/cases?project=portal-legacy')).json.total > 0,
    `sync=${JSON.stringify(renamedBack.json?.sync)}`,
  );

  // ---- 清理 ----
  const delResp = await api('DELETE', `/api/v1/projects/${project.id}?removeFiles=true`);
  check('移除项目（含 clone 目录）', delResp.status === 200 && !existsSync(path.join(REPOS, 'portal')));
  const delLegacy = await api('DELETE', `/api/v1/projects/${legacyRow.id}?removeFiles=true`);
  check('移除旧格式项目（含 clone 目录）', delLegacy.status === 200 && !existsSync(path.join(REPOS, 'portal-legacy')));
  check('移除后用例下线', (await api('GET', '/api/v1/meta')).json.stats.activeCases === 0);

  server.kill('SIGTERM');
  worker.kill('SIGTERM');
  if (failCount === 0) {
    await rm(DATA, { recursive: true, force: true }).catch(() => {});
  } else {
    console.log(`（保留数据目录用于排查: ${DATA}）`);
  }

  console.log(`\n== 结果: ${passCount} 通过, ${failCount} 失败 ==`);
  if (failures.length) {
    console.log('失败项:', failures.join(' | '));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
