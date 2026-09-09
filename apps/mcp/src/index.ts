#!/usr/bin/env node
// tern MCP Server —— 平台 REST API 的 stdio MCP 封装（面向 Coding Agent）
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { TernClient, ApiError, type RunDetail } from '@tern/sdk';

// 默认指向本地平台实例；自建/远端平台用 TERN_URL 覆盖
const baseUrl = process.env.TERN_URL ?? 'http://127.0.0.1:7430';
const client = new TernClient({ baseUrl, token: process.env.TERN_TOKEN });

const server = new McpServer({ name: 'tern', version: '0.3.0' });

function text(v: unknown) {
  return {
    content: [
      { type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) },
    ],
  };
}

function briefRun(b: RunDetail) {
  return {
    runId: b.id,
    title: b.title,
    project: b.project,
    env: b.envName,
    envs: b.envs,
    suites: b.suites,
    status: b.status,
    stats: `total=${b.total} passed=${b.passed} failed=${b.failed} timedOut=${b.timedOut} error=${b.error} skipped=${b.skipped} cancelled=${b.cancelled}`,
    params: b.params,
    workerId: b.workerId,
    items: b.items.map((it) => ({
      caseId: it.caseId,
      env: it.env,
      status: it.status,
      attempt: it.attempt,
      durationMs: it.durationMs,
      executionId: it.executionId,
      lastError: it.lastError ? it.lastError.slice(0, 300) : null,
    })),
  };
}

const waitTimeout = { timeoutS: z.number().optional().describe('等待超时秒数（默认 900）') };

server.registerTool(
  'tern_list_projects',
  {
    description:
      '列出平台上的所有测试项目（用例 git/local 仓库）及用例数量、最近同步状态、git 认证摘要（secret 不回显）',
    inputSchema: {},
  },
  async () => text({ projects: await client.projects(), meta: await client.meta() }),
);

server.registerTool(
  'tern_add_project',
  {
    description:
      '添加一个 git 用例仓库作为测试项目（自动 clone + 首次同步）。默认 HTTP 协议，可用账号密码；SSH 必须提供私钥 PEM（运行在容器内，不会使用宿主机密钥）。仓库根目录需要 tern.yaml',
    inputSchema: {
      gitUrl: z.string().describe('git 仓库地址（https 默认；ssh:// 或 git@ 需配私钥）'),
      branch: z.string().optional(),
      name: z.string().optional().describe('项目名（缺省读仓库 tern.yaml 的 name）'),
      credentialType: z
        .enum(['none', 'password', 'ssh'])
        .optional()
        .describe('none=公开库；password=HTTP 账号密码；ssh=私钥'),
      username: z.string().optional().describe('HTTP 用户名'),
      secret: z.string().optional().describe('HTTP 密码/token，或 SSH 私钥 PEM 全文'),
    },
  },
  async ({ gitUrl, branch, name, credentialType, username, secret }) => {
    const r = await client.addProject({
      gitUrl,
      branch,
      name,
      credential:
        credentialType || username || secret
          ? { type: credentialType ?? (secret && !username ? 'ssh' : 'password'), username, secret }
          : undefined,
    });
    return text({ project: r.project, sync: r.sync });
  },
);

server.registerTool(
  'tern_sync_project',
  {
    description:
      '强制更新一个项目：git 仓库会 fetch + reset --hard + clean -fdx（丢弃一切本地修改）后重新扫描用例。写完用例 push 之后调用它让平台生效',
    inputSchema: { project: z.string().describe('项目 id 或名称') },
  },
  async ({ project }) => {
    const id = await resolveProjectId(project);
    return text(await client.syncProject(id));
  },
);

server.registerTool(
  'tern_list_cases',
  {
    description:
      '查询测试用例列表（默认一页 20 条）。可用 project / version / module / tags（tagMode any=任一命中, all=全部命中）/ excludeTags / 关键字多维度过滤',
    inputSchema: {
      project: z.string().optional(),
      version: z.array(z.string()).optional().describe('被测系统版本（可多选）'),
      module: z.array(z.string()).optional().describe('功能模块（可多选）'),
      tags: z.array(z.string()).optional(),
      tagMode: z.enum(['any', 'all']).optional(),
      excludeTags: z.array(z.string()).optional(),
      q: z.string().optional().describe('标题/描述/ID 关键字'),
      limit: z.number().optional().describe('每页条数，默认 20'),
      offset: z.number().optional(),
    },
  },
  async ({ project, version, module, tags, tagMode, excludeTags, q, limit, offset }) =>
    text(
      await client.cases({
        project,
        version,
        module,
        tags,
        tagMode,
        excludeTags,
        q,
        status: 'active',
        limit: limit ?? 20,
        offset: offset ?? 0,
      }),
    ),
);

