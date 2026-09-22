import path from 'node:path';

export type Dialect = 'sqlite' | 'mysql' | 'postgresql';

export interface DbConfig {
  dialect: Dialect;
  /** sqlite-only: full path to the .db file */
  sqlitePath?: string;
  /** mysql/postgresql connection */
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** mysql/postgresql: full connection URL (overrides host/port/user/password/database) */
  url?: string;
}

const DIALECT_ALIASES: Record<string, Dialect> = {
  sqlite: 'sqlite',
  sqlite3: 'sqlite',
  mysql: 'mysql',
  postgresql: 'postgresql',
  postgres: 'postgresql',
};

const DEFAULT_PORTS: Record<string, number> = {
  mysql: 3306,
  postgresql: 5432,
};

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/**
 * 解析数据库配置（从环境变量）。
 * - DB_DIALECT: sqlite | mysql | postgresql（默认 sqlite；别名 postgres → postgresql, sqlite3 → sqlite）
 * - DATABASE_URL: 完整连接字符串（优先于分离的 host/port/user/password/database）
 * - DB_PATH: sqlite 文件路径覆盖（默认 DATA_DIR/platform.db）
 * - DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME: mysql/postgresql 分离连接参数
 */
export function resolveDbConfig(dataDir: string): DbConfig {
  const rawDialect = (env('DB_DIALECT') ?? 'sqlite').toLowerCase();
  const dialect = DIALECT_ALIASES[rawDialect];
  if (!dialect) {
    const allowed = Object.keys(DIALECT_ALIASES).join(', ');
    throw new Error(
      `[db] 不支持的数据库方言 DB_DIALECT="${rawDialect}"（允许: ${allowed}）`,
    );
  }

  const url = env('DATABASE_URL');

  if (dialect === 'sqlite') {
    let sqlitePath: string;
    if (url) {
      // sqlite:/abs/path 或 sqlite:relative/path
      sqlitePath = path.resolve(url.replace(/^sqlite:(\/\/)?/, ''));
    } else {
      sqlitePath = path.resolve(env('DB_PATH') ?? path.join(dataDir, 'platform.db'));
    }
    return { dialect, sqlitePath };
  }

  // mysql / postgresql
  if (url) {
    return { dialect, url };
  }

  const host = env('DB_HOST');
  const user = env('DB_USER');
  const password = env('DB_PASSWORD');
  const database = env('DB_NAME');
  const port = envInt('DB_PORT', DEFAULT_PORTS[dialect]);

  if (!host || !user || !database) {
    throw new Error(
      `[db] ${dialect} 需要 DATABASE_URL 或 DB_HOST + DB_USER + DB_NAME（当前均未设置）`,
    );
  }

  return { dialect, host, port, user, password, database };
}
