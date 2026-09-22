import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqlDb, type SqlDb } from './sql-db.js';
import { MIGRATIONS, runMigrations } from './migrations.js';
import { syncProjectAssets, lintCaseAssets, activeAssetMap } from './assets.js';
import type { PrepareCaseResult } from '@tern/case-bundler';
import type { Runtime } from './runtime.js';

function tmpRt(): { rt: Runtime; dir: string; close: () => void } {
  const dir = path.join(
    os.tmpdir(),
    `tern-assets-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  rmSync(dir, { recursive: true, force: true });
  // 项目仓库根 = <reposDir>/<项目名>（assetsRoot 按 dir_name ?? name 解析）
  mkdirSync(path.join(dir, 'portal', 'cases', '_assets', 'audio'), { recursive: true });
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
      reposDir: dir,
      bundlesDir: path.join(dir, 'bundles'),
      assetsDir: path.join(dir, 'assets'),
      artifactsDir: path.join(dir, 'artifacts'),
    },
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

import type { ProjectRow } from './repos.js';

function project(rt: Runtime): ProjectRow {
  return rt.db.prepare('SELECT * FROM projects WHERE id=1').get() as ProjectRow;
}

/** 生成最小合法 WAV（44 字节头 + n 字节静音） */
function makeWav(file: string, dataBytes: number): void {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  writeFileSync(file, Buffer.concat([header, Buffer.alloc(dataBytes, 0x01)]));
}

function fakePrep(devices: unknown, refs: string[]): PrepareCaseResult {
  return {
    ok: true,
    relPath: 'media/x.spec.ts',
    caseId: 'media/x',
    project: 'portal',
    source: '',
    contentHash: 'h',
    bundleHash: 'b',
    bundlePath: null,
    frontmatter: {
      meta: { title: 't', description: '', tags: [], meta: {}, devices: devices as never },
      raw: '',
      errors: [],
    },
    assetRefs: refs,
    issues: [],
  };
}

test('资产同步：入库 / 内容寻址 / 增删 / 变更 hash', () => {
  const { rt, dir, close } = tmpRt();
  try {
    const root = path.join(dir, 'portal', 'cases', '_assets');
    makeWav(path.join(root, 'audio', 'tone.wav'), 3200);
    writeFileSync(path.join(root, 'audio', 'note.txt'), 'hello');
    let stat = syncProjectAssets(rt, project(rt));
    assert.deepEqual([stat.added, stat.removed], [2, 0]);
    let map = activeAssetMap(rt, 1);
    assert.equal(map.size, 2);
    assert.equal(map.get('audio/tone.wav')!.size, 44 + 3200);
    // 内容寻址文件落盘
    const hash = map.get('audio/tone.wav')!.hash;
    assert.ok(/^[a-f0-9]{64}$/.test(hash));

    // 修改 note.txt → hash 变化（added 计数 1）；tone 不变则不重算
    writeFileSync(path.join(root, 'audio', 'note.txt'), 'hello world');
    stat = syncProjectAssets(rt, project(rt));
    assert.deepEqual([stat.added, stat.removed], [1, 0]);
    const map2 = activeAssetMap(rt, 1);
    assert.notEqual(map2.get('audio/note.txt')!.hash, map.get('audio/note.txt')!.hash);
    assert.equal(map2.get('audio/tone.wav')!.hash, hash);

    // 删除 note.txt → removed 1
    rmSync(path.join(root, 'audio', 'note.txt'));
    stat = syncProjectAssets(rt, project(rt));
    assert.deepEqual([stat.added, stat.removed], [0, 1]);
    assert.equal(activeAssetMap(rt, 1).size, 1);
  } finally {
    close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('用例资产 lint：devices 存在性/WAV 校验 + ternAsset 引用', () => {
  const { rt, dir, close } = tmpRt();
  try {
    const root = path.join(dir, 'portal', 'cases', '_assets');
    makeWav(path.join(root, 'audio', 'tone.wav'), 3200);
    writeFileSync(path.join(root, 'audio', 'bad.txt'), 'x');
    syncProjectAssets(rt, project(rt));

    // 正常：devices.mic 指向 WAV + ternAsset 引用存在
    let r = lintCaseAssets(rt, 1, fakePrep({ mic: 'audio/tone.wav' }, ['audio/tone.wav']));
    assert.deepEqual(r.issues, []);
    assert.deepEqual(JSON.parse(r.assetsJson), {
      devices: { mic: 'audio/tone.wav' },
      refs: ['audio/tone.wav'],
    });

    // mic 指向非 WAV → ASSET_BAD_FORMAT
    r = lintCaseAssets(rt, 1, fakePrep({ mic: 'audio/bad.txt' }, []));
    assert.equal(r.issues[0].code, 'ASSET_BAD_FORMAT');

    // 引用不存在 → ASSET_NOT_FOUND（devices 与 ternAsset 各报各的）
    r = lintCaseAssets(rt, 1, fakePrep({ mic: 'audio/ghost.wav' }, ['audio/missing.png']));
    assert.deepEqual(
      r.issues.map((i) => i.code),
      ['ASSET_NOT_FOUND', 'ASSET_NOT_FOUND'],
    );

    // 数组形式 devices（仅启用 fake 设备）：无文件校验
    r = lintCaseAssets(rt, 1, fakePrep(['mic'], []));
    assert.deepEqual(r.issues, []);
    assert.deepEqual(JSON.parse(r.assetsJson).devices, ['mic']);
  } finally {
    close();
    rmSync(dir, { recursive: true, force: true });
  }
});
