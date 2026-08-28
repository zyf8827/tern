import { useEffect, useState, useCallback } from 'react';
import { api, connectLive, STATUS_STYLE, fmtTime } from './lib';
import { ShortId } from './ShortId';
import { PAGE_SIZE, Pager } from './Pager';

export interface RunInfo {
  id: string;
  title: string;
  createdBy: string;
  status: string;
  project: string;
  envName: string | null;
  suites: string[];
  envs: string[];
  params: Record<string, string>;
  workerId: string | null;
  total: number;
  passed: number;
  failed: number;
  timedOut: number;
  error: number;
  skipped: number;
  cancelled: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface RunItem {
  id: string;
  runId: string;
  caseId: string;
  position: number;
  status: string;
  attempt: number;
  maxAttempts: number;
  executionId: string | null;
  env: string | null;
  durationMs: number | null;
  lastError: string | null;
}
export interface RunDetail extends RunInfo {
  items: RunItem[];
}

interface SuiteLite {
  name: string;
  description: string;
  env: string | null;
  account: string | null;
  enabled: boolean;
  health: { resolvedCount: number; envStatus: string | null; isFullProject: boolean };
}

export function RunsPage({
  onOpen,
  runIntent,
  onIntentConsumed,
}: {
  onOpen: (id: string) => void;
  runIntent?: { project: string; suites: string[] } | null;
  onIntentConsumed?: () => void;
}) {
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [showNew, setShowNew] = useState(false);
  const [intent, setIntent] = useState<{ project: string; suites: string[] } | null>(null);
  const [status, setStatus] = useState('all');
  const [project, setProject] = useState('');
  const [createdBy, setCreatedBy] = useState('');
  const [workerId, setWorkerId] = useState('');
  const [env, setEnv] = useState('');
  const [q, setQ] = useState('');
  const [projects, setProjects] = useState<{ name: string }[]>([]);
  const [workers, setWorkers] = useState<{ id: string; name: string }[]>([]);

  const load = useCallback(async () => {
    const p = new URLSearchParams();
    if (status && status !== 'all') p.set('status', status);
    if (project) p.set('project', project);
    if (createdBy) p.set('createdBy', createdBy);
    if (workerId) p.set('workerId', workerId);
    if (env) p.set('env', env);
    if (q) p.set('q', q);
    p.set('limit', String(PAGE_SIZE));
    p.set('offset', String(offset));
    const r = await api<{ items: RunInfo[]; total: number }>(`/api/v1/runs?${p}`);
    setRuns(r.items);
    setTotal(r.total);
  }, [status, project, createdBy, workerId, env, q, offset]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setOffset(0);
  }, [status, project, createdBy, workerId, env, q]);
  useEffect(() => {
    void api<{ name: string }[]>('/api/v1/projects').then(setProjects);
    void api<{ id: string; name: string }[]>('/api/v1/workers').then(setWorkers);
  }, []);

  useLiveRuns(load);