server.registerTool(
  'tern_get_case',
  {
    description: '获取单个用例的元数据、完整源码与最近执行记录',
    inputSchema: {
      caseId: z.string().describe('用例 ID（即文件相对路径，如 portal/login/login-basic）'),
    },
  },
  async ({ caseId }) => text(await client.case(caseId)),
);

server.registerTool(
  'tern_run_cases',
  {
    description:
      '创建并执行一次测试运行。必须指定 project（或只用 caseIds/suites，且须同属一个项目）。可覆盖该项目的多个 version / module / tag。suites 引用平台测试集（可多个：各自用各自绑定的环境，按「用例×环境」去重执行）。env 引用平台环境（显式指定时会覆盖拉平所有测试集的环境绑定）。workerId 缺省则所有空闲 worker 并行。wait=true（默认）阻塞到结束',
    inputSchema: {
      caseIds: z.array(z.string()).optional().describe('显式用例 ID 列表（须同属一个项目）'),
      project: z.string().optional().describe('归属项目（必填，除非只传同项目的 caseIds/suites）'),
      suites: z
        .array(z.string())
        .optional()
        .describe('引用的测试集名（可多个；各用各的 env 绑定，与筛选/caseIds 并存取并集）'),
      version: z.array(z.string()).optional().describe('被测系统版本（可多选）'),
      module: z.array(z.string()).optional().describe('功能模块（可多选）'),
      tags: z.array(z.string()).optional(),
      tagMode: z.enum(['any', 'all']).optional(),
      excludeTags: z.array(z.string()).optional(),
      env: z
        .string()
        .optional()
        .describe('环境名（显式指定 = 覆盖拉平所有测试集的环境绑定；不传则各测试集用自己的环境）'),
      workerId: z
        .string()
        .optional()
        .describe('指定执行的 worker（id 或名称）；缺省所有空闲 worker 并行'),
      title: z.string().optional(),
      params: z
        .record(z.string(), z.string())
        .optional()
        .describe('运行参数（显式覆盖环境值与环境变量注入，如 BASE_URL、AUTH_ACCOUNT）'),
      maxAttempts: z.number().optional().describe('每条用例最大尝试次数'),
      includeQuarantined: z
        .boolean()
        .optional()
        .describe('纳入已隔离（flaky）用例；缺省排除（显式 caseIds 点名不受限）'),
      wait: z.boolean().optional().describe('等待运行完成（默认 true）'),
      ...waitTimeout,
    },
  },
  async (args) => {
    const {
      caseIds,
      project,
      suites,
      version,
      module,
      tags,
      tagMode,
      excludeTags,
      env,
      workerId,
      title,
      params,
      maxAttempts,
      includeQuarantined,
      wait,
      timeoutS,
    } = args as {
      caseIds?: string[];
      project?: string;
      suites?: string[];
      version?: string[];
      module?: string[];
      tags?: string[];
      tagMode?: 'any' | 'all';
      excludeTags?: string[];
      env?: string;
      workerId?: string;
      title?: string;
      params?: Record<string, string>;
      maxAttempts?: number;
      includeQuarantined?: boolean;
      wait?: boolean;
      timeoutS?: number;
    };
    const { run } = await client.createRun({
      caseIds,
      project,
      suites,
      version,
      module,
      tags,
      tagMode,
      excludeTags,
      env,
      workerId,
      title,
      params,
      maxAttempts,
      includeQuarantined,
      createdBy: 'mcp',
    });
    if (wait === false)
      return text({
        runId: run.id,
        status: run.status,
        total: run.total,
        suites: run.suites,
        envs: run.envs,
      });
    const done = await waitRun(run.id, timeoutS ?? 900);
    return text(briefRun(done));
  },
);

