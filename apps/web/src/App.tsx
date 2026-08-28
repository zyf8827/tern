import { useEffect, useState } from 'react';
import { api, STATUS_STYLE, fmtTime } from './lib';
import { CasesPage, useLive } from './CasesPage';
import { RunsPage } from './RunsPage';
import { RunDetailPage } from './RunDetailPage';
import { ProjectsPage } from './ProjectsPage';
import { SchedulesPage } from './SchedulesPage';
// SuitesPage placeholder
import { TernLogo } from './Logo';
import { ShortId } from './ShortId';

interface WorkerInfo {
  id: string;
  name: string;
  hostname: string;
  agentVersion: string;
  playwrightVersion: string;
  capabilities: { browsers: string[]; maxSlots: number };
  status: string;
  currentRunId: string | null;
  lastHeartbeatAt: string | null;
  registeredAt: string;
  stats: { executed?: number; passed?: number; failed?: number };
}

function WorkersPage() {
  const [workers, setWorkers] = useState<WorkerInfo[]>([]);
  const [showOffline, setShowOffline] = useState(false);
  const load = () => {
    void api<WorkerInfo[]>('/api/v1/workers').then(setWorkers);
  };
  useEffect(load, []);
  useLive(
    () => ['workers'],
    () => load(),
  );
  // 默认隐藏离线：历史接入的 worker（容器重建/换机后名字变化）不在此堆积，需要排查时勾选查看
  const visible = showOffline ? workers : workers.filter((w) => w.status !== 'offline');

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <h2 className="font-semibold">Workers</h2>
        <label className="flex items-center gap-1 text-xs text-gray-500 cursor-pointer">
          <input
            type="checkbox"
            checked={showOffline}
            onChange={(e) => setShowOffline(e.target.checked)}
          />
          显示离线
        </label>
      </div>
      {workers.length === 0 && (
        <div className="text-sm text-gray-500">
          暂无 Worker 接入。启动方式：SERVER_URL=... WORKER_TOKEN=... node apps/worker/dist/index.js
        </div>
      )}
      {workers.length > 0 && visible.length === 0 && (
        <div className="text-sm text-gray-500">
          没有在线 Worker。勾选「显示离线」可查看历史接入记录。
        </div>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 border-b">
            <th className="py-1.5 pr-2">名称</th>
            <th className="py-1.5 pr-2">状态</th>
            <th className="py-1.5 pr-2">版本</th>
            <th className="py-1.5 pr-2">并发槽</th>
            <th className="py-1.5 pr-2">累计执行</th>
            <th className="py-1.5 pr-2">最近心跳</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((w) => (
            <tr key={w.id} className="border-b">
              <td className="py-1.5 pr-2">
                <div className="font-medium">{w.name}</div>
                <ShortId id={w.id} />
              </td>
              <td className="py-1.5 pr-2">
                <span
                  className={`px-2 py-0.5 rounded-full text-xs ${STATUS_STYLE[w.status] ?? ''}`}
                >
                  {w.status}
                </span>
              </td>
              <td className="py-1.5 pr-2 text-xs text-gray-500">
                agent {w.agentVersion} / pw {w.playwrightVersion}
              </td>
              <td className="py-1.5 pr-2 text-xs">{w.capabilities.maxSlots}</td>
              <td className="py-1.5 pr-2 text-xs">
                {w.stats.executed ?? 0}（✓{w.stats.passed ?? 0} ✗{w.stats.failed ?? 0}）
              </td>
              <td className="py-1.5 pr-2 text-xs text-gray-500">{fmtTime(w.lastHeartbeatAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function App() {
  const [route, setRoute] = useState(window.location.pathname);
  const [meta, setMeta] = useState<{
    stats: { activeCases: number; onlineWorkers: number; projects: number };
    gitCommit: string | null;
  } | null>(null);
  /** 从项目测试集「发起运行」带入的预选（project + suites） */
  const [runIntent, setRunIntent] = useState<{ project: string; suites: string[] } | null>(null);

  useEffect(() => {
    const onPop = () => setRoute(window.location.pathname);
    window.addEventListener('popstate', onPop);
    void api<typeof meta>('/api/v1/meta').then(setMeta);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const nav = (p: string) => {
    window.history.pushState(null, '', p);
    setRoute(p);
  };

  const link = (path: string, label: string, active?: boolean) => (
    <button
      className={`px-3 py-1.5 rounded text-sm ${(active ?? route.startsWith(path)) ? 'bg-sky-600 text-white' : 'hover:bg-slate-100'}`}
      onClick={() => nav(path)}
    >
      {label}
    </button>
  );

  return (
    <div className="min-h-screen bg-white text-slate-900">
      <header className="border-b border-slate-200 sticky top-0 bg-white/95 backdrop-blur z-40">
        <div className="w-full px-6 h-12 flex items-center gap-2.5">
          <TernLogo size={28} />
          <span className="font-bold tracking-tight text-lg leading-none">Tern</span>
          <span className="text-[11px] text-slate-400 leading-tight hidden sm:block whitespace-nowrap">
            北极燕鸥 · E2E 测试平台
            <br />
            pole to pole, end to end
          </span>
          <span className="mx-2 h-5 w-px bg-slate-200 hidden sm:block" />
          {link('/projects', '项目')}
          {link('/cases', '用例库', route === '/' || route.startsWith('/cases'))}
          {link('/suites', '测试集', route === '/suites' || route.startsWith('/suites/'))}
          {link('/runs', '测试运行')}
          {link('/schedules', '定时任务')}
          {link('/workers', 'Workers')}
          <span className="ml-auto text-xs text-slate-400">
            {meta
              ? `${meta.stats.projects} 项目 · ${meta.stats.activeCases} 用例 · ${meta.stats.onlineWorkers} worker 在线`
              : ''}
          </span>
        </div>
      </header>
      <main className="w-full px-6 py-4">
        {route.startsWith('/runs/') || route.startsWith('/batches/') ? (
          <RunDetailPage id={route.split('/')[2]} onNavigate={nav} />
        ) : route.startsWith('/runs') || route.startsWith('/batches') ? (
          <RunsPage
            onOpen={(id) => nav(`/runs/${id}`)}
            runIntent={runIntent}
            onIntentConsumed={() => setRunIntent(null)}
          />
        ) : route.startsWith('/suites') ? (
          <SuitesPage
            project={route.split('/')[2]}
            onNavigate={nav}
            onRunSuite={(p, s) => {
              setRunIntent({ project: p, suites: [s] });
              nav('/runs');
            }}
          />
        ) : route.startsWith('/schedules') ? (
          <SchedulesPage onOpenRun={(id) => nav(`/runs/${id}`)} />
        ) : route.startsWith('/workers') ? (
          <WorkersPage />
        ) : route.startsWith('/projects') ? (
          <ProjectsPage onOpenSuites={(p) => nav(`/suites/${p}`)} />
        ) : (
          <CasesPage onNavigate={nav} />
        )}
      </main>
    </div>
  );
}
