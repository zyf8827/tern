import type { Config } from './config.js';
import type { Database } from 'better-sqlite3';
import type { EventBus } from './events.js';
import type { Logger } from 'pino';
import type { WebSocket } from 'ws';
import { ulid } from 'ulid';
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ApiError } from './errors.js';
import { getRun } from './queries.js';
import { checkAuthRef, readAuthSnapshot, resolveAuthSpec } from './auth-config.js';
import { resolveRunSelector, resolveSuiteSelector } from './selector.js';
import { projectDir, type ProjectRow } from './repos.js';
import { resolveEnvParams } from './envs.js';
import { decryptJson, encryptJson, getSecretKey } from './crypto.js';
// error-sig placeholder
import { stripAnsi } from './ansi.js';
// flaky placeholder
// notifier placeholder
import type {
  AuthSnapshot,
  AuthSpec,
  CancelMsg,
  RunOptions,
  CreateRunPayload,
  ResultMsg,
  RunEvent,
  WorkerHello,
} from '@tern/sdk';

export interface WorkerConn {
  id: string;
  name: string;
  socket: WebSocket | null;
  maxSlots: number;
  busySlots: number;
  browsers: string[];
  agentVersion: string;
  playwrightVersion: string;
  online: boolean;
  lastSeen: number;
  ip: string;
}

export interface LiveRun {
  runId: string;
  runToken: string;
  batchId: string;
  itemId: string;
  caseId: string;
  workerId: string;
  dir: string;
  assignedAt: number;
  accepted: boolean;
  orphanSince: number | null;
}

export interface Runtime {
  cfg: Config;
  db: Database;
  events: EventBus;
  log: Logger;
  workers: Map<string, WorkerConn>;
  runs: Map<string, LiveRun>;
  frames: Map<string, Map<string, { data: string; ts: number; label?: string }>>;
  watchers: Map<string, number>;
  /** 强制取消补发队列：取消时 worker 不在线（或发送失败），cancel 报文入队，等它下次 hello 时补发 */
  pendingCancels: Map<string, Set<string>>;
}

