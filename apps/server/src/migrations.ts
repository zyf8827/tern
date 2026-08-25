import type Database from 'better-sqlite3';

/**
 * SQLite 自动迁移机制（随项目升级在 server 启动时自动执行）：
 *
 * 1. 迁移定义为有序数组 MIGRATIONS（id 单调递增，SQL 内嵌，无外部文件依赖）；
 * 2. openDb() 启动时自动补齐未应用的迁移（记录在 _migrations 表），升级无感；
 * 3. 每个迁移在事务内原子执行（SQL 与迁移记录同生共死，失败整体回滚不留半成品 schema）；
 * 4. 表重建类迁移按 SQLite 官方流程先 PRAGMA foreign_keys=OFF，执行后 foreign_key_check 兜底；
 * 5. migrate-cli（status/up）供运维/CI 独立检查与执行。
 */

export interface Migration {
  id: number;
  /** 迁移名（展示与排障用） */
  name: string;
  /** SQL（可多条语句） */
  sql: string;
  /** 涉及 DROP TABLE/表重建时为 true：执行期间关闭外键，结束后做 foreign_key_check */
  needsFkOff?: boolean;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial-schema',
    sql: `
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  file_path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  timeout_s INTEGER NOT NULL,
  retries INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  bundle_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE case_tags (
  case_id TEXT NOT NULL REFERENCES cases(id),
  tag TEXT NOT NULL,
  PRIMARY KEY (case_id, tag)
);
CREATE INDEX idx_case_tags_tag ON case_tags(tag);
CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  added INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  invalid INTEGER NOT NULL DEFAULT 0,
  git_commit TEXT,
  error TEXT
);
CREATE TABLE batches (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT 'api',
  scope TEXT NOT NULL DEFAULT '{}',
  params TEXT NOT NULL DEFAULT '{}',
  options TEXT NOT NULL DEFAULT '{}',
  max_attempts INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  total INTEGER NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  timed_out INTEGER NOT NULL DEFAULT 0,
  error INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  git_commit TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE batch_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  case_id TEXT NOT NULL REFERENCES cases(id),
  position INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  claimed_worker_id TEXT,
  lease_until TEXT,
  final_run_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  last_error TEXT
);
CREATE INDEX idx_items_batch ON batch_items(batch_id, status);
CREATE INDEX idx_items_status ON batch_items(status);
CREATE TABLE case_runs (
  id TEXT PRIMARY KEY,
  batch_item_id TEXT NOT NULL REFERENCES batch_items(id),
  batch_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  worker_id TEXT,
  attempt INTEGER NOT NULL,
  run_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  flaky INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  error TEXT,
  artifacts TEXT,
  bundle_hash TEXT
);
CREATE INDEX idx_runs_item ON case_runs(batch_item_id);
CREATE TABLE workers (
  id TEXT PRIMARY KEY,
  name TEXT,
  hostname TEXT,
  ip TEXT,
  agent_version TEXT,
  playwright_version TEXT,
  capabilities TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'offline',
  current_run_id TEXT,
  last_heartbeat_at TEXT,
  registered_at TEXT NOT NULL,
  stats TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  topic TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_events_topic ON events(topic, id);
`,
  },
  {
    id: 2,
    name: 'project-repos-and-case-dimensions',
    sql: `
ALTER TABLE projects ADD COLUMN source TEXT NOT NULL DEFAULT 'local';
ALTER TABLE projects ADD COLUMN git_url TEXT;
ALTER TABLE projects ADD COLUMN branch TEXT;
ALTER TABLE projects ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN pull_interval_sec INTEGER NOT NULL DEFAULT 300;
ALTER TABLE projects ADD COLUMN dir_name TEXT;
ALTER TABLE projects ADD COLUMN cases_dir TEXT NOT NULL DEFAULT 'cases';
ALTER TABLE projects ADD COLUMN auth TEXT NOT NULL DEFAULT '{}';
ALTER TABLE projects ADD COLUMN default_tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE projects ADD COLUMN last_commit TEXT;
ALTER TABLE projects ADD COLUMN last_synced_at TEXT;
ALTER TABLE projects ADD COLUMN sync_status TEXT;
ALTER TABLE projects ADD COLUMN sync_error TEXT;
ALTER TABLE projects ADD COLUMN updated_at TEXT;
ALTER TABLE cases ADD COLUMN version TEXT;
ALTER TABLE cases ADD COLUMN module TEXT;
ALTER TABLE cases ADD COLUMN auth TEXT;
ALTER TABLE batches ADD COLUMN worker_id TEXT;
ALTER TABLE sync_runs ADD COLUMN project_id INTEGER;
CREATE INDEX idx_cases_project ON cases(project_id, status);
CREATE INDEX idx_batches_worker ON batches(worker_id);
`,
  },
  {
    id: 3,
    name: 'drop-cross-lifecycle-fks',
    needsFkOff: true,
    sql: `
CREATE TABLE cases_v3 (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  file_path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  timeout_s INTEGER NOT NULL,
  retries INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  version TEXT,
  module TEXT,
  auth TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  bundle_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO cases_v3 SELECT id, project_id, title, description, file_path, source, timeout_s, retries, disabled, version, module, auth, meta, content_hash, bundle_hash, status, last_error, created_at, updated_at FROM cases;
DROP TABLE cases;
ALTER TABLE cases_v3 RENAME TO cases;
CREATE INDEX idx_cases_project ON cases(project_id, status);
CREATE TABLE batch_items_v3 (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  case_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  claimed_worker_id TEXT,
  lease_until TEXT,
  final_run_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  last_error TEXT
);
INSERT INTO batch_items_v3 SELECT id, batch_id, case_id, position, status, attempt, max_attempts, claimed_worker_id, lease_until, final_run_id, started_at, finished_at, duration_ms, last_error FROM batch_items;
DROP TABLE batch_items;
ALTER TABLE batch_items_v3 RENAME TO batch_items;
CREATE INDEX idx_items_batch ON batch_items(batch_id, status);
CREATE INDEX idx_items_status ON batch_items(status);
`,
  },
  {
    id: 4,
    name: 'run-project-and-git-credentials',
    sql: `
ALTER TABLE batches ADD COLUMN project TEXT;
ALTER TABLE projects ADD COLUMN cred_type TEXT NOT NULL DEFAULT 'none';
ALTER TABLE projects ADD COLUMN cred_user TEXT;
ALTER TABLE projects ADD COLUMN cred_secret TEXT;
`,
  },
  {
    id: 5,
    name: 'run-list-indexes',
    sql: `
CREATE INDEX IF NOT EXISTS idx_batches_project ON batches(project);
CREATE INDEX IF NOT EXISTS idx_batches_status_created ON batches(status, created_at);
`,
  },
  {
    id: 6,
    name: 'case-auth-store-name',
    sql: `
-- cases.auth 语义变化：整份 auth profile JSON → frontmatter 引用名。
-- 旧值为 JSON 对象字符串（以 { 开头）→ 统一改为 "default"；已是短名（或 NULL）不动。
-- 执行登录以 run 的 auth 快照为准，下次 sync 会按 frontmatter 重写为准确名字。
UPDATE cases SET auth='default' WHERE auth IS NOT NULL AND substr(auth, 1, 1) = '{';
`,
  },
  {
    id: 7,
    name: 'platform-enhancements',
    // docs/platform-enhancements.md：F1 环境 / F2 删除 / F4 失败签名 / F5 flaky / F6 定时 / F7 通知
    sql: `
-- F1 环境管理：tern.yaml env.variables 清单镜像（sync 覆盖，只读）
CREATE TABLE env_variables (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  key TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  secret INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, key)
);

-- F1 环境管理：平台侧环境定义（值整体加密存 values_enc；回显策略由清单 secret 标志驱动）
CREATE TABLE environments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  values_enc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);

-- F1：run 关联环境 + 展开后的 secret 参数（AES-256-GCM，见 crypto.ts）
ALTER TABLE batches ADD COLUMN env_name TEXT;
ALTER TABLE batches ADD COLUMN params_secret TEXT;

-- F4 失败摘要：错误签名（归一化消息的 sha1），按签名聚类 + 跨 run 历史
ALTER TABLE case_runs ADD COLUMN error_sig TEXT;
CREATE INDEX idx_case_runs_sig ON case_runs(error_sig);

-- F5 flaky 治理：滚动窗口统计 + 隔离标记
ALTER TABLE cases ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cases ADD COLUMN quarantined_by TEXT;
CREATE TABLE case_stats (
  case_id TEXT PRIMARY KEY REFERENCES cases(id),
  total INTEGER NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  flaky INTEGER NOT NULL DEFAULT 0,
  history TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

-- F6 定时任务
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '{}',
  env TEXT,
  params TEXT NOT NULL DEFAULT '{}',
  options TEXT NOT NULL DEFAULT '{}',
  max_attempts INTEGER NOT NULL DEFAULT 1,
  worker_id TEXT,
  title_prefix TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_id TEXT,
  last_run_at TEXT,
  next_run_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'api',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_schedules_due ON schedules(enabled, next_run_at);

-- F7 钉钉通知
CREATE TABLE webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id),
  type TEXT NOT NULL DEFAULT 'dingtalk',
  url TEXT NOT NULL,
  secret TEXT NOT NULL DEFAULT '',
  notify_on TEXT NOT NULL DEFAULT 'failure',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
ALTER TABLE batches ADD COLUMN notified_at TEXT;
`,
  },
  {
    id: 8,
    name: 'test-assets',
    // docs/test-assets-design.md：repo 资产（cases/_assets/）+ 设备输入（fake mic/camera）+ ternAsset 引用
    sql: `
-- 项目资产（内容寻址，同 bundle 机制；path 相对 assetsDir）
CREATE TABLE assets (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  path TEXT NOT NULL,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, path)
);
CREATE INDEX idx_assets_hash ON assets(hash);

-- tern.yaml 可选 assetsDir:（缺省 <casesDir>/_assets）
ALTER TABLE projects ADD COLUMN assets_dir TEXT;

-- 用例的设备声明与资产引用（JSON：{ devices, refs }）
ALTER TABLE cases ADD COLUMN assets TEXT;
`,
  },
  {
    id: 9,
    name: 'platform-settings',
    // docs/device-proxy-design.md F9：平台级设置（首个键 device_proxy_mode）+ batch 快照
    sql: `
CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO platform_settings (key, value, updated_at) VALUES ('device_proxy_mode', 'auto', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- run 创建时的代理模式快照（保证 run 内语义一致、可复现；NULL=创建时未记录，assign 时读实时设置）
ALTER TABLE batches ADD COLUMN device_proxy TEXT;
`,
  },
  {
    id: 10,
    name: 'env-device-proxy',
    // docs/device-proxy-design.md F9 修订：设备反向代理从平台全局设置下沉为环境级配置
    // （是否启用属于「环境怎么被访问」的属性，与 BASE_URL 一起按环境生效；run 创建时快照进 batch）
    sql: `
ALTER TABLE environments ADD COLUMN device_proxy TEXT;
UPDATE environments SET device_proxy='auto' WHERE device_proxy IS NULL;

-- 全局设置表随之退役（device_proxy_mode 已并入环境）
DROP TABLE IF EXISTS platform_settings;
`,
  },
  {
    id: 11,
    name: 'case-trace-mode',
    // 用例级 trace 覆盖（frontmatter trace: off/on/retain-on-failure，优先于运行级 options.trace）。
    // 长时录音/推流用例必须 off：trace 开启 Network 域 + screencast 后，高频 WS 二进制帧
    // 持续灌入 CDP 驱动管道会把 Playwright 楔死（await 永不 settle，悬到墙钟上限）。
    sql: `
ALTER TABLE cases ADD COLUMN trace_mode TEXT;
`,
  },
  {
    id: 12,
    name: 'test-suites',
    // docs/test-suite-design.md：测试集（可命名的用例选择 + 环境/账号绑定）+
    // 环境上下文（多测试集各自带环境、按「用例 × 环境」去重执行）。
    sql: `
-- 测试集：项目内可命名复用的用例选择（selector 声明式，解析发生在使用时）
CREATE TABLE suites (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  selector TEXT NOT NULL DEFAULT '{}',
  env TEXT,
  account TEXT,
  params TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT 'api',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);
CREATE INDEX idx_suites_project ON suites(project_id);

-- run 内的环境上下文：多测试集各自环境并存（去重键 = case_id × run_env_id）。
-- params/params_secret 为该上下文解析后的最终值（环境值 + 来源测试集 params 覆盖）。
-- 不引用测试集的 run 不写此表（batch_items.run_env_id = NULL，沿用 batches.params，行为不变）
CREATE TABLE run_envs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  env_name TEXT,
  params TEXT NOT NULL DEFAULT '{}',
  params_secret TEXT,
  device_proxy TEXT,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_run_envs_batch ON run_envs(batch_id);

ALTER TABLE batch_items ADD COLUMN run_env_id INTEGER;
`,
  },
];

