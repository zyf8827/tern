// 测试集（docs/test-suite-design.md）：项目内可命名、可复用的用例选择 + 环境/账号绑定。
// 选择器声明式（筛选 + 显式包含/排除，排除优先），解析发生在使用时（run 创建/预览/健康度）。
// 健康度读取时现算；env/account 存在性为软校验（仓库/环境随后补上即转绿），run 创建时硬校验。
import { ulid } from 'ulid';
import type { Runtime } from './runtime.js';
import { ApiError } from './errors.js';
import { resolveSuiteSelector, type SuiteResolve } from './selector.js';
import { normalizeAuthConfig } from './auth-config.js';
import { decryptJson, getSecretKey } from './crypto.js';
import type {
  AuthSnapshot,
  CreateSuitePayload,
  SuiteHealth,
  SuiteInfo,
  SuiteSelector,
  UpdateSuitePayload,
} from '@tern/sdk';

const SUITE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface SuiteRow {
  id: string;
  project_id: number;
  name: string;
  description: string;
  selector: string;
  env: string | null;
  account: string | null;
  params: string;
  enabled: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// ---- selector 校验（保存期硬校验：结构与跨项目；存在性软校验走健康度）----

const LIST_KEYS = [
  'version',
  'module',
  'tags',
  'excludeTags',
  'includeCaseIds',
  'excludeCaseIds',
] as const;

/** 白名单校验 + 归一（未知键/类型错 → 400 INVALID_SUITE_SELECTOR） */
function normalizeSelector(raw: unknown, where: string): SuiteSelector {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(400, 'INVALID_SUITE_SELECTOR', `${where}：selector 必须是对象`);
  }
  const out: SuiteSelector = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v == null) continue;
    if ((LIST_KEYS as readonly string[]).includes(k)) {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        throw new ApiError(
          400,
          'INVALID_SUITE_SELECTOR',
          `${where}：selector.${k} 必须是字符串数组`,
        );
      }
      const list = (v as string[]).map((s) => s.trim()).filter(Boolean);
      if (list.length) (out as Record<string, unknown>)[k] = list;
    } else if (k === 'tagMode') {
      if (v !== 'any' && v !== 'all') {
        throw new ApiError(
          400,
          'INVALID_SUITE_SELECTOR',
          `${where}：selector.tagMode 只允许 any|all`,
        );
      }
      if (v !== 'any') out.tagMode = v;
    } else if (k === 'q') {
      if (typeof v !== 'string')
        throw new ApiError(400, 'INVALID_SUITE_SELECTOR', `${where}：selector.q 必须是字符串`);
      if (v.trim()) out.q = v.trim();
    } else if (k === 'includeQuarantined') {
      if (typeof v !== 'boolean') {
        throw new ApiError(
          400,
          'INVALID_SUITE_SELECTOR',
          `${where}：selector.includeQuarantined 必须是布尔值`,
        );
      }
      if (v) out.includeQuarantined = true;
    } else {
      throw new ApiError(
        400,
        'INVALID_SUITE_SELECTOR',
        `${where}：selector 含未知字段 "${k}"（允许: ${[...LIST_KEYS, 'tagMode', 'q', 'includeQuarantined'].join(', ')}）`,
      );
    }
  }
  return out;
}

function normalizeParams(raw: unknown, where: string): Record<string, string> {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(400, 'INVALID_SUITE_PARAMS', `${where}：params 必须是 {键: 值} 对象`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string')
      throw new ApiError(400, 'INVALID_SUITE_PARAMS', `${where}：params.${k} 的值必须是字符串`);
    if (k.trim()) out[k.trim()] = v;
  }
  return out;
}

// ---- 健康度 ----

function parseStoredAuth(rt: Runtime, projectId: number): AuthSnapshot | null {
  const row = rt.db.prepare('SELECT auth FROM projects WHERE id=?').get(projectId) as
    { auth: string } | undefined;
  if (!row?.auth) return null;
  try {
    const snap = normalizeAuthConfig(JSON.parse(row.auth) || undefined);
    return snap;
  } catch {
    return null;
  }
}

