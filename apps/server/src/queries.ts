import { stripAnsi } from './ansi.js';
import type {
  CaseFlakyStats,
  ExecutionDetail,
  CaseDetail,
  CaseSummary,
  FacetValue,
  FacetsInfo,
  MetaInfo,
  RunBrief,
  RunDetail,
  RunInfo,
  RunItemInfo,
  RunOptions,
  RunStatus,
  SyncInfo,
  TagInfo,
  WorkerInfo,
} from '@tern/sdk';
import type { Runtime } from './runtime.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** cases.assets 列 JSON → devices / assetRefs（缺省无资产） */
function parseCaseAssets(json: unknown): {
  devices: { mic?: string; camera?: string } | string[] | null;
  refs: string[];
} {
  if (typeof json !== 'string' || !json) return { devices: null, refs: [] };
  try {
    const v = JSON.parse(json) as { devices?: unknown; refs?: unknown };
    const devices = (
      Array.isArray(v.devices)
        ? v.devices
        : v.devices && typeof v.devices === 'object'
          ? v.devices
          : null
    ) as { mic?: string; camera?: string } | string[] | null;
    return { devices, refs: Array.isArray(v.refs) ? v.refs.map(String) : [] };
  } catch {
    return { devices: null, refs: [] };
  }
}

export function caseSummary(r: Row): CaseSummary {
  const assets = parseCaseAssets(r.assets);
  return {
    caseId: r.id,
    title: r.title,
    project: r.project_name ?? '',
    description: r.description,
    filePath: r.file_path,
    tags: r.tags ?? [],
    version: r.version ?? null,
    module: r.module ?? null,
    timeoutS: r.timeout_s,
    retries: r.retries,
    traceMode: (r.trace_mode as 'off' | 'on' | 'retain-on-failure' | null) ?? null,
    disabled: !!r.disabled,
    status: r.status,
    quarantined: !!r.quarantined,
    quarantinedBy: r.quarantined_by ?? null,
    flakyStats: r.stats_json ? parseFlakyStats(r.stats_json as string) : null,
    devices: Array.isArray(assets.devices) ? null : assets.devices,
    assetRefs: assets.refs,
    contentHash: r.content_hash,
    bundleHash: r.bundle_hash,
    lastError: r.last_error ? stripAnsi(r.last_error) : null,
    updatedAt: r.updated_at,
  };
}

/** case_stats 行 → CaseFlakyStats（滚动序列重放计数，避免双份存储漂移） */
function parseFlakyStats(json: string): CaseFlakyStats {
  const row = JSON.parse(json || '{}') as { history?: string };
  const hist = Array.isArray(row.history) ? row.history : [];
  const effective = hist.filter((c) => c !== 's' && c !== 'c');
  const flaky = hist.filter((c) => c === 'F').length;
  return {
    total: effective.length,
    passed: hist.filter((c) => c === 'p' || c === 'F').length,
    failed: hist.filter((c) => c === 'f').length,
    flaky,
    rate: effective.length ? flaky / effective.length : null,
    history: hist,
  };
}

export function caseDetail(r: Row, recentRuns: RunBrief[]): CaseDetail {
  return {
    ...caseSummary(r),
    source: r.source,
    meta: JSON.parse(r.meta || '{}'),
    recentRuns,
  };
}