export interface MigrateOptions {
  /** 日志函数 */
  log?: (msg: string) => void;
}

export interface MigrateReport {
  applied: { id: number; name: string; durationMs: number }[];
  fromVersion: number;
  toVersion: number;
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/** 确保 _migrations 记录表存在并兼容旧版结构（老库只有 id/applied_at 两列） */
function ensureMigrationTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    name TEXT,
    applied_at TEXT NOT NULL,
    duration_ms INTEGER
  )`);
  const cols = tableColumns(db, '_migrations');
  if (!cols.has('name')) db.exec(`ALTER TABLE _migrations ADD COLUMN name TEXT`);
  if (!cols.has('duration_ms')) db.exec(`ALTER TABLE _migrations ADD COLUMN duration_ms INTEGER`);
}

export function currentVersion(db: Database.Database): number {
  ensureMigrationTable(db);
  const row = db.prepare('SELECT MAX(id) AS v FROM _migrations').get() as { v: number | null };
  return row.v ?? 0;
}

export function pendingMigrations(
  db: Database.Database,
  migrations: Migration[] = MIGRATIONS,
): Migration[] {
  const cur = currentVersion(db);
  return migrations.filter((m) => m.id > cur).sort((a, b) => a.id - b.id);
}

/**
 * 执行所有待应用的迁移（幂等）：
 * - 每个迁移单独一个事务：SQL 与迁移记录同生共死，失败整体回滚；
 * - needsFkOff 迁移按 SQLite 官方建议关外键执行，结束后 foreign_key_check 兜底。
 */
export function runMigrations(
  db: Database.Database,
  migrations: Migration[] = MIGRATIONS,
  opts: MigrateOptions = {},
): MigrateReport {
  const log = opts.log ?? (() => {});
  ensureMigrationTable(db);
  const pending = pendingMigrations(db, migrations);
  const fromVersion = currentVersion(db);
  const report: MigrateReport = { applied: [], fromVersion, toVersion: fromVersion };
  if (pending.length === 0) return report;

  const known = new Set(migrations.map((m) => m.id));
  for (const m of pending) {
    if (!known.has(m.id)) throw new Error(`迁移 ${m.id} 不在迁移定义列表中`);
  }

  for (const m of pending) {
    const started = Date.now();
    const fkOff = m.needsFkOff === true;
    if (fkOff) db.pragma('foreign_keys = OFF');
    try {
      const tx = db.transaction(() => {
        db.exec(m.sql);
        db.prepare(
          'INSERT INTO _migrations (id, name, applied_at, duration_ms) VALUES (?, ?, ?, 0)',
        ).run(m.id, m.name, new Date().toISOString());
      });
      tx();
    } catch (e) {
      throw new Error(
        `迁移 ${m.id}（${m.name}）失败（已回滚，库保持原 schema）: ${(e as Error).message}`,
      );
    } finally {
      if (fkOff) db.pragma('foreign_keys = ON');
    }
    const durationMs = Date.now() - started;
    db.prepare('UPDATE _migrations SET duration_ms=? WHERE id=?').run(durationMs, m.id);
    report.applied.push({ id: m.id, name: m.name, durationMs });
    report.toVersion = m.id;
    log(`已应用迁移 ${m.id}（${m.name}，${durationMs}ms）`);

    if (fkOff) {
      const fkErrors = db.pragma('foreign_key_check') as unknown[];
      if (fkErrors.length > 0) {
        throw new Error(
          `迁移 ${m.id} 后 foreign_key_check 失败: ${JSON.stringify(fkErrors.slice(0, 3))}`,
        );
      }
    }
  }
  return report;
}
