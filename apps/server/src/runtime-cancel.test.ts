// 强制结束运行（docs/tech-design.md §取消批次）单元测试：
// force 覆盖 claimed/pre-run 条目 / 掉线 worker 入队并在 hello 补发 /
// 迟到结果不回写终态（防幽灵结果翻案）/ 404 与终态幂等。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { createSqlDb, type SqlDb } from './sql-db.js';
import { MIGRATIONS, runMigrations } from './migrations.js';
import { cancelRun, handleHello, handleResult, type Runtime, type WorkerConn } from './runtime.js';

function tmpRt(): { rt: Runtime; dir: string; close: () => void } {
  const dir = path.join(
    os.tmpdir(),
    `tern-cancel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
      artifactsDir: path.join(dir, 'artifacts'),
      reposDir: path.join(dir, 'repos'),
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

/** 假 socket：记录 send 出去的报文 */
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

/** 注册 worker（rt.workers + workers 表同 id，保证 handleHello 能按名字找回） */
function addWorker(rt: Runtime, id: string, online = true): Record<string, unknown>[] {
  const { socket, sent } = fakeSocket();
  const now = new Date().toISOString();
  const conn: WorkerConn = {
    id,
    name: id,
    socket,
    maxSlots: 2,
    busySlots: 1,
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
  return sent;
}

function addCase(rt: Runtime, id: string): void {
  const now = new Date().toISOString();
  rt.db
    .prepare(
      `INSERT INTO cases (id, project_id, title, description, file_path, source, timeout_s, retries, disabled, meta, content_hash, bundle_hash, status, created_at, updated_at, quarantined)
       VALUES (?, 1, ?, '', ?, '', 60, 0, 0, '{}', ?, 'bundle-h', 'active', ?, ?, 0)`,
    )
    .run(id, id, `${id}.spec.ts`, `${id}-hash`, now, now);
}

interface ItemSpec {
  caseId: string;
  status: 'pending' | 'claimed' | 'running';
  workerId: string | null;
}

interface MadeItem {
  itemId: string;
  runId: string;
}

/** 建 batch + 条目（+ 对应 running case_runs），模拟 assignRun 落库后的形态 */
function addBatch(
  rt: Runtime,
  batchStatus: string,
  items: ItemSpec[],
): { batchId: string; items: MadeItem[] } {
  const batchId = `b_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  rt.db
    .prepare(
      `INSERT INTO batches (id, title, created_by, scope, params, max_attempts, status, total, created_at) VALUES (?, 't', 'test', '{}', '{}', 1, ?, ?, ?)`,
    )
    .run(batchId, batchStatus, items.length, now);
  const made: MadeItem[] = [];
  items.forEach((spec, i) => {
    addCase(rt, spec.caseId);
    const itemId = `i_${batchId}_${i}`;
    rt.db
      .prepare(
        `INSERT INTO batch_items (id, batch_id, case_id, position, status, attempt, max_attempts, claimed_worker_id) VALUES (?, ?, ?, ?, ?, 1, 1, ?)`,
      )
      .run(itemId, batchId, spec.caseId, i, spec.status, spec.workerId);
    const runId = `r_${itemId}`;
    rt.db
      .prepare(
        `INSERT INTO case_runs (id, batch_item_id, batch_id, case_id, worker_id, attempt, run_token, status, started_at) VALUES (?, ?, ?, ?, ?, 1, ?, 'running', ?)`,
      )
      .run(runId, itemId, batchId, spec.caseId, spec.workerId, `token_${runId}`, now);
    made.push({ itemId, runId });
  });
  return { batchId, items: made };
}

function cancelMsgs(sent: Record<string, unknown>[]): string[] {
  return sent.filter((m) => m.type === 'cancel').map((m) => String(m.runId));
}

test('强制结束：claimed（未进入执行）条目也向 worker 发中断', () => {
  const { rt, close } = tmpRt();
  try {
    const { batchId, items } = addBatch(rt, 'running', [
      { caseId: 'portal/a', status: 'claimed', workerId: 'w_1' },
      { caseId: 'portal/b', status: 'running', workerId: 'w_1' },
      { caseId: 'portal/c', status: 'pending', workerId: null },
    ]);
    const sent = addWorker(rt, 'w_1');

    cancelRun(rt, batchId, true);

    // 两条已派工条目（claimed + running）都收到了 cancel；pending 无 worker 无需报文
    assert.deepEqual(cancelMsgs(sent).sort(), [items[0].runId, items[1].runId].sort());
    // 运行与条目立即收敛 cancelled
    assert.equal(
      (rt.db.prepare('SELECT status FROM batches WHERE id=?').get(batchId) as { status: string })
        .status,
      'cancelled',
    );
    const statuses = rt.db
      .prepare('SELECT status FROM batch_items WHERE batch_id=? ORDER BY position')
      .all(batchId)
      .map((r) => (r as { status: string }).status);
    assert.deepEqual(statuses, ['cancelled', 'cancelled', 'cancelled']);
    const runStatus = rt.db
      .prepare('SELECT status FROM case_runs WHERE id=?')
      .get(items[1].runId) as { status: string };
    assert.equal(runStatus.status, 'cancelled');
  } finally {
    close();
  }
});

test('软取消（force=false）：不中断 claimed 条目，仅通知 running', () => {
  const { rt, close } = tmpRt();
  try {
    const { batchId, items } = addBatch(rt, 'running', [
      { caseId: 'portal/a', status: 'claimed', workerId: 'w_1' },
      { caseId: 'portal/b', status: 'running', workerId: 'w_1' },
    ]);
    const sent = addWorker(rt, 'w_1');

    cancelRun(rt, batchId, false);

    assert.deepEqual(cancelMsgs(sent), [items[1].runId]);
    assert.equal(
      (rt.db.prepare('SELECT status FROM batches WHERE id=?').get(batchId) as { status: string })
        .status,
      'cancelled',
    );
  } finally {
    close();
  }
});

test('强制结束：worker 不在线时入队，hello（重连）时补发', () => {
  const { rt, close } = tmpRt();
  try {
    const { batchId, items } = addBatch(rt, 'running', [
      { caseId: 'portal/a', status: 'running', workerId: 'w_off' },
    ]);
    addWorker(rt, 'w_off', false);

    cancelRun(rt, batchId, true);
    assert.deepEqual([...(rt.pendingCancels.get('w_off') ?? [])], [items[0].runId]);

    // worker 重连（hello）→ 补发 cancel
    const { socket, sent } = fakeSocket();
    handleHello(rt, socket, '10.0.0.9', {
      type: 'hello',
      name: 'w_off',
      version: '0.1.0',
      playwrightVersion: '1.0.0',
      capabilities: { browsers: ['chromium'], maxSlots: 1 },
    });
    assert.deepEqual(cancelMsgs(sent), [items[0].runId]);
    assert.equal(rt.pendingCancels.has('w_off'), false, '补发后队列清空');
  } finally {
    close();
  }
});

test('迟到结果不回写终态：已取消执行的 case_runs 保持 cancelled（产物仍入库）', () => {
  const { rt, close } = tmpRt();
  try {
    const { batchId, items } = addBatch(rt, 'running', [
      { caseId: 'portal/a', status: 'running', workerId: 'w_1' },
    ]);
    addWorker(rt, 'w_1');
    cancelRun(rt, batchId, true);
    const runId = items[0].runId;

    // worker linger：runner 已被杀但结果报文随后才到（迟到）
    handleResult(rt, 'w_1', {
      type: 'result',
      runId,
      runToken: `token_${runId}`,
      status: 'passed',
      durationMs: 42,
      artifacts: { screenshots: ['a.png'], videos: [], attachments: [], missing: [] },
    });

    const row = rt.db.prepare('SELECT status, artifacts FROM case_runs WHERE id=?').get(runId) as {
      status: string;
      artifacts: string | null;
    };
    assert.equal(row.status, 'cancelled', '迟到的 passed 不得把 cancelled 翻案');
    assert.ok(row.artifacts?.includes('a.png'), '迟到前上传的产物仍记录');
    const itemStatus = (
      rt.db.prepare('SELECT status FROM batch_items LIMIT 1').get() as { status: string }
    ).status;
    assert.equal(itemStatus, 'cancelled');
  } finally {
    close();
  }
});

test('cancelRun：不存在的 run 404；终态 run 幂等返回', () => {
  const { rt, close } = tmpRt();
  try {
    assert.throws(
      () => cancelRun(rt, 'b_nope', true),
      (e: Error & { status?: number }) => e.status === 404,
    );

    const { batchId } = addBatch(rt, 'running', [
      { caseId: 'portal/a', status: 'running', workerId: 'w_1' },
    ]);
    const sent = addWorker(rt, 'w_1');
    cancelRun(rt, batchId, true);
    cancelRun(rt, batchId, true); // 已终态：直接返回，不再发报文
    assert.equal(cancelMsgs(sent).length, 1);
  } finally {
    close();
  }
});
