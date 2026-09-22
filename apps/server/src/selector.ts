// 用例选择解析（docs/test-suite-design.md §3.1）
// createRun 的 run 级筛选、测试集解析、预览、定时任务共用同一套 WHERE 构造，
// 保证「所见即所得」：预览命中 = 实际执行命中。
import type { SqlDb } from './sql-db.js';
import type { SuiteSelector } from '@tern/sdk';

/** run 级筛选维度（CreateRunPayload 的 version/module/tags/tagMode/excludeTags/q 子集） */
export interface SelectorDims {
  version?: string[];
  module?: string[];
  tags?: string[];
  tagMode?: 'any' | 'all';
  excludeTags?: string[];
  q?: string;
}

export interface SelectorResolve {
  ids: string[];
  /** 因隔离（quarantined）被排除的数量 */
  quarantinedExcluded: number;
}

export interface SuiteResolve extends SelectorResolve {
  /** includeCaseIds 中当前不存在/非 active/不属于本项目的 ID */
  danglingIncludes: string[];
  /** 同时出现在 include 与 exclude 的死条目 */
  deadEntries: string[];
  /** 空选择器 = 项目全量 */
  isFullProject: boolean;
}

/** 筛选维度 → WHERE 片段（不含 status/project 约束，语义与既有 createRun 一致） */
export function buildCaseWhere(dims: SelectorDims): { where: string[]; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (dims.version?.length) {
    where.push(`c.version IN (${dims.version.map(() => '?').join(',')})`);
    params.push(...dims.version);
  }
  if (dims.module?.length) {
    where.push(`c.module IN (${dims.module.map(() => '?').join(',')})`);
    params.push(...dims.module);
  }
  if (dims.q) {
    where.push('(c.id LIKE ? OR c.title LIKE ? OR c.description LIKE ?)');
    const like = `%${dims.q}%`;
    params.push(like, like, like);
  }
  const tagMode = dims.tagMode ?? 'any';
  if (dims.tags?.length) {
    if (tagMode === 'all') {
      for (const t of dims.tags) {
        where.push('EXISTS (SELECT 1 FROM case_tags ct WHERE ct.case_id = c.id AND ct.tag = ?)');
        params.push(t);
      }
    } else {
      where.push(
        `EXISTS (SELECT 1 FROM case_tags ct WHERE ct.case_id = c.id AND ct.tag IN (${dims.tags.map(() => '?').join(',')}))`,
      );
      params.push(...dims.tags);
    }
  }
  if (dims.excludeTags?.length) {
    where.push(
      `NOT EXISTS (SELECT 1 FROM case_tags ct WHERE ct.case_id = c.id AND ct.tag IN (${dims.excludeTags.map(() => '?').join(',')}))`,
    );
    params.push(...dims.excludeTags);
  }
  return { where, params };
}

/** run 级选择器解析（既有 createRun 语义：项目内 active 用例 + 筛选 + 隔离默认排除）。
 *  projectName 为 null 时不加项目约束（跨项目筛选，由 createRun 的单项目校验兜底）。 */
export function resolveRunSelector(
  db: SqlDb,
  projectName: string | null,
  dims: SelectorDims,
  includeQuarantined: boolean,
): SelectorResolve {
  const { where, params } = buildCaseWhere(dims);
  if (projectName) {
    where.unshift('p.name = ?');
    params.unshift(projectName);
  }
  const rows = db
    .prepare(
      `SELECT DISTINCT c.id, c.quarantined FROM cases c JOIN projects p ON p.id = c.project_id
       WHERE c.status = 'active'${where.length ? ` AND ${where.join(' AND ')}` : ''}`,
    )
    .all(...params) as { id: string; quarantined: number }[];
  const ids = rows.filter((r) => includeQuarantined || !r.quarantined).map((r) => r.id);
  return { ids, quarantinedExcluded: rows.length - ids.length };
}

/**
 * 测试集选择器解析：筛选命中 ∪ includeCaseIds − excludeCaseIds（排除优先，压过一切包含手段）。
 * 空选择器（无筛选、无点名）= 项目全部 active 用例。
 */
export function resolveSuiteSelector(
  db: SqlDb,
  projectName: string,
  selector: SuiteSelector,
  includeQuarantinedOverride?: boolean,
): SuiteResolve {
  const includeQuarantined = includeQuarantinedOverride ?? selector.includeQuarantined ?? false;
  const includeCaseIds = (selector.includeCaseIds ?? [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const excludeCaseIds = (selector.excludeCaseIds ?? [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const excludeSet = new Set(excludeCaseIds);
  const deadEntries = includeCaseIds.filter((id) => excludeSet.has(id));

  const seen = new Set<string>();
  const ids: string[] = [];
  let quarantinedExcluded = 0;
  const danglingIncludes: string[] = [];
  const push = (caseId: string) => {
    if (!seen.has(caseId) && !excludeSet.has(caseId)) {
      seen.add(caseId);
      ids.push(caseId);
    }
  };

  const hasFilter = !!(
    selector.tags?.length ||
    selector.excludeTags?.length ||
    selector.q ||
    selector.version?.length ||
    selector.module?.length
  );

  if (hasFilter || includeCaseIds.length > 0) {
    if (hasFilter) {
      const r = resolveRunSelector(db, projectName, selector, includeQuarantined);
      quarantinedExcluded += r.quarantinedExcluded;
      for (const id of r.ids) push(id);
    }
    // 显式点名（active 才可执行；隔离默认同样排除，includeQuarantined 纳入）
    for (const caseId of includeCaseIds) {
      if (seen.has(caseId) || excludeSet.has(caseId)) continue;
      const row = db
        .prepare(
          `SELECT c.id, c.quarantined FROM cases c JOIN projects p ON p.id = c.project_id
           WHERE c.id = ? AND c.status = 'active' AND p.name = ?`,
        )
        .get(caseId, projectName) as { id: string; quarantined: number } | undefined;
      if (!row) {
        danglingIncludes.push(caseId);
        continue;
      }
      if (row.quarantined && !includeQuarantined) {
        quarantinedExcluded++;
        continue;
      }
      push(caseId);
    }
  } else {
    // 空选择器 = 全量（与 createRun「仅 project 无筛选 = 全选」语义一致）
    const r = resolveRunSelector(db, projectName, {}, includeQuarantined);
    quarantinedExcluded += r.quarantinedExcluded;
    for (const id of r.ids) push(id);
    return {
      ids: ids.sort(),
      quarantinedExcluded,
      danglingIncludes,
      deadEntries,
      isFullProject: true,
    };
  }

  return {
    ids: ids.sort(),
    quarantinedExcluded,
    danglingIncludes,
    deadEntries,
    isFullProject: false,
  };
}