  // 从项目测试集「发起运行」带入的预选：打开对话框并预选集
  useEffect(() => {
    if (runIntent) {
      setIntent(runIntent);
      setShowNew(true);
      onIntentConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runIntent]);

  /** 重跑 / 重跑失败：创建新运行并跳转过去 */
  const rerun = async (b: RunInfo, mode: 'all' | 'failed') => {
    try {
      const r = await api<{ run: { id: string } }>(
        `/api/v1/runs/${b.id}/${mode === 'failed' ? 'retry-failed' : 'rerun'}`,
        { method: 'POST' },
      );
      onOpen(r.run.id);
    } catch (err) {
      window.alert((err as Error).message);
    }
  };

  return (
    <div>
      <div className="flex items-center mb-3 gap-2 flex-wrap">
        <h2 className="font-semibold">测试运行</h2>
        <span className="text-xs text-gray-500">
          一次运行归属一个项目，可覆盖多个版本 / tag；缺省由全部空闲 worker 并行
        </span>
        <button
          className="ml-auto bg-sky-600 text-white text-sm px-3 py-1 rounded hover:bg-sky-700"
          onClick={() => setShowNew(true)}
        >
          + 新建运行
        </button>
      </div>
      <div className="flex flex-wrap gap-2 mb-3 text-sm">
        <select
          className="border rounded px-2 py-1"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="all">全部状态</option>
          {RUN_STATUS_FILTERS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <select
          className="border rounded px-2 py-1"
          value={project}
          onChange={(e) => setProject(e.target.value)}
        >
          <option value="">全部项目</option>
          {projects.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          className="border rounded px-2 py-1"
          value={workerId}
          onChange={(e) => setWorkerId(e.target.value)}
        >
          <option value="">全部 Worker</option>
          {workers.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <input
          className="border rounded px-2 py-1 w-32"
          placeholder="来源 createdBy"
          value={createdBy}
          onChange={(e) => setCreatedBy(e.target.value)}
        />
        <input
          className="border rounded px-2 py-1 w-28"
          placeholder="环境"
          value={env}
          onChange={(e) => setEnv(e.target.value)}
        />
        <input
          className="border rounded px-2 py-1 w-48"
          placeholder="搜索标题 / ID…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 border-b">
            <th className="py-1.5 pr-2">运行</th>
            <th className="py-1.5 pr-2">项目</th>
            <th className="py-1.5 pr-2">状态</th>
            <th className="py-1.5 pr-2">统计</th>
            <th className="py-1.5 pr-2">Worker</th>
            <th className="py-1.5 pr-2">来源</th>
            <th className="py-1.5 pr-2">创建时间</th>
          </tr>
        </thead>
        <tbody>
          {runs.length === 0 && (
            <tr>
              <td className="py-4 text-gray-400 text-sm" colSpan={7}>
                暂无测试运行
              </td>
            </tr>
          )}
          {runs.map((b) => {
            const ds = runDisplay(b);
            return (
              <tr key={b.id} className={`border-b ${RUN_STATUS_ROW[ds]}`}>
                <td className="py-1.5 pr-2 cursor-pointer" onClick={() => onOpen(b.id)}>
                  <div className="font-medium">{b.title}</div>
                  <ShortId id={b.id} />
                </td>
                <td className="py-1.5 pr-2 text-xs cursor-pointer" onClick={() => onOpen(b.id)}>
                  {b.project || '-'}
                  {(b.envs.length > 1 ? b.envs : b.envName ? [b.envName] : []).map((e) => (
                    <span key={e} className="ml-1 px-1.5 py-0.5 rounded bg-sky-50 text-sky-700">
                      {e}
                    </span>
                  ))}
                  {b.envs.length > 1 && <span className="ml-1 text-gray-400">多环境</span>}
                </td>
                <td className="py-1.5 pr-2">
                  <RunStatusBadge b={b} />
                </td>
                <td className="py-1.5 pr-2 text-xs">
                  <span className="text-green-700">✓{b.passed}</span>{' '}
                  <span className="text-red-700">✗{b.failed + b.timedOut + b.error}</span>{' '}
                  <span className="text-gray-500">共{b.total}</span>
                </td>
                <td className="py-1.5 pr-2 text-xs text-gray-500">
                  {b.workerId ? <ShortId id={b.workerId} /> : '全部空闲（可并行）'}
                </td>
                <td className="py-1.5 pr-2 text-xs text-gray-500">
                  {b.createdBy.startsWith('schedule:') ? (
                    <span className="px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 mr-1">
                      定时
                    </span>
                  ) : null}
                  {b.createdBy.startsWith('schedule:') ? b.createdBy.slice(9, 21) : b.createdBy}
                </td>
                <td className="py-1.5 pr-2 text-xs text-gray-500 whitespace-nowrap">
                  {fmtTime(b.createdAt)}
                  {(b.status === 'completed' || b.status === 'cancelled') && (
                    <button
                      className="ml-2 text-sky-600 hover:text-sky-800"
                      onClick={(e) => {
                        e.stopPropagation();
                        void rerun(b, 'all');
                      }}
                    >
                      重跑
                    </button>
                  )}
                  {(b.status === 'completed' || b.status === 'cancelled') &&
                    b.failed + b.timedOut + b.error > 0 && (
                      <button
                        className="ml-2 text-sky-600 hover:text-sky-800"
                        onClick={(e) => {
                          e.stopPropagation();
                          void rerun(b, 'failed');
                        }}
                      >
                        重跑失败
                      </button>
                    )}
                  <button
                    className="ml-2 text-red-500 hover:text-red-700"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (
                        !window.confirm(
                          `删除运行 ${b.id}？执行记录与截图/trace/日志产物将一并删除，不可恢复`,
                        )
                      )
                        return;
                      try {
                        await api(`/api/v1/runs/${b.id}?force=true`, { method: 'DELETE' });
                        void load();
                      } catch (err) {
                        window.alert((err as Error).message);
                      }
                    }}
                  >
                    删除
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Pager total={total} limit={PAGE_SIZE} offset={offset} onChange={setOffset} />
      {showNew && (
        <NewRunDialog
          onClose={() => {
            setShowNew(false);
            setIntent(null);
          }}
          onCreated={onOpen}
          initial={intent}
        />
      )}
    </div>
  );
}

function useLiveRuns(load: () => void) {
  useEffect(() => {
    const h = connectLive(
      (_t, type) => {
        if (type === 'run.updated' || type === 'run.item.updated') void load();
      },
      () => ['runs'],
    );
    return () => h.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function Badge({ s, tone }: { s: string; tone?: string }) {
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-xs ${tone ?? STATUS_STYLE[s] ?? 'bg-gray-100'}`}
    >
      {s}
    </span>
  );
}

/** 运行展示状态：生命周期（排队中/运行中/已取消）+ completed 后按用例结局细分。存储状态仍是 BatchStatus
 *  四态（schedules 防重叠、重跑按钮、CLI/MCP 判终态都依赖），此处只做展示派生 */
type RunDisplayStatus =
  'pending' | 'running' | 'cancelled' | 'all-passed' | 'has-failed' | 'all-failed' | 'done';
function runDisplay(b: RunInfo): RunDisplayStatus {
  if (b.status === 'pending') return 'pending';
  if (b.status === 'running') return 'running';
  if (b.status === 'cancelled') return 'cancelled';
  // completed：按通过/失败构成细分结局；全跳过/空运行（无通过也无失败）归「完成」
  const bad = b.failed + b.timedOut + b.error;
  if (bad === 0) return b.passed > 0 ? 'all-passed' : 'done';
  return b.passed === 0 ? 'all-failed' : 'has-failed';
}

const RUN_STATUS_LABEL: Record<RunDisplayStatus, string> = {
  pending: '排队中',
  running: '运行中',
  cancelled: '已取消',
  'all-passed': '全部成功',
  'has-failed': '部分成功',
  'all-failed': '全部失败',
  done: '完成',
};
const RUN_STATUS_BADGE: Record<RunDisplayStatus, string> = {
  pending: 'bg-yellow-50 text-yellow-700',
  running: 'bg-blue-100 text-blue-800 animate-pulse',
  cancelled: 'bg-gray-100 text-gray-600',
  'all-passed': 'bg-green-100 text-green-800',
  'has-failed': 'bg-amber-100 text-amber-800',
  'all-failed': 'bg-red-600 text-white',
  done: 'bg-gray-100 text-gray-600',
};
/** 行底色只给两种失败结局，进行中/完成/取消保持素净，列表才清爽 */
const RUN_STATUS_ROW: Record<RunDisplayStatus, string> = {
  pending: 'hover:bg-gray-50',
  running: 'hover:bg-gray-50',
  cancelled: 'hover:bg-gray-50',
  'all-passed': 'hover:bg-gray-50',
  'has-failed': 'bg-amber-50/60 hover:bg-amber-100/60',
  'all-failed': 'bg-red-50 hover:bg-red-100/60',
  done: 'hover:bg-gray-50',
};

/** 运行状态徽章（列表页与详情页共用，口径一致） */
export function RunStatusBadge({ b }: { b: RunInfo }) {
  const ds = runDisplay(b);
  return <Badge s={RUN_STATUS_LABEL[ds]} tone={RUN_STATUS_BADGE[ds]} />;
}

/** 状态筛选项：展示中文标签，value 仍是 API 的原始状态值 */
const RUN_STATUS_FILTERS: [string, string][] = [
  ['pending', '排队中'],
  ['running', '运行中'],
  ['completed', '已完成'],
  ['cancelled', '已取消'],
];

function toggle(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

interface EnvOpt {
  name: string;
  complete: boolean;
  missingKeys: string[];
}

function NewRunDialog({
  onClose,
  onCreated,
  initial,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
  initial?: { project: string; suites: string[] } | null;
}) {
  const [projects, setProjects] = useState<{ id: number; name: string }[]>([]);
  const [workers, setWorkers] = useState<{ id: string; name: string; status: string }[]>([]);
  const [facets, setFacets] = useState<{
    versions: { value: string }[];
    modules: { value: string }[];
  } | null>(null);
  const [envOpts, setEnvOpts] = useState<EnvOpt[]>([]);
  const [suiteOpts, setSuiteOpts] = useState<SuiteLite[]>([]);
  const [suites, setSuites] = useState<string[]>([]);
  const [env, setEnv] = useState('');
  const [project, setProject] = useState('');
  const [versions, setVersions] = useState<string[]>([]);
  const [modules, setModules] = useState<string[]>([]);
  const [tags, setTags] = useState('');
  const [tagMode, setTagMode] = useState<'any' | 'all'>('any');
  const [excludeTags, setExcludeTags] = useState('');
  const [workerId, setWorkerId] = useState('');
  const [title, setTitle] = useState('');
  const [params, setParams] = useState('');
  const [maxAttempts, setMaxAttempts] = useState(1);
  const [hits, setHits] = useState<number | null>(null);
  const [ctxPreview, setCtxPreview] = useState<
    { env: string | null; sources: string[]; caseCount: number }[] | null
  >(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    void api<{ id: number; name: string }[]>('/api/v1/projects').then((ps) => {
      setProjects(ps);
      if (initial?.project && ps.some((p) => p.name === initial.project))
        setProject(initial.project);
      else if (ps.length === 1) setProject(ps[0].name);
    });
    void api<{ id: string; name: string; status: string }[]>('/api/v1/workers').then(setWorkers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    setVersions([]);
    setModules([]);
    setEnv('');
    setEnvOpts([]);
    setSuites([]);
    setSuiteOpts([]);
    if (!project) {
      setFacets(null);
      return;
    }
    void api<{ versions: { value: string }[]; modules: { value: string }[] }>(
      `/api/v1/facets?project=${encodeURIComponent(project)}`,
    ).then(setFacets);
    const p = projects.find((x) => x.name === project);
    if (p) {
      void api<{ items: EnvOpt[] }>(`/api/v1/projects/${p.id}/environments`)
        .then((r) => setEnvOpts(r.items))
        .catch(() => setEnvOpts([]));
      void api<{ items: SuiteLite[] }>(`/api/v1/projects/${p.id}/suites`)
        .then((r) => {
          setSuiteOpts(r.items);
          if (initial?.project === project && initial.suites.length) {
            setSuites(initial.suites.filter((n) => r.items.some((s) => s.name === n && s.enabled)));
          }
        })
        .catch(() => setSuiteOpts([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, projects]);

  // 命中预览：引用测试集时用 runs/preview（按环境分组合计），否则按用例数
  useEffect(() => {
    if (!project) {
      setHits(null);
      setCtxPreview(null);
      return;
    }
    if (suites.length) {
      setHits(null);
      void api<{
        total: number;
        contexts: { env: string | null; sources: string[]; caseCount: number }[];
      }>('/api/v1/runs/preview', {
        method: 'POST',
        body: JSON.stringify({
          project,
          suites,
          env: env || undefined,
          version: versions.length ? versions : undefined,
          module: modules.length ? modules : undefined,
          tags: tags
            ? tags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)
            : undefined,
          tagMode,
          excludeTags: excludeTags
            ? excludeTags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)
            : undefined,
        }),
      })
        .then((r) => {
          setHits(r.total);
          setCtxPreview(r.contexts);
        })
        .catch(() => {
          setHits(null);
          setCtxPreview(null);
        });
      return;
    }
    setCtxPreview(null);
    const p = new URLSearchParams();
    p.set('project', project);
    if (versions.length) p.set('version', versions.join(','));
    if (modules.length) p.set('module', modules.join(','));
    if (tags) p.set('tags', tags);
    if (tagMode) p.set('tagMode', tagMode);
    if (excludeTags) p.set('excludeTags', excludeTags);
    p.set('status', 'active');
    p.set('limit', '0');
    void api<{ total: number }>(`/api/v1/cases?${p}`)
      .then((r) => setHits(r.total))
      .catch(() => setHits(null));
  }, [project, versions, modules, tags, tagMode, excludeTags, suites, env]);

  const submit = async () => {
    setErr('');
    try {
      const paramsObj: Record<string, string> = {};
      for (const line of params.split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) paramsObj[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      const r = await api<{ run: { id: string } }>('/api/v1/runs', {
        method: 'POST',
        body: JSON.stringify({
          title: title || undefined,
          project,
          suites: suites.length ? suites : undefined,
          version: versions.length ? versions : undefined,
          module: modules.length ? modules : undefined,
          tags: tags
            ? tags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)
            : undefined,
          tagMode,
          excludeTags: excludeTags
            ? excludeTags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)
            : undefined,
          env: env || undefined,
          workerId: workerId || undefined,
          params: paramsObj,
          maxAttempts,
          createdBy: 'web',
        }),
      });
      onCreated(r.run.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-white rounded-lg p-5 w-[560px] max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold mb-3">新建测试运行</h3>
        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="text-gray-500 text-xs">标题</span>
            <input
              className="border rounded w-full px-2 py-1"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="（可选）"
            />
          </label>
          <label className="block">
            <span className="text-gray-500 text-xs">项目 *（一次运行只能归属一个项目）</span>
            <select
              className="border rounded w-full px-2 py-1"
              value={project}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value="">请选择项目</option>
              {projects.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {project && suiteOpts.length > 0 && (
            <div>
              <span className="text-gray-500 text-xs">
                测试集（可多选：各用各的绑定环境，按「用例 × 环境」去重执行；与下方筛选/点名取并集）
              </span>
              <div className="border rounded px-2 py-1.5 mt-1 flex flex-wrap gap-1.5">
                {suiteOpts.map((s) => {
                  const on = suites.includes(s.name);
                  return (
                    <button
                      key={s.name}
                      className={`px-2 py-0.5 rounded-full text-xs border ${on ? 'bg-sky-600 text-white border-sky-600' : s.enabled ? 'bg-white text-gray-700 hover:bg-sky-50' : 'bg-gray-50 text-gray-300 line-through'}`}
                      disabled={!s.enabled}
                      title={`${s.description || s.name}${s.account ? ` · 账号 ${s.account}` : ''}`}
                      onClick={() =>
                        setSuites(on ? suites.filter((x) => x !== s.name) : [...suites, s.name])
                      }
                    >
                      {s.name} · {s.health.resolvedCount}
                      {s.env ? ` · ${s.env}` : ''}
                      {s.health.isFullProject ? ' · 全量' : ''}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {project && (
            <label className="block">
              <span className="text-gray-500 text-xs">
                {suites.length
                  ? '环境（默认"各测试集自带环境"多环境并跑；选中具体环境 = 覆盖拉平为单一环境）'
                  : '环境（平台配置的变量值集；选中后无需手填 BASE_URL/凭据）'}
              </span>
              <select
                className="border rounded w-full px-2 py-1"
                value={env}
                onChange={(e) => setEnv(e.target.value)}
              >
                <option value="">
                  {suites.length ? '各测试集自带环境（多环境并跑）' : '手动参数（不使用环境）'}
                </option>
                {envOpts.map((o) => (
                  <option key={o.name} value={o.name} disabled={!o.complete}>
                    {o.name}
                    {o.complete ? '' : `（缺 ${o.missingKeys.join(', ')}，去项目页配齐）`}
                  </option>
                ))}
              </select>
            </label>
          )}
          {project && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className="text-gray-500 text-xs">版本（可多选，空=全部）</span>
                <div className="border rounded px-2 py-1 max-h-28 overflow-auto">
                  {(facets?.versions.length ?? 0) === 0 && (
                    <div className="text-xs text-gray-400">无版本字段</div>
                  )}
                  {facets?.versions.map((v) => (
                    <label key={v.value} className="flex items-center gap-1 text-xs py-0.5">
                      <input
                        type="checkbox"
                        checked={versions.includes(v.value)}
                        onChange={() => setVersions(toggle(versions, v.value))}
                      />
                      {v.value}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <span className="text-gray-500 text-xs">模块（可多选，空=全部）</span>
                <div className="border rounded px-2 py-1 max-h-28 overflow-auto">
                  {(facets?.modules.length ?? 0) === 0 && (
                    <div className="text-xs text-gray-400">无模块字段</div>
                  )}
                  {facets?.modules.map((m) => (
                    <label key={m.value} className="flex items-center gap-1 text-xs py-0.5">
                      <input
                        type="checkbox"
                        checked={modules.includes(m.value)}
                        onChange={() => setModules(toggle(modules, m.value))}
                      />
                      {m.value}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
          <label className="block">
            <span className="text-gray-500 text-xs">Tags（逗号分隔，可多个）</span>
            <input
              className="border rounded w-full px-2 py-1"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="smoke, login"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-gray-500 text-xs">Tag 匹配</span>
              <select
                className="border rounded w-full px-2 py-1"
                value={tagMode}
                onChange={(e) => setTagMode(e.target.value as 'any' | 'all')}
              >
                <option value="any">任一命中</option>
                <option value="all">全部命中</option>
              </select>
            </label>
            <label className="block">
              <span className="text-gray-500 text-xs">排除 Tags</span>
              <input
                className="border rounded w-full px-2 py-1"
                value={excludeTags}
                onChange={(e) => setExcludeTags(e.target.value)}
                placeholder="flaky"
              />
            </label>
          </div>
          <label className="block">
            <span className="text-gray-500 text-xs">Worker：缺省全部空闲并行；也可指定一个</span>
            <select
              className="border rounded w-full px-2 py-1"
              value={workerId}
              onChange={(e) => setWorkerId(e.target.value)}
            >
              <option value="">全部空闲 Worker（可并行）</option>
              {workers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}（{w.status}）
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-gray-500 text-xs">重试次数（每条用例最大尝试）</span>
            <input
              type="number"
              min={1}
              className="border rounded w-full px-2 py-1"
              value={maxAttempts}
              onChange={(e) => setMaxAttempts(Number(e.target.value))}
            />
          </label>
          <label className="block">
            <span className="text-gray-500 text-xs">
              运行参数（每行 K=V；显式覆盖环境值；选择环境时通常留空）
            </span>
            <textarea
              className="border rounded w-full px-2 py-1 font-mono text-xs"
              rows={3}
              value={params}
              onChange={(e) => setParams(e.target.value)}
              placeholder={
                'BASE_URL=https://staging.example.com\nDEMO_USER=alice\nDEMO_PASS=secret'
              }
            />
          </label>
          <div className="text-xs text-gray-600">
            命中用例：
            <span className="font-semibold">{project ? (hits ?? '…') : '请先选项目'}</span> 条
            {suites.length === 0 && ctxPreview === null && '（仅传 project 时 = 项目全部用例）'}
            {ctxPreview && ctxPreview.length > 0 && (
              <span className="ml-2">
                环境：
                {ctxPreview.map((c) => (
                  <span
                    key={c.env ?? 'none'}
                    className="ml-1 px-1.5 py-0.5 rounded bg-sky-50 text-sky-700"
                  >
                    {c.env ?? '无环境'} {c.caseCount}
                  </span>
                ))}
                {env && <span className="ml-1 text-orange-600">（已覆盖拉平为 {env}）</span>}
                {!env && ctxPreview.some((c) => c.env === null) && (
                  <span
                    className="ml-1 text-orange-500"
                    title="直接指定的范围没有环境；多半应选择环境或放进测试集"
                  >
                    ⚠ 含无环境条目
                  </span>
                )}
              </span>
            )}
          </div>
          {err && <div className="text-xs text-red-600">{err}</div>}
          <div className="flex justify-end gap-2">
            <button className="px-3 py-1 rounded border" onClick={onClose}>
              取消
            </button>
            <button
              className="bg-sky-600 text-white px-3 py-1 rounded hover:bg-sky-700"
              onClick={() => void submit()}
              disabled={!project || !hits}
            >
              创建并执行
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