/** AUTH_ACCOUNT 可用的名字集合（单配方 = 账号表；多配方 = 配方名 ∪ default 配方的账号表） */
function knownAccountNames(snap: AuthSnapshot | null): Set<string> {
  const names = new Set<string>();
  if (!snap) return names;
  if (snap.kind === 'single') {
    names.add('default');
    for (const n of Object.keys(snap.recipe?.accounts ?? {})) names.add(n);
  } else {
    for (const [profile, recipe] of Object.entries(snap.profiles ?? {})) {
      names.add(profile);
      if (profile === 'default') for (const n of Object.keys(recipe?.accounts ?? {})) names.add(n);
    }
  }
  return names;
}

function envStatusOf(
  rt: Runtime,
  projectId: number,
  envName: string | null,
): SuiteHealth['envStatus'] {
  if (envName == null) return null;
  const env = rt.db
    .prepare('SELECT values_enc FROM environments WHERE project_id=? AND name=?')
    .get(projectId, envName) as { values_enc: string } | undefined;
  if (!env) return 'missing';
  const manifest = rt.db
    .prepare('SELECT key FROM env_variables WHERE project_id=?')
    .all(projectId) as { key: string }[];
  if (manifest.length === 0) return 'ok';
  // 解密只拿键集合（与 envs.ts 同一密钥/同一纪律：健康度计算不出值内容）
  let keys: Set<string>;
  try {
    keys = new Set(
      Object.keys(
        decryptJson<Record<string, string>>(env.values_enc, getSecretKey(rt.cfg.dataDir)) ?? {},
      ),
    );
  } catch {
    return 'incomplete';
  }
  return manifest.every((m) => keys.has(m.key)) ? 'ok' : 'incomplete';
}

function healthOf(rt: Runtime, projectId: number, projectName: string, row: SuiteRow): SuiteHealth {
  const sel = JSON.parse(row.selector || '{}') as SuiteSelector;
  const resolve: SuiteResolve = resolveSuiteSelector(rt.db, projectName, sel);
  return {
    resolvedCount: resolve.ids.length,
    quarantinedExcluded: resolve.quarantinedExcluded,
    danglingIncludes: resolve.danglingIncludes,
    deadEntries: resolve.deadEntries,
    envStatus: envStatusOf(rt, projectId, row.env),
    accountKnown:
      row.account == null
        ? null
        : knownAccountNames(parseStoredAuth(rt, projectId)).has(row.account),
    isFullProject: resolve.isFullProject,
  };
}

