/**
 * 跨方言数据库抽象层。
 *
 * - sqlite: 直接使用 better-sqlite3 同步 API（零开销，当前行为不变）
 * - mysql / postgresql: 通过 Worker 线程 + SharedArrayBuffer 同步桥接，
 *   保持与 sqlite 一致的同步调用语义。
 *
 * 对外暴露 prepare / get / all / run / exec / transaction API，
 * 上层业务代码无需区分方言、无需 async/await 改造。
 */
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import type { DbConfig, Dialect } from './db-config.js';

const require = createRequire(import.meta.url);

export interface RunResult {
  lastInsertRowid: number | bigint;
  changes: number;
}

export interface PreparedStatement {
  get(...params: unknown[]): unknown | undefined;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): RunResult;
}

export interface SqlDb {
  readonly dialect: Dialect;
  prepare(sql: string): PreparedStatement;
  exec(sql: string): void;
  pragma(directive: string): unknown;
  transaction<T>(fn: () => T): () => T;
  close(): void;
  jsonArrayAgg(expr: string): string;
  insertOrIgnore(table: string, columns: string[]): string;
  insertReturningId(sql: string, ...params: unknown[]): number;
}

// ============================================================
//  SQLite：直接委托 better-sqlite3（同步，零开销）
// ============================================================

function createSqliteDb(cfg: DbConfig): SqlDb {
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const db = new Database(cfg.sqlitePath!);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return {
    dialect: 'sqlite',
    prepare(sql: string): PreparedStatement {
      const stmt = db.prepare(sql);
      return {
        get: (...p: unknown[]) => stmt.get(...p),
        all: (...p: unknown[]) => stmt.all(...p),
        run(...p: unknown[]): RunResult {
          const info = stmt.run(...p);
          return { lastInsertRowid: info.lastInsertRowid, changes: info.changes };
        },
      };
    },
    exec: (sql: string) => db.exec(sql),
    pragma: (d: string) => db.pragma(d),
    transaction<T>(fn: () => T): () => T {
      return db.transaction(fn);
    },
    close: () => db.close(),
    jsonArrayAgg: (expr: string) => `json_group_array(${expr})`,
    insertOrIgnore: (table: string, columns: string[]) => `INSERT OR IGNORE INTO ${table} (${columns.join(', ')})`,
    insertReturningId: (sql: string, ...p: unknown[]) => Number(db.prepare(sql).run(...p).lastInsertRowid),
  };
}

// ============================================================
//  MySQL / PostgreSQL：Worker 线程同步桥接
// ============================================================
//
// 原理：主线程 Atomics.wait() 阻塞，Worker 线程执行异步查询后
// Atomics.notify() 唤醒。SharedArrayBuffer 传递控制信号，
// MessagePort 传递查询内容和结果（避免序列化限制）。

const WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads');

let conn;
let dialect;

function initMysql(cfg) {
  const mysql2 = require('mysql2');
  const c = cfg.url
    ? mysql2.createConnection({ uri: cfg.url, multipleStatements: true })
    : mysql2.createConnection({
        host: cfg.host, port: cfg.port, user: cfg.user,
        password: cfg.password, database: cfg.database,
        multipleStatements: true,
      });
  return new Promise((resolve, reject) => {
    c.connect((err) => err ? reject(err) : resolve(c));
  });
}

function initPg(cfg) {
  const { Client } = require('pg');
  const c = new Client(
    cfg.url
      ? { connectionString: cfg.url }
      : { host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database }
  );
  return c.connect().then(() => c);
}

function convertPlaceholders(sql, d) {
  if (d !== 'postgresql') return sql;
  let idx = 0;
  return sql.replace(/\?/g, () => '$' + (++idx));
}

async function execQuery(sql, params, method) {
  sql = convertPlaceholders(sql, dialect);
  if (dialect === 'mysql') {
    return new Promise((resolve, reject) => {
      const cb = (err, rows, fields) => {
        if (err) return reject(err);
        if (Array.isArray(rows)) {
          resolve({ rows, insertId: 0, affectedRows: 0 });
        } else {
          resolve({ rows: [], insertId: rows.insertId || 0, affectedRows: rows.affectedRows || 0 });
        }
      };
      if (method === 'exec' || !params || params.length === 0) {
        conn.query(sql, params || [], cb);
      } else {
        conn.execute(sql, params, cb);
      }
    });
  } else {
    const res = await conn.query(sql, params || []);
    let insertId = 0;
    let rows = [];
    let affectedRows = 0;
    if (Array.isArray(res)) {
      const lastRes = res[res.length - 1];
      rows = lastRes.rows || [];
      affectedRows = lastRes.rowCount || 0;
      if (rows.length > 0 && rows[0].id != null) insertId = rows[0].id;
    } else {
      rows = res.rows || [];
      affectedRows = res.rowCount || 0;
      if (rows.length > 0 && rows[0].id != null) insertId = rows[0].id;
    }
    return { rows, insertId, affectedRows };
  }
}

