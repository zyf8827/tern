import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseTraceDir, unzipToDir } from './trace-view.js';
import path from 'node:path';
import { cancelRun, createRun, deleteRun, previewRun, rerunRun, type Runtime } from './runtime.js';
import {
  addGitProject,
  discoverLocalProjects,
  getProject,
  patchProject,
  projectInfo,
  removeProject,
  syncAllProjects,
  updateProjectRepo,
  type ProjectRow,
} from './repos.js';
import {
  createEnvironment,
  deleteEnvironment,
  envManifest,
  listEnvironments,
  updateEnvironment,
} from './envs.js';
// schedules placeholder
import {
  createSuite,
  deleteSuite,
  getSuite,
  listSuites,
  previewSuiteSelector,
  updateSuite,
} from './suites.js';
import { setCaseQuarantine } from './flaky.js';
import { failureSummary } from './failure-summary.js';
import { sendWebhook } from './notifier.js';
import {
  caseDetail,
  caseSummary,
  executionDetail,
  facetsInfo,
  getCaseWithProject,
  getRun,
  listTags,
  metaInfo,
  runBrief,
  runInfo,
  syncInfo,
  workerInfo,
} from './queries.js';
import { saveArtifactStream } from './artifacts.js';
import type {
  CreateRunPayload,
  CreateProjectPayload,
  UpdateProjectPayload,
  CreateEnvironmentPayload,
  UpdateEnvironmentPayload,
  CreateSchedulePayload,
  UpdateSchedulePayload,
  CreateSuitePayload,
  UpdateSuitePayload,
  CreateWebhookPayload,
  UpdateWebhookPayload,
} from '@tern/sdk';
import { ApiError } from './errors.js';

function checkApiAuth(rt: Runtime, req: FastifyRequest): void {
  if (!rt.cfg.apiToken) return;
  const header = req.headers.authorization ?? '';
  if (header !== `Bearer ${rt.cfg.apiToken}`) {
    throw new ApiError(401, 'UNAUTHORIZED', '需要有效的 API_TOKEN');
  }
}

function checkWorkerAuth(rt: Runtime, req: FastifyRequest): void {
  const header =
    (req.headers['x-worker-token'] as string) ?? (req.query as Record<string, string>).token ?? '';
  if (header !== rt.cfg.workerToken) {
    throw new ApiError(401, 'UNAUTHORIZED', '需要有效的 WORKER_TOKEN');
  }
}