server.registerTool(
  'tern_list_runs',
  {
    description:
      '分页列出测试运行（默认一页 20 条），可按 status / project / env / createdBy / workerId / 关键字 / 创建时间筛选',
    inputSchema: {
      status: z.string().optional(),
      project: z.string().optional(),
      env: z.string().optional().describe('按环境名筛选'),
      q: z.string().optional(),
      createdBy: z.string().optional(),
      workerId: z.string().optional(),
      createdFrom: z.string().optional(),
      createdTo: z.string().optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    },
  },
  async (query) =>
    text(
      await client.runs({
        ...query,
        status: query.status as never,
        limit: query.limit ?? 20,
        offset: query.offset ?? 0,
      }),
    ),
);

server.registerTool(
  'tern_get_run',
  {
    description: '查询一次测试运行的状态与逐用例结果。runId 不传时返回最近一次运行',
    inputSchema: { runId: z.string().optional(), latest: z.boolean().optional() },
  },
  async ({ runId, latest }) => {
    const id = runId ?? (latest !== false ? await latestRunId() : undefined);
    if (!id) return text({ error: '平台还没有任何测试运行' });
    return text(briefRun(await client.run(id)));
  },
);

server.registerTool(
  'tern_wait_run',
  {
    description: '阻塞等待测试运行结束并返回最终统计',
    inputSchema: { runId: z.string(), ...waitTimeout },
  },
  async ({ runId, timeoutS }) => text(briefRun(await waitRun(runId, timeoutS ?? 900))),
);

server.registerTool(
  'tern_retry_failed',
  {
    description: '基于某次测试运行中失败的用例创建新运行并执行（修复后验证的标准动作）',
    inputSchema: { runId: z.string(), wait: z.boolean().optional(), ...waitTimeout },
  },
  async ({ runId, wait, timeoutS }) => {
    const { run } = await client.retryFailed(runId);
    if (wait === false) return text({ newRunId: run.id, total: run.total });
    return text(briefRun(await waitRun(run.id, timeoutS ?? 900)));
  },
);

server.registerTool(
  'tern_rerun',
  {
    description:
      '重跑某次测试运行的全部用例（沿用源运行的环境/参数/worker/trace 选项）；只复跑失败用例用 tern_retry_failed',
    inputSchema: { runId: z.string(), wait: z.boolean().optional(), ...waitTimeout },
  },
  async ({ runId, wait, timeoutS }) => {
    const { run } = await client.rerun(runId);
    if (wait === false) return text({ newRunId: run.id, total: run.total });
    return text(briefRun(await waitRun(run.id, timeoutS ?? 900)));
  },
);

server.registerTool(
  'tern_cancel_run',
  {
    description:
      '结束一次测试运行。默认强制结束：运行立即收敛为 cancelled（不等 worker 回执），中断 worker 上该用例的全部阶段（含尚未开始执行/登录中的条目），worker 不在线时重连后补发中断；force=false 为软取消：仅通知已进入执行阶段的用例。',
    inputSchema: {
      runId: z.string(),
      force: z.boolean().optional().describe('强制结束（默认 true）；false = 软取消'),
    },
  },
  async ({ runId, force }) => text(await client.cancelRun(runId, force ?? true)),
);

server.registerTool(
  'tern_get_execution',
  {
    description: '查询单条用例某次执行的详情：错误、日志尾部、产物清单（截图/trace URL）',
    inputSchema: { executionId: z.string() },
  },
  async ({ executionId }) => text(await client.execution(executionId)),
);

server.registerTool(
  'tern_get_screenshot',
  {
    description: '获取某次用例执行的失败截图，以图片返回（多模态模型可直接查看失败现场）',
    inputSchema: { executionId: z.string() },
  },
  async ({ executionId }) => {
    const run = await client.execution(executionId);
    const shot = run.artifacts?.screenshots?.[0];
    if (!shot) return text({ error: '该执行没有截图', artifacts: run.artifacts });
    const res = await fetch(baseUrl + shot);
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      content: [
        { type: 'text', text: `失败截图 ${shot}` },
        { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' },
      ],
    };
  },
);

server.registerTool(
  'tern_list_workers',
  { description: '列出所有执行 Worker 及其状态', inputSchema: {} },
  async () => text(await client.workers()),
);

