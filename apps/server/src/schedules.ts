// 定时任务（docs/platform-enhancements.md F6）
// schedules 表 + 15s 巡检循环；触发时按当前 scope/env 现读并 createRun（createdBy=schedule:<id>）。
// 防重叠：上次触发的 run 未终态则跳过本次；停机错过 >10min 只补跑一次。
import { ulid } from 'ulid';
import type { Runtime } from './runtime.js';
import { ApiError } from './errors.js';
import { nextCron } from './cron.js';
import { createRun } from './runtime.js';
import type {
  CreateSchedulePayload,
  ScheduleInfo,
  UpdateSchedulePayload,
  CreateRunPayload,
} from '@tern/sdk';

const CATCHUP_TOLERANCE_MS = 10 * 60 * 1000;

interface ScheduleRow {
  id: string;
  project_id: number;
  name: string;
  cron: string;
  scope: string;
  env: string | null;
  params: string;
  options: string;
  max_attempts: number;
  worker_id: string | null;
  title_prefix: string;
  enabled: number;
  last_run_id: string | null;
  last_run_at: string | null;
  next_run_at: string;
  created_by: string;
  created_at: string;
}

function rowToInfo(rt: Runtime, r: ScheduleRow): ScheduleInfo {
  const project = rt.db.prepare('SELECT name FROM projects WHERE id=?').get(r.project_id) as
    { name: string } | undefined;
  return {
    id: r.id,
    project: project?.name ?? `(deleted #${r.project_id})`,
    name: r.name,
    cron: r.cron,
    scope: JSON.parse(r.scope || '{}'),
    env: r.env,
    params: JSON.parse(r.params || '{}'),
    options: JSON.parse(r.options || '{}'),
    maxAttempts: r.max_attempts,
    workerId: r.worker_id,
    titlePrefix: r.title_prefix,
    enabled: !!r.enabled,
    lastRunId: r.last_run_id,
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function projectIdByName(rt: Runtime, name: string): number {
  const row = rt.db.prepare('SELECT id FROM projects WHERE name=?').get(name) as
    { id: number } | undefined;
  if (!row) throw new ApiError(404, 'PROJECT_NOT_FOUND', `项目不存在: ${name}`);
  return row.id;
}

/** scope 只允许 CreateRunPayload 的选择器子集（防止把 project/caseIds 等整体塞进 schedule）；
 *  suites 引用测试集（触发时按当前解析现算，见 docs/test-suite-design.md §8） */
const SCOPE_KEYS = new Set(['version', 'module', 'tags', 'tagMode', 'excludeTags', 'q', 'suites']);
function sanitizeScope(scope: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(scope ?? {})) {
    if (SCOPE_KEYS.has(k) && v != null) out[k] = v;
  }
  return out;
}

export function listSchedules(rt: Runtime): ScheduleInfo[] {
  return (
    rt.db.prepare('SELECT * FROM schedules ORDER BY created_at DESC').all() as ScheduleRow[]
  ).map((r) => rowToInfo(rt, r));
}

export function createSchedule(
  rt: Runtime,
  payload: CreateSchedulePayload,
  createdBy: string,
): ScheduleInfo {
  const projectId = projectIdByName(rt, payload.project);
  const name = payload.name?.trim() ?? '';
  if (!name) throw new ApiError(400, 'BAD_SCHEDULE_NAME', '定时任务名不能为空');
  let next: Date;
  try {
    next = nextCron(payload.cron, new Date());
  } catch (e) {
    throw new ApiError(400, 'INVALID_CRON', `cron 表达式非法: ${(e as Error).message}`);
  }
  if (payload.env) {
    const env = rt.db
      .prepare('SELECT id FROM environments WHERE project_id=? AND name=?')
      .get(projectId, payload.env);
    if (!env) throw new ApiError(404, 'ENV_NOT_FOUND', `环境不存在: ${payload.env}`);
  }
  const id = `s_${ulid()}`;
  const now = new Date().toISOString();
  rt.db
    .prepare(
      `INSERT INTO schedules (id, project_id, name, cron, scope, env, params, options, max_attempts, worker_id, title_prefix, enabled, next_run_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      projectId,
      name,
      payload.cron.trim(),
      JSON.stringify(sanitizeScope(payload.scope)),
      payload.env ?? null,
      JSON.stringify(payload.params ?? {}),
      JSON.stringify(payload.options ?? {}),
      payload.maxAttempts ?? 1,
      payload.workerId ?? null,
      payload.titlePrefix ?? '',
      payload.enabled === false ? 0 : 1,
      next.toISOString(),
      createdBy,
      now,
    );
  return rowToInfo(rt, rt.db.prepare('SELECT * FROM schedules WHERE id=?').get(id) as ScheduleRow);
}

export function updateSchedule(
  rt: Runtime,
  id: string,
  payload: UpdateSchedulePayload,
): ScheduleInfo {
  const row = rt.db.prepare('SELECT * FROM schedules WHERE id=?').get(id) as
    ScheduleRow | undefined;
  if (!row) throw new ApiError(404, 'SCHEDULE_NOT_FOUND', `定时任务不存在: ${id}`);
  let cron = row.cron;
  let nextRunAt = row.next_run_at;
  if (payload.cron !== undefined && payload.cron !== row.cron) {
    try {
      nextRunAt = nextCron(payload.cron, new Date()).toISOString();
    } catch (e) {
      throw new ApiError(400, 'INVALID_CRON', `cron 表达式非法: ${(e as Error).message}`);
    }
    cron = payload.cron.trim();
  }
  let env = row.env;
  if (payload.env !== undefined) {
    if (payload.env === null || payload.env === '') env = null;
    else {
      const found = rt.db
        .prepare('SELECT id FROM environments WHERE project_id=? AND name=?')
        .get(row.project_id, payload.env);
      if (!found) throw new ApiError(404, 'ENV_NOT_FOUND', `环境不存在: ${payload.env}`);
      env = payload.env;
    }
  }
  const enabled = payload.enabled === undefined ? row.enabled : payload.enabled ? 1 : 0;
  // 重新启用时若 next_run_at 已远过，立即对齐到未来最近触发点
  if (enabled && !row.enabled) {
    nextRunAt = nextCron(cron, new Date()).toISOString();
  }
  rt.db
    .prepare(
      `UPDATE schedules SET name=?, cron=?, scope=?, env=?, params=?, options=?, max_attempts=?, worker_id=?, title_prefix=?, enabled=?, next_run_at=? WHERE id=?`,
    )
    .run(
      payload.name?.trim() || row.name,
      cron,
      payload.scope !== undefined ? JSON.stringify(sanitizeScope(payload.scope)) : row.scope,
      env,
      payload.params !== undefined ? JSON.stringify(payload.params) : row.params,
      payload.options !== undefined ? JSON.stringify(payload.options) : row.options,
      payload.maxAttempts ?? row.max_attempts,
      payload.workerId === undefined ? row.worker_id : payload.workerId || null,
      payload.titlePrefix ?? row.title_prefix,
      enabled,
      nextRunAt,
      id,
    );
  return rowToInfo(rt, rt.db.prepare('SELECT * FROM schedules WHERE id=?').get(id) as ScheduleRow);
}

export function deleteSchedule(rt: Runtime, id: string): void {
  const r = rt.db.prepare('DELETE FROM schedules WHERE id=?').run(id);
  if (r.changes === 0) throw new ApiError(404, 'SCHEDULE_NOT_FOUND', `定时任务不存在: ${id}`);
}

/** 巡检：到期的 schedule 触发（index.ts 每 15s 调用） */
export function fireDueSchedules(rt: Runtime): void {
  const now = new Date();
  const due = rt.db
    .prepare(`SELECT * FROM schedules WHERE enabled=1 AND next_run_at <= ?`)
    .all(now.toISOString()) as ScheduleRow[];
  for (const s of due) {
    let next: Date;
    try {
      next = nextCron(s.cron, now);
    } catch {
      rt.log.error({ schedule: s.id, cron: s.cron }, 'schedule cron invalid, disabling');
      rt.db.prepare('UPDATE schedules SET enabled=0 WHERE id=?').run(s.id);
      continue;
    }
    // 错过补跑：停机等导致 next_run_at 落后超过容差 → 只触发一次并跳到未来最近点（已在 next）
    // 防重叠：上次触发的 run 仍未终态 → 跳过本次
    if (s.last_run_id) {
      const last = rt.db.prepare('SELECT status FROM batches WHERE id=?').get(s.last_run_id) as
        { status: string } | undefined;
      if (last && (last.status === 'pending' || last.status === 'running')) {
        rt.db
          .prepare('UPDATE schedules SET next_run_at=? WHERE id=?')
          .run(next.toISOString(), s.id);
        rt.log.info(
          { schedule: s.id, lastRun: s.last_run_id },
          'schedule skipped: previous run not terminal',
        );
        continue;
      }
    }
    const project = rt.db.prepare('SELECT name FROM projects WHERE id=?').get(s.project_id) as
      { name: string } | undefined;
    if (!project) {
      rt.db.prepare('DELETE FROM schedules WHERE id=?').run(s.id);
      continue;
    }
    const payload: CreateRunPayload = {
      project: project.name,
      ...(JSON.parse(s.scope || '{}') as Record<string, unknown>),
      env: s.env ?? undefined,
      params: JSON.parse(s.params || '{}'),
      options: JSON.parse(s.options || '{}'),
      maxAttempts: s.max_attempts,
      workerId: s.worker_id ?? undefined,
      // 标题内嵌时间按东八区展示（与 Web 端 fmtTime 口径一致；东八区无夏令时，固定 +8）
      title: `${s.title_prefix || s.name} ${new Date(now.getTime() + 8 * 3600_000).toISOString().slice(5, 16).replace('T', ' ')}`,
      createdBy: `schedule:${s.id}`,
    };
    try {
      const run = createRun(rt, payload, `schedule:${s.id}`);
      rt.db
        .prepare('UPDATE schedules SET last_run_id=?, last_run_at=?, next_run_at=? WHERE id=?')
        .run(run.id, now.toISOString(), next.toISOString(), s.id);
      rt.log.info({ schedule: s.id, runId: run.id }, 'schedule fired');
    } catch (e) {
      // 环境缺值等创建失败：记录告警并推进 next_run_at，避免每 15s 重试风暴
      rt.db.prepare('UPDATE schedules SET next_run_at=? WHERE id=?').run(next.toISOString(), s.id);
      rt.log.warn({ schedule: s.id, err: (e as Error).message }, 'schedule fire failed');
      rt.events.emit('system', 'system.alert', {
        level: 'warn',
        message: `定时任务 "${s.name}"（${s.id}）触发失败：${(e as Error).message}`,
      });
    }
  }
}