const TERMINAL_ITEM = new Set(['passed', 'failed', 'timed_out', 'error', 'skipped', 'cancelled']);
const REQUEUEABLE = new Set(['failed', 'timed_out', 'error', 'lost']);
const envInt = (n: string, d: number) => {
  const v = Number(process.env[n]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
const LEASE_MS = envInt('TERN_LEASE_MS', 60_000);
const HEARTBEAT_TIMEOUT_MS = envInt('TERN_HEARTBEAT_TIMEOUT_MS', 30_000);
const ORPHAN_GRACE_MS = envInt('TERN_ORPHAN_GRACE_MS', 60_000);

export function nowISO(): string {
  return new Date().toISOString();
}

/** 确保产物目录存在（run.log / events.jsonl 同步追加写，无 flush 竞态） */
export function ensureRunDir(run: LiveRun): void {
  mkdirSync(run.dir, { recursive: true });
}

/** 从 DB 恢复一个 LiveRun（server 重启后收到事件/结果时懒重建） */
export function reviveRun(rt: Runtime, runId: string): LiveRun | null {
  const row = rt.db.prepare('SELECT * FROM case_runs WHERE id = ?').get(runId) as
    | {
        id: string;
        run_token: string;
        batch_id: string;
        batch_item_id: string;
        case_id: string;
        worker_id: string;
        status: string;
      }
    | undefined;
  if (!row || row.status !== 'running') return null;
  const existing = rt.runs.get(runId);
  if (existing) return existing;
  const run: LiveRun = {
    runId,
    runToken: row.run_token,
    batchId: row.batch_id,
    itemId: row.batch_item_id,
    caseId: row.case_id,
    workerId: row.worker_id ?? '',
    dir: path.join(rt.cfg.artifactsDir, row.batch_id, runId),
    assignedAt: Date.now(),
    accepted: true,
    orphanSince: Date.now(),
  };
  rt.runs.set(runId, run);
  return run;
}

// ---------- Worker 生命周期 ----------

export function handleHello(rt: Runtime, socket: WebSocket, ip: string, msg: WorkerHello): void {
  if (msg.playwrightVersion === 'unknown') {
    socket.send(
      JSON.stringify({
        type: 'hello_reject',
        reason: 'worker 未上报 playwright 版本',
      } satisfies { type: 'hello_reject'; reason: string }),
    );
    return;
  }
  let row = rt.db.prepare('SELECT id FROM workers WHERE name = ?').get(msg.name) as
    { id: string } | undefined;
  const now = nowISO();
  if (!row) {
    const id = `w_${ulid()}`;
    rt.db
      .prepare(
        `INSERT INTO workers (id, name, hostname, ip, agent_version, playwright_version, capabilities, status, last_heartbeat_at, registered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'online', ?, ?)`,
      )
      .run(
        id,
        msg.name,
        msg.name,
        ip,
        msg.version,
        msg.playwrightVersion,
        JSON.stringify(msg.capabilities),
        now,
        now,
      );
    row = { id };
  } else {
    rt.db
      .prepare(
        `UPDATE workers SET ip=?, agent_version=?, playwright_version=?, capabilities=?, status='online', last_heartbeat_at=? WHERE id=?`,
      )
      .run(ip, msg.version, msg.playwrightVersion, JSON.stringify(msg.capabilities), now, row.id);
  }

  const prev = rt.workers.get(row.id);
  if (prev?.socket && prev.socket !== socket) {
    try {
      prev.socket.close(4000, 'replaced');
    } catch {
      /* ignore */
    }
  }
  rt.workers.set(row.id, {
    id: row.id,
    name: msg.name,
    socket,
    maxSlots: Math.max(1, msg.capabilities?.maxSlots ?? 1),
    busySlots: 0,
    browsers: msg.capabilities?.browsers ?? ['chromium'],
    agentVersion: msg.version,
    playwrightVersion: msg.playwrightVersion,
    online: true,
    lastSeen: Date.now(),
    ip,
  });

  // 重连 re-attach：worker 带回 lastRunId
  if (msg.lastRunId) {
    const run = reviveRun(rt, msg.lastRunId);
    if (run) {
      run.orphanSince = null;
      run.workerId = row.id;
    }
  }

  // 强制取消补发：该 worker 不在线时入队的 cancel 报文此时投递（重连后继续跑已取消用例的兜底）
  const queued = rt.pendingCancels.get(row.id);
  if (queued?.size) {
    const undelivered = new Set<string>();
    for (const runId of queued) {
      try {
        socket.send(JSON.stringify({ type: 'cancel', runId } satisfies CancelMsg));
      } catch {
        undelivered.add(runId);
      }
    }
    if (undelivered.size > 0) {
      rt.pendingCancels.set(row.id, undelivered);
    } else {
      rt.pendingCancels.delete(row.id);
    }
  }

  socket.send(
    JSON.stringify({
      type: 'hello_ack',
      workerId: row.id,
      // 心跳间隔为超时阈值的 1/3，保证慢配置（如测试环境）下不误判离线
      heartbeatIntervalMs: Math.max(1000, Math.floor(HEARTBEAT_TIMEOUT_MS / 3)),
    }),
  );
  rt.events.emit('workers', 'worker.updated', workerPublic(row.id, rt));
  rt.log.info({ worker: msg.name, id: row.id }, 'worker online');
}

export function workerPublic(workerId: string, rt: Runtime) {
  const row = rt.db.prepare('SELECT * FROM workers WHERE id = ?').get(workerId) as
    Record<string, unknown> | undefined;
  return row ?? { id: workerId };
}

export function markWorkerOffline(rt: Runtime, workerId: string): void {
  const conn = rt.workers.get(workerId);
  if (conn) {
    conn.online = false;
    conn.socket = null;
    for (const run of rt.runs.values()) {
      if (run.workerId === workerId && run.accepted && run.orphanSince === null) {
        run.orphanSince = Date.now();
      }
    }
  }
  rt.db
    .prepare(`UPDATE workers SET status='offline', current_run_id=NULL WHERE id=?`)
    .run(workerId);
  rt.events.emit('workers', 'worker.updated', workerPublic(workerId, rt));
  rt.log.info({ workerId }, 'worker offline');
}

// ---------- 调度 ----------

export function schedulerTick(rt: Runtime): void {
  const db = rt.db;

  // 1. 租约到期 → requeue
  const expired = db
    .prepare(
      `SELECT * FROM batch_items WHERE status='claimed' AND lease_until IS NOT NULL AND lease_until < ?`,
    )
    .all(nowISO()) as { id: string; claimed_worker_id: string | null }[];
  for (const item of expired) {
    const runRow = db
      .prepare(
        `SELECT id FROM case_runs WHERE batch_item_id=? AND status='running' ORDER BY attempt DESC LIMIT 1`,
      )
      .get(item.id) as { id: string } | undefined;
    if (runRow) {
      db.prepare(`UPDATE case_runs SET status='lost', finished_at=? WHERE id=?`).run(
        nowISO(),
        runRow.id,
      );
      rt.runs.delete(runRow.id);
    }
    db.prepare(
      `UPDATE batch_items SET status='pending', claimed_worker_id=NULL, lease_until=NULL WHERE id=?`,
    ).run(item.id);
    if (item.claimed_worker_id) {
      const conn = rt.workers.get(item.claimed_worker_id);
      if (conn) conn.busySlots = Math.max(0, conn.busySlots - 1);
    }
    broadcastItem(rt, item.id);
  }

  // 2. 心跳超时 → offline
  for (const conn of rt.workers.values()) {
    if (conn.online && Date.now() - conn.lastSeen > HEARTBEAT_TIMEOUT_MS) {
      try {
        conn.socket?.close(4001, 'heartbeat timeout');
      } catch {
        /* ignore */
      }
      markWorkerOffline(rt, conn.id);
    }
  }

  // 3. 孤儿 run 超宽限 → requeue / lost
  for (const run of rt.runs.values()) {
    if (
      run.accepted &&
      run.orphanSince !== null &&
      Date.now() - run.orphanSince > ORPHAN_GRACE_MS
    ) {
      failOrRequeueLost(rt, run);
    }
  }

  // 4. 派发
  const idleWorkers = [...rt.workers.values()].filter(
    (w) => w.online && w.socket !== null && w.busySlots < w.maxSlots,
  );
  if (idleWorkers.length === 0) return;
  const pending = db
    .prepare(
      `SELECT bi.*, b.created_at AS batch_created, b.worker_id AS batch_worker_id
       FROM batch_items bi JOIN batches b ON b.id = bi.batch_id
       WHERE bi.status='pending' ORDER BY b.created_at, bi.position LIMIT 200`,
    )
    .all() as ItemRow[];
  for (const item of pending) {
    // 批次指定了 worker 时只派给该 worker（不在线/满载则留在队列等待）
    const eligible = item.batch_worker_id
      ? idleWorkers.filter((w) => w.id === item.batch_worker_id)
      : idleWorkers;
    const worker = eligible
      .filter((w) => w.busySlots < w.maxSlots)
      .sort((a, b) => a.busySlots - b.busySlots)[0];
    if (!worker) continue;
    assignRun(rt, worker, item);
    worker.busySlots++;
  }
}

interface ItemRow {
  id: string;
  batch_id: string;
  case_id: string;
  position: number;
  status: string;
  attempt: number;
  max_attempts: number;
  batch_worker_id?: string | null;
  /** 多环境上下文（测试集）条目的 run_envs 行；NULL = 沿用 batches 级参数 */
  run_env_id?: number | null;
}

/** 解析用例的登录说明：run 的 auth 快照（scope.auth）+ frontmatter auth 名 + AUTH_ACCOUNT 运行参数 */
function resolveCaseAuth(
  db: Runtime['db'],
  rt: Runtime,
  batch: { scope: string; project: string | null },
  authRef: string | null,
  params: Record<string, string>,
): AuthSpec | null {
  let snapshot: AuthSnapshot | null = null;
  try {
    const scope = JSON.parse(batch.scope || '{}') as { auth?: AuthSnapshot };
    if (
      scope.auth &&
      typeof scope.auth === 'object' &&
      (scope.auth.kind === 'single' || scope.auth.kind === 'multi')
    ) {
      snapshot = scope.auth;
    }
  } catch {
    /* scope 损坏时走回退 */
  }
  if (!snapshot) {
    // 老 run 无快照 → 回退读项目当前 auth（读取时归一化，兼容旧嵌套形态）
    const projectRow = batch.project
      ? (db.prepare('SELECT * FROM projects WHERE name = ?').get(batch.project) as
          ProjectRow | undefined)
      : undefined;
    snapshot = projectRow
      ? readAuthSnapshot(projectDir(rt, projectRow))
      : { kind: 'multi', recipe: null, profiles: {} };
  }
  return resolveAuthSpec(snapshot, authRef, params.AUTH_ACCOUNT);
}

function assignRun(rt: Runtime, worker: WorkerConn, item: ItemRow): void {
  const db = rt.db;
  const now = nowISO();
  const batch = db
    .prepare(
      'SELECT max_attempts, params, params_secret, options, scope, project, status, device_proxy FROM batches WHERE id=?',
    )
    .get(item.batch_id) as {
    max_attempts: number;
    params: string;
    params_secret: string | null;
    options: string;
    scope: string;
    project: string | null;
    status: string;
    device_proxy: 'auto' | 'on' | 'off' | null;
  };
  // 多环境上下文：条目自己的参数基底（环境值 + 集级参数，创建时快照），run 级显式参数最后覆盖
  let ctxParams: Record<string, string> = {};
  let ctxSecret: Record<string, string> = {};
  let deviceProxy: 'auto' | 'on' | 'off' = batch.device_proxy ?? 'auto';
  if (item.run_env_id) {
    const ctx = db
      .prepare(
        'SELECT params, params_secret, device_proxy FROM run_envs WHERE id = ? AND batch_id = ?',
      )
      .get(item.run_env_id, item.batch_id) as
      { params: string; params_secret: string | null; device_proxy: string | null } | undefined;
    if (ctx) {
      ctxParams = JSON.parse(ctx.params || '{}');
      ctxSecret =
        decryptJson<Record<string, string>>(ctx.params_secret, getSecretKey(rt.cfg.dataDir)) ?? {};
      if (ctx.device_proxy === 'on' || ctx.device_proxy === 'off' || ctx.device_proxy === 'auto') {
        deviceProxy = ctx.device_proxy;
      }
    }
  }
  const taskParams: Record<string, string> = {
    ...ctxParams,
    ...JSON.parse(batch.params || '{}'),
    ...ctxSecret,
    ...(decryptJson<Record<string, string>>(batch.params_secret, getSecretKey(rt.cfg.dataDir)) ??
      {}),
  };
  const kase = db
    .prepare(
      `SELECT id, title, timeout_s, retries, bundle_hash, status, auth, assets, trace_mode FROM cases WHERE id=?`,
    )
    .get(item.case_id) as
    | {
        id: string;
        title: string;
        timeout_s: number;
        retries: number;
        bundle_hash: string | null;
        status: string;
        auth: string | null;
        assets: string | null;
        trace_mode: 'off' | 'on' | 'retain-on-failure' | null;
      }
    | undefined;
  if (!kase || kase.status !== 'active' || !kase.bundle_hash) {
    db.prepare(
      `UPDATE batch_items SET status='error', finished_at=?, last_error='case 不可执行（deleted/invalid/缺少 bundle）' WHERE id=?`,
    ).run(now, item.id);
    broadcastItem(rt, item.id);
    recomputeRun(rt, item.batch_id);
    return;
  }
  // 按本 run 的 auth 快照解析该用例的登录配方（老 run 无快照则回退读项目当前 auth）
  let authSpec: AuthSpec | null;
  try {
    authSpec = resolveCaseAuth(db, rt, batch, kase.auth, taskParams);
  } catch (e) {
    db.prepare(`UPDATE batch_items SET status='error', finished_at=?, last_error=? WHERE id=?`).run(
      now,
      (e as Error).message,
      item.id,
    );
    broadcastItem(rt, item.id);
    recomputeRun(rt, item.batch_id);
    return;
  }
  const attempt = item.attempt + 1;
  const runId = `r_${ulid()}`;
  const runToken = randomBytes(16).toString('hex');
  const maxAttempts = item.max_attempts || batch.max_attempts || kase.retries + 1;

  db.prepare(
    `INSERT INTO case_runs (id, batch_item_id, batch_id, case_id, worker_id, attempt, run_token, status, bundle_hash, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, NULL)`,
  ).run(
    runId,
    item.id,
    item.batch_id,
    item.case_id,
    worker.id,
    attempt,
    runToken,
    kase.bundle_hash,
  );
  db.prepare(
    `UPDATE batch_items SET status='claimed', attempt=?, claimed_worker_id=?, lease_until=? WHERE id=?`,
  ).run(attempt, worker.id, new Date(Date.now() + LEASE_MS).toISOString(), item.id);

  if (batch.status === 'pending') {
    db.prepare(`UPDATE batches SET status='running', started_at=? WHERE id=?`).run(
      now,
      item.batch_id,
    );
    broadcastRun(rt, item.batch_id);
  }

  rt.runs.set(runId, {
    runId,
    runToken,
    batchId: item.batch_id,
    itemId: item.id,
    caseId: item.case_id,
    workerId: worker.id,
    dir: path.join(rt.cfg.artifactsDir, item.batch_id, runId),
    assignedAt: Date.now(),
    accepted: false,
    orphanSince: null,
  });

  // F8：设备输入（case frontmatter devices；run options.devices 覆盖文件路径）
  let caseDevices: { mic?: string; camera?: string } | string[] | null = null;
  try {
    caseDevices = kase.assets
      ? ((JSON.parse(kase.assets) as { devices?: unknown }).devices ?? null)
      : null;
  } catch {
    caseDevices = null;
  }
  let devices: { mic?: string; camera?: string } | string[] | null = caseDevices;
  const override = (
    JSON.parse(batch.options || '{}') as {
      devices?: { mic?: string | null; camera?: string | null };
    }
  ).devices;
  if (override && devices && !Array.isArray(devices)) {
    devices = {
      mic: override.mic !== undefined ? override.mic || undefined : devices.mic,
      camera: override.camera !== undefined ? override.camera || undefined : devices.camera,
    };
  }

  // F8：随行测试资产（scope 快照 → 下发清单；worker 按 hash 下载缓存）
  let taskAssets: { path: string; hash: string; url: string; bytes: number }[] | undefined;
  try {
    const snap = (
      JSON.parse(batch.scope || '{}') as {
        assets?: Record<string, { hash: string; bytes: number }>;
      }
    ).assets;
    if (snap && Object.keys(snap).length) {
      taskAssets = Object.entries(snap).map(([p, a]) => ({
        path: p,
        hash: a.hash,
        url: `/api/v1/assets/${a.hash}`,
        bytes: a.bytes,
      }));
    }
  } catch {
    /* scope 损坏时无资产下发，用例内 ternAsset 将明确报错 */
  }

  const assignMsg = {
    type: 'assign',
    run: {
      runId,
      runToken,
      testRunId: item.batch_id,
      itemId: item.id,
      case: {
        caseId: kase.id,
        title: kase.title,
        bundleHash: kase.bundle_hash,
        bundleUrl: `/api/v1/bundles/${kase.bundle_hash}.cjs`,
        timeoutS: kase.timeout_s,
        retries: kase.retries,
        attempt,
        maxAttempts,
        auth: authSpec,
        devices: devices ?? undefined,
      },
      assets: taskAssets,
      // 条目上下文参数 + run 级显式参数 + 各自解密的 secret 合并下发（对 worker 协议零改动）
      params: taskParams,
      // 运行级 options + 用例级 trace 覆盖（frontmatter trace，长录音用例必须 off，见 migration 11）
      options: (() => {
        const o = JSON.parse(batch.options || '{}') as { trace?: string };
        if (kase!.trace_mode) o.trace = kase!.trace_mode;
        return o;
      })(),
      // 设备反向代理模式（F9 修订）：环境级配置在 run 创建时快照（条目上下文优先，run 级兜底）；
      // NULL = 历史批次未记录，回落 auto
      deviceProxy,
    },
  };
  try {
    worker.socket?.send(JSON.stringify(assignMsg));
  } catch (e) {
    rt.log.warn({ err: (e as Error).message, runId }, 'assign send failed; lease will expire');
  }
  broadcastItem(rt, item.id);
}

function failOrRequeueLost(rt: Runtime, run: LiveRun): void {
  const db = rt.db;
  const item = db.prepare('SELECT * FROM batch_items WHERE id=?').get(run.itemId) as ItemRow;
  run.orphanSince = null;
  db.prepare(`UPDATE case_runs SET status='lost', finished_at=? WHERE id=?`).run(
    nowISO(),
    run.runId,
  );
  rt.runs.delete(run.runId);
  const conn = rt.workers.get(run.workerId);
  if (conn) conn.busySlots = Math.max(0, conn.busySlots - 1);

  if (item && item.attempt < item.max_attempts) {
    db.prepare(
      `UPDATE batch_items SET status='pending', claimed_worker_id=NULL, lease_until=NULL WHERE id=?`,
    ).run(item.id);
  } else if (item) {
    db.prepare(
      `UPDATE batch_items SET status='failed', final_run_id=?, finished_at=?, last_error=? WHERE id=?`,
    ).run(run.runId, nowISO(), 'worker 失联超宽限（lost）', item.id);
  }
  if (item) {
    broadcastItem(rt, item.id);
    recomputeRun(rt, item.batch_id);
  }
}

// ---------- Worker 消息处理 ----------

export function handleAccept(rt: Runtime, workerId: string, runId: string, token: string): void {
  const run = rt.runs.get(runId);
  if (!run || run.runToken !== token || run.workerId !== workerId) return;
  run.accepted = true;
  run.orphanSince = null;
  rt.db
    .prepare(`UPDATE case_runs SET started_at=? WHERE id=? AND started_at IS NULL`)
    .run(nowISO(), runId);
  rt.db
    .prepare(`UPDATE batch_items SET status='running', started_at=? WHERE id=?`)
    .run(nowISO(), run.itemId);
  rt.db
    .prepare(`UPDATE workers SET status='busy', current_run_id=? WHERE id=?`)
    .run(runId, workerId);
  broadcastItem(rt, run.itemId);
  // 同时向批次主题广播 run.started，便于前端/订阅方拿到 runId 后订阅 run:<id>
  rt.events.emit(`run:${run.batchId}`, 'execution.started', {
    runId,
    itemId: run.itemId,
    caseId: run.caseId,
  });
  rt.events.emit(`execution:${runId}`, 'execution.started', { runId, caseId: run.caseId });
}

export function handleReject(rt: Runtime, workerId: string, runId: string, token: string): void {
  const run = rt.runs.get(runId);
  if (!run || run.runToken !== token || run.workerId !== workerId) return;
  rt.db
    .prepare(`UPDATE case_runs SET status='cancelled', finished_at=? WHERE id=?`)
    .run(nowISO(), runId);
  rt.runs.delete(runId);
  rt.db
    .prepare(
      `UPDATE batch_items SET status='pending', claimed_worker_id=NULL, lease_until=NULL WHERE id=?`,
    )
    .run(run.itemId);
  const conn = rt.workers.get(workerId);
  if (conn) conn.busySlots = Math.max(0, conn.busySlots - 1);
  broadcastItem(rt, run.itemId);
}

export function handleRunEvent(rt: Runtime, runId: string, token: string, event: RunEvent): void {
  const run = rt.runs.get(runId) ?? reviveRun(rt, runId);
  if (!run || run.runToken !== token) return;
  ensureRunDir(run);
  if (event.type === 'started') {
    rt.db
      .prepare(`UPDATE case_runs SET started_at=? WHERE id=? AND started_at IS NULL`)
      .run(nowISO(), runId);
  }
  try {
    appendFileSync(path.join(run.dir, 'events.jsonl'), JSON.stringify({ ...event }) + '\n');
    if (event.type === 'log' && event.text !== undefined) {
      appendFileSync(path.join(run.dir, 'run.log'), event.text + '\n');
    }
  } catch {
    /* 产物写盘失败不影响实时链路 */
  }
  if (event.type === 'frame' && event.data) {
    const screens =
      rt.frames.get(runId) ?? new Map<string, { data: string; ts: number; label?: string }>();
    screens.set(event.screen ?? 'default', {
      data: event.data,
      ts: Date.now(),
      label: event.screenLabel,
    });
    rt.frames.set(runId, screens);
  }
  // 实时扇出（不落库）
  rt.events.emit(`execution:${runId}`, `execution.${event.type}`, event, false);
}

export function handleResult(rt: Runtime, workerId: string, msg: ResultMsg): void {
  const db = rt.db;
  const runRow = db.prepare('SELECT * FROM case_runs WHERE id=?').get(msg.runId) as
    | {
        id: string;
        run_token: string;
        worker_id: string;
        batch_id: string;
        status: string;
        started_at: string | null;
      }
    | undefined;
  if (!runRow || runRow.run_token !== msg.runToken || runRow.worker_id !== workerId) {
    rt.log.warn({ runId: msg.runId, workerId }, 'rejected stale/invalid result');
    return;
  }
  if (runRow.status !== 'running') {
    // 迟到报文：该执行已被强制取消/判 lost/已回执终态。不回写 status/flaky/error
    // （防止已取消的运行被迟到结果翻案），但迟到前上传的产物照收入库，截图/trace 不丢。
    if (msg.artifacts) {
      db.prepare(`UPDATE case_runs SET artifacts=? WHERE id=?`).run(
        JSON.stringify(withArtifactUrls(msg.artifacts, runRow.batch_id, msg.runId)),
        msg.runId,
      );
    }
    rt.runs.delete(msg.runId);
    rt.frames.delete(msg.runId);
    return;
  }
  const item = db.prepare('SELECT * FROM batch_items WHERE id=?').get(
    rt.runs.get(msg.runId)?.itemId ??
      (
        db.prepare('SELECT batch_item_id FROM case_runs WHERE id=?').get(msg.runId) as {
          batch_item_id: string;
        }
      ).batch_item_id,
  ) as ItemRow | undefined;
  if (!item) return;

  const status = msg.status;
  const duration = msg.durationMs ?? null;
  const finished = nowISO();
  // ANSI 色码不入库（Playwright reporter 输出带色，页面/钉钉/MCP 展示会成乱码）
  const cleanError = msg.error
    ? {
        ...msg.error,
        message: stripAnsi(msg.error.message ?? ''),
        stack: msg.error.stack ? stripAnsi(msg.error.stack) : msg.error.stack,
      }
    : null;
  const errorSig = null;
  db.prepare(
    `UPDATE case_runs SET status=?, flaky=?, finished_at=?, duration_ms=?, error=?, error_sig=?, artifacts=?, started_at=COALESCE(started_at, ?) WHERE id=?`,
  ).run(
    status,
    msg.flaky ? 1 : 0,
    finished,
    duration,
    cleanError ? JSON.stringify(cleanError) : null,
    errorSig,
    msg.artifacts
      ? JSON.stringify(withArtifactUrls(msg.artifacts, item.batch_id, msg.runId))
      : null,
    finished,
    msg.runId,
  );

  const itemTerminal = TERMINAL_ITEM.has(item.status);
  if (itemTerminal && item.status !== 'running' && item.status !== 'claimed') {
    // 迟到报文：item 已终态（如被取消）
    rt.runs.delete(msg.runId);
    rt.frames.delete(msg.runId);
    return;
  }

  rt.runs.delete(msg.runId);
  rt.frames.delete(msg.runId);

  const canRequeue = REQUEUEABLE.has(status) && item.attempt < item.max_attempts;
  if (canRequeue) {
    db.prepare(
      `UPDATE batch_items SET status='pending', claimed_worker_id=NULL, lease_until=NULL, last_error=? WHERE id=?`,
    ).run(msg.error ? stripAnsi(msg.error.message ?? '') || status : status, item.id);
  } else {
    const finalStatus = status === 'lost' ? 'failed' : status;
    db.prepare(
      `UPDATE batch_items SET status=?, final_run_id=?, finished_at=?, duration_ms=?, last_error=? WHERE id=?`,
    ).run(
      finalStatus,
      msg.runId,
      finished,
      duration,
      msg.error ? stripAnsi(msg.error.message ?? '') || null : null,
      item.id,
    );
    // F5 flaky：终态进滚动窗口（flaky = runner 内重试通过 或 run 级 attempt>1 后通过）
    // recordCaseOutcome(
      rt,
      item.case_id,
      finalStatus,
      !!msg.flaky || (item.attempt > 1 && finalStatus === 'passed'),
    );
  }

  // worker 状态
  const conn = rt.workers.get(workerId);
  if (conn) {
    conn.busySlots = Math.max(0, conn.busySlots - 1);
  }
  const statsRow = db.prepare('SELECT stats FROM workers WHERE id=?').get(workerId) as
    { stats: string } | undefined;
  const stats = JSON.parse(statsRow?.stats || '{}') as Record<string, number>;
  stats.executed = (stats.executed ?? 0) + 1;
  if (status === 'passed') stats.passed = (stats.passed ?? 0) + 1;
  if (REQUEUEABLE.has(status)) stats.failed = (stats.failed ?? 0) + 1;
  db.prepare(`UPDATE workers SET stats=?, status='online', current_run_id=NULL WHERE id=?`).run(
    JSON.stringify(stats),
    workerId,
  );
  rt.events.emit('workers', 'worker.updated', workerPublic(workerId, rt));

  broadcastItem(rt, item.id);
  rt.events.emit(`execution:${msg.runId}`, 'execution.finished', {
    runId: msg.runId,
    status,
    flaky: !!msg.flaky,
    durationMs: duration,
  });
  recomputeRun(rt, item.batch_id);
}

function withArtifactUrls(
  artifacts: NonNullable<ResultMsg['artifacts']>,
  batchId: string,
  runId: string,
) {
  const base = `/artifacts/${batchId}/${runId}`;
  const map = (p?: string) => (p ? `${base}/${p}` : undefined);
  return {
    trace: map(artifacts.trace),
    log: map(artifacts.log ?? 'run.log'),
    events: map(artifacts.events ?? 'events.jsonl'),
    screenshots: artifacts.screenshots?.map(map),
    videos: artifacts.videos?.map(map),
    attachments: artifacts.attachments?.map(map),
    missing: artifacts.missing,
  };
}

// ---------- 测试运行（Run）操作 ----------

function asStringList(v: unknown): string[] {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string')
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return [String(v).trim()].filter(Boolean);
}

// ---------- 测试集选择规划（docs/test-suite-design.md §3.2/§3.3）----------
// 多测试集各自带环境：环境从 run 级单值升级为「环境上下文」，batch_items 按（用例 × 环境）去重；
// run 显式 env = 全局覆盖（拉平为单一环境，退化为 v0.5 行为）。
// planRunSelection 是纯选择规划（不解析环境值），createRun 与 runs/preview 共用，保证所见即所得。

const CTX_NONE = '__none__'; // 隐式上下文键（无环境；env 名是 kebab-case，不会碰撞）

export interface PlanSuiteSnap {
  id: string;
  name: string;
  env: string | null;
  account: string | null;
  selector: Record<string, unknown>;
  resolvedCount: number;
}

export interface PlanContext {
  /** 环境名；null = 无环境（仅显式参数） */
  envName: string | null;
  /** 来源测试集名（隐式上下文 = 直接选择器，sources 为空） */
  sources: string[];
  account: string | null;
  /** 集级参数（未与环境值合并；run 级显式参数在 assign 时覆盖） */
  params: Record<string, string>;
}

export interface RunPlan {
  projectName: string;
  /** 引用测试集时为 true（走多环境上下文路径）；否则为既有单环境路径 */
  useSuites: boolean;
  suites: PlanSuiteSnap[];
  contexts: PlanContext[];
  /** 去重后的执行条目（ctx = contexts 下标），顺序 = 测试集引用顺序 → 集内 caseId 字典序 → 直接选择器 */
  entries: { caseId: string; ctx: number }[];
  /** 同（用例 × 环境）被多个来源命中而去重的记录 */
  deduped: { caseId: string; env: string | null; keptFrom: string; droppedFrom: string[] }[];
  quarantinedExcluded: number;
  /** run 显式 env 覆盖了测试集自带环境（拉平模式） */
  envOverridden: boolean;
  directIds: string[];
}

/** 内部扩展：rerun 直接指定环境上下文与条目对（沿用源 run 已解析的值，不再重解析环境） */
export interface InternalRunSpec {
  _rerunFrom?: string;
  _contexts?: {
    envName: string | null;
    params: string;
    paramsSecretEnc: string | null;
    deviceProxy: string | null;
    sources: string[];
  }[];
  _entryPairs?: { caseId: string; ctx: number }[];
}

/** 上下文合并冲突检查（D6：同一环境内 account/params 不一致 fail-fast，run 显式值可解） */
function mergeIntoContext(
  ctx: PlanContext,
  suiteName: string,
  account: string | null,
  params: Record<string, string>,
  runExplicitParams: Record<string, string>,
): void {
  if (
    account != null &&
    ctx.account != null &&
    ctx.account !== account &&
    runExplicitParams.AUTH_ACCOUNT === undefined
  ) {
    throw new ApiError(
      400,
      'SUITE_ACCOUNT_CONFLICT',
      `环境上下文（${ctx.envName ?? '无环境'}）内多个测试集绑定了不同账号: ${ctx.account}（${ctx.sources.join('、')}）vs ${account}（${suiteName}）；请统一账号、在测试集中保持一致，或在运行参数显式指定 AUTH_ACCOUNT`,
    );
  }
  if (account != null && ctx.account == null) ctx.account = account;
  for (const [k, v] of Object.entries(params)) {
    if (ctx.params[k] !== undefined && ctx.params[k] !== v && runExplicitParams[k] === undefined) {
      throw new ApiError(
        400,
        'SUITE_PARAM_CONFLICT',
        `环境上下文（${ctx.envName ?? '无环境'}）内多个测试集对参数 ${k} 给出不同值: "${ctx.params[k]}"（${ctx.sources.join('、')}）vs "${v}"（${suiteName}）；请统一取值或用运行参数显式覆盖`,
      );
    }
    ctx.params[k] = v;
  }
}

export function planRunSelection(rt: Runtime, payload: CreateRunPayload): RunPlan {
  const db = rt.db;
  const suitesNames = asStringList(payload.suites);
  const caseIds = asStringList(payload.caseIds);
  const project = payload.project?.trim() || '';

  if (!project && caseIds.length === 0 && suitesNames.length === 0) {
    throw new ApiError(
      400,
      'PROJECT_REQUIRED',
      '请指定 project（一个测试运行只归属一个项目；可覆盖该项目的多个版本 / tag / 测试集）',
    );
  }

  // ---- 载入并校验测试集 ----
  interface LoadedSuite {
    id: string;
    name: string;
    project_name: string;
    env: string | null;
    account: string | null;
    params: Record<string, string>;
    selector: Record<string, unknown>;
  }
  const loaded: LoadedSuite[] = [];
  let projectName = project;
  for (const name of suitesNames) {
    const rows = db
      .prepare(
        'SELECT s.id, s.name, s.project_id, s.env, s.account, s.params, s.selector, s.enabled, p.name AS project_name FROM suites s JOIN projects p ON p.id = s.project_id WHERE s.name = ?',
      )
      .all(name) as (Record<string, unknown> & { project_name: string; enabled: number })[];
    if (rows.length === 0) throw new ApiError(404, 'SUITE_NOT_FOUND', `测试集不存在: ${name}`);
    let row = rows[0];
    if (rows.length > 1) {
      if (!project) {
        throw new ApiError(
          400,
          'SUITE_NAME_AMBIGUOUS',
          `测试集名 "${name}" 在多个项目中存在（${rows.map((r) => r.project_name).join('、')}），请指定 project`,
        );
      }
      row = rows.find((r) => r.project_name === project)!;
      if (!row) {
        throw new ApiError(
          400,
          'SUITE_PROJECT_MISMATCH',
          `测试集 "${name}" 不属于项目 ${project}（一个测试运行只能归属一个项目）`,
        );
      }
    }
    if (!row.enabled) throw new ApiError(400, 'SUITE_DISABLED', `测试集已停用: ${name}`);
    if (!projectName) projectName = row.project_name;
    else if (row.project_name !== projectName) {
      throw new ApiError(
        400,
        'SUITE_PROJECT_MISMATCH',
        `测试集 "${row.name}" 属于项目 ${row.project_name}，与本次运行的项目 ${projectName} 不一致（一个测试运行只能归属一个项目）`,
      );
    }
    loaded.push({
      id: row.id as string,
      name: row.name as string,
      project_name: row.project_name,
      env: (row.env as string | null) ?? null,
      account: (row.account as string | null) ?? null,
      params: JSON.parse((row.params as string) || '{}'),
      selector: JSON.parse((row.selector as string) || '{}'),
    });
  }
  const useSuites = loaded.length > 0;
  const envOverridden = useSuites && !!payload.env;

  // ---- 上下文归并 + 条目生成 ----
  const contexts: PlanContext[] = [];
  const ctxIndex = new Map<string, number>();
  const ctxOf = (envName: string | null, source?: string): number => {
    const key = envName ?? CTX_NONE;
    let i = ctxIndex.get(key);
    if (i === undefined) {
      i = contexts.length;
      contexts.push({ envName, sources: [], account: null, params: {} });
      ctxIndex.set(key, i);
    }
    if (source && !contexts[i].sources.includes(source)) contexts[i].sources.push(source);
    return i;
  };

  const entries: { caseId: string; ctx: number }[] = [];
  const deduped: RunPlan['deduped'] = [];
  const seen = new Map<string, { ctx: number; from: string; dropped: string[] }>();
  const pushEntry = (caseId: string, ctx: number, from: string) => {
    const key = `${caseId}\u0000${ctx}`;
    const prev = seen.get(key);
    if (prev) {
      if (from !== '(direct)') prev.dropped.push(from);
      return;
    }
    seen.set(key, { ctx, from, dropped: [] });
    entries.push({ caseId, ctx });
  };

  const explicitParams = payload.params ?? {};
  let quarantinedExcluded = 0;
  const suiteSnaps: PlanSuiteSnap[] = [];

  for (const s of loaded) {
    const resolve = resolveSuiteSelector(
      db,
      projectName,
      s.selector,
      payload.includeQuarantined === true ? true : undefined,
    );
    if (resolve.ids.length === 0) {
      throw new ApiError(
        400,
        'SUITE_RESOLVED_EMPTY',
        `测试集 "${s.name}" 当前解析命中 0 条可用用例（selector: ${JSON.stringify(s.selector)}；检查用例是否被删除/隔离或筛选条件是否写错）`,
      );
    }
    quarantinedExcluded += resolve.quarantinedExcluded;
    suiteSnaps.push({
      id: s.id,
      name: s.name,
      env: s.env,
      account: s.account,
      selector: s.selector,
      resolvedCount: resolve.ids.length,
    });
    const effectiveEnv = envOverridden ? (payload.env as string) : s.env;
    const ctx = ctxOf(effectiveEnv, s.name);
    mergeIntoContext(contexts[ctx], s.name, s.account, s.params, explicitParams);
    for (const caseId of resolve.ids) pushEntry(caseId, ctx, s.name);
  }

  // ---- 直接选择器（筛选/caseIds；隐式上下文，或拉平模式下并入显式环境上下文）----
  const version = asStringList(payload.version);
  const moduleNames = asStringList(payload.module);
  const tags = asStringList(payload.tags);
  const excludeTags = asStringList(payload.excludeTags);
  const hasSelector = !!(
    tags.length ||
    excludeTags.length ||
    payload.q ||
    version.length ||
    moduleNames.length
  );
  const includeQuarantined = payload.includeQuarantined === true;
  // 仅 project 无筛选且未引用测试集时才按项目全选（引用测试集时直接范围必须显式给出）
  const selectByProject = !!projectName && caseIds.length === 0 && !hasSelector && !useSuites;
  let directIds: string[] = [];
  if (hasSelector || selectByProject) {
    const r = resolveRunSelector(
      db,
      projectName || null,
      {
        version,
        module: moduleNames,
        tags,
        tagMode: payload.tagMode ?? 'any',
        excludeTags,
        q: payload.q,
      },
      includeQuarantined,
    );
    directIds = r.ids;
    quarantinedExcluded += r.quarantinedExcluded;
  }
  if (caseIds.length) {
    const marks = caseIds.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id FROM cases WHERE id IN (${marks}) AND status='active'`)
      .all(...caseIds) as {
      id: string;
    }[];
    const idSet = new Set(directIds);
    for (const r of rows) if (!idSet.has(r.id)) directIds.push(r.id);
  }
  if (directIds.length) {
    const directCtx = ctxOf(envOverridden ? (payload.env as string) : null);
    for (const caseId of directIds) pushEntry(caseId, directCtx, '(direct)');
  }

  // deduped 汇总（同一用例 × 环境被多个测试集命中）
  for (const [key, info] of seen) {
    if (info.dropped.length === 0) continue;
    const caseId = key.slice(0, key.indexOf('\u0000'));
    deduped.push({
      caseId,
      env: contexts[info.ctx].envName,
      keptFrom: info.from,
      droppedFrom: info.dropped,
    });
  }

  return {
    projectName,
    useSuites,
    suites: suiteSnaps,
    contexts,
    entries,
    deduped,
    quarantinedExcluded,
    envOverridden,
    directIds,
  };
}

export function createRun(rt: Runtime, payload: CreateRunPayload, createdBy: string) {
  const db = rt.db;
  const spec = payload as CreateRunPayload & InternalRunSpec;
  const internal = !!(spec._entryPairs && spec._contexts);
  const plan: RunPlan = internal
    ? {
        projectName: payload.project ?? '',
        useSuites: false,
        suites: [],
        contexts: [],
        entries: spec._entryPairs!,
        deduped: [],
        quarantinedExcluded: 0,
        envOverridden: false,
        directIds: [],
      }
    : planRunSelection(rt, payload);
  const source = plan.entries;

  const ids: string[] = [];
  const idSet = new Set<string>();
  for (const e of source) {
    if (!idSet.has(e.caseId)) {
      idSet.add(e.caseId);
      ids.push(e.caseId);
    }
  }

  if (ids.length === 0) {
    throw new ApiError(
      400,
      'NO_CASES_MATCHED',
      '筛选条件命中 0 条可用用例，请检查 project/version/module/tags/caseIds/suites',
    );
  }
  if (ids.length > rt.cfg.maxBatchItems) {
    throw new ApiError(
      400,
      'TOO_MANY_ITEMS',
      `单个测试运行的用例数超过上限 ${rt.cfg.maxBatchItems}`,
    );
  }

  // 一个 Run 只归属一个 project：显式指定时校验一致；仅传 caseIds 时从用例推导
  const ownerRows = db
    .prepare(
      `SELECT DISTINCT p.name AS name FROM cases c JOIN projects p ON p.id = c.project_id WHERE c.id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...ids) as { name: string }[];
  if (ownerRows.length === 0) {
    throw new ApiError(400, 'NO_CASES_MATCHED', '命中的用例不存在或不可执行');
  }
  if (ownerRows.length > 1) {
    throw new ApiError(
      400,
      'MULTIPLE_PROJECTS',
      `用例跨越了多个项目（${ownerRows.map((r) => r.name).join('、')}）：一个测试运行只能归属一个项目`,
    );
  }
  const projectName = plan.projectName || ownerRows[0].name;
  if (plan.projectName && ownerRows[0].name !== plan.projectName) {
    throw new ApiError(
      400,
      'CASE_PROJECT_MISMATCH',
      `选中的用例属于项目 ${ownerRows[0].name}，与指定的 project=${plan.projectName} 不一致`,
    );
  }

  // F8 测试资产：汇总选中用例引用（frontmatter devices + ternAsset()），解析 hash 快照进 scope
  const projectRow = db.prepare('SELECT * FROM projects WHERE name = ?').get(projectName) as
    ProjectRow | undefined;
  const assetRows = ids.length
    ? (db
        .prepare(`SELECT assets FROM cases WHERE id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids) as { assets: string | null }[])
    : [];
  const refSet = new Set<string>();
  for (const row of assetRows) {
    if (!row.assets) continue;
    try {
      const parsed = JSON.parse(row.assets) as { refs?: string[] };
      for (const r of parsed.refs ?? []) refSet.add(r);
    } catch {
      /* 资产 JSON 损坏时按无引用处理 */
    }
  }
  const scopeAssets: Record<string, { hash: string; bytes: number }> = {};
  if (refSet.size > 0) {
    const missing: string[] = [];
    for (const ref of refSet) {
      const a = db
        .prepare("SELECT hash, size FROM assets WHERE project_id=? AND path=? AND status='active'")
        .get(projectRow?.id ?? -1, ref) as { hash: string; size: number } | undefined;
      if (!a) missing.push(ref);
      else scopeAssets[ref] = { hash: a.hash, bytes: a.size };
    }
    if (missing.length) {
      throw new ApiError(
        400,
        'ASSET_NOT_FOUND',
        `测试资产缺失: ${missing.join(', ')}（重新 push/sync 项目后重试）`,
      );
    }
  }

  // auth 快照：从当前 clone 现读（改 yaml 只影响下一轮运行），并校验选中用例的 auth 引用
  let authSnapshot: AuthSnapshot = { kind: 'multi', recipe: null, profiles: {} };
  if (projectRow) {
    authSnapshot = readAuthSnapshot(projectDir(rt, projectRow));
  }
  const refRows = db
    .prepare(
      `SELECT id, auth FROM cases WHERE id IN (${ids.map(() => '?').join(',')}) AND auth IS NOT NULL`,
    )
    .all(...ids) as { id: string; auth: string }[];
  const badRefs: string[] = [];
  for (const r of refRows) {
    try {
      checkAuthRef(authSnapshot, r.auth, `用例 ${r.id}`);
    } catch (e) {
      badRefs.push((e as Error).message);
    }
  }
  if (badRefs.length) {
    throw new ApiError(400, 'AUTH_PROFILE_NOT_FOUND', badRefs.join('；'));
  }

  // 指定 worker：按 id 或名称校验存在性（允许排队等待上线）
  let workerId: string | null = null;
  if (payload.workerId) {
    const w = db
      .prepare('SELECT id FROM workers WHERE id = ? OR name = ?')
      .get(payload.workerId, payload.workerId) as { id: string } | undefined;
    if (!w)
      throw new ApiError(
        404,
        'WORKER_NOT_FOUND',
        `worker 不存在: ${payload.workerId}（可用 tern workers 查看）`,
      );
    workerId = w.id;
  }

  // ---- 环境与参数落位 ----
  // 多环境上下文（引用了测试集 / rerun 内部指定）：每个上下文在创建时解析并快照（环境值 + 集级参数覆盖）；
  // batches.params 收窄为「run 级显式参数」，assign 时叠加到每个条目。
  // 既有单环境路径（未引用测试集）：完全维持现状（值写 batches，run_env_id = NULL）。
  interface ResolvedContext {
    envName: string | null;
    params: Record<string, string>;
    paramsSecretEnc: string | null;
    deviceProxy: 'auto' | 'on' | 'off';
    sources: string[];
  }
  let resolvedContexts: ResolvedContext[] | null = null;
  let runParams: Record<string, string> = payload.params ?? {};
  let paramsSecretEnc: string | null = null;
  let envName: string | null = null;
  let envDeviceProxy: 'auto' | 'on' | 'off' = 'auto';

  if (internal) {
    resolvedContexts = spec._contexts!.map((c) => ({
      envName: c.envName,
      params: JSON.parse(c.params || '{}'),
      paramsSecretEnc: c.paramsSecretEnc,
      deviceProxy: (['auto', 'on', 'off'] as const).includes(c.deviceProxy as 'auto')
        ? (c.deviceProxy as 'auto' | 'on' | 'off')
        : 'auto',
      sources: c.sources ?? [],
    }));
    runParams = payload.params ?? {};
    paramsSecretEnc = payload.secretParamsEnc ?? null;
    // rerun 沿用源 run 的环境语义：单环境保持 envName（与首次创建一致），多环境为 null（看 envs）
    const ctxEnvNames = [
      ...new Set(resolvedContexts.map((c) => c.envName).filter((e): e is string => e != null)),
    ];
    envName = payload.env ?? (ctxEnvNames.length === 1 ? ctxEnvNames[0] : null);
  } else if (plan.useSuites) {
    const normDp = (v: unknown): 'auto' | 'on' | 'off' => (v === 'on' || v === 'off' ? v : 'auto');
    resolvedContexts = plan.contexts.map((ctx) => {
      const ctxParams: Record<string, string> = { ...ctx.params };
      if (ctx.account && ctxParams.AUTH_ACCOUNT === undefined) ctxParams.AUTH_ACCOUNT = ctx.account;
      if (ctx.envName) {
        if (!projectRow) throw new ApiError(404, 'PROJECT_NOT_FOUND', `项目不存在: ${projectName}`);
        // 集级账号写入 AUTH_ACCOUNT 后随上下文参数参与环境分层（显式覆盖环境同名值）
        const resolved = resolveEnvParams(
          rt,
          projectRow.id,
          ctx.envName,
          ctxParams,
          undefined,
          undefined,
        );
        return {
          envName: ctx.envName,
          params: resolved.params,
          paramsSecretEnc:
            Object.keys(resolved.secretParams).length > 0
              ? encryptJson(resolved.secretParams, getSecretKey(rt.cfg.dataDir))
              : null,
          deviceProxy: normDp(resolved.deviceProxy),
          sources: ctx.sources,
        };
      }
      return {
        envName: null,
        params: ctxParams,
        paramsSecretEnc: null,
        deviceProxy: 'auto' as const,
        sources: ctx.sources,
      };
    });
    // 集级绑定账号硬校验（保存期是软校验，仓库可能随后补上）
    for (const ctx of plan.contexts) {
      if (!ctx.account) continue;
      try {
        resolveAuthSpec(authSnapshot, null, ctx.account);
      } catch {
        throw new ApiError(
          400,
          'AUTH_ACCOUNT_NOT_FOUND',
          `测试集绑定的账号 "${ctx.account}" 在项目 auth 配置中不存在（更新 tern.yaml 后重新 sync）`,
        );
      }
    }
    runParams = payload.params ?? {};
    // run 级显式 secret（secretParams 标记）统一走加密通道，与上下文值在 assign 时合并
    {
      const secretKeys = new Set(payload.secretParams ?? []);
      const secrets: Record<string, string> = {};
      for (const k of secretKeys) {
        if (runParams[k] !== undefined) {
          secrets[k] = runParams[k];
          delete runParams[k];
        }
      }
      if (Object.keys(secrets).length)
        paramsSecretEnc = encryptJson(secrets, getSecretKey(rt.cfg.dataDir));
    }
    envName =
      payload.env ??
      (resolvedContexts.length === 1 && resolvedContexts[0].envName
        ? resolvedContexts[0].envName
        : null);
    envDeviceProxy = payload.env ? resolvedContexts[0].deviceProxy : 'auto';
  } else if (payload.env) {
    // F1 环境展开（既有单环境路径）
    if (!projectRow) throw new ApiError(404, 'PROJECT_NOT_FOUND', `项目不存在: ${projectName}`);
    const resolved = resolveEnvParams(
      rt,
      projectRow.id,
      payload.env,
      payload.params,
      payload.secretParams,
      payload.secretParamsEnc,
    );
    runParams = resolved.params;
    envName = payload.env;
    envDeviceProxy = resolved.deviceProxy;
    if (Object.keys(resolved.secretParams).length > 0) {
      paramsSecretEnc = encryptJson(resolved.secretParams, getSecretKey(rt.cfg.dataDir));
    }
  } else if (payload.secretParamsEnc) {
    // 无环境但透传了已加密 secret（retry 场景）
    paramsSecretEnc = payload.secretParamsEnc;
  }

  const id = `b_${ulid()}`;
  const now = nowISO();
  const lastSync = db
    .prepare(
      'SELECT git_commit FROM sync_runs WHERE git_commit IS NOT NULL ORDER BY id DESC LIMIT 1',
    )
    .get() as { git_commit: string | null } | undefined;
  const options: RunOptions = {
    trace: payload.options?.trace ?? 'retain-on-failure',
    video: payload.options?.video ?? false,
  };
  const { secretParamsEnc: _omit, ...scopePayload } = payload;
  const defaultTitle = plan.useSuites
    ? `[${plan.suites.map((s) => s.name).join('+')}] 测试运行 ${now.slice(0, 16)}`
    : `测试运行 ${now.slice(0, 16)}`;
  db.prepare(
    `INSERT INTO batches (id, title, created_by, scope, params, params_secret, env_name, options, max_attempts, worker_id, project, status, total, git_commit, device_proxy, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
  ).run(
    id,
    payload.title ?? defaultTitle,
    createdBy,
    JSON.stringify({
      ...(internal ? {} : scopePayload),
      ...(internal && spec._rerunFrom ? { rerunFrom: spec._rerunFrom } : {}),
      project: projectName,
      version: asStringList(payload.version),
      module: asStringList(payload.module),
      tags: asStringList(payload.tags),
      excludeTags: asStringList(payload.excludeTags),
      caseIds: asStringList(payload.caseIds).length
        ? asStringList(payload.caseIds)
        : payload.caseIds,
      excludedQuarantined:
        !internal && plan.quarantinedExcluded > 0 ? plan.quarantinedExcluded : undefined,
      // 测试集引用快照（id/name/selector/命中数；此后仓库/集怎么变都不影响本次 run）
      suites: !internal && plan.useSuites ? plan.suites : undefined,
      // 环境上下文构成（多环境并跑的审计核心）
      envContexts: resolvedContexts
        ? resolvedContexts.map((c, i) => ({
            env: c.envName,
            sources: c.sources,
            caseCount: source.filter((e) => e.ctx === i).length,
          }))
        : undefined,
      envOverridden: !internal && plan.envOverridden ? true : undefined,
      deduped: !internal && plan.deduped.length ? plan.deduped : undefined,
      // 本次运行随行的测试资产快照（path → {hash, bytes}；worker 按 hash 下载缓存）
      assets: Object.keys(scopeAssets).length ? scopeAssets : undefined,
      // 本次运行的 auth 配置快照（配方，不含已解析的 secret）
      auth: authSnapshot,
    }),
    JSON.stringify(runParams),
    paramsSecretEnc,
    envName,
    JSON.stringify(options),
    payload.maxAttempts ?? 1,
    workerId,
    projectName,
    source.length,
    lastSync?.git_commit ?? null,
    // F9 修订：环境级设备代理模式快照（assign 只读它，保证 run 内一致）
    envDeviceProxy,
    now,
  );

  // 多环境上下文：先落 run_envs 行，条目按 (case × context) 落位
  let ctxRowIds: (number | null)[] = [];
  if (resolvedContexts) {
    const insCtx = db.prepare(
      'INSERT INTO run_envs (batch_id, env_name, params, params_secret, device_proxy, position) VALUES (?, ?, ?, ?, ?, ?)',
    );
    ctxRowIds = resolvedContexts.map((c, i) =>
      Number(
        insCtx.run(id, c.envName, JSON.stringify(c.params), c.paramsSecretEnc, c.deviceProxy, i)
          .lastInsertRowid,
      ),
    );
  }

  const insItem = db.prepare(
    `INSERT INTO batch_items (id, batch_id, case_id, position, status, attempt, max_attempts, run_env_id) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
  );
  const getCase = db.prepare('SELECT retries FROM cases WHERE id=?');
  const tx = db.transaction(() => {
    source.forEach((e, i) => {
      const kase = getCase.get(e.caseId) as { retries: number };
      const maxAttempts = payload.maxAttempts ?? kase.retries + 1;
      insItem.run(`i_${ulid()}`, id, e.caseId, i, maxAttempts, ctxRowIds[e.ctx] ?? null);
    });
  });
  tx();
  broadcastRun(rt, id);
  rt.log.info(
    {
      runId: id,
      total: source.length,
      createdBy,
      suites: plan.useSuites ? plan.suites.map((s) => s.name) : undefined,
    },
    'run created',
  );
  return getRun(rt, id)!;
}

/** run 创建 dry-run 预览（POST /runs/preview）：与 createRun 共用选择规划，不落库 */
export function previewRun(rt: Runtime, payload: CreateRunPayload) {
  const plan = planRunSelection(rt, payload);
  return {
    total: plan.entries.length,
    contexts: plan.contexts.map((c, i) => ({
      env: c.envName,
      sources: c.sources,
      account: c.account,
      caseCount: plan.entries.filter((e) => e.ctx === i).length,
    })),
    perSuite: plan.suites.map((s) => ({ name: s.name, resolvedCount: s.resolvedCount })),
    deduped: plan.deduped,
    quarantinedExcluded: plan.quarantinedExcluded,
  };
}

/**
 * 取消运行。force=false（软取消）：pending/claimed/running 条目立即在本地置 cancelled（不等待 worker 回执），
 * 只对已进入 running 的条目尽力通知 worker；force=true（强制结束）：无论条目处于哪个阶段
 * （claimed 未 accept、pre-run/登录中）一律通知 worker 中断，worker 不在线或发送失败时入补发队列，
 * 等它下次 hello（含断线重连）时补发。两种情况都靠 case_runs 终态拒绝迟到报文（见 handleResult）。
 */
export function cancelRun(rt: Runtime, runId: string, force: boolean) {
  const db = rt.db;
  const run = db.prepare('SELECT * FROM batches WHERE id=?').get(runId) as
    { id: string; status: string } | undefined;
  if (!run) throw new ApiError(404, 'RUN_NOT_FOUND', '测试运行不存在');
  if (run.status === 'completed' || run.status === 'cancelled') {
    return;
  }
  const items = db
    .prepare(
      `SELECT * FROM batch_items WHERE batch_id=? AND status IN ('pending','claimed','running')`,
    )
    .all(runId) as (ItemRow & { claimed_worker_id: string | null })[];
  for (const item of items) {
    const runRow = db
      .prepare(
        `SELECT id, run_token, worker_id FROM case_runs WHERE batch_item_id=? AND status='running' ORDER BY attempt DESC LIMIT 1`,
      )
      .get(item.id) as { id: string; worker_id: string | null } | undefined;
    if (item.status === 'pending') {
      db.prepare(`UPDATE batch_items SET status='cancelled', finished_at=? WHERE id=?`).run(
        nowISO(),
        item.id,
      );
    } else if (runRow) {
      db.prepare(`UPDATE case_runs SET status='cancelled', finished_at=? WHERE id=?`).run(
        nowISO(),
        runRow.id,
      );
      db.prepare(
        `UPDATE batch_items SET status='cancelled', final_run_id=?, finished_at=? WHERE id=?`,
      ).run(runRow.id, nowISO(), item.id);
      rt.runs.delete(runRow.id);
      const workerId = item.claimed_worker_id ?? runRow.worker_id;
      const conn = workerId ? rt.workers.get(workerId) : undefined;
      if (conn) {
        conn.busySlots = Math.max(0, conn.busySlots - 1);
      }
      // 软取消只中断已进入执行阶段的用例；强制结束覆盖全部阶段（含 pre-run/登录）
      if (force || item.status === 'running') {
        interruptWorkerRun(rt, workerId, runRow.id, force);
      }
    } else {
      db.prepare(`UPDATE batch_items SET status='cancelled', finished_at=? WHERE id=?`).run(
        nowISO(),
        item.id,
      );
    }
    broadcastItem(rt, item.id);
  }
  db.prepare(`UPDATE batches SET status='cancelled', finished_at=? WHERE id=?`).run(
    nowISO(),
    runId,
  );
  recomputeRun(rt, runId); // 重算统计列（status 已是 cancelled，不会被覆盖）
  broadcastRun(rt, runId);
}

/**
 * 通知 worker 中断某次执行。hard=true（强制结束）：worker 不在线或发送失败时把 cancel 报文
 * 转入 pendingCancels 补发队列，等它下次 hello 时补发——否则掉线 worker 重连后会把这一个
 * 已取消的用例继续跑完；hard=false（软取消）尽力而为，迟到结果由 handleResult 拒绝。
 */
function interruptWorkerRun(
  rt: Runtime,
  workerId: string | null,
  runId: string,
  hard: boolean,
): void {
  if (!workerId) return;
  const conn = rt.workers.get(workerId);
  if (conn?.online && conn.socket) {
    try {
      conn.socket.send(JSON.stringify({ type: 'cancel', runId } satisfies CancelMsg));
      return;
    } catch {
      /* 发送失败按不在线处理，走补发队列 */
    }
  }
  if (!hard) return;
  const queued = rt.pendingCancels.get(workerId) ?? new Set<string>();
  queued.add(runId);
  rt.pendingCancels.set(workerId, queued);
}

/**
 * 重跑：基于一次已有运行创建新运行。mode='all' 复跑全部用例；'failed' 只复跑失败（failed/timed_out/error）。
 * 沿用源 run 的环境与参数（secret 密文透传，不经过明文层）、指定 worker 与 trace/video 选项。
 * 多环境上下文（测试集）run：按（用例 × 环境）对重建——失败条目在哪个环境失败的，就在哪个环境重跑；
 * 上下文值从源 run 的 run_envs 快照原样复制（环境定义此后被改/删也不影响重跑语义）。
 */
export function rerunRun(rt: Runtime, runId: string, createdBy: string, mode: 'all' | 'failed') {
  const db = rt.db;
  const source = db
    .prepare(
      'SELECT project, env_name, params, params_secret, options, worker_id, status, scope FROM batches WHERE id=?',
    )
    .get(runId) as
    | {
        project: string | null;
        env_name: string | null;
        params: string | null;
        params_secret: string | null;
        options: string | null;
        worker_id: string | null;
        status: string;
        scope: string | null;
      }
    | undefined;
  if (!source) throw new ApiError(404, 'RUN_NOT_FOUND', `测试运行不存在: ${runId}`);
  if (source.status === 'pending' || source.status === 'running') {
    throw new ApiError(409, 'RUN_NOT_TERMINAL', '运行尚未结束；等待完成或先取消，再重跑');
  }
  const failedOnly = mode === 'failed';
  const items = failedOnly
    ? (db
        .prepare(
          `SELECT case_id, run_env_id FROM batch_items WHERE batch_id=? AND status IN ('failed','timed_out','error')`,
        )
        .all(runId) as { case_id: string; run_env_id: number | null }[])
    : (db.prepare(`SELECT case_id, run_env_id FROM batch_items WHERE batch_id=?`).all(runId) as {
        case_id: string;
        run_env_id: number | null;
      }[]);
  if (items.length === 0) {
    throw new ApiError(400, 'NO_FAILED_CASES', '该运行没有失败用例可重跑');
  }

  // 多环境上下文 run：上下文原样复制（值与密文都不重解析），条目按 (case × ctx) 重建
  const ctxRows = db
    .prepare(
      'SELECT id, env_name, params, params_secret, device_proxy, position FROM run_envs WHERE batch_id=? ORDER BY position',
    )
    .all(runId) as {
    id: number;
    env_name: string | null;
    params: string;
    params_secret: string | null;
    device_proxy: string | null;
    position: number;
  }[];
  if (ctxRows.length > 0) {
    const scope = (() => {
      try {
        return JSON.parse(source.scope || '{}') as { envContexts?: { sources?: string[] }[] };
      } catch {
        return {};
      }
    })();
    // 先按选中条目去重出引用的上下文，再按引用顺序复制（retry-failed 只复制失败条目所在环境，
    // 未被引用的上下文不带到新 run——envName/envs 统计与实际执行构成一致）
    const referencedIds: number[] = [];
    const refSeen = new Set<number>();
    for (const it of items) {
      if (it.run_env_id == null || refSeen.has(it.run_env_id)) continue;
      refSeen.add(it.run_env_id);
      referencedIds.push(it.run_env_id);
    }
    const ctxById = new Map(ctxRows.map((c) => [c.id, c]));
    const newCtxIndex = new Map<number, number>();
    const contexts: InternalRunSpec['_contexts'] = [];
    for (const id of referencedIds) {
      const c = ctxById.get(id);
      if (!c) continue;
      newCtxIndex.set(id, contexts.length);
      contexts.push({
        envName: c.env_name,
        params: c.params,
        paramsSecretEnc: c.params_secret,
        deviceProxy: c.device_proxy,
        sources:
          ctxRows.indexOf(c) < (scope.envContexts?.length ?? 0)
            ? (scope.envContexts?.[ctxRows.indexOf(c)]?.sources ?? [])
            : [],
      });
    }
    const seen = new Set<string>();
    const pairs: { caseId: string; ctx: number }[] = [];
    for (const it of items) {
      const ctx = it.run_env_id != null ? (newCtxIndex.get(it.run_env_id) ?? 0) : 0;
      const key = `${it.case_id}\u0000${ctx}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ caseId: it.case_id, ctx });
    }
    // 源 run 钉住的 worker 已下线/删除时回退为全部空闲 worker
    let workerId: string | undefined;
    if (source.worker_id) {
      const w = db.prepare('SELECT id FROM workers WHERE id=?').get(source.worker_id) as
        { id: string } | undefined;
      workerId = w?.id;
    }
    let options: CreateRunPayload['options'];
    if (source.options) {
      try {
        options = JSON.parse(source.options) as CreateRunPayload['options'];
      } catch {
        /* options JSON 损坏时走默认 */
      }
    }
    return createRun(
      rt,
      {
        project: source.project ?? undefined,
        title: `${failedOnly ? '重跑失败' : '重跑'}（源自 ${runId}）`,
        createdBy,
        options,
        workerId,
        ...({ _rerunFrom: runId, _contexts: contexts, _entryPairs: pairs } as InternalRunSpec),
      },
      createdBy,
    );
  }

  // 既有单环境路径
  let env: string | undefined;
  if (source.env_name) {
    const stillExists = db
      .prepare(
        `SELECT 1 FROM environments WHERE name=? AND project_id=(SELECT id FROM projects WHERE name=?)`,
      )
      .get(source.env_name, source.project ?? '');
    if (stillExists) env = source.env_name;
  }
  // 源 run 钉住的 worker 已下线/删除时回退为全部空闲 worker
  let workerId: string | undefined;
  if (source.worker_id) {
    const w = db.prepare('SELECT id FROM workers WHERE id=?').get(source.worker_id) as
      { id: string } | undefined;
    workerId = w?.id;
  }
  let options: CreateRunPayload['options'];
  if (source.options) {
    try {
      options = JSON.parse(source.options) as CreateRunPayload['options'];
    } catch {
      /* options JSON 损坏时走默认 */
    }
  }
  return createRun(
    rt,
    {
      caseIds: items.map((i) => i.case_id),
      project: source.project ?? undefined,
      env,
      params: JSON.parse(source.params || '{}'),
      secretParamsEnc: env ? undefined : (source.params_secret ?? undefined),
      options,
      workerId,
      title: `${failedOnly ? '重跑失败' : '重跑'}（源自 ${runId}）`,
      createdBy,
    },
    createdBy,
  );
}