(async () => {
  const cfg = workerData.cfg;
  dialect = cfg.dialect;
  conn = cfg.dialect === 'mysql' ? await initMysql(cfg) : await initPg(cfg);

  const sab = workerData.sab;
  const signal = new Int32Array(sab);

  parentPort.on('message', async (msg) => {
    const { sql, params, method, port } = msg;
    if (!port) return; 
    try {
      const result = await execQuery(sql, params, method);
      port.postMessage({ ok: true, result });
    } catch (e) {
      port.postMessage({ ok: false, error: e.message, stack: e.stack });
    } finally {
      Atomics.store(signal, 0, 1);
      Atomics.notify(signal, 0);
    }
  });

  parentPort.postMessage({ type: 'ready' });
})();
`;

interface WorkerBridge {
  query(sql: string, params: unknown[], method: 'get' | 'all' | 'run' | 'exec'): { rows: unknown[]; insertId: number; affectedRows: number };
  close(): void;
}

function createWorkerBridge(cfg: DbConfig): WorkerBridge {
  const { MessageChannel, receiveMessageOnPort } = require('node:worker_threads');
  const sab = new SharedArrayBuffer(4);
  const signal = new Int32Array(sab);

  const worker = new Worker(WORKER_CODE, {
    eval: true,
    workerData: { cfg, sab },
  });

  let ready = false;
  let initError: Error | null = null;

  worker.on('message', (msg) => {
    if (msg.type === 'ready') {
      ready = true;
      Atomics.store(signal, 0, 1);
      Atomics.notify(signal, 0);
    }
  });
  worker.on('error', (e) => {
    initError = e;
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  });

  Atomics.store(signal, 0, 0);
  Atomics.wait(signal, 0, 0, 30000);
  if (initError) throw initError;
  if (!ready) throw new Error('[db] Worker 初始化超时（30s）');

  return {
    query(sql: string, params: unknown[], method: 'get' | 'all' | 'run' | 'exec') {
      const { port1, port2 } = new MessageChannel();
      Atomics.store(signal, 0, 0);
      worker.postMessage({ sql, params, method, port: port2 }, [port2]);
      Atomics.wait(signal, 0, 0, 60000);
      
      const msg = receiveMessageOnPort(port1);
      if (!msg) throw new Error('[db] 查询超时或未收到返回结果');
      const lastResult = msg.message;
      
      if (!lastResult.ok) {
        const e = new Error(lastResult.error || 'query failed');
        if (lastResult.stack) e.stack = lastResult.stack;
        throw e;
      }
      return lastResult.result as { rows: unknown[]; insertId: number; affectedRows: number };
    },
    close() {
      worker.terminate();
    },
  };
}

function createAsyncDialectDb(cfg: DbConfig): SqlDb {
  const bridge = createWorkerBridge(cfg);
  const dialect = cfg.dialect;

  return {
    dialect,
    prepare(sql: string): PreparedStatement {
      return {
        get(...params: unknown[]) {
          return bridge.query(sql, params, 'get').rows[0];
        },
        all(...params: unknown[]) {
          return bridge.query(sql, params, 'all').rows;
        },
        run(...params: unknown[]): RunResult {
          const r = bridge.query(sql, params, 'run');
          return { lastInsertRowid: r.insertId, changes: r.affectedRows };
        },
      };
    },
    exec(sql: string): void {
      bridge.query(sql, [], 'exec');
    },
    pragma(_directive: string): unknown {
      // pragma 仅 sqlite 使用，mysql/pg 忽略
      return undefined;
    },
    transaction<T>(fn: () => T): () => T {
      return () => {
        bridge.query('BEGIN', [], 'exec');
        try {
          const result = fn();
          bridge.query('COMMIT', [], 'exec');
          return result;
        } catch (e) {
          bridge.query('ROLLBACK', [], 'exec');
          throw e;
        }
      };
    },
    close(): void {
      bridge.close();
    },
    jsonArrayAgg(expr: string): string {
      if (dialect === 'mysql') return `JSON_ARRAYAGG(${expr})`;
      if (dialect === 'postgresql') return `(json_agg(${expr}))::text`;
      return `json_group_array(${expr})`;
    },
    insertOrIgnore(table: string, columns: string[]): string {
      const cols = columns.join(', ');
      if (dialect === 'mysql') return `INSERT IGNORE INTO ${table} (${cols})`;
      if (dialect === 'postgresql') return `INSERT INTO ${table} (${cols}) ON CONFLICT DO NOTHING`;
      return `INSERT OR IGNORE INTO ${table} (${cols})`;
    },
    insertReturningId(sql: string, ...params: unknown[]): number {
      const runSql = dialect === 'postgresql' && /^\s*INSERT/i.test(sql) ? sql + ' RETURNING id' : sql;
      return Number(bridge.query(runSql, params, 'run').insertId);
    },
  };
}

export function createSqlDb(cfg: DbConfig): SqlDb {
  if (cfg.dialect === 'sqlite') return createSqliteDb(cfg);
  return createAsyncDialectDb(cfg);
}