server.registerTool(
  'tern_resync_cases',
  {
    description: '全量更新并重新扫描所有项目用例（git 拉取 + 重扫 + lint/打包校验）',
    inputSchema: {},
  },
  async () => text(await client.sync()),
);

server.registerTool(
  'tern_list_environments',
  {
    description:
      '列出项目环境与变量清单（清单来自用例仓库 tern.yaml 的 env.variables；环境值在平台配置，secret 不回显）。发起运行前可用它确认环境是否配齐',
    inputSchema: { project: z.string().describe('项目 id 或名称') },
  },
  async ({ project }) => {
    const id = await resolveProjectId(project);
    const [{ variables }, { items }] = await Promise.all([
      client.envVariables(id),
      client.environments(id),
    ]);
    return text({ variables, environments: items });
  },
);

server.registerTool(
  'tern_delete_run',
  {
    description:
      '删除一次测试运行：级联删除执行记录/事件，并清理截图、trace、日志等产物文件（不可恢复）。进行中的运行需 force=true',
    inputSchema: {
      runId: z.string(),
      force: z.boolean().optional().describe('进行中的运行先强制取消再删（默认拒绝）'),
    },
  },
  async ({ runId, force }) => text(await client.deleteRun(runId, force ?? false)),
);

server.registerTool(
  'tern_get_failure_summary',
  {
    description:
      '获取一次运行的失败摘要：按错误签名聚类分组（同签名 = 同类失败），每组含代表性用例、截图 URL、日志尾部与跨 run 历史（首见/出现次数）。诊断批量失败的首选工具',
    inputSchema: {
      runId: z.string(),
      withScreenshot: z.boolean().optional().describe('附带第一组的失败截图（image，默认 true）'),
    },
  },
  async ({ runId, withScreenshot }) => {
    const summary = await client.failureSummary(runId);
    if (withScreenshot === false || summary.groups.length === 0) return text(summary);
    const shot = summary.groups[0].items.find((i) => i.screenshotUrl)?.screenshotUrl;
    if (!shot) return text(summary);
    const res = await fetch(baseUrl + shot);
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      content: [
        { type: 'text', text: JSON.stringify(summary, null, 2) },
        { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' },
      ],
    };
  },
);

server.registerTool(
  'tern_list_schedules',
  { description: '列出定时任务（cron、环境、下次触发时间、最近一次运行）', inputSchema: {} },
  async () => text(await client.schedules()),
);

// ---- 测试集（docs/test-suite-design.md）----

const suiteSelectorSchema = {
  tags: z.array(z.string()).optional().describe('标签筛选'),
  tagMode: z.enum(['any', 'all']).optional().describe('any=任一命中（默认）；all=全部命中'),
  excludeTags: z.array(z.string()).optional(),
  version: z.array(z.string()).optional(),
  module: z.array(z.string()).optional(),
  q: z.string().optional().describe('标题/描述/ID 关键字'),
  includeCaseIds: z.array(z.string()).optional().describe('显式点名包含（与筛选命中取并集）'),
  excludeCaseIds: z.array(z.string()).optional().describe('显式排除（最高优先级，压过筛选与包含）'),
  includeQuarantined: z.boolean().optional().describe('纳入已隔离用例（默认排除）'),
};

server.registerTool(
  'tern_list_suites',
  {
    description:
      '列出项目测试集：可命名复用的用例选择 + 环境/账号绑定。返回命中数与健康度（悬空引用/空集/环境缺值）——发起运行前选集的主入口',
    inputSchema: { project: z.string().describe('项目 id 或名称') },
  },
  async ({ project }) => text(await client.suites(await resolveProjectId(project))),
);

server.registerTool(
  'tern_get_suite',
  {
    description: '获取单个测试集详情：选择器、环境/账号绑定、健康度与命中数',
    inputSchema: { project: z.string(), name: z.string() },
  },
  async ({ project, name }) => text(await client.suite(await resolveProjectId(project), name)),
);