// ---------- Run 删除（F2）----------

const DELETE_CHUNK = 500;

/** 删除一次测试运行：DB 级联（events → case_runs → batch_items → batches，分块）+ 产物目录清理 */
export function deleteRun(
  rt: Runtime,
  runId: string,
  force: boolean,
): { removedExecutions: number } {
  const db = rt.db;
  const run = db.prepare('SELECT id, status FROM batches WHERE id=?').get(runId) as
    { id: string; status: string } | undefined;
  if (!run) throw new ApiError(404, 'RUN_NOT_FOUND', `测试运行不存在: ${runId}`);
  if (run.status === 'pending' || run.status === 'running') {
    if (!force) {
      throw new ApiError(
        409,
        'RUN_NOT_TERMINAL',
        '运行仍在进行中；先取消，或 force=true 强制取消后删除',
      );
    }
    cancelRun(rt, runId, true);
  }
  // 事务外收集执行 id（events topic 清理用），事务内分块删除行
  const execIds = (
    db.prepare('SELECT id FROM case_runs WHERE batch_id=?').all(runId) as { id: string }[]
  ).map((r) => r.id);
  const delExec = db.prepare(
    'DELETE FROM case_runs WHERE id IN (SELECT id FROM case_runs WHERE batch_id=? LIMIT ?)',
  );
  const delItem = db.prepare(
    'DELETE FROM batch_items WHERE id IN (SELECT id FROM batch_items WHERE batch_id=? LIMIT ?)',
  );
  const delEvents = db.prepare(
    'DELETE FROM events WHERE topic IN (SELECT value FROM json_each(?))',
  );
  const tx = db.transaction(() => {
    for (;;) {
      if (delExec.run(runId, DELETE_CHUNK).changes === 0) break;
    }
    for (;;) {
      if (delItem.run(runId, DELETE_CHUNK).changes === 0) break;
    }
    db.prepare('DELETE FROM run_envs WHERE batch_id=?').run(runId);
    const topics = [`run:${runId}`, ...execIds.map((id) => `execution:${id}`)];
    for (let i = 0; i < topics.length; i += DELETE_CHUNK) {
      delEvents.run(JSON.stringify(topics.slice(i, i + DELETE_CHUNK)));
    }
    db.prepare('DELETE FROM batches WHERE id=?').run(runId);
  });
  tx();
  // 产物目录（截图/trace/视频/日志/报告）清理；失败只告警
  const dir = path.join(rt.cfg.artifactsDir, runId);
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    rt.log.warn({ err: (e as Error).message, runId }, 'delete artifacts dir failed');
  }
  rt.log.info({ runId, removedExecutions: execIds.length }, 'run deleted');
  return { removedExecutions: execIds.length };
}

