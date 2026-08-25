import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, runMigrations, currentVersion, pendingMigrations } from './migrations.js';

function tmpDb(name: string): { dir: string; db: Database.Database } {
  const dir = path.join(
    os.tmpdir(),
    `tern-migrate-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'platform.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return { dir, db };
}

test('全新数据库：自动应用全部迁移', () => {
  const { db } = tmpDb('fresh');
  const report = runMigrations(db, MIGRATIONS);
  assert.equal(report.applied.length, MIGRATIONS.length);
  assert.equal(report.toVersion, MIGRATIONS[MIGRATIONS.length - 1].id);
  for (const t of [
    'projects',
    'cases',
    'case_tags',
    'batches',
    'batch_items',
    'case_runs',
    'workers',
    'sync_runs',
    'events',
  ]) {
    assert.ok(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t),
      `表 ${t} 应存在`,
    );
  }
  // 幂等：重复执行无待应用
  assert.equal(pendingMigrations(db, MIGRATIONS).length, 0);
  assert.equal(runMigrations(db, MIGRATIONS).applied.length, 0);
  db.close();
});

test('旧版（v1）数据库升级：DDL 升级且数据完整保留', () => {
  const { db } = tmpDb('upgrade');

  // 模拟 v1 旧库：只应用迁移 1，并写入业务数据
  runMigrations(db, MIGRATIONS.slice(0, 1));
  db.prepare(
    `INSERT INTO projects (name, description, created_at) VALUES ('legacy', '旧项目', '2026-01-01')`,
  ).run();
  const pid = (db.prepare('SELECT id FROM projects').get() as { id: number }).id;
  db.prepare(
    `INSERT INTO cases (id, project_id, title, description, file_path, source, timeout_s, retries, disabled, meta, content_hash, status, created_at, updated_at)
     VALUES ('legacy/case-1', ?, '旧用例', '', 'legacy/cases/case-1.spec.ts', '// src', 60, 0, 0, '{}', 'hash1', 'active', '2026-01-01', '2026-01-01')`,
  ).run(pid);
  db.prepare(`INSERT INTO case_tags (case_id, tag) VALUES ('legacy/case-1', 'smoke')`).run();
  const bid = 'b_legacy';
  db.prepare(
    `INSERT INTO batches (id, title, created_by, status, total, created_at) VALUES (?, '旧批次', 'test', 'completed', 1, '2026-01-01')`,
  ).run(bid);
  db.prepare(
    `INSERT INTO batch_items (id, batch_id, case_id, position, status) VALUES ('i_legacy', ?, 'legacy/case-1', 0, 'passed')`,
  ).run(bid);

  // 升级到最新
  const report = runMigrations(db, MIGRATIONS);
  assert.ok(report.applied.length >= 2, '应应用后续迁移');
  assert.equal(report.fromVersion, 1);

  // 数据仍在
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as { n: number }).n, 1);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM cases WHERE status='active'`).get() as { n: number }).n,
    1,
  );
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM case_tags`).get() as { n: number }).n, 1);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_items`).get() as { n: number }).n, 1);

  // 新列可写（v2 的 version/module/worker_id；v3 重建后的表结构）
  db.prepare(`UPDATE cases SET version='v9', module='legacy-mod' WHERE id='legacy/case-1'`).run();
  const kase = db.prepare(`SELECT version, module FROM cases WHERE id='legacy/case-1'`).get() as {
    version: string;
    module: string;
  };
  assert.equal(kase.version, 'v9');
  assert.equal(kase.module, 'legacy-mod');
  db.prepare(`UPDATE batches SET worker_id='w_x' WHERE id=?`).run(bid);
  db.prepare(`UPDATE projects SET source='git', git_url='https://x' WHERE id=?`).run(pid);
  db.prepare(`UPDATE batches SET project='legacy' WHERE id=?`).run(bid);
  db.prepare(`UPDATE projects SET cred_type='password', cred_user='alice' WHERE id=?`).run(pid);
  const cred = db
    .prepare(`SELECT cred_type, cred_user, cred_secret FROM projects WHERE id=?`)
    .get(pid) as {
    cred_type: string;
    cred_user: string;
    cred_secret: string | null;
  };
  assert.equal(cred.cred_type, 'password');
  assert.equal(cred.cred_user, 'alice');
  assert.equal(cred.cred_secret, null);

  // v3 之后允许硬删 project 及其用例（跨生命周期外键已去除）
  db.prepare(`DELETE FROM case_tags WHERE case_id='legacy/case-1'`).run();
  db.prepare(`DELETE FROM cases WHERE id='legacy/case-1'`).run();
  db.prepare(`DELETE FROM projects WHERE id=?`).run(pid);
  assert.equal(currentVersion(db), MIGRATIONS[MIGRATIONS.length - 1].id);
  db.close();
});

test('旧结构 _migrations 表（仅 id/applied_at）可正常续接', () => {
  const { db } = tmpDb('legacy-meta');
  db.exec(`CREATE TABLE _migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
  db.exec(MIGRATIONS[0].sql);
  db.prepare(`INSERT INTO _migrations (id, applied_at) VALUES (1, '2026-01-01')`).run();
  assert.equal(currentVersion(db), 1);
  const report = runMigrations(db, MIGRATIONS);
  assert.ok(report.applied.length >= 1);
  assert.ok(
    report.applied.every((m) => m.id > 1),
    '只应用迁移 1 之后的版本',
  );
  const row = db
    .prepare(`SELECT name, duration_ms FROM _migrations WHERE id=?`)
    .get(MIGRATIONS[MIGRATIONS.length - 1].id) as {
    name: string | null;
    duration_ms: number | null;
  };
  assert.ok(row.name, '新迁移记录应带 name');
  db.close();
});

test('失败的迁移：事务回滚、不记录版本、不留残留表', () => {
  const { db } = tmpDb('failure');
  const bad = [
    ...MIGRATIONS.slice(0, 1),
    { id: 99, name: 'bad-sql', sql: `CREATE TABLE broken (x INT); NOT A VALID SQL STATEMENT;` },
  ];
  assert.throws(() => runMigrations(db, bad));
  assert.equal(currentVersion(db), 1);
  assert.ok(!db.prepare(`SELECT name FROM sqlite_master WHERE name='broken'`).get());
  db.close();
});
