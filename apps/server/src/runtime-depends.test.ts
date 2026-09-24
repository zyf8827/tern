import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { createSqlDb } from './sql-db.js';
import { MIGRATIONS, runMigrations } from './migrations.js';
import {
  schedulerTick,
  dependsGate,
  type Runtime,
  type WorkerConn,
} from './runtime.js';
import { detectDependencyCycles, syncProjectCases } from './sync.js';
import type { ProjectRow } from './repos.js';

function tmpRt(): { rt: Runtime; dir: string; close: () => void } {
  const dir = path.join(
    os.tmpdir(),
    `tern-depends-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const db = createSqlDb({ dialect: 'sqlite', sqlitePath: path.join(dir, 'platform.db') });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db, MIGRATIONS);
  db.prepare(`INSERT INTO projects (name, created_at) VALUES ('portal', ?)`).run(
    new Date().toISOString(),
  );
  const rt = {
    cfg: {
      dataDir: dir,
      bundlesDir: path.join(dir, 'bundles'),
      artifactsDir: path.join(dir, 'artifacts'),
      reposDir: path.join(dir, 'repos'),
      caseDefaultTimeoutS: 60,
      maxBatchItems: 2000,
    },
    db,
    events: { emit() {} },
    log: { info() {}, warn() {}, error() {} },
    workers: new Map(),
    runs: new Map(),
    frames: new Map(),
    watchers: new Map(),
    pendingCancels: new Map(),
  } as unknown as Runtime;
  return { rt, dir, close: () => db.close() };
}

function fakeSocket(): { socket: WebSocket; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  return {
    socket: {
      send: (m: string) => sent.push(JSON.parse(m) as Record<string, unknown>),
      close: () => {},
    } as unknown as WebSocket,
    sent,
  };
}

function addWorker(
  rt: Runtime,
  id: string,
  maxSlots = 2,
  busySlots = 0,
  online = true,
): { sent: Record<string, unknown>[]; conn: WorkerConn } {
  const { socket, sent } = fakeSocket();
  const now = new Date().toISOString();
  const conn: WorkerConn = {
    id,
    name: id,
    socket,
    maxSlots,
    busySlots,
    browsers: ['chromium'],
    agentVersion: '0.1.0',
    playwrightVersion: '1.0.0',
    online,
    lastSeen: Date.now(),
    ip: '127.0.0.1',
  };
  rt.workers.set(id, conn);
  rt.db
    .prepare(
      `INSERT INTO workers (id, name, hostname, ip, agent_version, playwright_version, capabilities, status, last_heartbeat_at, registered_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', 'online', ?, ?)`,
    )
    .run(id, id, id, conn.ip, conn.agentVersion, conn.playwrightVersion, now, now);
  return { sent, conn };
}

function addCase(rt: Runtime, id: string, depends?: string[]): void {
  const now = new Date().toISOString();
  const meta = JSON.stringify(depends?.length ? { depends } : {});
  rt.db
    .prepare(
      `INSERT INTO cases (id, project_id, title, description, file_path, source, timeout_s, retries, disabled, meta, content_hash, bundle_hash, status, created_at, updated_at, quarantined)
       VALUES (?, 1, ?, '', ?, '', 60, 0, 0, ?, ?, 'bundle-h', 'active', ?, ?, 0)`,
    )
    .run(id, id, `${id}.spec.ts`, meta, `${id}-hash`, now, now);
}

interface ItemInit {
  caseId: string;
  status?: string;
  runEnvId?: number | null;
}

function addBatch(
  rt: Runtime,
  items: ItemInit[],
  batchId = `b_${Math.random().toString(36).slice(2, 10)}`,
): { batchId: string; itemIds: string[] } {
  const now = new Date().toISOString();
  rt.db
    .prepare(
      `INSERT INTO batches (id, title, created_by, scope, params, max_attempts, status, total, created_at) VALUES (?, 't', 'test', '{}', '{}', 1, 'pending', ?, ?)`,
    )
    .run(batchId, items.length, now);

  const itemIds: string[] = [];
  items.forEach((it, i) => {
    const itemId = `i_${batchId}_${i}`;
    rt.db
      .prepare(
        `INSERT INTO batch_items (id, batch_id, case_id, position, status, attempt, max_attempts, run_env_id) VALUES (?, ?, ?, ?, ?, 0, 1, ?)`,
      )
      .run(itemId, batchId, it.caseId, i, it.status ?? 'pending', it.runEnvId ?? null);
    itemIds.push(itemId);
  });
  return { batchId, itemIds };
}

test('depends: A pending, B 依赖 A → 第一轮仅派发 A，A 通过后下一轮派发 B', () => {
  const { rt, close } = tmpRt();
  try {
    addCase(rt, 'portal/a');
    addCase(rt, 'portal/b', ['a']);
    const { conn } = addWorker(rt, 'w_1', 2, 0);

    const { batchId } = addBatch(rt, [
      { caseId: 'portal/a' },
      { caseId: 'portal/b' },
    ]);

    // Tick 1: A 被派发（claimed），B 仍 pending
    schedulerTick(rt);

    const s1 = rt.db
      .prepare('SELECT case_id, status FROM batch_items WHERE batch_id=? ORDER BY position')
      .all(batchId) as { case_id: string; status: string }[];
    assert.deepEqual(s1, [
      { case_id: 'portal/a', status: 'claimed' },
      { case_id: 'portal/b', status: 'pending' },
    ]);

    // 模拟 A 执行完成 passed，释放 worker 槽位
    const now = new Date().toISOString();
    rt.db
      .prepare(`UPDATE batch_items SET status='passed', finished_at=? WHERE batch_id=? AND case_id='portal/a'`)
      .run(now, batchId);
    conn.busySlots = 0;

    // Tick 2: B 依赖已满足，派发 B
    schedulerTick(rt);

    const s2 = rt.db
      .prepare('SELECT case_id, status FROM batch_items WHERE batch_id=? ORDER BY position')
      .all(batchId) as { case_id: string; status: string }[];
    assert.deepEqual(s2, [
      { case_id: 'portal/a', status: 'passed' },
      { case_id: 'portal/b', status: 'claimed' },
    ]);
  } finally {
    close();
  }
});

test('depends: A failed → B 自动 skipped，last_error 包含 depends not met', () => {
  const { rt, close } = tmpRt();
  try {
    addCase(rt, 'portal/a');
    addCase(rt, 'portal/b', ['a']);
    addWorker(rt, 'w_1', 2, 0);

    const { batchId } = addBatch(rt, [
      { caseId: 'portal/a', status: 'failed' },
      { caseId: 'portal/b', status: 'pending' },
    ]);

    schedulerTick(rt);

    const bRow = rt.db
      .prepare('SELECT status, last_error FROM batch_items WHERE batch_id=? AND case_id=?')
      .get(batchId, 'portal/b') as { status: string; last_error: string };

    assert.equal(bRow.status, 'skipped');
    assert.ok(
      bRow.last_error.includes('depends not met: a failed'),
      `last_error 应包含 depends not met: ${bRow.last_error}`,
    );
  } finally {
    close();
  }
});

test('depends: 依赖用例不在本 batch（软依赖）→ B 正常派发，不被阻断', () => {
  const { rt, close } = tmpRt();
  try {
    addCase(rt, 'portal/a');
    addCase(rt, 'portal/b', ['a']);
    addWorker(rt, 'w_1', 2, 0);

    // 仅选中 B，A 未入选
    const { batchId } = addBatch(rt, [{ caseId: 'portal/b' }]);

    schedulerTick(rt);

    const bRow = rt.db
      .prepare('SELECT status FROM batch_items WHERE batch_id=? AND case_id=?')
      .get(batchId, 'portal/b') as { status: string };

    assert.equal(bRow.status, 'claimed');
  } finally {
    close();
  }
});

test('depends: 同 batch 但不同 run_env_id → B 不被不同 env 的 A 阻断（仅同 env 门禁）', () => {
  const { rt, close } = tmpRt();
  try {
    addCase(rt, 'portal/a');
    addCase(rt, 'portal/b', ['a']);
    addWorker(rt, 'w_1', 2, 0);

    // A 在 env 101，B 在 env 102
    const { batchId } = addBatch(rt, [
      { caseId: 'portal/a', runEnvId: 101, status: 'pending' },
      { caseId: 'portal/b', runEnvId: 102, status: 'pending' },
    ]);

    schedulerTick(rt);

    const items = rt.db
      .prepare('SELECT case_id, run_env_id, status FROM batch_items WHERE batch_id=? ORDER BY position')
      .all(batchId) as { case_id: string; run_env_id: number; status: string }[];

    // 两者属于不同环境上下文，B 在 env 102 下无对应 A，不被阻塞，两者均被派发
    assert.deepEqual(items, [
      { case_id: 'portal/a', run_env_id: 101, status: 'claimed' },
      { case_id: 'portal/b', run_env_id: 102, status: 'claimed' },
    ]);
  } finally {
    close();
  }
});

test('depends: 传递依赖链路 A → B → C，A 失败逐轮收敛跳过 B 与 C', () => {
  const { rt, close } = tmpRt();
  try {
    addCase(rt, 'portal/a');
    addCase(rt, 'portal/b', ['a']);
    addCase(rt, 'portal/c', ['b']);
    addWorker(rt, 'w_1', 2, 0);

    const { batchId } = addBatch(rt, [
      { caseId: 'portal/a', status: 'failed' },
      { caseId: 'portal/b', status: 'pending' },
      { caseId: 'portal/c', status: 'pending' },
    ]);

    // 执行调度 tick（B 被 skip，同一 tick 或下一 tick C 也会因 B 终态非 passed 而 skip）
    schedulerTick(rt);
    schedulerTick(rt);

    const items = rt.db
      .prepare('SELECT case_id, status, last_error FROM batch_items WHERE batch_id=? ORDER BY position')
      .all(batchId) as { case_id: string; status: string; last_error: string }[];

    assert.equal(items[1].case_id, 'portal/b');
    assert.equal(items[1].status, 'skipped');
    assert.ok(items[1].last_error.includes('depends not met: a failed'));

    assert.equal(items[2].case_id, 'portal/c');
    assert.equal(items[2].status, 'skipped');
    assert.ok(items[2].last_error.includes('depends not met: b skipped'));
  } finally {
    close();
  }
});

test('depends: 多槽位并发 worker (maxSlots=2)，A 与无依赖的 C 并行派发，B 保持等待', () => {
  const { rt, close } = tmpRt();
  try {
    addCase(rt, 'portal/a');
    addCase(rt, 'portal/b', ['a']);
    addCase(rt, 'portal/c');
    const { conn } = addWorker(rt, 'w_1', 2, 0);

    const { batchId } = addBatch(rt, [
      { caseId: 'portal/a' },
      { caseId: 'portal/b' },
      { caseId: 'portal/c' },
    ]);

    schedulerTick(rt);

    const items = rt.db
      .prepare('SELECT case_id, status FROM batch_items WHERE batch_id=? ORDER BY position')
      .all(batchId) as { case_id: string; status: string }[];

    // A 和 C 被派发，B 等待
    assert.deepEqual(items, [
      { case_id: 'portal/a', status: 'claimed' },
      { case_id: 'portal/b', status: 'pending' },
      { case_id: 'portal/c', status: 'claimed' },
    ]);
    assert.equal(conn.busySlots, 2);
  } finally {
    close();
  }
});

test('detectDependencyCycles: 环形依赖精准识别与错误信息格式', () => {
  // a -> b -> a
  const adj1 = new Map([
    ['a', ['b']],
    ['b', ['a']],
  ]);
  const cycles1 = detectDependencyCycles(adj1);
  assert.equal(cycles1.size, 2);
  assert.equal(cycles1.get('a'), 'depends cycle: a -> b -> a');
  assert.equal(cycles1.get('b'), 'depends cycle: a -> b -> a');

  // a -> b -> c -> a，同时 x -> a（x 不在环中）
  const adj2 = new Map([
    ['x', ['a']],
    ['a', ['b']],
    ['b', ['c']],
    ['c', ['a']],
  ]);
  const cycles2 = detectDependencyCycles(adj2);
  assert.equal(cycles2.has('x'), false);
  assert.equal(cycles2.get('a'), 'depends cycle: a -> b -> c -> a');
  assert.equal(cycles2.get('b'), 'depends cycle: a -> b -> c -> a');
  assert.equal(cycles2.get('c'), 'depends cycle: a -> b -> c -> a');

  // DAG 无环
  const adj3 = new Map([
    ['a', ['b', 'c']],
    ['b', ['d']],
    ['c', ['d']],
    ['d', []],
  ]);
  const cycles3 = detectDependencyCycles(adj3);
  assert.equal(cycles3.size, 0);
});

test('syncProjectCases: 环形依赖标记 invalid、自依赖报错、未知依赖 soft warn 并持久化 meta.depends', async () => {
  const { rt, close } = tmpRt();
  try {
    const projectDirAbs = path.join(rt.cfg.reposDir, 'portal');
    const casesDirAbs = path.join(projectDirAbs, 'cases');
    mkdirSync(casesDirAbs, { recursive: true });

    // 用例 1: a 依赖 b
    writeFileSync(
      path.join(casesDirAbs, 'case-a.spec.ts'),
      `/**
 * @tern
 * title: 用例 A
 * depends: [case-b]
 */
import { test } from '@playwright/test';
test('a', () => {});
`,
    );

    // 用例 2: b 依赖 a（形成环：case-a -> case-b -> case-a）
    writeFileSync(
      path.join(casesDirAbs, 'case-b.spec.ts'),
      `/**
 * @tern
 * title: 用例 B
 * depends: [case-a]
 */
import { test } from '@playwright/test';
test('b', () => {});
`,
    );

    // 用例 3: c 自依赖
    writeFileSync(
      path.join(casesDirAbs, 'case-c.spec.ts'),
      `/**
 * @tern
 * title: 用例 C
 * depends: [case-c]
 */
import { test } from '@playwright/test';
test('c', () => {});
`,
    );

    // 用例 4: d 依赖未知用例（软告警，正常入库 active）
    writeFileSync(
      path.join(casesDirAbs, 'case-d.spec.ts'),
      `/**
 * @tern
 * title: 用例 D
 * depends: [case-unknown]
 */
import { test } from '@playwright/test';
test('d', () => {});
`,
    );

    const project = rt.db.prepare('SELECT * FROM projects WHERE name = ?').get('portal') as ProjectRow;
    const res = await syncProjectCases(rt, project);

    assert.equal(res.invalid, 3);

    const aRow = rt.db.prepare('SELECT status, last_error, meta FROM cases WHERE id=?').get('portal/case-a') as { status: string; last_error: string; meta: string };
    const bRow = rt.db.prepare('SELECT status, last_error, meta FROM cases WHERE id=?').get('portal/case-b') as { status: string; last_error: string; meta: string };
    const cRow = rt.db.prepare('SELECT status, last_error, meta FROM cases WHERE id=?').get('portal/case-c') as { status: string; last_error: string; meta: string };
    const dRow = rt.db.prepare('SELECT status, last_error, meta FROM cases WHERE id=?').get('portal/case-d') as { status: string; last_error: string; meta: string };

    assert.equal(aRow.status, 'invalid');
    assert.ok(aRow.last_error.includes('depends cycle: case-a -> case-b -> case-a'));

    assert.equal(bRow.status, 'invalid');
    assert.ok(bRow.last_error.includes('depends cycle: case-a -> case-b -> case-a'));

    assert.equal(cRow.status, 'invalid');
    assert.ok(cRow.last_error.includes('depends self-reference: case-c'));

    // dRow 软依赖保持 active，meta 包含 depends
    assert.equal(dRow.status, 'active');
    assert.equal(dRow.last_error, null);
    assert.deepEqual(JSON.parse(dRow.meta), { depends: ['case-unknown'] });
  } finally {
    close();
  }
});

