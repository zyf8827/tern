#!/usr/bin/env node
// 数据库迁移 CLI：status / up
// 用法: node apps/server/dist/migrate-cli.js [status|up]
//   status  查看当前 schema 版本与待应用迁移（只读）
//   up      执行待应用迁移（与 server 启动时的自动迁移同一代码路径）
import Database from 'better-sqlite3';
import path from 'node:path';
import { loadConfig } from './config.js';
import { MIGRATIONS, currentVersion, pendingMigrations, runMigrations } from './migrations.js';

async function main(): Promise<number> {
  const cmd = process.argv[2] ?? 'status';
  const cfg = loadConfig();
  const file = path.join(cfg.dataDir, 'platform.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const cur = currentVersion(db);
  const pending = pendingMigrations(db, MIGRATIONS);
  console.log(`数据库: ${file}`);
  console.log(`当前 schema: v${cur}（平台版本 ${cfg.version}，迁移定义 ${MIGRATIONS.length} 个）`);

  if (cmd === 'status') {
    if (pending.length === 0) {
      console.log('待应用迁移: 无（已最新）');
    } else {
      console.log('待应用迁移:');
      for (const m of pending) console.log(`  v${m.id}  ${m.name}`);
    }
    return 0;
  }

  if (cmd === 'up') {
    if (pending.length === 0) {
      console.log('无待应用迁移。');
      return 0;
    }
    const report = runMigrations(db, MIGRATIONS, { log: (msg) => console.log(msg) });
    console.log(
      `完成: v${report.fromVersion} → v${report.toVersion}，应用 ${report.applied.length} 个迁移`,
    );
    return 0;
  }

  console.error(`未知命令: ${cmd}（可用: status | up）`);
  return 1;
}

process.exit(await main());
