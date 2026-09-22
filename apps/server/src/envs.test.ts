import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqlDb, type SqlDb } from './sql-db.js';
import { MIGRATIONS, runMigrations } from './migrations.js';
import { encryptJson, getSecretKey, resetSecretKeyCache } from './crypto.js';
import {
  createEnvironment,
  envManifest,
  listEnvironments,
  parseEnvVariables,
  resolveEnvParams,
  syncEnvVariables,
  updateEnvironment,
} from './envs.js';
import type { Runtime } from './runtime.js';

function tmpRt(): { rt: Runtime; dir: string; close: () => void } {
  const dir = path.join(
    os.tmpdir(),
    `tern-envs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
    cfg: { dataDir: dir, artifactsDir: path.join(dir, 'artifacts') },
    db,
    events: { emit() {} },
    log: { info() {}, warn() {} },
    workers: new Map(),
    runs: new Map(),
    frames: new Map(),
    watchers: new Map(),
    pendingCancels: new Map(),
  } as unknown as Runtime;
  return { rt, dir, close: () => db.close() };
}

const YAML = (envNode: string) => `name: portal\n${envNode}`;

test('清单解析：命名校验、防呆告警', () => {
  const { variables, warnings } = parseEnvVariables(
    YAML(`
env:
  variables:
    BASE_URL:
      description: 地址
    CLIENT_ID:
      secret: true
    bad-name: {}
    ADMIN_TOKEN: {}      # 疑似凭据未标 secret
`),
  );
  assert.deepEqual(
    variables.map((v) => v.key),
    ['BASE_URL', 'CLIENT_ID', 'ADMIN_TOKEN'],
  );
  assert.equal(variables[1].secret, true);
  assert.equal(warnings.length, 2); // 坏名 + 防呆
  assert.match(warnings[0], /bad-name/);
  assert.match(warnings[1], /ADMIN_TOKEN/);
  // 无节点 → 空清单无告警
  const empty = parseEnvVariables(YAML(''));
  assert.deepEqual(empty, { variables: [], warnings: [] });
});

test('环境 CRUD + 完备性 + 脱敏', () => {
  const { rt, close, dir } = tmpRt();
  try {
    syncEnvVariables(rt, 1, dir); // dir 里没有 tern.yaml → 空清单
    // 手动塞一份清单（绕开文件，直接测 CRUD 语义）
    rt.db
      .prepare(
        'INSERT INTO env_variables (project_id, key, description, secret, position) VALUES (1, ?, ?, ?, ?)',
      )
      .run('CLIENT_ID', '', 1, 0);
    rt.db
      .prepare(
        'INSERT INTO env_variables (project_id, key, description, secret, position) VALUES (1, ?, ?, ?, ?)',
      )
      .run('BASE_URL', '', 0, 1);

    createEnvironment(rt, 1, { name: 'staging', values: { BASE_URL: 'https://s.example.com' } });
    // 未知键拒绝
    assert.throws(
      () => createEnvironment(rt, 1, { name: 'x', values: { FOO: '1' } }),
      (e: unknown) => (e as { code?: string }).code === 'ENV_UNKNOWN_KEYS',
    );
    // 完备性：缺 CLIENT_ID
    let items = listEnvironments(rt, 1);
    assert.equal(items[0].complete, false);
    assert.deepEqual(items[0].missingKeys, ['CLIENT_ID']);
    // 补齐后：BASE_URL 非 secret 回显，CLIENT_ID secret 脱敏
    updateEnvironment(rt, 1, 'staging', {
      values: { BASE_URL: 'https://s.example.com', CLIENT_ID: 'cid-123' },
    });
    items = listEnvironments(rt, 1);
    assert.equal(items[0].complete, true);
    assert.equal(items[0].values.BASE_URL, 'https://s.example.com');
    assert.equal(items[0].values.CLIENT_ID, null); // 已配置但不回显
  } finally {
    close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveEnvParams：分层覆盖 / fail-fast / secret 分装 / 透传密文', () => {
  const { rt, close, dir } = tmpRt();
  try {
    resetSecretKeyCache();
    rt.db
      .prepare(
        'INSERT INTO env_variables (project_id, key, description, secret, position) VALUES (1, ?, ?, ?, ?)',
      )
      .run('BASE_URL', '', 0, 0);
    rt.db
      .prepare(
        'INSERT INTO env_variables (project_id, key, description, secret, position) VALUES (1, ?, ?, ?, ?)',
      )
      .run('CLIENT_ID', '', 1, 1);
    createEnvironment(rt, 1, {
      name: 'staging',
      values: { BASE_URL: 'https://s.example.com', CLIENT_ID: 'cid-secret' },
    });

    // 1) 环境不存在
    assert.throws(
      () => resolveEnvParams(rt, 1, 'nope', undefined, undefined),
      (e: unknown) => (e as { code?: string }).code === 'ENV_NOT_FOUND',
    );
    // 2) 常规展开：非 secret → params；secret → secretParams
    const r1 = resolveEnvParams(rt, 1, 'staging', undefined, undefined);
    assert.deepEqual(r1.params, { BASE_URL: 'https://s.example.com' });
    assert.deepEqual(r1.secretParams, { CLIENT_ID: 'cid-secret' });
    // 3) 显式覆盖优先 + secretParams 标记
    const r2 = resolveEnvParams(rt, 1, 'staging', { BASE_URL: 'http://override', EXTRA: '1' }, [
      'EXTRA',
    ]);
    assert.deepEqual(r2.params, { BASE_URL: 'http://override' });
    assert.deepEqual(r2.secretParams, { CLIENT_ID: 'cid-secret', EXTRA: '1' });
    // 4) 密文透传合并
    const enc = encryptJson({ FROM_OLD: 'old-secret' }, getSecretKey(dir));
    const r3 = resolveEnvParams(rt, 1, 'staging', undefined, undefined, enc);
    assert.equal(r3.secretParams.FROM_OLD, 'old-secret');
    assert.equal(r3.secretParams.CLIENT_ID, 'cid-secret');
    // 5) 环境缺值 fail-fast（直写缺 CLIENT_ID 的密文构造场景）
    rt.db
      .prepare('UPDATE environments SET values_enc=? WHERE project_id=1 AND name=?')
      .run(encryptJson({ BASE_URL: 'https://s.example.com' }, getSecretKey(dir)), 'staging');
    assert.throws(
      () => resolveEnvParams(rt, 1, 'staging', undefined, undefined),
      (e: unknown) => (e as { code?: string }).code === 'MISSING_ENV_VALUES',
    );
  } finally {
    close();
    resetSecretKeyCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncEnvVariables：镜像 + 残留值告警', () => {
  const { rt, close, dir } = tmpRt();
  try {
    writeFileSync(
      path.join(dir, 'tern.yaml'),
      YAML(`
env:
  variables:
    BASE_URL: {}
`),
    );
    let w = syncEnvVariables(rt, 1, dir);
    assert.deepEqual(
      envManifest(rt, 1).map((v) => v.key),
      ['BASE_URL'],
    );
    assert.equal(w.length, 0);
    // 环境里出现清单外的值（模拟清单曾经的变量被删）：直写密文构造
    createEnvironment(rt, 1, { name: 'dev', values: { BASE_URL: 'http://d' } });
    rt.db
      .prepare('UPDATE environments SET values_enc=? WHERE project_id=1 AND name=?')
      .run(encryptJson({ BASE_URL: 'http://d', FOO: 'x' }, getSecretKey(dir)), 'dev');
    w = syncEnvVariables(rt, 1, dir);
    assert.ok(w.some((x) => x.includes('FOO')));
  } finally {
    close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('环境级设备反向代理：默认 auto / 创建指定 / 单独 PATCH / 非法值拒绝', () => {
  const { rt, close } = tmpRt();
  try {
    // 手动塞一份清单，保证 values 校验路径可用
    rt.db
      .prepare(
        "INSERT INTO env_variables (project_id, key, description, secret, position) VALUES (1, 'BASE_URL', '', 0, 0)",
      )
      .run();
    const created = createEnvironment(rt, 1, {
      name: 'dev',
      values: { BASE_URL: 'http://10.0.0.10:8080' },
    });
    assert.equal(created.deviceProxy, 'auto'); // 缺省 auto
    const forced = createEnvironment(rt, 1, {
      name: 'lab',
      values: { BASE_URL: 'http://10.0.0.5:8080' },
      deviceProxy: 'on',
    });
    assert.equal(forced.deviceProxy, 'on');

    // 单独 PATCH（不动值集）
    const patched = updateEnvironment(rt, 1, 'dev', { deviceProxy: 'off' });
    assert.equal(patched.deviceProxy, 'off');
    assert.equal(
      listEnvironments(rt, 1).find((e) => e.name === 'dev')?.values.BASE_URL,
      'http://10.0.0.10:8080',
    );

    // 非法值拒绝（创建与更新）
    assert.throws(
      () => createEnvironment(rt, 1, { name: 'bad', values: {}, deviceProxy: 'yes' as never }),
      /deviceProxy/,
    );
    assert.throws(
      () => updateEnvironment(rt, 1, 'dev', { deviceProxy: 'always' as never }),
      /deviceProxy/,
    );

    // resolveEnvParams 带出环境模式（createRun 快照用）
    assert.equal(resolveEnvParams(rt, 1, 'dev', undefined, undefined).deviceProxy, 'off');
    assert.equal(resolveEnvParams(rt, 1, 'lab', undefined, undefined).deviceProxy, 'on');
  } finally {
    close();
  }
});