/** scope JSON → 引用的测试集名 / 涉及环境（多环境上下文审计快照派生） */
function scopeSuites(scopeJson: string | null | undefined): string[] {
  try {
    const v = (JSON.parse(scopeJson || '{}') as { suites?: { name?: string }[] }).suites;
    return Array.isArray(v) ? v.map((s) => String(s?.name ?? '')).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** scope JSON 的 envContexts → 涉及环境（runs 列表视图无 run_envs join 时由此派生） */
function scopeEnvs(scopeJson: string | null | undefined): string[] | null {
  try {
    const ctxs = (JSON.parse(scopeJson || '{}') as { envContexts?: { env: string | null }[] })
      .envContexts;
    if (!Array.isArray(ctxs)) return null;
    return [...new Set(ctxs.map((c) => c.env).filter((e): e is string => e != null))];
  } catch {
    return null;
  }
}

function runEnvs(r: Row, ctxEnvs?: (string | null)[]): string[] {
  // 详情视图：run_envs join 的环境名（空数组 = 旧 run 无上下文行，回退 env_name/scope）
  if (ctxEnvs && ctxEnvs.length) {
    return [...new Set(ctxEnvs.filter((e): e is string => e != null))];
  }
  // 列表视图 / 旧 run：scope 快照派生，再回退 env_name
  const fromScope = scopeEnvs(r.scope);
  if (fromScope) return fromScope;
  return r.env_name ? [r.env_name] : [];
}

export function runInfo(r: Row, ctxEnvs?: (string | null)[]): RunInfo {
  return {
    id: r.id,
    title: r.title,
    createdBy: r.created_by,
    status: r.status,
    project: r.project ?? '',
    suites: scopeSuites(r.scope),
    envs: runEnvs(r, ctxEnvs),
    envName: r.env_name ?? null,
    scope: JSON.parse(r.scope || '{}'),
    params: JSON.parse(r.params || '{}'),
    options: JSON.parse(r.options || '{}') as RunOptions,
    maxAttempts: r.max_attempts,
    workerId: r.worker_id ?? null,
    total: r.total,
    passed: r.passed,
    failed: r.failed,
    timedOut: r.timed_out,
    error: r.error,
    skipped: r.skipped,
    cancelled: r.cancelled,
    gitCommit: r.git_commit,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export function runItemInfo(r: Row): RunItemInfo {
  return {
    id: r.id,
    runId: r.batch_id,
    caseId: r.case_id,
    position: r.position,
    status: r.status,
    attempt: r.attempt,
    maxAttempts: r.max_attempts,
    env: r.env_name ?? null,
    executionId: r.final_run_id,
    durationMs: r.duration_ms,
    lastError: r.last_error ? stripAnsi(r.last_error) : null,
  };
}

/** case_runs.error（JSON 字符串）→ 剥离 ANSI 后的 ErrorVo */
function stripErrorVo(
  raw: string | null | undefined,
): { name?: string; message?: string; stack?: string } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { name?: string; message?: string; stack?: string };
    return {
      name: v.name,
      message: v.message ? stripAnsi(v.message) : v.message,
      stack: v.stack ? stripAnsi(v.stack) : v.stack,
    };
  } catch {
    return null;
  }
}

export function runBrief(r: Row): RunBrief {
  return {
    id: r.id,
    status: r.status as RunStatus,
    flaky: !!r.flaky,
    attempt: r.attempt,
    workerId: r.worker_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.duration_ms,
    error: stripErrorVo(r.error),
  };
}

export function executionDetail(rt: Runtime, r: Row): ExecutionDetail {
  let logTail: string[] = [];
  try {
    const file = join(rt.cfg.artifactsDir, r.batch_id, r.id, 'run.log');
    const text = readFileSync(file, 'utf8');
    logTail = text.split('\n').filter(Boolean).slice(-200);
  } catch {
    logTail = [];
  }
  return {
    ...runBrief(r),
    runId: r.batch_id,
    caseId: r.case_id,
    bundleHash: r.bundle_hash,
    artifacts: r.artifacts ? JSON.parse(r.artifacts) : null,
    logTail,
  };
}

export function workerInfo(r: Row): WorkerInfo {
  return {
    id: r.id,
    name: r.name,
    hostname: r.hostname ?? r.name,
    agentVersion: r.agent_version,
    playwrightVersion: r.playwright_version,
    capabilities: JSON.parse(r.capabilities || '{}'),
    status: r.status,
    currentRunId: r.current_run_id,
    lastHeartbeatAt: r.last_heartbeat_at,
    registeredAt: r.registered_at,
    stats: JSON.parse(r.stats || '{}'),
  };
}

export function syncInfo(r: Row): SyncInfo {
  return {
    id: r.id,
    projectId: r.project_id ?? null,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    added: r.added,
    updated: r.updated,
    removed: r.removed,
    invalid: r.invalid,
    gitCommit: r.git_commit,
    error: r.error,
  };
}

export function getRun(rt: Runtime, id: string, itemStatusFilter?: string): RunDetail | null {
  const row = rt.db.prepare('SELECT * FROM batches WHERE id = ?').get(id) as Row | undefined;
  if (!row) return null;
  // 条目联出各自的环境上下文名（多环境测试集并跑时逐行显示）
  const ctxEnvs = (
    rt.db.prepare('SELECT env_name FROM run_envs WHERE batch_id = ? ORDER BY position').all(id) as {
      env_name: string | null;
    }[]
  ).map((c) => c.env_name);
  const items = itemStatusFilter
    ? (rt.db
        .prepare(
          `SELECT bi.*, re.env_name FROM batch_items bi LEFT JOIN run_envs re ON re.id = bi.run_env_id
           WHERE bi.batch_id = ? AND bi.status = ? ORDER BY bi.position`,
        )
        .all(id, itemStatusFilter) as Row[])
    : (rt.db
        .prepare(
          `SELECT bi.*, re.env_name FROM batch_items bi LEFT JOIN run_envs re ON re.id = bi.run_env_id
           WHERE bi.batch_id = ? ORDER BY bi.position`,
        )
        .all(id) as Row[]);
  // running 条目的 executionId 用内存中的在途 run 补上（final_run_id 要到结束才写入），
  // 否则前端「实时画面」拿不到订阅目标，点击无反应
  const liveByItem = new Map<string, string>();
  for (const live of rt.runs.values()) liveByItem.set(live.itemId, live.runId);
  return {
    ...runInfo(row, ctxEnvs),
    items: items.map((r) => {
      const info = runItemInfo(r);
      if (!info.executionId && info.status === 'running')
        info.executionId = liveByItem.get(info.id) ?? null;
      return info;
    }),
  };
}

export function getCaseWithProject(rt: Runtime, id: string): Row | undefined {
  const row = rt.db
    .prepare(
      `SELECT c.*, p.name AS project_name,
        (SELECT ${rt.db.jsonArrayAgg('tag')} FROM case_tags WHERE case_id = c.id) AS tags_json
       FROM cases c JOIN projects p ON p.id = c.project_id WHERE c.id = ?`,
    )
    .get(id) as Row | undefined;
  if (row) {
    row.tags = JSON.parse(row.tags_json || '[]');
  }
  return row;
}

export function metaInfo(rt: Runtime): MetaInfo {
  const db = rt.db;
  const lastSyncRow = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get() as
    Row | undefined;
  const activeCases = (
    db.prepare(`SELECT COUNT(*) AS n FROM cases WHERE status='active'`).get() as { n: number }
  ).n;
  const runningRuns = (
    db.prepare(`SELECT COUNT(*) AS n FROM batches WHERE status IN ('pending','running')`).get() as {
      n: number;
    }
  ).n;
  const onlineWorkers = (
    db.prepare(`SELECT COUNT(*) AS n FROM workers WHERE status != 'offline'`).get() as { n: number }
  ).n;
  const projects = (db.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as { n: number }).n;
  return {
    version: rt.cfg.version,
    reposDir: rt.cfg.reposDir,
    gitCommit: lastSyncRow?.git_commit ?? null,
    lastSync: lastSyncRow ? syncInfo(lastSyncRow) : null,
    stats: { activeCases, runningRuns, onlineWorkers, projects },
    status: 'ok',
  };
}

export function facetsInfo(rt: Runtime, project?: string): FacetsInfo {
  const where = project ? `AND p.name = @project` : '';
  const params = project ? { project } : {};
  const versions = rt.db
    .prepare(
      `SELECT c.version AS value, COUNT(*) AS count FROM cases c JOIN projects p ON p.id = c.project_id
       WHERE c.status='active' AND c.version IS NOT NULL ${where}
       GROUP BY c.version ORDER BY value`,
    )
    .all(params) as FacetValue[];
  const modules = rt.db
    .prepare(
      `SELECT c.module AS value, COUNT(*) AS count FROM cases c JOIN projects p ON p.id = c.project_id
       WHERE c.status='active' AND c.module IS NOT NULL ${where}
       GROUP BY c.module ORDER BY value`,
    )
    .all(params) as FacetValue[];
  const projects = rt.db
    .prepare(
      `SELECT p.name AS name, COUNT(c.id) AS count FROM projects p
       LEFT JOIN cases c ON c.project_id = p.id AND c.status='active'
       GROUP BY p.id ORDER BY p.name`,
    )
    .all() as { name: string; count: number }[];
  return { projects, versions, modules };
}

export function listTags(rt: Runtime): TagInfo[] {
  return rt.db
    .prepare(
      `SELECT ct.tag AS tag, COUNT(*) AS count FROM case_tags ct
       JOIN cases c ON c.id = ct.case_id AND c.status='active'
       GROUP BY ct.tag ORDER BY count DESC, tag`,
    )
    .all() as TagInfo[];
}