// ---------- 批次统计 / 汇报 ----------

export function recomputeRun(rt: Runtime, batchId: string): void {
  const db = rt.db;
  const counts = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status='passed' THEN 1 ELSE 0 END) AS passed,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status='timed_out' THEN 1 ELSE 0 END) AS timed_out,
        SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS error,
        SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped,
        SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
        SUM(CASE WHEN status IN ('passed','failed','timed_out','error','skipped','cancelled') THEN 1 ELSE 0 END) AS terminal
      FROM batch_items WHERE batch_id=?`,
    )
    .get(batchId) as {
    total: number;
    passed: number | null;
    failed: number | null;
    timed_out: number | null;
    error: number | null;
    skipped: number | null;
    cancelled: number | null;
    terminal: number | null;
  };
  const batch = db.prepare('SELECT status, finished_at FROM batches WHERE id=?').get(batchId) as
    { status: string; finished_at: string | null } | undefined;
  if (!batch) return;
  const allTerminal = (counts.terminal ?? 0) >= counts.total && counts.total > 0;
  let status = batch.status;
  let finishedAt = batch.finished_at;
  if (status !== 'cancelled') {
    if (allTerminal) {
      status = 'completed';
      finishedAt = finishedAt ?? nowISO();
    } else if (status === 'pending') {
      status = 'pending';
    } else {
      status = 'running';
    }
  }
  db.prepare(
    `UPDATE batches SET total=?, passed=?, failed=?, timed_out=?, error=?, skipped=?, cancelled=?, status=?, finished_at=? WHERE id=?`,
  ).run(
    counts.total,
    counts.passed ?? 0,
    counts.failed ?? 0,
    counts.timed_out ?? 0,
    counts.error ?? 0,
    counts.skipped ?? 0,
    counts.cancelled ?? 0,
    status,
    finishedAt,
    batchId,
  );
  if (allTerminal && status === 'completed') {
    writeBatchReport(rt, batchId);
  }
  // F7：终态触发钉钉通知（幂等 notified_at；内部 fire-and-forget）
  if (allTerminal && (status === 'completed' || status === 'cancelled')) {
    // notifyRunFinished(rt, batchId);
  }
  broadcastRun(rt, batchId);
}

export function runPublic(rt: Runtime, batchId: string) {
  const row = rt.db.prepare('SELECT * FROM batches WHERE id=?').get(batchId);
  return row ?? null;
}

function broadcastRun(rt: Runtime, batchId: string): void {
  const run = runPublic(rt, batchId);
  rt.events.emit(`run:${batchId}`, 'run.updated', run);
  // 列表页主题
  rt.events.emit('runs', 'run.updated', run);
}
function broadcastItem(rt: Runtime, itemId: string): void {
  const item = rt.db.prepare('SELECT * FROM batch_items WHERE id=?').get(itemId);
  if (!item) return;
  const batchId = (item as { batch_id: string }).batch_id;
  rt.events.emit(`run:${batchId}`, 'run.item.updated', item);
}

function writeBatchReport(rt: Runtime, batchId: string): void {
  const db = rt.db;
  const batch = db.prepare('SELECT * FROM batches WHERE id=?').get(batchId) as Record<
    string,
    unknown
  >;
  // 敏感列不进报告文件（params_secret 为 AES-GCM 密文，仍按纪律剔除）
  delete batch.params_secret;
  const items = db
    .prepare(
      `SELECT bi.*, r.status AS run_status, r.flaky, r.duration_ms AS run_duration, r.error AS run_error, r.artifacts AS run_artifacts,
              re.env_name AS env
       FROM batch_items bi LEFT JOIN case_runs r ON r.id = bi.final_run_id
       LEFT JOIN run_envs re ON re.id = bi.run_env_id
       WHERE bi.batch_id=? ORDER BY bi.position`,
    )
    .all(batchId);
  const report = {
    batch,
    items: items.map((it) => {
      const row = it as Record<string, unknown>;
      return {
        ...row,
        run_artifacts: row.run_artifacts ? JSON.parse(row.run_artifacts as string) : null,
      };
    }),
    generatedAt: nowISO(),
  };
  try {
    mkdirSync(path.join(rt.cfg.artifactsDir, batchId), { recursive: true });
    writeFileSync(
      path.join(rt.cfg.artifactsDir, batchId, 'batch-report.json'),
      JSON.stringify(report, null, 2),
    );
  } catch (e) {
    rt.log.warn({ err: (e as Error).message }, 'write batch report failed');
  }
}
