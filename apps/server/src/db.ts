import path from 'node:path';
import { resolveDbConfig, type DbConfig } from './db-config.js';
import { createSqlDb, type SqlDb } from './sql-db.js';
import { MIGRATIONS, runMigrations } from './migrations.js';

export { MIGRATIONS, runMigrations, currentVersion } from './migrations.js';
export type { SqlDb } from './sql-db.js';
export type { RunResult, PreparedStatement } from './sql-db.js';
export type { DbConfig, Dialect } from './db-config.js';
export { resolveDbConfig } from './db-config.js';

/**
 * 打开数据库并自动把 schema 升级到当前版本（server 每次启动调用）。
 * 迁移保证见 migrations.ts：有序、幂等、每迁移一个事务、失败即回滚。
 *
 * 支持 sqlite（默认）、mysql、postgresql，方言由环境变量 DB_DIALECT 控制。
 */
export function openDb(dataDir: string): SqlDb {
  const dbCfg = resolveDbConfig(dataDir);
  const db = createSqlDb(dbCfg);
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
