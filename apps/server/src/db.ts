import Database from 'better-sqlite3';
import path from 'node:path';
import { MIGRATIONS, runMigrations } from './migrations.js';

export { MIGRATIONS, runMigrations, currentVersion } from './migrations.js';

/**
 * 打开数据库并自动把 schema 升级到当前版本（server 每次启动调用）。
 * 迁移保证见 migrations.ts：有序、幂等、每迁移一个事务、失败即回滚。
 */
export function openDb(dataDir: string): Database.Database {
  const db = new Database(path.join(dataDir, 'platform.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const report = runMigrations(db, MIGRATIONS, {
    log: (msg) => console.log(`[migrate] ${msg}`),
  });
  if (report.applied.length > 0) {
    console.log(
      `[migrate] schema v${report.fromVersion} → v${report.toVersion}（${report.applied
        .map((m) => `${m.id}:${m.name}`)
        .join(', ')}）`,
    );
  }
  return db;
}
