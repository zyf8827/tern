import { useEffect, useState, useCallback } from 'react';
import { api, connectLive, fmtDuration, fmtTime, STATUS_STYLE } from './lib';
import { ShortId } from './ShortId';
import { PAGE_SIZE, Pager } from './Pager';

interface ProjectInfo {
  id: number;
  name: string;
  caseCount: number;
}
interface TagInfo {
  tag: string;
  count: number;
}
interface FacetValue {
  value: string;
  count: number;
}
interface FacetsInfo {
  projects: { name: string; count: number }[];
  versions: FacetValue[];
  modules: FacetValue[];
}
interface CaseSummary {
  caseId: string;
  title: string;
  project: string;
  description: string;
  tags: string[];
  version: string | null;
  module: string | null;
  timeoutS: number;
  retries: number;
  traceMode: 'off' | 'on' | 'retain-on-failure' | null;
  status: string;
  quarantined: boolean;
  quarantinedBy: string | null;
  flakyStats: { total: number; flaky: number; rate: number | null; history: string[] } | null;
  lastError: string | null;
  updatedAt: string;
}
interface CaseDetail extends CaseSummary {
  source: string;
  recentRuns: { id: string; status: string; startedAt: string | null; durationMs: number | null }[];
}
interface ProjectSyncResult {
  name: string;
  added: number;
  updated: number;
  removed: number;
  invalid: number;
  error: string | null;
  invalidCases?: { caseId: string; error: string }[];
}

