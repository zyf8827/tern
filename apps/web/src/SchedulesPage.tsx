import { useCallback, useEffect, useState } from 'react';
import { api, connectLive, fmtTime } from './lib';

interface ScheduleInfo {
  id: string;
  project: string;
  name: string;
  cron: string;
  scope: Record<string, unknown>;
  env: string | null;
  params: Record<string, string>;
  maxAttempts: number;
  workerId: string | null;
  titlePrefix: string;
  enabled: boolean;
  lastRunId: string | null;
  lastRunAt: string | null;
  nextRunAt: string;
  createdBy: string;
  createdAt: string;
}
interface ProjectInfo {
  id: number;
  name: string;
}
interface EnvironmentInfo {
  name: string;
  complete: boolean;
  missingKeys: string[];
}

export function SchedulesPage({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  const [items, setItems] = useState<ScheduleInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    const r = await api<{ items: ScheduleInfo[] }>('/api/v1/schedules');
    setItems(r.items);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void api<ProjectInfo[]>('/api/v1/projects').then(setProjects);
  }, []);
  useEffect(() => {
    const h = connectLive(
      (_t, type) => {
        if (type === 'run.updated') void load();
      },
      () => ['runs'],
    );
    return () => h.close();
  }, []);

  const toggle = async (s: ScheduleInfo) => {
    await api(`/api/v1/schedules/${s.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    void load();
  };
  const remove = async (s: ScheduleInfo) => {
    if (!window.confirm(`删除定时任务「${s.name}」？`)) return;
    await api(`/api/v1/schedules/${s.id}`, { method: 'DELETE' });
    void load();
  };

  return (
    <div>
      <div className="flex items-center mb-3 gap-2">
        <h2 className="font-semibold">定时任务</h2>
        <span className="text-xs text-gray-500">
          按 cron 定时创建测试运行（cron 按 UTC
          解析，时间展示为东八区；防重叠：上次未结束则跳过本次）
        </span>
        <button
          className="ml-auto bg-sky-600 text-white text-sm px-3 py-1 rounded hover:bg-sky-700"
          onClick={() => setShowNew(true)}
        >
          + 新建任务
        </button>
      </div>
      {err && <div className="mb-2 text-xs text-red-600">{err}</div>}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 border-b">
            <th className="py-1.5 pr-2">任务</th>
            <th className="py-1.5 pr-2">项目 / 环境</th>
            <th className="py-1.5 pr-2">Cron</th>
            <th className="py-1.5 pr-2">范围</th>
            <th className="py-1.5 pr-2">下次触发</th>
            <th className="py-1.5 pr-2">最近一次</th>
            <th className="py-1.5">操作</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr>
              <td className="py-4 text-gray-400 text-sm" colSpan={7}>
                暂无定时任务
              </td>
            </tr>
          )}
          {items.map((s) => (
            <tr key={s.id} className="border-b">
              <td className="py-1.5 pr-2">
                <div className={`font-medium ${s.enabled ? '' : 'text-gray-400'}`}>{s.name}</div>
                <div className="font-mono text-xs text-gray-400">{s.id}</div>
              </td>
              <td className="py-1.5 pr-2 text-xs">
                {s.project}
                {s.env ? (
                  <span className="ml-1 px-1.5 rounded bg-sky-50 text-sky-700">{s.env}</span>
                ) : null}
              </td>
              <td className="py-1.5 pr-2 font-mono text-xs">{s.cron}</td>
              <td className="py-1.5 pr-2 text-xs text-gray-500">{describeScope(s.scope)}</td>
              <td className="py-1.5 pr-2 text-xs">
                {s.enabled ? fmtTime(s.nextRunAt) : '（已停用）'}
              </td>
              <td className="py-1.5 pr-2 text-xs">
                {s.lastRunId ? (
                  <button
                    className="text-sky-600 font-mono"
                    onClick={() => onOpenRun(s.lastRunId!)}
                  >
                    {s.lastRunId.slice(0, 14)}…
                  </button>
                ) : (
                  '-'
                )}
              </td>
              <td className="py-1.5 text-xs space-x-2 whitespace-nowrap">
                <button className="text-sky-600" onClick={() => void toggle(s)}>
                  {s.enabled ? '暂停' : '启用'}
                </button>
                <button className="text-red-600" onClick={() => void remove(s)}>
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {showNew && (
        <NewScheduleDialog
          projects={projects}
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function describeScope(scope: Record<string, unknown>): string {
  const parts: string[] = [];
  const suites = scope.suites as string[] | undefined;
  const tags = scope.tags as string[] | undefined;
  const versions = scope.version as string[] | undefined;
  const modules = scope.module as string[] | undefined;
  if (suites?.length) parts.push(`测试集 ${suites.join('+')}`);
  if (tags?.length) parts.push(`tags=${tags.join(',')}`);
  if (versions?.length) parts.push(`v=${versions.join(',')}`);
  if (modules?.length) parts.push(`m=${modules.join(',')}`);
  return parts.length ? parts.join(' ') : '项目全部用例';
}

function NewScheduleDialog({
  projects,
  onClose,
  onCreated,
}: {
  projects: ProjectInfo[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [project, setProject] = useState(projects.length === 1 ? projects[0].name : '');
  const [name, setName] = useState('');
  const [cron, setCron] = useState('0 9 * * 1-5');
  const [envs, setEnvs] = useState<EnvironmentInfo[]>([]);
  const [env, setEnv] = useState('');
  const [suiteOpts, setSuiteOpts] = useState<
    { name: string; env: string | null; enabled: boolean; health: { resolvedCount: number } }[]
  >([]);
  const [suites, setSuites] = useState<string[]>([]);
  const [tags, setTags] = useState('');
  const [titlePrefix, setTitlePrefix] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSuites([]);
    setSuiteOpts([]);
    if (!project) {
      setEnvs([]);
      return;
    }
    const p = projects.find((x) => x.name === project);
    if (!p) return;
    void api<{ items: EnvironmentInfo[] }>(`/api/v1/projects/${p.id}/environments`).then((r) =>
      setEnvs(r.items),
    );
    void api<{
      items: {
        name: string;
        env: string | null;
        enabled: boolean;
        health: { resolvedCount: number };
      }[];
    }>(`/api/v1/projects/${p.id}/suites`)
      .then((r) => setSuiteOpts(r.items))
      .catch(() => setSuiteOpts([]));
  }, [project, projects]);

  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      await api('/api/v1/schedules', {
        method: 'POST',
        body: JSON.stringify({
          project,
          name,
          cron,
          env: env || undefined,
          scope: suites.length
            ? { suites }
            : tags
              ? {
                  tags: tags
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean),
                }
              : {},
          titlePrefix: titlePrefix || undefined,
        }),
      });
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-white rounded-lg p-5 w-[520px] max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold mb-3">新建定时任务</h3>
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-gray-500 text-xs">项目 *</span>
              <select
                className="border rounded w-full px-2 py-1"
                value={project}
                onChange={(e) => setProject(e.target.value)}
              >
                <option value="">请选择</option>
                {projects.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-gray-500 text-xs">任务名 *</span>
              <input
                className="border rounded w-full px-2 py-1"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="每日冒烟"
              />
            </label>
          </div>
          <label className="block">
            <span className="text-gray-500 text-xs">Cron（分 时 日 月 周，UTC 时间）*</span>
            <input
              className="border rounded w-full px-2 py-1 font-mono text-xs"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="0 9 * * 1-5"
            />
          </label>
          <label className="block">
            <span className="text-gray-500 text-xs">
              环境（
              {suites.length
                ? '显式指定 = 覆盖拉平所有测试集的环境；默认各测试集自带环境多环境并跑'
                : '触发时按当前环境值展开'}
              ）
            </span>
            <select
              className="border rounded w-full px-2 py-1"
              value={env}
              onChange={(e) => setEnv(e.target.value)}
            >
              <option value="">
                {suites.length ? '各测试集自带环境（多环境并跑）' : '不使用环境'}
              </option>
              {envs.map((e) => (
                <option key={e.name} value={e.name} disabled={!e.complete}>
                  {e.name}
                  {e.complete ? '' : `（缺 ${e.missingKeys.join(',')}，不可用）`}
                </option>
              ))}
            </select>
          </label>
          {suiteOpts.length > 0 && (
            <div>
              <span className="text-gray-500 text-xs">
                测试集（可多选；选定后忽略下方 Tags，范围以测试集为准）
              </span>
              <div className="border rounded px-2 py-1.5 mt-1 flex flex-wrap gap-1.5">
                {suiteOpts.map((s) => {
                  const on = suites.includes(s.name);
                  return (
                    <button
                      key={s.name}
                      className={`px-2 py-0.5 rounded-full text-xs border ${on ? 'bg-sky-600 text-white border-sky-600' : s.enabled ? 'bg-white text-gray-700 hover:bg-sky-50' : 'bg-gray-50 text-gray-300 line-through'}`}
                      disabled={!s.enabled}
                      onClick={() =>
                        setSuites(on ? suites.filter((x) => x !== s.name) : [...suites, s.name])
                      }
                    >
                      {s.name} · {s.health.resolvedCount}
                      {s.env ? ` · ${s.env}` : ''}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {suites.length === 0 && (
            <label className="block">
              <span className="text-gray-500 text-xs">Tags（逗号分隔，空 = 项目全部用例）</span>
              <input
                className="border rounded w-full px-2 py-1"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="smoke"
              />
            </label>
          )}
          <label className="block">
            <span className="text-gray-500 text-xs">运行标题前缀（可选）</span>
            <input
              className="border rounded w-full px-2 py-1"
              value={titlePrefix}
              onChange={(e) => setTitlePrefix(e.target.value)}
              placeholder="每日冒烟"
            />
          </label>
          {err && <div className="text-xs text-red-600">{err}</div>}
          <div className="flex justify-end gap-2">
            <button className="px-3 py-1 rounded border" onClick={onClose}>
              取消
            </button>
            <button
              className="bg-sky-600 text-white px-3 py-1 rounded hover:bg-sky-700 disabled:opacity-50"
              onClick={() => void submit()}
              disabled={!project || !name || !cron || busy}
            >
              {busy ? '创建中…' : '创建'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