interface CaseListRow {
  id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

/** 项目路由参数解析：数字 id 或项目名 */
function resolveProject(rt: Runtime, idOrName: string): ProjectRow {
  const numeric = Number(idOrName);
  if (Number.isInteger(numeric) && numeric > 0 && String(numeric) === idOrName) {
    return getProject(rt, numeric);
  }
  const row = rt.db.prepare('SELECT * FROM projects WHERE name = ?').get(idOrName) as
    ProjectRow | undefined;
  if (!row) throw new ApiError(404, 'PROJECT_NOT_FOUND', `项目不存在: ${idOrName}`);
  return row;
}

function webhookPublic(rt: Runtime, id: number) {
  const row = rt.db
    .prepare(
      `SELECT w.*, p.name AS project_name FROM webhooks w LEFT JOIN projects p ON p.id = w.project_id WHERE w.id=?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) throw new ApiError(404, 'WEBHOOK_NOT_FOUND', `webhook 不存在: ${id}`);
  return {
    id: row.id,
    project: (row.project_name as string | null) ?? null,
    type: 'dingtalk' as const,
    hasSecret: !!row.secret,
    notifyOn: row.notify_on as 'always' | 'failure',
    enabled: !!row.enabled,
    createdAt: row.created_at,
  };
}

export function registerApi(app: FastifyInstance, rt: Runtime): void {
  app.setErrorHandler((err, _req, reply) => {
    const e = err as Error & { statusCode?: number; code?: string };
    if (err instanceof ApiError) {
      reply
        .code(err.status)
        .send({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if (
      e.statusCode === 413 ||
      e.code === 'FST_PART_FILE_TOO_LARGE' ||
      e.code === 'FST_REQ_FILE_TOO_LARGE'
    ) {
      reply.code(413).send({ error: { code: 'FILE_TOO_LARGE', message: '上传文件过大' } });
      return;
    }
    rt.log.error({ err: e.message }, 'api error');
    reply.code(500).send({ error: { code: 'INTERNAL', message: e.message } });
  });

  app.get('/api/v1/meta', () => metaInfo(rt));

  // ---- 项目（用例仓库）管理 ----

  app.get('/api/v1/projects', () => {
    const rows = rt.db.prepare('SELECT * FROM projects ORDER BY name').all() as ProjectRow[];
    return rows.map((r) => projectInfo(rt, r));
  });

  app.post('/api/v1/projects', async (req) => {
    checkApiAuth(rt, req);
    const payload = (req.body ?? {}) as CreateProjectPayload;
    const { project, sync } = await addGitProject(rt, payload);
    return { project: projectInfo(rt, project), sync };
  });

  app.post('/api/v1/projects/:id/sync', async (req) => {
    checkApiAuth(rt, req);
    const { id } = req.params as { id: string };
    return updateProjectRepo(rt, Number(id));
  });

  app.patch('/api/v1/projects/:id', async (req) => {
    checkApiAuth(rt, req);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as UpdateProjectPayload;
    const before = rt.db.prepare('SELECT name FROM projects WHERE id=?').get(Number(id)) as
      { name: string } | undefined;
    if (!before) throw new ApiError(404, 'PROJECT_NOT_FOUND', `项目不存在: ${Number(id)}`);
    const row = patchProject(rt, Number(id), body);
    // 改名 = caseId 前缀切换：自动重新同步，用例库立即按新项目名重新收录
    if (row.name !== before.name) {
      const sync = await updateProjectRepo(rt, row.id);
      return { project: projectInfo(rt, row), sync };
    }
    return { project: projectInfo(rt, row) };
  });

  app.delete('/api/v1/projects/:id', async (req) => {
    checkApiAuth(rt, req);
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string | undefined>;
    await removeProject(rt, Number(id), q.removeFiles === 'true');
    return { ok: true as const };
  });

  app.post('/api/v1/projects/discover', async (req) => {
    checkApiAuth(rt, req);
    return discoverLocalProjects(rt);
  });

  app.get('/api/v1/tags', () => listTags(rt));

  app.get('/api/v1/facets', (req) => {
    const q = req.query as Record<string, string | undefined>;
    return facetsInfo(rt, q.project || undefined);
  });

  app.post('/api/v1/sync', async (req) => {
    checkApiAuth(rt, req);
    return syncAllProjects(rt);
  });

  app.get('/api/v1/sync', () => {
    const rows = rt.db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 20').all() as Record<
      string,
      unknown
    >[];
    return { items: rows.map(syncInfo), total: rows.length };
  });

  app.get('/api/v1/cases', (req) => {
    const q = req.query as Record<string, string | undefined>;
    const where: string[] = [];
    const params: unknown[] = [];
    const status = q.status && q.status !== 'all' ? q.status : 'active';
    if (status !== '*') {
      where.push('c.status = ?');
      params.push(status);
    }
    // F5：隔离筛选（exclude=默认，与 createRun 的排除规则一致；only=只看隔离；all=不过滤）
    const quarantine =
      q.quarantine === 'only' ? 'only' : q.quarantine === 'all' ? 'all' : 'exclude';
    if (quarantine === 'exclude') where.push('c.quarantined = 0');
    if (quarantine === 'only') where.push('c.quarantined = 1');
    if (q.project) {
      where.push('p.name = ?');
      params.push(q.project);
    }
    const versions = q.version
      ? q.version
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
      : [];
    if (versions.length) {
      where.push(`c.version IN (${versions.map(() => '?').join(',')})`);
      params.push(...versions);
    }
    const modules = q.module
      ? q.module
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
      : [];
    if (modules.length) {
      where.push(`c.module IN (${modules.map(() => '?').join(',')})`);
      params.push(...modules);
    }
    if (q.q) {
      where.push('(c.id LIKE ? OR c.title LIKE ? OR c.description LIKE ?)');
      const like = `%${q.q}%`;
      params.push(like, like, like);
    }
    const tags = q.tags
      ? q.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
    if (tags.length) {
      if ((q.tagMode ?? 'any') === 'all') {
        for (const t of tags) {
          where.push('EXISTS (SELECT 1 FROM case_tags ct WHERE ct.case_id = c.id AND ct.tag = ?)');
          params.push(t);
        }
      } else {
        where.push(
          `EXISTS (SELECT 1 FROM case_tags ct WHERE ct.case_id = c.id AND ct.tag IN (${tags.map(() => '?').join(',')}))`,
        );
        params.push(...tags);
      }
    }
    const exclude = q.excludeTags
      ? q.excludeTags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
    if (exclude.length) {
      where.push(
        `NOT EXISTS (SELECT 1 FROM case_tags ct WHERE ct.case_id = c.id AND ct.tag IN (${exclude.map(() => '?').join(',')}))`,
      );
      params.push(...exclude);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      rt.db
        .prepare(
          `SELECT COUNT(*) AS n FROM cases c JOIN projects p ON p.id=c.project_id ${whereSql}`,
        )
        .get(...params) as { n: number }
    ).n;
    const rawLimit = Number(q.limit ?? 20);
    const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(0, rawLimit)) : 20;
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    const rows = rt.db
      .prepare(
        `SELECT c.*, p.name AS project_name,
          (SELECT json_group_array(tag) FROM case_tags ct WHERE ct.case_id = c.id) AS tags_json,
          (SELECT history FROM case_stats cs WHERE cs.case_id = c.id) AS stats_json
         FROM cases c JOIN projects p ON p.id = c.project_id
         ${whereSql} ORDER BY c.id LIMIT ${limit} OFFSET ${offset}`,
      )
      .all(...params) as CaseListRow[];
    return {
      items: rows.map((r) => {
        r.tags = JSON.parse(r.tags_json ?? '[]');
        return caseSummary(r);
      }),
      total,
      limit,
      offset,
    };
  });

  app.get('/api/v1/cases/*', (req) => {
    const caseId = decodeURIComponent((req.params as Record<string, string>)['*']);
    const row = getCaseWithProject(rt, caseId);
    if (!row) throw new ApiError(404, 'CASE_NOT_FOUND', `用例不存在: ${caseId}`);
    const stats = rt.db.prepare('SELECT history FROM case_stats WHERE case_id=?').get(caseId) as
      { history: string } | undefined;
    if (stats) row.stats_json = stats.history;
    const runs = rt.db
      .prepare('SELECT * FROM case_runs WHERE case_id = ? ORDER BY started_at DESC LIMIT 10')
      .all(caseId) as Record<string, unknown>[];
    return caseDetail(row, runs.map(runBrief));
  });

  // F5：手动隔离 / 解除隔离（manual 优先于 auto 规则）
  app.patch('/api/v1/cases/*', (req) => {
    checkApiAuth(rt, req);
    const caseId = decodeURIComponent((req.params as Record<string, string>)['*']);
    const body = (req.body ?? {}) as { quarantined?: boolean };
    if (typeof body.quarantined !== 'boolean') {
      throw new ApiError(400, 'BAD_PATCH', '仅支持 { quarantined: boolean }');
    }
    const row = getCaseWithProject(rt, caseId);
    if (!row) throw new ApiError(404, 'CASE_NOT_FOUND', `用例不存在: ${caseId}`);
    setCaseQuarantine(rt, caseId, body.quarantined);
    const fresh = getCaseWithProject(rt, caseId);
    if (!fresh) throw new ApiError(404, 'CASE_NOT_FOUND', `用例不存在: ${caseId}`);
    const stats = rt.db.prepare('SELECT history FROM case_stats WHERE case_id=?').get(caseId) as
      { history: string } | undefined;
    if (stats) fresh.stats_json = stats.history;
    const runs = rt.db
      .prepare('SELECT * FROM case_runs WHERE case_id = ? ORDER BY started_at DESC LIMIT 10')
      .all(caseId) as Record<string, unknown>[];
    return caseDetail(fresh, runs.map(runBrief));
  });

  // ---- 测试运行（Run）----

  app.post('/api/v1/runs', (req) => {
    checkApiAuth(rt, req);
    const payload = req.body as CreateRunPayload;
    const createdBy = payload?.createdBy ?? 'api';
    const run = createRun(rt, payload ?? {}, createdBy);
    return { run };
  });

  // run 创建 dry-run 预览：与 createRun 共用选择规划（测试集/多环境上下文/去重明细），不落库
  app.post('/api/v1/runs/preview', (req) => {
    const payload = req.body as CreateRunPayload;
    return previewRun(rt, payload ?? {});
  });

  app.get('/api/v1/runs', (req) => {
    const q = req.query as Record<string, string | undefined>;
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status && q.status !== 'all') {
      where.push('status = ?');
      params.push(q.status);
    }
    if (q.project) {
      where.push('project = ?');
      params.push(q.project);
    }
    if (q.createdBy) {
      where.push('created_by = ?');
      params.push(q.createdBy);
    }
    if (q.workerId) {
      where.push('worker_id = ?');
      params.push(q.workerId);
    }
    if (q.env) {
      // 环境筛选：run 级环境名或任一环境上下文名命中即可（多环境测试集并跑）
      where.push(
        '(env_name = ? OR EXISTS (SELECT 1 FROM run_envs re WHERE re.batch_id = batches.id AND re.env_name = ?))',
      );
      params.push(q.env, q.env);
    }
    if (q.suite) {
      // 按引用过的测试集名筛选（匹配 scope 快照的 suites[].name）
      where.push(
        `EXISTS (SELECT 1 FROM json_each(batches.scope, '$.suites') WHERE json_extract(value, '$.name') = ?)`,
      );
      params.push(q.suite);
    }
    if (q.q) {
      where.push('(id LIKE ? OR title LIKE ?)');
      params.push(`%${q.q}%`, `%${q.q}%`);
    }
    if (q.createdFrom) {
      where.push('created_at >= ?');
      params.push(q.createdFrom);
    }
    if (q.createdTo) {
      where.push('created_at <= ?');
      params.push(q.createdTo);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      rt.db.prepare(`SELECT COUNT(*) AS n FROM batches ${whereSql}`).get(...params) as { n: number }
    ).n;
    const limit = Math.min(200, Math.max(0, Number(q.limit ?? 20)));
    const offset = Math.max(0, Number(q.offset ?? 0));
    const rows = rt.db
      .prepare(
        `SELECT * FROM batches ${whereSql} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      )
      .all(...params) as Record<string, unknown>[];
    return { items: rows.map((r) => runInfo(r)), total, limit, offset };
  });

  app.get('/api/v1/runs/:id', (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string | undefined>;
    const run = getRun(rt, id, q.itemStatus);
    if (!run) throw new ApiError(404, 'RUN_NOT_FOUND', '测试运行不存在');
    return run;
  });

  app.post('/api/v1/runs/:id/cancel', (req) => {
    checkApiAuth(rt, req);
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string | undefined>;
    cancelRun(rt, id, q.force === 'true');
    return { ok: true as const };
  });

  app.post('/api/v1/runs/:id/retry-failed', (req) => {
    checkApiAuth(rt, req);
    const { id } = req.params as { id: string };
    return { run: rerunRun(rt, id, 'retry', 'failed') };
  });

  // 重跑：复跑该运行的全部用例（沿用环境/参数/worker/trace 选项）；只复跑失败用例用 /retry-failed
  app.post('/api/v1/runs/:id/rerun', (req) => {
    checkApiAuth(rt, req);
    const { id } = req.params as { id: string };
    return { run: rerunRun(rt, id, 'retry', 'all') };
  });

  // F2：删除 run（DB 级联 + 产物目录清理）
  app.delete('/api/v1/runs/:id', (req) => {
    checkApiAuth(rt, req);
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string | undefined>;
    return deleteRun(rt, id, q.force === 'true');
  });

  // F4：失败摘要（按错误签名分组 + 跨 run 历史）
  app.get('/api/v1/runs/:id/failure-summary', (req) => {
    const { id } = req.params as { id: string };
    return failureSummary(rt, id);
  });

  // ---- 单用例执行（execution）明细 ----

  app.get('/api/v1/executions/:id', (req) => {
    const { id } = req.params as { id: string };
    const row = rt.db.prepare('SELECT * FROM case_runs WHERE id=?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) throw new ApiError(404, 'EXECUTION_NOT_FOUND', '执行记录不存在');
    return executionDetail(rt, row);
  });

  // trace 轻量在线查看（非 SW 依赖）：解包 trace.zip + 解析 NDJSON，帧/资源经 /artifacts/ 静态目录直出
  app.get('/api/v1/executions/:id/trace-view', (req) => {
    const { id } = req.params as { id: string };
    const row = rt.db.prepare('SELECT * FROM case_runs WHERE id=?').get(id) as
      { artifacts: string | null } | undefined;
    if (!row) throw new ApiError(404, 'EXECUTION_NOT_FOUND', '执行记录不存在');
    const traceUrl =
      (row.artifacts ? (JSON.parse(row.artifacts) as { trace?: string }).trace : null) ?? null;
    if (!traceUrl) throw new ApiError(404, 'TRACE_NOT_FOUND', '该执行没有 trace 产物');
    const rel = traceUrl.replace(/^\/artifacts\//, '');
    const zipPath = join(rt.cfg.artifactsDir, rel);
    if (!existsSync(zipPath))
      throw new ApiError(404, 'TRACE_FILE_MISSING', 'trace.zip 文件不存在（可能已被保留策略清理）');
    const extractedDir = join(dirname(zipPath), 'trace-extracted');
    unzipToDir(zipPath, extractedDir);
    // resourceBase：trace-extracted 的静态访问前缀（/artifacts/ 本身就是静态目录）
    const resourceBase = `/artifacts/${dirname(rel)}/trace-extracted`;
    return parseTraceDir(extractedDir, resourceBase);
  });

  app.get('/api/v1/executions/:id/logs', (req) => {
    const { id } = req.params as { id: string };
    const row = rt.db.prepare('SELECT batch_id FROM case_runs WHERE id=?').get(id) as
      { batch_id: string } | undefined;
    if (!row) throw new ApiError(404, 'EXECUTION_NOT_FOUND', '执行记录不存在');
    const file = path.join(rt.cfg.artifactsDir, row.batch_id, id, 'run.log');
    let logs = '';
    try {
      logs = readFileSync(file, 'utf8');
    } catch {
      logs = '';
    }
    return { executionId: id, logs };
  });

  app.get('/api/v1/workers', () => {
    const rows = rt.db.prepare('SELECT * FROM workers ORDER BY registered_at').all() as Record<
      string,
      unknown
    >[];
    return rows.map(workerInfo);
  });

  // ---- F1 环境管理（:idOrName 支持项目 id 或名称）----

  app.get('/api/v1/projects/:idOrName/env-variables', (req) => {
    const project = resolveProject(rt, (req.params as { idOrName: string }).idOrName);
    return { variables: envManifest(rt, project.id) };
  });

  app.get('/api/v1/projects/:idOrName/environments', (req) => {
    const project = resolveProject(rt, (req.params as { idOrName: string }).idOrName);
    return { items: listEnvironments(rt, project.id) };
  });

  app.post('/api/v1/projects/:idOrName/environments', (req) => {
    checkApiAuth(rt, req);
    const project = resolveProject(rt, (req.params as { idOrName: string }).idOrName);
    const payload = (req.body ?? {}) as CreateEnvironmentPayload;
    return { environment: createEnvironment(rt, project.id, payload) };
  });

  app.patch('/api/v1/projects/:idOrName/environments/:envName', (req) => {
    checkApiAuth(rt, req);
    const project = resolveProject(rt, (req.params as { idOrName: string }).idOrName);
    const { envName } = req.params as { envName: string };
    const payload = (req.body ?? {}) as UpdateEnvironmentPayload;
    return { environment: updateEnvironment(rt, project.id, decodeURIComponent(envName), payload) };
  });

  app.delete('/api/v1/projects/:idOrName/environments/:envName', (req) => {
    checkApiAuth(rt, req);
    const project = resolveProject(rt, (req.params as { idOrName: string }).idOrName);
    const { envName } = req.params as { envName: string };
    deleteEnvironment(rt, project.id, decodeURIComponent(envName));
    return { ok: true as const };
  });

  // ---- 测试集（docs/test-suite-design.md）----

  // 草稿解析预览（编辑器实时命中预览；不落库）
  app.post('/api/v1/projects/:idOrName/suites/preview', (req) => {
    const project = resolveProject(rt, (req.params as { idOrName: string }).idOrName);
    const body = (req.body ?? {}) as { selector?: unknown; limit?: number };
    return previewSuiteSelector(rt, project.name, body.selector, Number(body.limit ?? 50));
  });

  app.get('/api/v1/projects/:idOrName/suites', (req) => {
    const project = resolveProject(rt, (req.params as { idOrName: string }).idOrName);
    const q = req.query as Record<string, string | undefined>;
    const items = listSuites(rt, project.id);
    if (!q.q) return { items };
    const needle = q.q.toLowerCase();
    return {
      items: items.filter(
        (s) => s.name.includes(needle) || s.description.toLowerCase().includes(needle),
      ),
    };
  });

  app.post('/api/v1/projects/:idOrName/suites', (req) => {
    checkApiAuth(rt, req);
    const project = resolveProject(rt, (req.params as { idOrName: string }).idOrName);
    const payload = (req.body ?? {}) as CreateSuitePayload;
    return { suite: createSuite(rt, project.name, payload, 'api') };
  });

  app.get('/api/v1/projects/:idOrName/suites/:name', (req) => {
    const project = resolveProject(rt, (req.params as { idOrName: string }).idOrName);
    const { name } = req.params as { name: string };
    return getSuite(rt, project.id, decodeURIComponent(name));
  });

  app.patch('/api/v1/projects/:idOrName/suites/:name', (req) => {
    checkApiAuth(rt, req);
    const project = resolveProject(rt, (req.params as { idOrName: string }).idOrName);
    const { name } = req.params as { name: string };
    const payload = (req.body ?? {}) as UpdateSuitePayload;
    return { suite: updateSuite(rt, project.name, decodeURIComponent(name), payload) };
  });

  app.delete('/api/v1/projects/:idOrName/suites/:name', (req) => {
    checkApiAuth(rt, req);
    const project = resolveProject(rt, (req.params as { idOrName: string }).idOrName);
    const { name } = req.params as { name: string };
    deleteSuite(rt, project.name, decodeURIComponent(name));
    return { ok: true as const };
  });

  // ---- F6 定时任务 ----

  app.get('/api/v1/schedules', () => ({ items: listSchedules(rt) }));

  app.post('/api/v1/schedules', (req) => {
    checkApiAuth(rt, req);
    const payload = (req.body ?? {}) as CreateSchedulePayload;
    return { schedule: createSchedule(rt, payload, 'api') };
  });

  app.patch('/api/v1/schedules/:id', (req) => {
    checkApiAuth(rt, req);
    const { id } = req.params as { id: string };
    const payload = (req.body ?? {}) as UpdateSchedulePayload;
    return { schedule: updateSchedule(rt, id, payload) };
  });

  app.delete('/api/v1/schedules/:id', (req) => {
    checkApiAuth(rt, req);
    const { id } = req.params as { id: string };
    deleteSchedule(rt, id);
    return { ok: true as const };
  });

  // ---- F7 钉钉 webhook ----

  app.get('/api/v1/webhooks', () => {
    const rows = rt.db
      .prepare(
        `SELECT w.*, p.name AS project_name FROM webhooks w LEFT JOIN projects p ON p.id = w.project_id ORDER BY w.id DESC`,
      )
      .all() as Record<string, unknown>[];
    return {
      items: rows.map((w) => ({
        id: w.id,
        project: (w.project_name as string | null) ?? null,
        type: 'dingtalk' as const,
        hasSecret: !!w.secret,
        notifyOn: w.notify_on as 'always' | 'failure',
        enabled: !!w.enabled,
        createdAt: w.created_at,
      })),
    };
  });

  app.post('/api/v1/webhooks', (req) => {
    checkApiAuth(rt, req);
    const payload = (req.body ?? {}) as CreateWebhookPayload;
    if (!/^https?:\/\//.test(payload.url ?? '')) {
      throw new ApiError(400, 'BAD_WEBHOOK_URL', 'webhook url 必须是 http(s) 地址');
    }
    let projectId: number | null = null;
    if (payload.project) projectId = resolveProject(rt, payload.project).id;
    const whType = payload.type ?? (payload.url.includes('dingtalk.com') ? 'dingtalk' : 'generic');
    const r = rt.db
      .prepare(
        `INSERT INTO webhooks (project_id, type, url, secret, notify_on, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        projectId,
        whType,
        payload.url,
        payload.secret ?? '',
        payload.notifyOn ?? 'failure',
        new Date().toISOString(),
      );
    const id = Number(r.lastInsertRowid);
    return { webhook: webhookPublic(rt, id) };
  });

  app.patch('/api/v1/webhooks/:id', (req) => {
    checkApiAuth(rt, req);
    const id = Number((req.params as { id: string }).id);
    const payload = (req.body ?? {}) as UpdateWebhookPayload;
    const row = rt.db.prepare('SELECT * FROM webhooks WHERE id=?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) throw new ApiError(404, 'WEBHOOK_NOT_FOUND', `webhook 不存在: ${id}`);
    if (payload.url !== undefined && !/^https?:\/\//.test(payload.url)) {
      throw new ApiError(400, 'BAD_WEBHOOK_URL', 'webhook url 必须是 http(s) 地址');
    }
    const secret = payload.secret === undefined ? row.secret : payload.secret;
    const type = payload.type ?? row.type;
    rt.db
      .prepare('UPDATE webhooks SET type=?, url=?, secret=?, notify_on=?, enabled=? WHERE id=?')
      .run(
        type,
        payload.url ?? row.url,
        secret,
        payload.notifyOn ?? row.notify_on,
        payload.enabled === undefined ? row.enabled : payload.enabled ? 1 : 0,
        id,
      );
    return { webhook: webhookPublic(rt, id) };
  });

  app.delete('/api/v1/webhooks/:id', (req) => {
    checkApiAuth(rt, req);
    const id = Number((req.params as { id: string }).id);
    const r = rt.db.prepare('DELETE FROM webhooks WHERE id=?').run(id);
    if (r.changes === 0) throw new ApiError(404, 'WEBHOOK_NOT_FOUND', `webhook 不存在: ${id}`);
    return { ok: true as const };
  });

  app.post('/api/v1/webhooks/:id/test', async (req) => {
    checkApiAuth(rt, req);
    const id = Number((req.params as { id: string }).id);
    const row = rt.db.prepare('SELECT * FROM webhooks WHERE id=?').get(id) as
      | {
          id: number;
          project_id: number | null;
          type: string;
          url: string;
          secret: string;
          notify_on: string;
          enabled: number;
        }
      | undefined;
    if (!row) throw new ApiError(404, 'WEBHOOK_NOT_FOUND', `webhook 不存在: ${id}`);
    try {
      await sendWebhook(row as never, {
        event: 'test',
        timestamp: new Date().toISOString(),
        markdown: {
          title: 'Tern 通知测试',
          text: '**Tern 测试通知**\n\n这是一条测试消息：webhook 配置成功 ✅',
        },
      });
      return { ok: true as const };
    } catch (e) {
      throw new ApiError(502, 'WEBHOOK_SEND_FAILED', `测试消息发送失败: ${(e as Error).message}`);
    }
  });

  app.get('/api/v1/bundles/:name', (req, reply) => {
    checkWorkerAuth(rt, req);
    const { name } = req.params as { name: string };
    if (!/^[a-f0-9]{64}\.cjs$/.test(name)) throw new ApiError(400, 'BAD_NAME', '非法 bundle 名称');
    const file = path.join(rt.cfg.bundlesDir, name.slice(0, 2), name);
    if (!existsSync(file)) throw new ApiError(404, 'BUNDLE_NOT_FOUND', 'bundle 不存在');
    reply.type('text/javascript').send(createReadStream(file));
  });

  // F8：测试资产下载（worker；内容寻址，同 bundle 通道）
  app.get('/api/v1/assets/:hash', (req, reply) => {
    checkWorkerAuth(rt, req);
    const { hash } = req.params as { hash: string };
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new ApiError(400, 'BAD_NAME', '非法资产 hash');
    const file = path.join(rt.cfg.assetsDir, hash.slice(0, 2), hash);
    if (!existsSync(file))
      throw new ApiError(404, 'ASSET_NOT_FOUND', `资产不存在: ${hash.slice(0, 12)}…`);
    reply.type('application/octet-stream').send(createReadStream(file));
  });

  // F8：项目资产列表（Web/CLI/MCP）
  app.get('/api/v1/projects/:idOrName/assets', (req) => {
    const project = resolveProject(rt, (req.params as { idOrName: string }).idOrName);
    const rows = rt.db
      .prepare(
        'SELECT path, hash, size, status, updated_at FROM assets WHERE project_id=? ORDER BY path',
      )
      .all(project.id) as {
      path: string;
      hash: string;
      size: number;
      status: string;
      updated_at: string;
    }[];
    return {
      items: rows.map((r) => ({
        path: r.path,
        hash: r.hash,
        bytes: r.size,
        status: r.status,
        updatedAt: r.updated_at,
      })),
    };
  });

  app.post('/api/v1/executions/:id/artifacts', async (req, reply) => {
    checkWorkerAuth(rt, req);
    const { id } = req.params as { id: string };
    const runToken = req.headers['x-run-token'] as string | undefined;
    const row = rt.db.prepare('SELECT run_token, batch_id FROM case_runs WHERE id=?').get(id) as
      { run_token: string; batch_id: string } | undefined;
    if (!row) throw new ApiError(404, 'EXECUTION_NOT_FOUND', '执行记录不存在');
    if (!runToken || runToken !== row.run_token) {
      throw new ApiError(401, 'BAD_RUN_TOKEN', 'run_token 不匹配（过期/重派后的报文将被拒绝）');
    }
    const saved: string[] = [];
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const relName = decodeURIComponent(part.filename ?? 'unnamed');
        await saveArtifactStream(rt, row.batch_id, id, relName, part.file);
        saved.push(relName);
      }
    }
    void reply;
    return { ok: true as const, saved };
  });
}