export function CasesPage({ onNavigate }: { onNavigate: (p: string) => void }) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [facets, setFacets] = useState<FacetsInfo | null>(null);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [project, setProject] = useState('');
  const [version, setVersion] = useState('');
  const [moduleName, setModuleName] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [tagMode, setTagMode] = useState<'any' | 'all'>('any');
  const [quarantine, setQuarantine] = useState<'exclude' | 'only' | 'all'>('exclude');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [limit] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<CaseDetail | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncInfo, setSyncInfo] = useState<ProjectSyncResult[] | null>(null);
  const [invalidOpen, setInvalidOpen] = useState(false);

  const load = useCallback(async () => {
    const p = new URLSearchParams();
    if (project) p.set('project', project);
    if (version) p.set('version', version);
    if (moduleName) p.set('module', moduleName);
    if (tagFilter) p.set('tags', tagFilter);
    if (tagMode) p.set('tagMode', tagMode);
    if (q) p.set('q', q);
    if (quarantine !== 'exclude') p.set('quarantine', quarantine);
    p.set('limit', String(limit));
    p.set('offset', String(offset));
    const r = await api<{ items: CaseSummary[]; total: number }>(`/api/v1/cases?${p}`);
    setCases(r.items);
    setTotal(r.total);
  }, [project, version, moduleName, tagFilter, tagMode, quarantine, q, limit, offset]);

  useEffect(() => {
    setOffset(0);
  }, [project, version, moduleName, tagFilter, tagMode, quarantine, q]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void api<ProjectInfo[]>('/api/v1/projects').then(setProjects);
    void api<TagInfo[]>('/api/v1/tags').then(setTags);
  }, []);
  useEffect(() => {
    const p = project ? `?project=${encodeURIComponent(project)}` : '';
    void api<FacetsInfo>(`/api/v1/facets${p}`).then(setFacets);
  }, [project]);

  const doSync = async () => {
    setSyncing(true);
    try {
      const r = await api<{ projects: ProjectSyncResult[] }>('/api/v1/sync', {
        method: 'POST',
        body: '{}',
      });
      setSyncInfo(r.projects);
      if (r.projects.some((p) => (p.invalidCases?.length ?? 0) > 0)) setInvalidOpen(true);
      await load();
    } finally {
      setSyncing(false);
    }
  };

  const showCase = async (id: string) => {
    setSelected(await api<CaseDetail>(`/api/v1/cases/${id}`));
  };

  const allInvalid = syncInfo?.flatMap((p) => p.invalidCases ?? []) ?? [];

  return (
    <div className="flex gap-4">
      <div className="w-56 shrink-0 space-y-4">
        <div>
          <div className="text-xs font-semibold text-gray-500 mb-1">PROJECT</div>
          <button
            className={`block w-full text-left px-2 py-1 rounded text-sm ${project === '' ? 'bg-sky-600 text-white' : 'hover:bg-gray-100'}`}
            onClick={() => setProject('')}
          >
            全部
          </button>
          {projects.map((p) => (
            <button
              key={p.name}
              className={`block w-full text-left px-2 py-1 rounded text-sm ${project === p.name ? 'bg-sky-600 text-white' : 'hover:bg-gray-100'}`}
              onClick={() => setProject(p.name)}
            >
              {p.name} <span className="opacity-60">({p.caseCount})</span>
            </button>
          ))}
        </div>
        <div>
          <div className="text-xs font-semibold text-gray-500 mb-1">版本</div>
          <select
            className="w-full border rounded px-2 py-1 text-sm"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
          >
            <option value="">全部</option>
            {facets?.versions.map((v) => (
              <option key={v.value} value={v.value}>
                {v.value} ({v.count})
              </option>
            ))}
          </select>
        </div>
        <div>
          <div className="text-xs font-semibold text-gray-500 mb-1">模块</div>
          <select
            className="w-full border rounded px-2 py-1 text-sm"
            value={moduleName}
            onChange={(e) => setModuleName(e.target.value)}
          >
            <option value="">全部</option>
            {facets?.modules.map((m) => (
              <option key={m.value} value={m.value}>
                {m.value} ({m.count})
              </option>
            ))}
          </select>
        </div>
        <div>
          <div className="text-xs font-semibold text-gray-500 mb-1">TAGS</div>
          <div className="flex flex-wrap gap-1">
            {tags.map((t) => (
              <button
                key={t.tag}
                className={`px-2 py-0.5 rounded-full text-xs ${tagFilter.split(',').includes(t.tag) ? 'bg-sky-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}
                onClick={() => {
                  const cur = tagFilter ? tagFilter.split(',') : [];
                  const next = cur.includes(t.tag)
                    ? cur.filter((x) => x !== t.tag)
                    : [...cur, t.tag];
                  setTagFilter(next.join(','));
                }}
              >
                {t.tag}
              </button>
            ))}
          </div>
          {tagFilter && (
            <select
              className="mt-2 text-xs border rounded px-1 py-0.5"
              value={tagMode}
              onChange={(e) => setTagMode(e.target.value as 'any' | 'all')}
            >
              <option value="any">任一命中</option>
              <option value="all">全部命中</option>
            </select>
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-3">
          <input
            className="border rounded px-2 py-1 text-sm w-64"
            placeholder="搜索标题 / 描述 / ID…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
            className="border rounded px-2 py-1 text-sm"
            value={quarantine}
            onChange={(e) => setQuarantine(e.target.value as 'exclude' | 'only' | 'all')}
          >
            <option value="exclude">不含停用（默认）</option>
            <option value="all">全部（含停用）</option>
            <option value="only">只看停用</option>
          </select>
          <button
            className="bg-sky-600 text-white text-sm px-3 py-1 rounded hover:bg-sky-700 disabled:opacity-50"
            onClick={doSync}
            disabled={syncing}
          >
            {syncing ? '同步中…' : '同步用例库'}
          </button>
          {syncInfo && (
            <span className="text-xs text-gray-500">
              {syncInfo
                .map(
                  (p) =>
                    `${p.name}: +${p.added} ~${p.updated} -${p.removed}${p.invalid ? ` invalid ${p.invalid}` : ''}`,
                )
                .join('；')}
              {allInvalid.length > 0 && (
                <button
                  className="ml-1 text-red-600 underline"
                  onClick={() => setInvalidOpen(true)}
                >
                  查看错误
                </button>
              )}
            </span>
          )}
          <span className="ml-auto text-sm text-gray-500">用例在各项目 git 仓库中维护，只读</span>
        </div>

        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-gray-500 border-b">
              <th className="py-1.5 pr-2">Case ID</th>
              <th className="py-1.5 pr-2">标题</th>
              <th className="py-1.5 pr-2">版本 / 模块</th>
              <th className="py-1.5 pr-2">Tags</th>
              <th className="py-1.5 pr-2">超时</th>
              <th className="py-1.5 pr-2">状态</th>
              <th
                className="py-1.5"
                title="停用的用例默认不参与新建运行（用于隔离疑似不稳定用例）；筛选「只看停用」后仍可对其手动发起运行"
              >
                停用
              </th>
            </tr>
          </thead>
          <tbody>
            {cases.map((cs) => (
              <tr
                key={cs.caseId}
                className="border-b hover:bg-gray-50 cursor-pointer"
                onClick={() => void showCase(cs.caseId)}
              >
                <td className="py-1.5 pr-2 font-mono text-xs">
                  {cs.caseId}
                  {cs.quarantined && (
                    <span
                      className="ml-1 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 text-[10px] align-middle"
                      title={`已停用（${cs.quarantinedBy === 'auto' ? 'flaky 自动判定' : '手动'}）：默认不参与新建运行；筛选「只看停用」后可对其手动发起运行，或点右侧「启用」恢复`}
                    >
                      停用
                    </span>
                  )}
                </td>
                <td className="py-1.5 pr-2">
                  {cs.title}
                  {cs.flakyStats && cs.flakyStats.flaky > 0 && (
                    <span
                      className="ml-1.5 px-1.5 py-0.5 rounded bg-yellow-50 text-yellow-700 text-[10px] align-middle"
                      title={`近 ${cs.flakyStats.total} 次 flaky ${cs.flakyStats.flaky} 次`}
                    >
                      flaky {cs.flakyStats.flaky}/{cs.flakyStats.total}
                    </span>
                  )}
                </td>
                <td className="py-1.5 pr-2 text-xs">
                  {cs.version && (
                    <span className="mr-1 px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700">
                      {cs.version}
                    </span>
                  )}
                  {cs.module && (
                    <span className="px-1.5 py-0.5 rounded bg-teal-50 text-teal-700">
                      {cs.module}
                    </span>
                  )}
                  {!cs.version && !cs.module && <span className="text-gray-300">-</span>}
                </td>
                <td className="py-1.5 pr-2">
                  {cs.tags.map((t) => (
                    <span key={t} className="mr-1 px-1.5 py-0.5 rounded-full bg-gray-100 text-xs">
                      {t}
                    </span>
                  ))}
                </td>
                <td className="py-1.5 pr-2 text-gray-500">
                  {cs.timeoutS}s
                  {cs.traceMode && (
                    <span
                      className="ml-1 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700"
                      title={`用例级 trace=${cs.traceMode}（覆盖运行级设置）`}
                    >
                      trace:{cs.traceMode}
                    </span>
                  )}
                </td>
                <td className="py-1.5">
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs ${STATUS_STYLE[cs.status] ?? ''}`}
                  >
                    {cs.status}
                  </span>
                </td>
                <td className="py-1.5">
                  <button
                    className={`text-xs ${cs.quarantined ? 'text-green-600' : 'text-amber-600'}`}
                    onClick={async (e) => {
                      e.stopPropagation();
                      await api(`/api/v1/cases/${encodeURIComponent(cs.caseId)}`, {
                        method: 'PATCH',
                        body: JSON.stringify({ quarantined: !cs.quarantined }),
                      });
                      void load();
                    }}
                  >
                    {cs.quarantined ? '启用' : '停用'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager total={total} limit={limit} offset={offset} onChange={setOffset} />
        <div className="mt-2">
          <button className="text-xs text-sky-600" onClick={() => onNavigate('/runs')}>
            去测试运行列表发起执行 →
          </button>
        </div>
      </div>

      {selected && (
        <div
          className="fixed inset-0 bg-black/40 flex justify-end"
          onClick={() => setSelected(null)}
        >
          <div
            className="bg-white w-[760px] max-w-[90vw] h-full overflow-auto p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-start mb-2">
              <h2 className="font-semibold text-base leading-snug">{selected.title}</h2>
              <button
                className="text-gray-400 hover:text-gray-700"
                onClick={() => setSelected(null)}
              >
                ✕
              </button>
            </div>
            <div className="font-mono text-xs text-gray-500 mb-2">{selected.caseId}</div>
            <p className="text-sm text-gray-700 mb-3 whitespace-pre-wrap">
              {selected.description || '（无描述）'}
            </p>
            <div className="flex gap-1 mb-3 flex-wrap">
              {selected.version && (
                <span className="px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 text-xs">
                  {selected.version}
                </span>
              )}
              {selected.module && (
                <span className="px-2 py-0.5 rounded-full bg-teal-50 text-teal-700 text-xs">
                  {selected.module}
                </span>
              )}
              {selected.tags.map((t) => (
                <span key={t} className="px-2 py-0.5 rounded-full bg-gray-100 text-xs">
                  {t}
                </span>
              ))}
            </div>
            {selected.lastError && (
              <pre className="bg-red-50 text-red-700 text-xs p-2 rounded mb-3 whitespace-pre-wrap">
                {selected.lastError}
              </pre>
            )}
            <div className="text-xs font-semibold text-gray-500 mb-1">最近执行</div>
            <table className="w-full text-xs mb-4">
              <tbody>
                {selected.recentRuns.length === 0 && (
                  <tr>
                    <td className="text-gray-400 py-1">暂无执行记录</td>
                  </tr>
                )}
                {selected.recentRuns.map((r) => (
                  <tr key={r.id}>
                    <td className="py-0.5">
                      <ShortId id={r.id} />
                    </td>
                    <td>
                      <span className={`px-1.5 rounded-full ${STATUS_STYLE[r.status] ?? ''}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="text-gray-500">{fmtTime(r.startedAt)}</td>
                    <td className="text-gray-500">{fmtDuration(r.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-xs font-semibold text-gray-500 mb-1">源码（只读）</div>
            <pre className="bg-gray-900 text-gray-100 text-xs p-3 rounded overflow-auto whitespace-pre">
              {selected.source}
            </pre>
          </div>
        </div>
      )}

      {invalidOpen && allInvalid.length > 0 && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center"
          onClick={() => setInvalidOpen(false)}
        >
          <div
            className="bg-white rounded-lg p-5 w-[640px] max-w-[90vw] max-h-[80vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-semibold mb-2">同步发现 {allInvalid.length} 个 invalid 用例</h3>
            {allInvalid.map((c) => (
              <div key={c.caseId} className="mb-3">
                <div className="font-mono text-xs">{c.caseId}</div>
                <pre className="bg-red-50 text-red-700 text-xs p-2 rounded whitespace-pre-wrap">
                  {c.error}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function useLive(
  topics: () => string[],
  onEvent: (topic: string, type: string, payload: unknown) => void,
) {
  useEffect(() => {
    const h = connectLive(onEvent, topics);
    return () => h.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
