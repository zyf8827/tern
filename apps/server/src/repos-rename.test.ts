// 项目改名（PATCH /projects/:id {name}）单元测试：
// 非法名 400 / 重名 409 / 改名后重新同步——caseId 前缀（第一段）随注册名切换，
// 旧 caseId 下线、新 caseId 入索引；改名广播 project.updated。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, runMigrations } from './migrations.js';
import { patchProject, updateProjectRepoInner } from './repos.js';
import type { Runtime } from './runtime.js';

const CASE_SRC = `/**
 * @tern
 * title: 冒烟 - 首页
 * description: 改名测试材料
 * tags: [smoke]
 * timeout: 30
 */
import { test, expect } from '@playwright/test';

test('冒烟', async ({ page }) => {
  await page.setContent('<h1>ok</h1>');
  await expect(page.locator('h1')).toBeVisible();
});
`;

test('项目改名：非法名/重名拒绝；改名+重新同步切换 caseId 前缀', async () => {
  const base = path.join(
    os.tmpdir(),
    `tern-rename-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const repos = path.join(base, 'repos');
  const repoDir = path.join(repos, 'alpha-cases');
  mkdirSync(path.join(repoDir, 'cases', 'smoke'), { recursive: true });
  writeFileSync(
    path.join(repoDir, 'tern.yaml'),
    'name: alpha\ndescription: alpha repo\ncasesDir: cases\n',
  );
  writeFileSync(path.join(repoDir, 'cases', 'smoke', 'a.spec.ts'), CASE_SRC);

  const db = new Database(path.join(base, 'platform.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db, MIGRATIONS);
  const events: string[] = [];
  const rt = {
    cfg: {
      dataDir: base,
      artifactsDir: path.join(base, 'artifacts'),
      bundlesDir: path.join(base, 'bundles'),
      reposDir: repos,
      maxBatchItems: 2000,
      caseDefaultTimeoutS: 120,
    },
    db,
    events: { emit: (topic: string, kind: string) => events.push(`${topic}:${kind}`) },
    log: { info() {}, warn() {}, error() {} },
    workers: new Map(),
    runs: new Map(),
    frames: new Map(),
    watchers: new Map(),
    pendingCancels: new Map(),
  } as unknown as Runtime;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO projects (id, name, description, created_at, source, dir_name, cases_dir, assets_dir, enabled, pull_interval_sec, sync_status)
     VALUES (1, 'alpha', 'alpha repo', ?, 'local', 'alpha-cases', 'cases', '_assets', 1, 0, 'ok')`,
  ).run(now);

  try {
    // 首次同步：caseId = <项目名>/<相对路径>
    const r1 = await updateProjectRepoInner(rt, 1);
    assert.equal(r1.error, null);
    assert.equal(r1.added, 1);
    assert.ok(
      db.prepare(`SELECT id FROM cases WHERE id='alpha/smoke/a'`).get(),
      'alpha/smoke/a 应入索引',
    );

    // 非法项目名（大写/下划线）→ 400
    assert.throws(
      () => patchProject(rt, 1, { name: 'Alpha_1' }),
      (e: Error & { status?: number }) => e.status === 400,
    );
    // 重名 → 409
    db.prepare(`INSERT INTO projects (name, description, created_at) VALUES ('beta', '', ?)`).run(
      now,
    );
    assert.throws(
      () => patchProject(rt, 1, { name: 'beta' }),
      (e: Error & { status?: number }) => e.status === 409,
    );
    // 原名不变 → 不改写
    const same = patchProject(rt, 1, { name: 'alpha' });
    assert.equal(same.name, 'alpha');

    // 改名 → gamma，随后重新同步：caseId 前缀整体切换
    events.length = 0;
    const row = patchProject(rt, 1, { name: 'gamma' });
    assert.equal(row.name, 'gamma');
    assert.ok(events.includes('projects:project.updated'), '改名应广播 project.updated');
    const r2 = await updateProjectRepoInner(rt, 1);
    assert.equal(r2.error, null);
    assert.equal(r2.added, 1);
    assert.equal(r2.removed, 1);
    // 旧 caseId 软删除（status=deleted 即下线）；新前缀入索引
    assert.ok(
      !db.prepare(`SELECT id FROM cases WHERE id=? AND status!='deleted'`).get('alpha/smoke/a'),
      '旧 caseId 应下线',
    );
    assert.ok(
      db.prepare(`SELECT id FROM cases WHERE id=? AND status!='deleted'`).get('gamma/smoke/a'),
      '新 caseId 应入索引',
    );

    // 改回原名：旧 caseId 从软删除复活（计入 updated，不是 added），gamma 前缀下线
    patchProject(rt, 1, { name: 'alpha' });
    const r3 = await updateProjectRepoInner(rt, 1);
    assert.equal(r3.error, null);
    assert.equal(r3.updated, 1, '软删除行复活计入 updated');
    assert.equal(r3.removed, 1);
    assert.equal(r3.added, 0, '复活不产生新行');
    assert.ok(
      db.prepare(`SELECT id FROM cases WHERE id=? AND status!='deleted'`).get('alpha/smoke/a'),
      '旧 caseId 应复活',
    );
    assert.ok(
      !db.prepare(`SELECT id FROM cases WHERE id=? AND status!='deleted'`).get('gamma/smoke/a'),
      '新前缀应下线',
    );
  } finally {
    db.close();
    rmSync(base, { recursive: true, force: true });
  }
});