function rowToInfo(rt: Runtime, r: SuiteRow): SuiteInfo {
  const project = rt.db.prepare('SELECT name FROM projects WHERE id=?').get(r.project_id) as
    { name: string } | undefined;
  const projectName = project?.name ?? `(deleted #${r.project_id})`;
  return {
    id: r.id,
    project: projectName,
    name: r.name,
    description: r.description,
    selector: JSON.parse(r.selector || '{}'),
    env: r.env,
    account: r.account,
    params: JSON.parse(r.params || '{}'),
    enabled: !!r.enabled,
    health: healthOf(rt, r.project_id, projectName, r),
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function suiteRow(rt: Runtime, projectId: number, name: string): SuiteRow | undefined {
  return rt.db
    .prepare('SELECT * FROM suites WHERE project_id=? AND name=?')
    .get(projectId, name) as SuiteRow | undefined;
}

function projectIdByName(rt: Runtime, name: string): number {
  const row = rt.db.prepare('SELECT id FROM projects WHERE name=?').get(name) as
    { id: number } | undefined;
  if (!row) throw new ApiError(404, 'PROJECT_NOT_FOUND', `项目不存在: ${name}`);
  return row.id;
}

// ---- CRUD ----

function validateBinding(projectName: string, selector: SuiteSelector, where: string): void {
  // include/exclude 只能点名本项目用例（caseId 首段 = 项目名）；存在性软校验（健康度警示）
  for (const key of ['includeCaseIds', 'excludeCaseIds'] as const) {
    for (const caseId of selector[key] ?? []) {
      const seg = caseId.split('/')[0];
      if (seg !== projectName) {
        throw new ApiError(
          400,
          'INVALID_SUITE_SELECTOR',
          `${where}：${key} 中的 "${caseId}" 不属于本项目 ${projectName}（测试集只能装本项目的用例）`,
        );
      }
    }
  }
}

interface SuiteWriteFields {
  name?: string;
  description?: string;
  selector?: SuiteSelector;
  env?: string | null;
  account?: string | null;
  params?: Record<string, string>;
  enabled?: boolean;
}

function normalizeFields(
  rt: Runtime,
  projectId: number,
  projectName: string,
  fields: SuiteWriteFields,
  where: string,
): {
  name?: string;
  description?: string;
  selector?: string;
  env?: string | null;
  account?: string | null;
  params?: string;
  enabled?: number;
} {
  const out: Record<string, unknown> = {};
  if (fields.name !== undefined) {
    const name = fields.name.trim();
    if (!SUITE_NAME_RE.test(name)) {
      throw new ApiError(
        400,
        'BAD_SUITE_NAME',
        `测试集名必须是小写 kebab-case（[a-z0-9-]）: "${name}"`,
      );
    }
    out.name = name;
  }
  if (fields.description !== undefined) out.description = fields.description ?? '';
  if (fields.selector !== undefined) {
    const sel = normalizeSelector(fields.selector, where);
    validateBinding(projectName, sel, where);
    out.selector = JSON.stringify(sel);
  }
  if (fields.env !== undefined) {
    if (fields.env === null || fields.env === '') out.env = null;
    else {
      const env = String(fields.env).trim();
      if (!SUITE_NAME_RE.test(env))
        throw new ApiError(400, 'BAD_ENV_NAME', `环境名必须是小写 kebab-case: "${env}"`);
      out.env = env;
    }
  }
  if (fields.account !== undefined) {
    if (fields.account === null || fields.account === '') out.account = null;
    else out.account = String(fields.account).trim();
  }
  if (fields.params !== undefined)
    out.params = JSON.stringify(normalizeParams(fields.params, where));
  if (fields.enabled !== undefined) out.enabled = fields.enabled ? 1 : 0;
  return out as {
    name?: string;
    description?: string;
    selector?: string;
    env?: string | null;
    account?: string | null;
    params?: string;
    enabled?: number;
  };
}

export function listSuites(rt: Runtime, projectId: number): SuiteInfo[] {
  return (
    rt.db
      .prepare('SELECT * FROM suites WHERE project_id=? ORDER BY name')
      .all(projectId) as SuiteRow[]
  ).map((r) => rowToInfo(rt, r));
}

export function getSuite(rt: Runtime, projectId: number, name: string): SuiteInfo {
  const row = suiteRow(rt, projectId, name);
  if (!row) throw new ApiError(404, 'SUITE_NOT_FOUND', `测试集不存在: ${name}`);
  return rowToInfo(rt, row);
}

export function createSuite(
  rt: Runtime,
  projectName: string,
  payload: CreateSuitePayload,
  createdBy: string,
): SuiteInfo {
  const projectId = projectIdByName(rt, projectName);
  if (!payload.name || !payload.name.trim())
    throw new ApiError(400, 'BAD_SUITE_NAME', '测试集名不能为空');
  const fields = normalizeFields(
    rt,
    projectId,
    projectName,
    payload as SuiteWriteFields,
    '创建测试集',
  );
  const name = fields.name!;
  if (suiteRow(rt, projectId, name))
    throw new ApiError(400, 'SUITE_NAME_TAKEN', `测试集已存在: ${name}`);
  const id = `ts_${ulid()}`;
  const now = new Date().toISOString();
  rt.db
    .prepare(
      `INSERT INTO suites (id, project_id, name, description, selector, env, account, params, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      projectId,
      name,
      fields.description ?? '',
      fields.selector ?? '{}',
      fields.env ?? null,
      fields.account ?? null,
      fields.params ?? '{}',
      fields.enabled ?? 1,
      createdBy,
      now,
      now,
    );
  return rowToInfo(rt, suiteRow(rt, projectId, name)!);
}

export function updateSuite(
  rt: Runtime,
  projectName: string,
  name: string,
  payload: UpdateSuitePayload,
): SuiteInfo {
  const projectId = projectIdByName(rt, projectName);
  const row = suiteRow(rt, projectId, name);
  if (!row) throw new ApiError(404, 'SUITE_NOT_FOUND', `测试集不存在: ${name}`);
  const fields = normalizeFields(
    rt,
    projectId,
    projectName,
    payload as SuiteWriteFields,
    '更新测试集',
  );
  const newName = fields.name ?? row.name;
  if (newName !== row.name && suiteRow(rt, projectId, newName)) {
    throw new ApiError(400, 'SUITE_NAME_TAKEN', `测试集已存在: ${newName}`);
  }
  const next = {
    description: fields.description ?? row.description,
    selector: fields.selector ?? row.selector,
    env: fields.env !== undefined ? fields.env : row.env,
    account: fields.account !== undefined ? fields.account : row.account,
    params: fields.params ?? row.params,
    enabled: fields.enabled ?? row.enabled,
  };
  rt.db
    .prepare(
      `UPDATE suites SET name=?, description=?, selector=?, env=?, account=?, params=?, enabled=?, updated_at=? WHERE id=?`,
    )
    .run(
      newName,
      next.description,
      next.selector,
      next.env,
      next.account,
      next.params,
      next.enabled,
      new Date().toISOString(),
      row.id,
    );
  if (newName !== row.name) renameSuiteInSchedules(rt, projectId, row.name, newName);
  return rowToInfo(rt, suiteRow(rt, projectId, newName)!);
}

/** 改名联动：重写本项目 schedules.scope.suites 中引用的旧名（消除"改名打断夜间任务"） */
function renameSuiteInSchedules(
  rt: Runtime,
  projectId: number,
  oldName: string,
  newName: string,
): void {
  const rows = rt.db
    .prepare(`SELECT id, scope FROM schedules WHERE project_id=? AND scope LIKE ?`)
    .all(projectId, `%"${oldName}"%`) as { id: string; scope: string }[];
  const upd = rt.db.prepare('UPDATE schedules SET scope=? WHERE id=?');
  for (const s of rows) {
    try {
      const scope = JSON.parse(s.scope || '{}') as { suites?: string[] };
      if (!Array.isArray(scope.suites) || !scope.suites.includes(oldName)) continue;
      scope.suites = scope.suites.map((n) => (n === oldName ? newName : n));
      upd.run(JSON.stringify(scope), s.id);
    } catch {
      /* scope 损坏的 schedule 不动 */
    }
  }
}

export function deleteSuite(rt: Runtime, projectName: string, name: string): void {
  const projectId = projectIdByName(rt, projectName);
  const r = rt.db.prepare('DELETE FROM suites WHERE project_id=? AND name=?').run(projectId, name);
  if (r.changes === 0) throw new ApiError(404, 'SUITE_NOT_FOUND', `测试集不存在: ${name}`);
}

/** 草稿解析预览（编辑器实时命中预览；不落库） */
export function previewSuiteSelector(
  rt: Runtime,
  projectName: string,
  selector: unknown,
  limit = 50,
): { health: SuiteHealth; items: { caseId: string; title: string; quarantined: boolean }[] } {
  const projectId = projectIdByName(rt, projectName);
  const sel = normalizeSelector(selector, '预览');
  validateBinding(projectName, sel, '预览');
  const resolve = resolveSuiteSelector(rt.db, projectName, sel);
  const shown = resolve.ids.slice(0, Math.max(0, Math.min(200, limit)));
  const marks = shown.length
    ? (rt.db
        .prepare(
          `SELECT id, title, quarantined FROM cases WHERE id IN (${shown.map(() => '?').join(',')})`,
        )
        .all(...shown) as { id: string; title: string; quarantined: number }[])
    : [];
  const byId = new Map(marks.map((m) => [m.id, m]));
  return {
    health: {
      resolvedCount: resolve.ids.length,
      quarantinedExcluded: resolve.quarantinedExcluded,
      danglingIncludes: resolve.danglingIncludes,
      deadEntries: resolve.deadEntries,
      envStatus: null,
      accountKnown: null,
      isFullProject: resolve.isFullProject,
    },
    items: shown.map((id) => {
      const m = byId.get(id);
      return { caseId: id, title: m?.title ?? id, quarantined: !!m?.quarantined };
    }),
  };
}

/** project 删除时级联清理 */
export function purgeProjectSuites(rt: Runtime, projectId: number): void {
  rt.db.prepare('DELETE FROM suites WHERE project_id=?').run(projectId);
}
