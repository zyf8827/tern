import type {
  ExecutionDetail,
  CaseDetail,
  CaseQuery,
  CaseSummary,
  CreateRunPayload,
  CreateProjectPayload,
  UpdateProjectPayload,
  CreateEnvironmentPayload,
  UpdateEnvironmentPayload,
  EnvironmentInfo,
  EnvVariable,
  ProjectAssetInfo,
  FacetsInfo,
  FailureSummary,
  ListResp,
  MetaInfo,
  ProjectInfo,
  ProjectSyncResult,
  RunDetail,
  RunInfo,
  RunQuery,
  ScheduleInfo,
  CreateSchedulePayload,
  UpdateSchedulePayload,
  CreateSuitePayload,
  UpdateSuitePayload,
  SuiteInfo,
  SuitePreview,
  RunPreview,
  SyncResult,
  SyncInfo,
  TagInfo,
  WebhookInfo,
  CreateWebhookPayload,
  UpdateWebhookPayload,
  WorkerInfo,
} from './types.js';

export interface TernClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class TernClient {
  private baseUrl: string;
  private token?: string;
  private fetchImpl: typeof fetch;

  constructor(opts: TernClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string; details?: unknown } })
        ?.error;
      throw new ApiError(
        res.status,
        err?.code ?? 'HTTP_ERROR',
        err?.message ?? text.slice(0, 500) ?? res.statusText,
        err?.details,
      );
    }
    return json as T;
  }

  meta() {
    return this.req<MetaInfo>('GET', '/api/v1/meta');
  }
  projects() {
    return this.req<ProjectInfo[]>('GET', '/api/v1/projects');
  }
  addProject(payload: CreateProjectPayload) {
    return this.req<{ project: ProjectInfo; sync: ProjectSyncResult }>(
      'POST',
      '/api/v1/projects',
      payload,
    );
  }
  syncProject(projectId: number) {
    return this.req<ProjectSyncResult>('POST', `/api/v1/projects/${projectId}/sync`);
  }
  updateProject(projectId: number, patch: UpdateProjectPayload) {
    // 改名（payload.name 变化）时服务端会自动重新同步，响应带 sync 结果
    return this.req<{ project: ProjectInfo; sync?: ProjectSyncResult }>(
      'PATCH',
      `/api/v1/projects/${projectId}`,
      patch,
    );
  }
  removeProject(projectId: number, removeFiles = false) {
    return this.req<{ ok: true }>(
      'DELETE',
      `/api/v1/projects/${projectId}?removeFiles=${removeFiles}`,
    );
  }
  discoverProjects() {
    return this.req<{ added: string[]; refreshed: number }>(
      'POST',
      '/api/v1/projects/discover',
      {},
    );
  }
  cases(query: CaseQuery = {}) {
    const p = new URLSearchParams();
    if (query.project) p.set('project', query.project);
    if (query.version?.length) p.set('version', query.version.join(','));
    if (query.module?.length) p.set('module', query.module.join(','));
    if (query.tags?.length) p.set('tags', query.tags.join(','));
    if (query.tagMode) p.set('tagMode', query.tagMode);
    if (query.excludeTags?.length) p.set('excludeTags', query.excludeTags.join(','));
    if (query.q) p.set('q', query.q);
    if (query.status) p.set('status', query.status);
    if (query.quarantine) p.set('quarantine', query.quarantine);
    if (query.limit != null) p.set('limit', String(query.limit));
    if (query.offset != null) p.set('offset', String(query.offset));
    return this.req<ListResp<CaseSummary>>('GET', `/api/v1/cases?${p}`);
  }
  case(caseId: string) {
    return this.req<CaseDetail>('GET', `/api/v1/cases/${caseId}`);
  }
  tags() {
    return this.req<TagInfo[]>('GET', '/api/v1/tags');
  }
  facets(project?: string) {
    const q = project ? `?project=${encodeURIComponent(project)}` : '';
    return this.req<FacetsInfo>('GET', `/api/v1/facets${q}`);
  }
  sync() {
    return this.req<SyncResult>('POST', '/api/v1/sync');
  }
  syncHistory() {
    return this.req<ListResp<SyncInfo>>('GET', '/api/v1/sync');
  }
  createRun(payload: CreateRunPayload) {
    return this.req<{ run: RunInfo }>('POST', '/api/v1/runs', payload);
  }
  runs(query: RunQuery = {}) {
    const p = new URLSearchParams();
    if (query.status) p.set('status', query.status);
    if (query.project) p.set('project', query.project);
    if (query.q) p.set('q', query.q);
    if (query.createdBy) p.set('createdBy', query.createdBy);
    if (query.workerId) p.set('workerId', query.workerId);
    if (query.env) p.set('env', query.env);
    if (query.suite) p.set('suite', query.suite);
    if (query.createdFrom) p.set('createdFrom', query.createdFrom);
    if (query.createdTo) p.set('createdTo', query.createdTo);
    if (query.limit != null) p.set('limit', String(query.limit));
    if (query.offset != null) p.set('offset', String(query.offset));
    return this.req<ListResp<RunInfo>>('GET', `/api/v1/runs?${p}`);
  }
  run(id: string, itemStatus?: string) {
    const q = itemStatus ? `?itemStatus=${itemStatus}` : '';
    return this.req<RunDetail>('GET', `/api/v1/runs/${id}${q}`);
  }
  cancelRun(id: string, force = false) {
    return this.req<{ ok: true }>('POST', `/api/v1/runs/${id}/cancel?force=${force}`);
  }
  retryFailed(id: string) {
    return this.req<{ run: RunInfo }>('POST', `/api/v1/runs/${id}/retry-failed`);
  }
  /** 重跑该运行的全部用例（沿用环境/参数/worker/trace 选项） */
  rerun(id: string) {
    return this.req<{ run: RunInfo }>('POST', `/api/v1/runs/${id}/rerun`);
  }
  deleteRun(id: string, force = false) {
    return this.req<{ deleted: true; removedExecutions: number }>(
      'DELETE',
      `/api/v1/runs/${id}?force=${force}`,
    );
  }
  failureSummary(runId: string) {
    return this.req<FailureSummary>('GET', `/api/v1/runs/${runId}/failure-summary`);
  }
  /** 用例隔离开关（flaky 治理） */
  patchCase(caseId: string, patch: { quarantined?: boolean }) {
    return this.req<CaseDetail>('PATCH', `/api/v1/cases/${encodeURIComponent(caseId)}`, patch);
  }
  /** 环境管理 */
  envVariables(projectId: number) {
    return this.req<{ variables: EnvVariable[] }>(
      'GET',
      `/api/v1/projects/${projectId}/env-variables`,
    );
  }
  /** 项目测试资产列表 */
  projectAssets(projectId: number) {
    return this.req<{ items: ProjectAssetInfo[] }>('GET', `/api/v1/projects/${projectId}/assets`);
  }
  environments(projectId: number) {
    return this.req<{ items: EnvironmentInfo[] }>(
      'GET',
      `/api/v1/projects/${projectId}/environments`,
    );
  }
  createEnvironment(projectId: number, payload: CreateEnvironmentPayload) {
    return this.req<{ environment: EnvironmentInfo }>(
      'POST',
      `/api/v1/projects/${projectId}/environments`,
      payload,
    );
  }
  updateEnvironment(projectId: number, envName: string, payload: UpdateEnvironmentPayload) {
    return this.req<{ environment: EnvironmentInfo }>(
      'PATCH',
      `/api/v1/projects/${projectId}/environments/${encodeURIComponent(envName)}`,
      payload,
    );
  }
  deleteEnvironment(projectId: number, envName: string) {
    return this.req<{ ok: true }>(
      'DELETE',
      `/api/v1/projects/${projectId}/environments/${encodeURIComponent(envName)}`,
    );
  }
  /** 定时任务 */
  schedules() {
    return this.req<{ items: ScheduleInfo[] }>('GET', '/api/v1/schedules');
  }
  createSchedule(payload: CreateSchedulePayload) {
    return this.req<{ schedule: ScheduleInfo }>('POST', '/api/v1/schedules', payload);
  }
  updateSchedule(id: string, payload: UpdateSchedulePayload) {
    return this.req<{ schedule: ScheduleInfo }>('PATCH', `/api/v1/schedules/${id}`, payload);
  }
  deleteSchedule(id: string) {
    return this.req<{ ok: true }>('DELETE', `/api/v1/schedules/${id}`);
  }
  /** 测试集（docs/test-suite-design.md） */
  suites(projectId: number) {
    return this.req<{ items: SuiteInfo[] }>('GET', `/api/v1/projects/${projectId}/suites`);
  }
  suite(projectId: number, name: string) {
    return this.req<SuiteInfo>(
      'GET',
      `/api/v1/projects/${projectId}/suites/${encodeURIComponent(name)}`,
    );
  }
  createSuite(projectId: number, payload: CreateSuitePayload) {
    return this.req<{ suite: SuiteInfo }>('POST', `/api/v1/projects/${projectId}/suites`, payload);
  }
  updateSuite(projectId: number, name: string, payload: UpdateSuitePayload) {
    return this.req<{ suite: SuiteInfo }>(
      'PATCH',
      `/api/v1/projects/${projectId}/suites/${encodeURIComponent(name)}`,
      payload,
    );
  }
  deleteSuite(projectId: number, name: string) {
    return this.req<{ ok: true }>(
      'DELETE',
      `/api/v1/projects/${projectId}/suites/${encodeURIComponent(name)}`,
    );
  }
  /** 测试集草稿解析预览（不落库） */
  previewSuite(
    projectId: number,
    payload: {
      selector?: CreateSuitePayload['selector'];
      env?: string | null;
      account?: string | null;
      limit?: number;
    },
  ) {
    return this.req<SuitePreview>('POST', `/api/v1/projects/${projectId}/suites/preview`, payload);
  }
  /** run 创建 dry-run 预览（含测试集/多环境上下文与去重明细，不落库） */
  previewRun(payload: CreateRunPayload) {
    return this.req<RunPreview>('POST', '/api/v1/runs/preview', payload);
  }
  /** 钉钉通知 webhook */
  webhooks() {
    return this.req<{ items: WebhookInfo[] }>('GET', '/api/v1/webhooks');
  }
  createWebhook(payload: CreateWebhookPayload) {
    return this.req<{ webhook: WebhookInfo }>('POST', '/api/v1/webhooks', payload);
  }
  updateWebhook(id: number, payload: UpdateWebhookPayload) {
    return this.req<{ webhook: WebhookInfo }>('PATCH', `/api/v1/webhooks/${id}`, payload);
  }
  deleteWebhook(id: number) {
    return this.req<{ ok: true }>('DELETE', `/api/v1/webhooks/${id}`);
  }
  testWebhook(id: number) {
    return this.req<{ ok: true }>('POST', `/api/v1/webhooks/${id}/test`, {});
  }
  /** 单用例的一次执行明细 */
  execution(executionId: string) {
    return this.req<ExecutionDetail>('GET', `/api/v1/executions/${executionId}`);
  }
  executionLogs(executionId: string) {
    return this.req<{ executionId: string; logs: string }>(
      'GET',
      `/api/v1/executions/${executionId}/logs`,
    );
  }
  workers() {
    return this.req<WorkerInfo[]>('GET', '/api/v1/workers');
  }
}