server.registerTool(
  'tern_create_suite',
  {
    description:
      '创建测试集（项目内可命名复用的用例选择 + 执行前提绑定）。选择器 = 筛选条件 + 显式包含/排除（排除优先）；空选择器 = 项目全量。env/account 是运行该集时的缺省环境与账号（AUTH_ACCOUNT，只覆盖未声明 auth 的用例），run 显式指定可覆盖',
    inputSchema: {
      project: z.string(),
      name: z.string().describe('小写 kebab-case，项目内唯一'),
      description: z.string().optional(),
      selector: z.object(suiteSelectorSchema).optional(),
      env: z.string().optional().describe('绑定环境名（平台项目页配置）'),
      account: z.string().optional().describe('绑定账号名（tern.yaml auth.accounts）'),
      params: z.record(z.string(), z.string()).optional().describe('绑定运行参数（非敏感）'),
    },
  },
  async ({ project, name, description, selector, env, account, params }) =>
    text(
      (
        await client.createSuite(await resolveProjectId(project), {
          name,
          description,
          selector,
          env: env || null,
          account: account || null,
          params,
        })
      ).suite,
    ),
);

server.registerTool(
  'tern_update_suite',
  {
    description: '更新测试集（只改提供的字段；改名会联动引用它的定时任务）',
    inputSchema: {
      project: z.string(),
      name: z.string(),
      rename: z.string().optional().describe('新名字'),
      description: z.string().optional(),
      selector: z.object(suiteSelectorSchema).optional(),
      env: z.string().nullable().optional(),
      account: z.string().nullable().optional(),
      params: z.record(z.string(), z.string()).optional(),
    },
  },
  async ({ project, name, rename, description, selector, env, account, params }) =>
    text(
      (
        await client.updateSuite(await resolveProjectId(project), name, {
          ...(rename ? { name: rename } : {}),
          description,
          selector,
          env: env === undefined ? undefined : env,
          account: account === undefined ? undefined : account,
          params,
        })
      ).suite,
    ),
);

server.registerTool(
  'tern_delete_suite',
  {
    description: '删除测试集（历史 run 靠 scope 快照不受影响；引用它的定时任务触发时会明确报错）',
    inputSchema: { project: z.string(), name: z.string() },
  },
  async ({ project, name }) =>
    text(await client.deleteSuite(await resolveProjectId(project), name)),
);

server.registerTool(
  'tern_preview_run',
  {
    description:
      'run 创建 dry-run 预览（不执行不落库）：与 tern_run_cases 同参，返回去重后的条目总数、按环境分组的命中构成（每组的来源测试集与条数）、各测试集命中数与去重明细——发起前自查选择是否写对',
    inputSchema: {
      project: z.string().optional(),
      suites: z.array(z.string()).optional(),
      caseIds: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      tagMode: z.enum(['any', 'all']).optional(),
      excludeTags: z.array(z.string()).optional(),
      version: z.array(z.string()).optional(),
      module: z.array(z.string()).optional(),
      env: z.string().optional(),
      includeQuarantined: z.boolean().optional(),
    },
  },
  async (args) => text(await client.previewRun(args as Parameters<typeof client.previewRun>[0])),
);

server.registerTool(
  'tern_set_case_quarantine',
  {
    description:
      '手动隔离/解除隔离一条用例（flaky 治理）。隔离的用例默认不参与新建运行，但仍可显式 caseIds 点名执行；手动设置优先于自动规则',
    inputSchema: { caseId: z.string(), quarantined: z.boolean() },
  },
  async ({ caseId, quarantined }) => text(await client.patchCase(caseId, { quarantined })),
);

async function resolveProjectId(idOrName: string): Promise<number> {
  const list = await client.projects();
  const hit = list.find((p) => String(p.id) === idOrName || p.name === idOrName);
  if (!hit) throw new Error(`项目不存在: ${idOrName}`);
  return hit.id;
}

async function latestRunId(): Promise<string | undefined> {
  const { items } = await client.runs({ limit: 1 });
  return items[0]?.id;
}

async function waitRun(runId: string, timeoutS: number): Promise<RunDetail> {
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const b = await client.run(runId);
    if (b.status === 'completed' || b.status === 'cancelled') return b;
    if (Date.now() > deadline)
      throw new Error(`等待测试运行超时（${timeoutS}s），当前 ${b.status}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error(`[tern-mcp] connected to ${baseUrl}`);
}

main().catch((e) => {
  console.error('[tern-mcp] fatal:', e instanceof ApiError ? `${e.code}: ${e.message}` : e);
  process.exit(1);
});
