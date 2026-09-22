// 测试集（docs/test-suite-design.md）单元测试：
// 选择器解析矩阵 / CRUD 校验 / 多集环境上下文归并与（用例×环境）去重 /
// 同上下文冲突 fail-fast / 多环境 run 落库（run_envs + batch_items.run_env_id）/ rerun 保留环境对 / 改名联动 schedules。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqlDb, type SqlDb } from './sql-db.js';
import { MIGRATIONS, runMigrations } from './migrations.js';
import { resolveSuiteSelector } from './selector.js';
import { createSuite, getSuite, updateSuite, deleteSuite, listSuites } from './suites.js';
import { createEnvironment, syncEnvVariables } from './envs.js';
import { createRun, rerunRun, previewRun } from './runtime.js';
import { getRun } from './queries.js';
import type { Runtime } from './runtime.js';
import type { SuiteSelector } from '@tern/sdk';

function tmpRt(): { rt: Runtime; dir: string; close: () => void } {
  const dir = path.join(
    os.tmpdir(),
    `tern-suites-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

function addCase(rt: Runtime, id: string, tags: string[] = [], quarantined = false): void {
  const now = new Date().toISOString();
  rt.db
    .prepare(
      `INSERT INTO cases (id, project_id, title, description, file_path, source, timeout_s, retries, disabled, meta, content_hash, bundle_hash, status, created_at, updated_at, quarantined)
       VALUES (?, 1, ?, '', ?, '', 60, 0, 0, '{}', '${id}-hash', '${id}-bundle', 'active', ?, ?, ?)`,
    )
    .run(id, id, `${id}.spec.ts`, now, now, quarantined ? 1 : 0);
  for (const t of tags)
    rt.db.prepare('INSERT INTO case_tags (case_id, tag) VALUES (?, ?)').run(id, t);
}

function makeEnv(rt: Runtime, name: string, values: Record<string, string>): void {
  // 项目不带 env 清单（无契约），环境值一律按敏感加密存储
  createEnvironment(rt, 1, { name, values });
}

test('resolveSuiteSelector：筛选/全量/包含/排除优先/隔离/悬空', () => {
  const { rt, close } = tmpRt();
  try {
    addCase(rt, 'portal/a-login', ['smoke', 'login']);
    addCase(rt, 'portal/a-admin', ['admin']);
    addCase(rt, 'portal/a-slow', ['slow']);
    addCase(rt, 'portal/a-quar', ['smoke'], true); // 隔离

    // tag 筛选 + 隔离默认排除
    const byTag = resolveSuiteSelector(rt.db, 'portal', { tags: ['smoke'] });
    assert.deepEqual(byTag.ids, ['portal/a-login']);
    assert.equal(byTag.quarantinedExcluded, 1);

    // includeQuarantined 纳入
    assert.deepEqual(resolveSuiteSelector(rt.db, 'portal', { tags: ['smoke'] }, true).ids, [
      'portal/a-login',
      'portal/a-quar',
    ]);

    // 空选择器 = 项目全量（确定性字典序）
    const full = resolveSuiteSelector(rt.db, 'portal', {});
    assert.equal(full.isFullProject, true);
    assert.deepEqual(full.ids, ['portal/a-admin', 'portal/a-login', 'portal/a-slow']);
    assert.equal(resolveSuiteSelector(rt.db, 'portal', { tags: ['smoke'] }).isFullProject, false);

    // 显式包含与筛选取并集；排除压过一切
    assert.deepEqual(
      resolveSuiteSelector(rt.db, 'portal', { tags: ['smoke'], includeCaseIds: ['portal/a-admin'] })
        .ids,
      ['portal/a-admin', 'portal/a-login'],
    );
    assert.deepEqual(
      resolveSuiteSelector(rt.db, 'portal', {
        includeCaseIds: ['portal/a-admin', 'portal/a-login'],
        excludeCaseIds: ['portal/a-login'],
      }).ids,
      ['portal/a-admin'],
    );

    // 悬空引用：不存在的 id 警示不报错；include∩exclude 死条目
    const dangling = resolveSuiteSelector(rt.db, 'portal', {
      includeCaseIds: ['portal/a-login', 'portal/gone'],
      excludeCaseIds: ['portal/a-login'],
    });
    assert.deepEqual(dangling.ids, []);
    assert.deepEqual(dangling.danglingIncludes, ['portal/gone']);
    assert.deepEqual(dangling.deadEntries, ['portal/a-login']);
  } finally {
    close();
  }
});

test('测试集 CRUD：命名/选择器校验、跨项目点名拒绝、健康度', () => {
  const { rt, close } = tmpRt();
  try {
    addCase(rt, 'portal/a-login', ['smoke']);
    rt.db
      .prepare(`INSERT INTO projects (name, created_at) VALUES ('other', ?)`)
      .run(new Date().toISOString());
    addCaseOther(rt);

    assert.throws(() => createSuite(rt, 'portal', { name: 'Bad_Name' }, 'test'), /kebab-case/);
    assert.throws(
      () =>
        createSuite(
          rt,
          'portal',
          { name: 'smoke', selector: { tags: ['x'], nope: 1 } as unknown as SuiteSelector },
          'test',
        ),
      /selector/,
    );
    assert.throws(
      () =>
        createSuite(
          rt,
          'portal',
          { name: 'smoke', selector: { includeCaseIds: ['other/x'] } },
          'test',
        ),
      /不属于本项目/,
    );

    const s = createSuite(
      rt,
      'portal',
      {
        name: 'smoke',
        description: '冒烟',
        selector: { tags: ['smoke'] },
        env: 'dev',
        account: 'admin',
      },
      'test',
    );
    assert.equal(s.health.resolvedCount, 1);
    assert.equal(s.health.envStatus, 'missing'); // dev 环境未建（软校验）
    assert.equal(s.health.accountKnown, false); // auth 快照无 accounts

    assert.throws(() => createSuite(rt, 'portal', { name: 'smoke' }, 'test'), /测试集已存在/);

    makeEnv(rt, 'dev', { BASE_URL: 'http://dev' });
    assert.equal(getSuite(rt, 1, 'smoke').health.envStatus, 'ok');

    const renamed = updateSuite(rt, 'portal', 'smoke', { name: 'smoke-v2' });
    assert.equal(renamed.name, 'smoke-v2');
    assert.throws(() => getSuite(rt, 1, 'smoke'), /测试集不存在/);

    deleteSuite(rt, 'portal', 'smoke-v2');
    assert.deepEqual(listSuites(rt, 1), []);
  } finally {
    close();
  }
});

function addCaseOther(rt: Runtime): void {
  const now = new Date().toISOString();
  rt.db
    .prepare(
      `INSERT INTO cases (id, project_id, title, description, file_path, source, timeout_s, retries, disabled, meta, content_hash, bundle_hash, status, created_at, updated_at)
       VALUES ('other/x', 2, 'x', '', 'x.spec.ts', '', 60, 0, 0, '{}', 'x', 'xb', 'active', ?, ?)`,
    )
    .run(now, now);
}

test('多测试集：环境上下文归并 + （用例×环境）去重', () => {
  const { rt, close } = tmpRt();
  try {
    addCase(rt, 'portal/a', ['smoke', 'reg']);
    addCase(rt, 'portal/b', ['smoke']);
    addCase(rt, 'portal/c', ['reg']);
    makeEnv(rt, 'dev', {});
    makeEnv(rt, 'staging', {});
    createSuite(rt, 'portal', { name: 'smoke', selector: { tags: ['smoke'] }, env: 'dev' }, 't');
    createSuite(rt, 'portal', { name: 'reg', selector: { tags: ['reg'] }, env: 'staging' }, 't');

    // a 同时在两集（不同环境）→ 2 条；b/c 各 1 条 → 总 4
    const run = createRun(rt, { project: 'portal', suites: ['smoke', 'reg'] }, 'test');
    assert.equal(run.total, 4);

    const ctxs = rt.db
      .prepare('SELECT * FROM run_envs WHERE batch_id=? ORDER BY position')
      .all(run.id) as {
      env_name: string;
    }[];
    assert.deepEqual(
      ctxs.map((c) => c.env_name),
      ['dev', 'staging'],
    );
    const items = rt.db
      .prepare(
        'SELECT bi.case_id, re.env_name FROM batch_items bi LEFT JOIN run_envs re ON re.id=bi.run_env_id WHERE bi.batch_id=? ORDER BY bi.position',
      )
      .all(run.id) as { case_id: string; env_name: string }[];
    assert.deepEqual(items.map((i) => `${i.case_id}@${i.env_name}`).sort(), [
      'portal/a@dev',
      'portal/a@staging',
      'portal/b@dev',
      'portal/c@staging',
    ]);
    // RunInfo 派生字段
    assert.deepEqual(run.envs.sort(), ['dev', 'staging']);
    assert.deepEqual(run.suites.sort(), ['reg', 'smoke']);

    // 同环境两集 → 去重为一条
    createSuite(rt, 'portal', { name: 'smoke2', selector: { tags: ['smoke'] }, env: 'dev' }, 't');
    const run2 = createRun(rt, { project: 'portal', suites: ['smoke', 'smoke2'] }, 'test');
    assert.equal(run2.total, 2); // a、b 各一次（dev）
    const scope2 = JSON.parse(
      (rt.db.prepare('SELECT scope FROM batches WHERE id=?').get(run2.id) as { scope: string })
        .scope,
    );
    assert.ok(
      scope2.deduped.length === 2 &&
        scope2.deduped.some((d: { caseId: string }) => d.caseId === 'portal/a'),
    );
    assert.deepEqual(
      scope2.envContexts.map((c: { env: string | null }) => c.env),
      ['dev'],
    );
  } finally {
    close();
  }
});

test('同环境上下文冲突 fail-fast，run 显式值可解；拉平模式', () => {
  const { rt, dir, close } = tmpRt();
  try {
    addCase(rt, 'portal/a', ['x']);
    // auth 账号表（账号硬校验需要；readAuthSnapshot 从 repos/<name>/tern.yaml 现读）
    const repoDir = path.join(dir, 'repos', 'portal');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(
      path.join(repoDir, 'tern.yaml'),
      'name: portal\nauth:\n  mode: api\n  url: /login\n  accounts:\n    default: { clientId: d }\n    admin: { clientId: a }\n',
    );
    makeEnv(rt, 'dev', {});
    makeEnv(rt, 'staging', {});
    createSuite(
      rt,
      'portal',
      { name: 's1', selector: { tags: ['x'] }, env: 'dev', account: 'admin' },
      't',
    );
    createSuite(
      rt,
      'portal',
      { name: 's2', selector: { tags: ['x'] }, env: 'dev', account: 'default' },
      't',
    );
    createSuite(
      rt,
      'portal',
      { name: 's3', selector: { tags: ['x'] }, env: 'dev', params: { K: '1' } },
      't',
    );
    createSuite(
      rt,
      'portal',
      { name: 's4', selector: { tags: ['x'] }, env: 'dev', params: { K: '2' } },
      't',
    );
    // 单侧绑定账号/参数 = 采纳（无冲突；只有同键"都有值且不同"才冲突）
    createSuite(rt, 'portal', { name: 's5', selector: { tags: ['x'] }, env: 'dev' }, 't');
    createRun(rt, { project: 'portal', suites: ['s1', 's5'] }, 'test');

    // 账号冲突（同环境 dev）
    assert.throws(
      () => createRun(rt, { project: 'portal', suites: ['s1', 's2'] }, 'test'),
      /不同账号/,
    );
    assert.throws(
      () => createRun(rt, { project: 'portal', suites: ['s1', 's2'], env: 'staging' }, 'test'),
      /不同账号/,
    ); // 拉平同样检查
    // run 显式 AUTH_ACCOUNT 解冲突
    createRun(
      rt,
      { project: 'portal', suites: ['s1', 's2'], params: { AUTH_ACCOUNT: 'admin' } },
      'test',
    );
    // 参数冲突
    assert.throws(
      () => createRun(rt, { project: 'portal', suites: ['s3', 's4'] }, 'test'),
      /不同值/,
    );
    // run 显式参数解冲突
    createRun(rt, { project: 'portal', suites: ['s3', 's4'], params: { K: '9' } }, 'test');
    // 不同环境不冲突（账号/参数各归各的上下文）
    updateSuite(rt, 'portal', 's2', { env: 'staging' });
    createRun(rt, { project: 'portal', suites: ['s1', 's2'] }, 'test');

    // run 显式 env = 覆盖拉平：两集并入 staging 单一上下文，同用例去重为一条
    const flat = createRun(
      rt,
      {
        project: 'portal',
        suites: ['s1', 's2'],
        env: 'staging',
        params: { AUTH_ACCOUNT: 'admin' },
      },
      'test',
    );
    assert.equal(flat.total, 1);
    assert.equal(flat.envName, 'staging');
    const scope = JSON.parse(
      (rt.db.prepare('SELECT scope FROM batches WHERE id=?').get(flat.id) as { scope: string })
        .scope,
    );
    assert.equal(scope.envOverridden, true);
  } finally {
    close();
  }
});

test('多环境 run：每上下文解析环境值与 secret、assign 参数基底正确', () => {
  const { rt, dir, close } = tmpRt();
  try {
    addCase(rt, 'portal/a', ['smoke']);
    addCase(rt, 'portal/b', ['reg']);
    // 变量清单（契约）：BASE_URL 明文，TOKEN secret
    const repoDir = path.join(dir, 'repos', 'portal');
    mkdirSync(repoDir, { recursive: true });
    syncEnvVariables(
      rt,
      1,
      path.join(dir, 'nowhere'), // 无 yaml → 空清单；下面手工塞清单
    );
    rt.db
      .prepare(
        'INSERT INTO env_variables (project_id, key, description, secret, position) VALUES (1, ?, ?, ?, ?)',
      )
      .run('BASE_URL', '', 0, 0);
    rt.db
      .prepare(
        'INSERT INTO env_variables (project_id, key, description, secret, position) VALUES (1, ?, ?, ?, ?)',
      )
      .run('TOKEN', '', 1, 1);
    makeEnv(rt, 'dev', { BASE_URL: 'http://dev', TOKEN: 'dev-token' });
    makeEnv(rt, 'staging', { BASE_URL: 'http://staging', TOKEN: 'staging-token' });

    createSuite(rt, 'portal', { name: 'smoke', selector: { tags: ['smoke'] }, env: 'dev' }, 't');
    createSuite(
      rt,
      'portal',
      { name: 'reg', selector: { tags: ['reg'] }, env: 'staging', params: { EXTRA: 'r' } },
      't',
    );
    const run = createRun(rt, { project: 'portal', suites: ['smoke', 'reg'] }, 'test');

    const ctxs = rt.db
      .prepare('SELECT * FROM run_envs WHERE batch_id=? ORDER BY position')
      .all(run.id) as {
      env_name: string;
      params: string;
      params_secret: string | null;
    }[];
    assert.equal(ctxs.length, 2);
    assert.deepEqual(JSON.parse(ctxs[0].params), { BASE_URL: 'http://dev' }); // secret 不在明文
    assert.ok(ctxs[0].params_secret); // TOKEN 密文存在
    assert.deepEqual(JSON.parse(ctxs[1].params), { BASE_URL: 'http://staging', EXTRA: 'r' });
    assert.ok(ctxs[1].params_secret);
    // batches.params 只剩 run 级显式（此处空）
    const batch = rt.db.prepare('SELECT params FROM batches WHERE id=?').get(run.id) as {
      params: string;
    };
    assert.deepEqual(JSON.parse(batch.params), {});
  } finally {
    close();
  }
});

test('引用校验：不存在/停用/空集/跨项目', () => {
  const { rt, close } = tmpRt();
  try {
    addCase(rt, 'portal/a', ['x']);
    assert.throws(
      () => createRun(rt, { project: 'portal', suites: ['nope'] }, 'test'),
      /测试集不存在/,
    );
    createSuite(rt, 'portal', { name: 'empty', selector: { tags: ['none'] } }, 't');
    assert.throws(
      () => createRun(rt, { project: 'portal', suites: ['empty'] }, 'test'),
      /命中 0 条/,
    );
    createSuite(rt, 'portal', { name: 'off', selector: { tags: ['x'] }, enabled: false }, 't');
    assert.throws(() => createRun(rt, { project: 'portal', suites: ['off'] }, 'test'), /已停用/);
    rt.db
      .prepare(`INSERT INTO projects (name, created_at) VALUES ('other', ?)`)
      .run(new Date().toISOString());
    addCaseOther(rt);
    createSuite(rt, 'other', { name: 's', selector: { includeCaseIds: ['other/x'] } }, 't');
    assert.throws(
      () => createRun(rt, { project: 'portal', suites: ['s'] }, 'test'),
      /不属于项目|与本次运行的项目/,
    );
    // 未指定 project 时从测试集推导
    const run = createRun(rt, { suites: ['s'] }, 'test');
    assert.equal(run.project, 'other');
  } finally {
    close();
  }
});

test('previewRun：与 createRun 同构的命中预览（上下文分组 + 去重明细）', () => {
  const { rt, close } = tmpRt();
  try {
    addCase(rt, 'portal/a', ['smoke', 'reg']);
    addCase(rt, 'portal/b', ['smoke']);
    createSuite(rt, 'portal', { name: 'smoke', selector: { tags: ['smoke'] }, env: 'dev' }, 't');
    createSuite(rt, 'portal', { name: 'reg', selector: { tags: ['reg'] }, env: 'staging' }, 't');
    const p = previewRun(rt, { project: 'portal', suites: ['smoke', 'reg'] });
    assert.equal(p.total, 3); // a@dev + b@dev + a@staging（a 跨环境各一条）
    assert.deepEqual(
      p.contexts.map((c) => [c.env, c.caseCount]),
      [
        ['dev', 2],
        ['staging', 1],
      ],
    );
  } finally {
    close();
  }
});

test('rerunRun：多环境 run 按（用例×环境）对原位重跑', () => {
  const { rt, close } = tmpRt();
  try {
    addCase(rt, 'portal/a', ['smoke', 'reg']);
    addCase(rt, 'portal/b', ['smoke']);
    makeEnv(rt, 'dev', {});
    makeEnv(rt, 'staging', {});
    createSuite(rt, 'portal', { name: 'smoke', selector: { tags: ['smoke'] }, env: 'dev' }, 't');
    createSuite(rt, 'portal', { name: 'reg', selector: { tags: ['reg'] }, env: 'staging' }, 't');
    const run = createRun(rt, { project: 'portal', suites: ['smoke', 'reg'] }, 'test');

    // 模拟 dev 的 a 失败、其余通过
    rt.db
      .prepare(
        `UPDATE batch_items SET status=CASE WHEN case_id='portal/a' AND run_env_id=(SELECT id FROM run_envs WHERE batch_id=? AND env_name='dev') THEN 'failed' ELSE 'passed' END, finished_at=? WHERE batch_id=?`,
      )
      .run(run.id, new Date().toISOString(), run.id);
    rt.db
      .prepare(`UPDATE batches SET status='completed', finished_at=? WHERE id=?`)
      .run(new Date().toISOString(), run.id);

    const retry = rerunRun(rt, run.id, 'test', 'failed');
    assert.equal(retry.total, 1);
    assert.equal(retry.envName, 'dev'); // 单一环境上下文保持 envName（与首次创建一致）
    const item = rt.db
      .prepare(
        'SELECT bi.case_id, re.env_name FROM batch_items bi LEFT JOIN run_envs re ON re.id=bi.run_env_id WHERE bi.batch_id=?',
      )
      .get(retry.id) as { case_id: string; env_name: string };
    assert.equal(item.case_id, 'portal/a');
    assert.equal(item.env_name, 'dev'); // 失败在哪个环境，就在哪个环境重跑
    // 上下文值原样复制（非重解析）
    const ctx = rt.db.prepare('SELECT env_name FROM run_envs WHERE batch_id=?').get(retry.id) as {
      env_name: string;
    };
    assert.equal(ctx.env_name, 'dev');

    // 全量重跑保留两上下文四条目
    const all = rerunRun(rt, run.id, 'test', 'all');
    assert.equal(all.total, 3);
    assert.equal(all.envName, null); // 多环境：envName 空，环境看 envs
    assert.deepEqual(all.envs.sort(), ['dev', 'staging']);
  } finally {
    close();
  }
});

test('改名联动 schedules.scope.suites', () => {
  const { rt, close } = tmpRt();
  try {
    addCase(rt, 'portal/a', ['x']);
    createSuite(rt, 'portal', { name: 'smoke', selector: { tags: ['x'] } }, 't');
    const now = new Date().toISOString();
    rt.db
      .prepare(
        `INSERT INTO schedules (id, project_id, name, cron, scope, max_attempts, enabled, next_run_at, created_by, created_at)
         VALUES ('s_1', 1, '每晚冒烟', '0 9 * * *', ?, 1, 1, ?, 'test', ?)`,
      )
      .run(JSON.stringify({ suites: ['smoke', 'other-suite'] }), now, now);
    updateSuite(rt, 'portal', 'smoke', { name: 'smoke-v2' });
    const scope = JSON.parse(
      (rt.db.prepare('SELECT scope FROM schedules WHERE id=?').get('s_1') as { scope: string })
        .scope,
    );
    assert.deepEqual(scope.suites, ['smoke-v2', 'other-suite']);
  } finally {
    close();
  }
});

test('直接指定范围与测试集并存：并集 + 隐式上下文；getRun 条目带 env', () => {
  const { rt, close } = tmpRt();
  try {
    addCase(rt, 'portal/a', ['smoke']);
    addCase(rt, 'portal/b', []);
    makeEnv(rt, 'dev', {});
    createSuite(rt, 'portal', { name: 'smoke', selector: { tags: ['smoke'] }, env: 'dev' }, 't');
    const run = createRun(
      rt,
      { project: 'portal', suites: ['smoke'], caseIds: ['portal/b'] },
      'test',
    );
    assert.equal(run.total, 2);
    const detail = getRun(rt, run.id)!;
    const envByCase = new Map(detail.items.map((i) => [i.caseId, i.env]));
    assert.equal(envByCase.get('portal/a'), 'dev');
    assert.equal(envByCase.get('portal/b'), null); // 直接点名 → 隐式（无环境）上下文
    // 纯直接范围（无测试集）走既有路径：无 run_envs 行
    const legacy = createRun(rt, { project: 'portal', caseIds: ['portal/b'] }, 'test');
    assert.equal(legacy.total, 1);
    assert.equal(
      (
        rt.db.prepare('SELECT COUNT(*) AS n FROM run_envs WHERE batch_id=?').get(legacy.id) as {
          n: number;
        }
      ).n,
      0,
    );
    assert.deepEqual(legacy.suites, []);
    assert.deepEqual(legacy.envs, []);
    // 回归：旧式单环境 run（带 env）详情视图 envs 从 env_name 派生（无 run_envs 行时不能误报空）
    const legacyEnv = createRun(
      rt,
      { project: 'portal', caseIds: ['portal/b'], env: 'dev' },
      'test',
    );
    const legacyEnvDetail = getRun(rt, legacyEnv.id)!;
    assert.equal(legacyEnvDetail.envName, 'dev');
    assert.deepEqual(legacyEnvDetail.envs, ['dev']);
    // 回归：RunInfo.envs 只含真实环境（隐式上下文不算）
    assert.deepEqual(run.envs, ['dev']);
  } finally {
    close();
  }
});
