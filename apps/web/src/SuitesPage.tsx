// 测试集一级页面（/suites）：项目维度管理测试集——列表、健康徽标、新建/编辑（选择器构建器 + 实时命中预览）、按集发起运行。
// docs/test-suite-design.md §6
import { useCallback, useEffect, useState } from 'react';
import { api } from './lib';

export interface SuiteSelector {
  version?: string[];
  module?: string[];
  tags?: string[];
  tagMode?: 'any' | 'all';
  excludeTags?: string[];
  q?: string;
  includeCaseIds?: string[];
  excludeCaseIds?: string[];
  includeQuarantined?: boolean;
}

export interface SuiteInfo {
  id: string;
  name: string;
  description: string;
  selector: SuiteSelector;
  env: string | null;
  account: string | null;
  params: Record<string, string>;
  enabled: boolean;
  health: {
    resolvedCount: number;
    quarantinedExcluded: number;
    danglingIncludes: string[];
    deadEntries: string[];
    envStatus: 'ok' | 'incomplete' | 'missing' | null;
    accountKnown: boolean | null;
    isFullProject: boolean;
  };
}

interface ProjectLite {
  id: number;
  name: string;
}
interface EnvOpt {
  name: string;
  complete: boolean;
  missingKeys: string[];
}

export function SuitesPage({
  project,
  onNavigate,
  onRunSuite,
}: {
  project?: string;
  onNavigate: (p: string) => void;
  onRunSuite: (project: string, suite: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [suites, setSuites] = useState<SuiteInfo[] | null>(null);
  const [editing, setEditing] = useState<{ original: SuiteInfo | null } | null>(null);

  useEffect(() => {
    void api<ProjectLite[]>('/api/v1/projects').then((ps) => {
      setProjects(ps);
      // 未选项目且只有一个项目时自动选中
      if (!project && ps.length === 1) onNavigate(`/suites/${ps[0].name}`);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    if (!project) {
      setSuites(null);
      return;
    }
    const p = projects.find((x) => x.name === project);
    if (!p) {
      setSuites(null);
      return;
    }
    try {
      const r = await api<{ items: SuiteInfo[] }>(`/api/v1/projects/${p.id}/suites`);
      setSuites(r.items);
    } catch {
      setSuites([]);
    }
  }, [project, projects]);
  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (s: SuiteInfo) => {
    if (
      !window.confirm(
        `删除测试集「${s.name}」？历史运行靠快照不受影响；引用它的定时任务触发时会明确报错。`,
      )
    )
      return;
    const p = projects.find((x) => x.name === project);
    if (!p) return;
    await api(`/api/v1/projects/${p.id}/suites/${encodeURIComponent(s.name)}`, {
      method: 'DELETE',
    });
    void load();
  };

  const current = projects.find((x) => x.name === project) ?? null;

  return (
    <div>
      <div className="flex items-center mb-3 gap-2 flex-wrap">
        <h2 className="font-semibold">测试集</h2>
        <span className="text-xs text-gray-500">
          可命名的用例选择 + 环境/账号绑定；一次运行引用多个集时各用各的环境，按「用例 ×
          环境」去重执行
        </span>
        <div className="ml-auto flex items-center gap-2">
          <select
            className="border rounded px-2 py-1 text-sm"
            value={project ?? ''}
            onChange={(e) => onNavigate(e.target.value ? `/suites/${e.target.value}` : '/suites')}
          >
            <option value="">请选择项目</option>
            {projects.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            className="bg-sky-600 text-white text-sm px-3 py-1 rounded hover:bg-sky-700 disabled:opacity-50"
            onClick={() => setEditing({ original: null })}
            disabled={!current}
            title={current ? undefined : '先选择项目'}
          >
            + 新建测试集
          </button>
        </div>
      </div>

      {!project && <div className="text-sm text-gray-500">选择一个项目查看其测试集。</div>}
      {project && !current && <div className="text-sm text-red-600">项目不存在: {project}</div>}
      {suites !== null && suites.length === 0 && (
        <div className="text-sm text-gray-500">
          暂无测试集。建一个「冒烟集」试试：tags 填
          smoke，绑定环境后日常回归按集发起（发起运行对话框顶部可多选集）。
        </div>
      )}
      <div className="space-y-1.5">
        {suites?.map((s) => (
          <div key={s.id} className="border rounded px-3 py-2 flex items-center gap-2 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span
                  className={`font-medium text-sm ${s.enabled ? '' : 'text-gray-400 line-through'}`}
                >
                  {s.name}
                </span>
                <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                  命中 {s.health.resolvedCount}
                </span>
                {s.env && (
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded ${s.health.envStatus === 'ok' ? 'bg-sky-50 text-sky-700' : 'bg-orange-50 text-orange-700'}`}
                  >
                    env {s.env}
                    {s.health.envStatus === 'ok'
                      ? ''
                      : s.health.envStatus === 'missing'
                        ? '（不存在）'
                        : '（值缺齐）'}
                  </span>
                )}
                {s.account && (
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded ${s.health.accountKnown ? 'bg-violet-50 text-violet-700' : 'bg-orange-50 text-orange-700'}`}
                  >
                    账号 {s.account}
                    {s.health.accountKnown === false ? '（未声明）' : ''}
                  </span>
                )}
                {s.health.isFullProject && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-50 text-yellow-700">
                    全量
                  </span>
                )}
                {s.health.resolvedCount === 0 && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-red-50 text-red-700">空集</span>
                )}
                {s.health.quarantinedExcluded > 0 && (
                  <span className="text-xs text-gray-400" title="因 flaky 隔离被排除">
                    隔离排除 {s.health.quarantinedExcluded}
                  </span>
                )}
              </div>
              {s.description && (
                <div className="text-xs text-gray-500 truncate max-w-[680px]" title={s.description}>
                  {s.description}
                </div>
              )}
              {s.health.danglingIncludes.length > 0 && (
                <div
                  className="text-xs text-orange-600 truncate max-w-[680px]"
                  title={s.health.danglingIncludes.join(', ')}
                >
                  ⚠ 悬空引用 {s.health.danglingIncludes.length} 条（点名的用例已删除/改名）：
                  {s.health.danglingIncludes.slice(0, 3).join(', ')}
                  {s.health.danglingIncludes.length > 3 ? ' …' : ''}
                </div>
              )}
            </div>
            <div className="ml-auto text-xs space-x-2 whitespace-nowrap">
              <button
                className="text-sky-600 hover:underline"
                onClick={() => onRunSuite(project!, s.name)}
              >
                发起运行
              </button>
              <button
                className="text-sky-600 hover:underline"
                onClick={() => setEditing({ original: s })}
              >
                编辑
              </button>
              <button className="text-red-600 hover:underline" onClick={() => void remove(s)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>

      {editing && current && (
        <SuiteEditDialog
          project={current}
          original={editing.original}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

const csvOf = (s: string) =>
  s
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

export function SuiteEditDialog({
  project,
  original,
  onClose,
  onSaved,
}: {
  project: ProjectLite;
  original: SuiteInfo | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(original?.name ?? '');
  const [description, setDescription] = useState(original?.description ?? '');
  const [tags, setTags] = useState(original?.selector.tags?.join(', ') ?? '');
  const [tagMode, setTagMode] = useState<'any' | 'all'>(original?.selector.tagMode ?? 'any');
  const [excludeTags, setExcludeTags] = useState(original?.selector.excludeTags?.join(', ') ?? '');
  const [q, setQ] = useState(original?.selector.q ?? '');
  const [includeIds, setIncludeIds] = useState(original?.selector.includeCaseIds?.join('\n') ?? '');
  const [excludeIds, setExcludeIds] = useState(original?.selector.excludeCaseIds?.join('\n') ?? '');
  const [includeQuarantined, setIncludeQuarantined] = useState(
    original?.selector.includeQuarantined ?? false,
  );
  const [env, setEnv] = useState(original?.env ?? '');
  const [account, setAccount] = useState(original?.account ?? '');
  const [params, setParams] = useState(
    Object.entries(original?.params ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );
  const [enabled, setEnabled] = useState(original?.enabled ?? true);
  const [envOpts, setEnvOpts] = useState<EnvOpt[]>([]);
  const [preview, setPreview] = useState<{
    health: { resolvedCount: number; quarantinedExcluded: number; isFullProject: boolean };
    items: { caseId: string; title: string }[];
  } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<{ items: EnvOpt[] }>(`/api/v1/projects/${project.id}/environments`)
      .then((r) => setEnvOpts(r.items))
      .catch(() => setEnvOpts([]));
  }, [project.id]);

  const selector = (): SuiteSelector | undefined => {
    const sel: SuiteSelector = {};
    const t = csvOf(tags);
    const et = csvOf(excludeTags);
    if (t.length) sel.tags = t;
    if (tagMode !== 'any') sel.tagMode = tagMode;
    if (et.length) sel.excludeTags = et;
    if (q.trim()) sel.q = q.trim();
    const inc = includeIds
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const exc = excludeIds
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (inc.length) sel.includeCaseIds = inc;
    if (exc.length) sel.excludeCaseIds = exc;
    if (includeQuarantined) sel.includeQuarantined = true;
    return Object.keys(sel).length ? sel : undefined;
  };

  useEffect(() => {
    const t = setTimeout(() => {
      void api<{
        health: { resolvedCount: number; quarantinedExcluded: number; isFullProject: boolean };
        items: { caseId: string; title: string }[];
      }>(`/api/v1/projects/${project.id}/suites/preview`, {
        method: 'POST',
        body: JSON.stringify({ selector: selector() ?? {}, limit: 8 }),
      })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, tags, tagMode, excludeTags, q, includeIds, excludeIds, includeQuarantined]);

  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      const paramsObj: Record<string, string> = {};
      for (const line of params.split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) paramsObj[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      const body = {
        name: name.trim(),
        description,
        selector: selector(),
        env: env || null,
        account: account.trim() || null,
        params: paramsObj,
        enabled,
      };
      if (original) {
        await api(`/api/v1/projects/${project.id}/suites/${encodeURIComponent(original.name)}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
      } else {
        await api(`/api/v1/projects/${project.id}/suites`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg p-5 w-[640px] max-w-[94vw] max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold mb-3">
          {original ? `编辑测试集 · ${original.name}` : `新建测试集 · ${project.name}`}
        </h3>
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-gray-500 text-xs">名称 *（小写 kebab-case，项目内唯一）</span>
              <input
                className="border rounded w-full px-2 py-1 font-mono text-xs"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="smoke"
              />
            </label>
            <label className="block">
              <span className="text-gray-500 text-xs">说明</span>
              <input
                className="border rounded w-full px-2 py-1"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="冒烟集"
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-gray-500 text-xs">Tags（逗号分隔，空 = 不限）</span>
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
          </div>
          <label className="block">
            <span className="text-gray-500 text-xs">关键字（匹配用例 ID / 标题 / 描述）</span>
            <input
              className="border rounded w-full px-2 py-1"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-gray-500 text-xs">
                显式包含（每行一个 caseId；与筛选命中取并集）
              </span>
              <textarea
                className="border rounded w-full px-2 py-1 font-mono text-xs"
                rows={3}
                value={includeIds}
                onChange={(e) => setIncludeIds(e.target.value)}
                placeholder={`${project.name}/smoke/core-flow`}
              />
            </label>
            <label className="block">
              <span className="text-gray-500 text-xs">显式排除（每行一个 caseId；最高优先级）</span>
              <textarea
                className="border rounded w-full px-2 py-1 font-mono text-xs"
                rows={3}
                value={excludeIds}
                onChange={(e) => setExcludeIds(e.target.value)}
                placeholder={`${project.name}/task/rename-delete`}
              />
            </label>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={includeQuarantined}
              onChange={(e) => setIncludeQuarantined(e.target.checked)}
            />
            纳入已隔离（quarantined）用例（默认排除）
          </label>
          <div className="border-t pt-3 space-y-3">
            <div className="text-xs font-semibold text-gray-500">
              执行前提（run 引用该集时的缺省值，可被运行参数覆盖）
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-gray-500 text-xs">环境</span>
                <select
                  className="border rounded w-full px-2 py-1"
                  value={env}
                  onChange={(e) => setEnv(e.target.value)}
                >
                  <option value="">（不绑定）</option>
                  {envOpts.map((o) => (
                    <option key={o.name} value={o.name}>
                      {o.name}
                      {o.complete ? '' : `（缺 ${o.missingKeys.join(',')}）`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-gray-500 text-xs">
                  账号（AUTH_ACCOUNT，只覆盖未声明 auth 的用例）
                </span>
                <input
                  className="border rounded w-full px-2 py-1"
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                  placeholder="admin"
                />
              </label>
            </div>
            <label className="block">
              <span className="text-gray-500 text-xs">
                绑定参数（每行 K=V；非敏感，敏感值放环境里）
              </span>
              <textarea
                className="border rounded w-full px-2 py-1 font-mono text-xs"
                rows={2}
                value={params}
                onChange={(e) => setParams(e.target.value)}
                placeholder="FEATURE_FLAG=on"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              启用（停用后不可被运行/定时任务引用）
            </label>
          </div>
          <div className="border-t pt-3 text-xs text-gray-600">
            命中预览：
            <span className="font-semibold">{preview ? preview.health.resolvedCount : '…'}</span> 条
            {preview && preview.health.isFullProject && (
              <span className="ml-1 px-1.5 py-0.5 rounded bg-yellow-50 text-yellow-700">
                空选择器 = 项目全量
              </span>
            )}
            {preview && preview.health.quarantinedExcluded > 0 && (
              <span className="ml-1 text-gray-400">
                （隔离排除 {preview.health.quarantinedExcluded}）
              </span>
            )}
            {preview?.items.length ? (
              <div className="mt-1 font-mono text-[10px] text-gray-400 space-y-0.5">
                {preview.items.map((it) => (
                  <div key={it.caseId} className="truncate">
                    {it.caseId}
                  </div>
                ))}
                {preview.health.resolvedCount > preview.items.length && (
                  <div>…其余 {preview.health.resolvedCount - preview.items.length} 条</div>
                )}
              </div>
            ) : null}
          </div>
          {err && <div className="text-xs text-red-600">{err}</div>}
          <div className="flex justify-end gap-2">
            <button className="px-3 py-1 rounded border" onClick={onClose}>
              取消
            </button>
            <button
              className="bg-sky-600 text-white px-3 py-1 rounded hover:bg-sky-700 disabled:opacity-50"
              onClick={() => void submit()}
              disabled={!name.trim() || busy || (preview?.health.resolvedCount ?? 0) === 0}
              title={
                (preview?.health.resolvedCount ?? 0) === 0
                  ? '当前命中 0 条（空集不可创建）'
                  : undefined
              }
            >
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
