import { useCallback, useEffect, useRef, useState } from 'react';
import { api, connectLive, fmtDuration, fmtTime, stripAnsi } from './lib';
import { Badge, RunStatusBadge, type RunDetail, type RunItem } from './RunsPage';
// TraceLite placeholder
import { ShortId } from './ShortId';

interface ExecutionDetail {
  id: string;
  status: string;
  flaky: boolean;
  durationMs: number | null;
  error: { message?: string } | null;
  artifacts: {
    trace?: string;
    log?: string;
    events?: string;
    screenshots?: string[];
    videos?: string[];
    attachments?: string[];
  } | null;
  logTail: string[];
}

interface FailureGroup {
  sig: string;
  label: string;
  count: number;
  items: {
    caseId: string;
    executionId: string | null;
    status: string;
    durationMs: number | null;
    screenshotUrl: string | null;
    traceUrl: string | null;
    logTail: string[];
  }[];
  history: { occurrenceRuns: number; firstSeenAt: string | null; lastSeenAt: string | null };
}

/** trace 在线查看：安全上下文（localhost/HTTPS）用官方 Playwright viewer；
 * http://<IP> 下 Service Worker 不可用，改为平台轻量查看（服务端解包解析） */
const traceViewerUrl = (traceUrl: string) =>
  `/trace-viewer/index.html?trace=${encodeURIComponent(traceUrl)}`;

export function RunDetailPage({ id, onNavigate }: { id: string; onNavigate: (p: string) => void }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [selectedExec, setSelectedExec] = useState<ExecutionDetail | null>(null);
  const [liveExecId, setLiveExecId] = useState<string | null>(null);
  const watchItemId = useRef<string | null>(null);
  const [frames, setFrames] = useState<Record<string, { data: string; label?: string }>>({});
  const [activeScreen, setActiveScreen] = useState<string | null>(null);
  const runRef = useRef<RunDetail | null>(null);
  runRef.current = run;

  const reload = useCallback(async () => {
    setRun(await api<RunDetail>(`/api/v1/runs/${id}`));
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const h = connectLive(
      (topic, type, payload) => {
        if (topic === `run:${id}`) {
          if (type === 'execution.started') {
            const p = payload as { runId: string; itemId: string };
            if (watchItemId.current === p.itemId) setLiveExecId(p.runId);
          }
          void reload();
        } else if (topic === `execution:${liveExecId}`) {
          if (type === 'execution.frame') {
            const p = payload as { data?: string; screen?: string; screenLabel?: string };
            if (p.data) {
              const key = p.screen ?? 'default';
              setFrames((f) => ({ ...f, [key]: { data: p.data!, label: p.screenLabel } }));
              setActiveScreen((s) => s ?? key);
            }
          } else if (type === 'execution.log' || type === 'execution.step') {
            const ev = payload as { text?: string; step?: { title: string; phase: string } };
            const line = ev.text ?? (ev.step ? `[step ${ev.step.phase}] ${ev.step.title}` : null);
            if (line) appendLiveLog(stripAnsi(line));
          }
        }
      },
      () => {
        const t = [`run:${id}`];
        if (liveExecId) t.push(`execution:${liveExecId}`);
        return t;
      },
    );
    return () => h.close();
  }, [id, liveExecId, reload]);

  const [liveLog, setLiveLog] = useState<string[]>([]);
  const appendLiveLog = (line: string) => setLiveLog((l) => [...l.slice(-400), line]);
  useEffect(() => {
    setLiveLog([]);
    setFrames({});
    setActiveScreen(null);
  }, [liveExecId]);

  const failedCount = run ? run.failed + run.timedOut + run.error : 0;
  const [groups, setGroups] = useState<FailureGroup[] | null>(null);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [liteTraceExec, setLiteTraceExec] = useState<string | null>(null);
  /** trace 链接：非安全上下文给「精简查看」（点开平台自渲染），安全上下文给官方 viewer */
  const traceLink = (traceUrl: string, executionId: string | null) =>
    officialTraceViewerUsable() || !executionId ? (
      <a href={traceViewerUrl(traceUrl)} target="_blank" rel="noreferrer" className="text-sky-600">
        trace 在线查看
      </a>
    ) : (
      <button className="text-sky-600" onClick={() => setLiteTraceExec(executionId)}>
        trace 在线查看（精简）
      </button>
    );
  useEffect(() => {
    setGroups(null);
    if (run?.status === 'completed' && failedCount > 0 && groupsOpen) {
      void api<{ groups: FailureGroup[] }>(`/api/v1/runs/${id}/failure-summary`)
        .then((r) => setGroups(r.groups))
        .catch(() => setGroups([]));
    }
  }, [id, run?.status, failedCount, groupsOpen]);

  /** 结束运行。force=false 软取消：仅通知执行中的用例；force=true 强制结束：立即中断全部阶段 */
  const cancel = async (force: boolean) => {
    if (
      force &&
      !window.confirm(
        `强制结束运行 ${id}？\n\n运行立即收敛为「已取消」（不等 worker 回执），正在执行/登录/下载的用例全部中断；worker 不在线时重连后补发中断。已生成的截图/trace 尽量保留。`,
      )
    ) {
      return;
    }
    await api(`/api/v1/runs/${id}/cancel?force=${force}`, { method: 'POST' });
  };
  /** 重跑 / 重跑失败：创建新运行并跳转过去 */
  const startRerun = async (mode: 'all' | 'failed') => {
    try {
      const r = await api<{ run: { id: string } }>(
        `/api/v1/runs/${id}/${mode === 'failed' ? 'retry-failed' : 'rerun'}`,
        { method: 'POST' },
      );
      onNavigate(`/runs/${r.run.id}`);
    } catch (e) {
      window.alert((e as Error).message);
    }
  };
  const openExec = async (executionId: string) => {
    setSelectedExec(await api<ExecutionDetail>(`/api/v1/executions/${executionId}`));
  };
  const watchRun = (item: RunItem) => {
    watchItemId.current = item.id;
    if (item.executionId) setLiveExecId(item.executionId);
  };

  if (!run) return <div className="text-gray-500">加载中…</div>;
  const done = run.passed + run.failed + run.timedOut + run.error + run.skipped + run.cancelled;
  const terminal = run.status === 'completed' || run.status === 'cancelled';

  return (
    <div>
      <button className="text-xs text-sky-600 mb-2" onClick={() => onNavigate('/runs')}>
        ← 测试运行列表
      </button>
      <div className="flex items-center gap-3 mb-1">
        <h2 className="font-semibold">{run.title}</h2>
        <RunStatusBadge b={run} />
        <ShortId id={run.id} />
        {run.project && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100">{run.project}</span>
        )}
        {(run.envs.length > 1 ? run.envs : run.envName ? [run.envName] : []).map((e) => (
          <span key={e} className="text-xs px-1.5 py-0.5 rounded bg-sky-50 text-sky-700">
            env {e}
          </span>
        ))}
        {run.envs.length > 1 && <span className="text-xs text-gray-500">多环境并跑</span>}
        {run.suites.map((s) => (
          <span
            key={s}
            className="text-xs px-1.5 py-0.5 rounded bg-violet-50 text-violet-700"
            title="引用的测试集"
          >
            集 {s}
          </span>
        ))}
        <div className="ml-auto flex gap-2">
          {!terminal && (
            <>
              <button
                className="text-xs px-2 py-1 border rounded hover:bg-gray-50"
                title="软取消：仅通知已进入执行阶段的用例；其余条目标记取消后等待自然收敛"
                onClick={() => void cancel(false)}
              >
                取消运行
              </button>
              <button
                className="text-xs px-2 py-1 border border-red-300 text-red-600 rounded hover:bg-red-50"
                title="强制结束：立即中断全部阶段（含尚未开始执行/登录中的条目），不等 worker 回执"
                onClick={() => void cancel(true)}
              >
                强制结束
              </button>
            </>
          )}
          {terminal && (
            <button
              className="text-xs px-2 py-1 border rounded hover:bg-gray-50"
              onClick={() => void startRerun('all')}
            >
              重跑
            </button>
          )}
          {terminal && failedCount > 0 && (
            <button
              className="text-xs px-2 py-1 border rounded hover:bg-gray-50"
              onClick={() => void startRerun('failed')}
            >
              重跑失败
            </button>
          )}
          <button
            className="text-xs px-2 py-1 border border-red-300 text-red-600 rounded hover:bg-red-50"
            onClick={async () => {
              if (
                !window.confirm(
                  `删除运行 ${run.id}？执行记录与截图/trace/日志产物将一并删除，不可恢复`,
                )
              )
                return;
              try {
                await api(`/api/v1/runs/${run.id}?force=true`, { method: 'DELETE' });
                onNavigate('/runs');
              } catch (e) {
                window.alert((e as Error).message);
              }
            }}
          >
            删除
          </button>
        </div>
      </div>

      <div className="flex gap-4 text-sm mb-2 flex-wrap">
        <span>
          进度 {done}/{run.total}
        </span>
        <span className="text-green-700">✓ {run.passed}</span>
        <span className="text-red-700">✗ {run.failed}</span>
        <span className="text-orange-700">⏱ {run.timedOut}</span>
        <span className="text-purple-700">⚠ {run.error}</span>
        <span className="text-gray-500">⏭ {run.skipped}</span>
        <span className="text-gray-500">
          Worker {run.workerId ? <ShortId id={run.workerId} /> : '全部空闲（可并行）'}
        </span>
        <span className="text-gray-500">
          创建 {fmtTime(run.createdAt)} · 来源 {run.createdBy}
        </span>
      </div>
      <div className="h-2 bg-gray-100 rounded mb-4 overflow-hidden flex">
        <div
          className="bg-green-500 h-full"
          style={{ width: `${(run.passed / run.total) * 100}%` }}
        />
        <div
          className="bg-red-500 h-full"
          style={{ width: `${((run.failed + run.timedOut + run.error) / run.total) * 100}%` }}
        />
        <div
          className="bg-gray-300 h-full"
          style={{
            width: `${(done / run.total) * 100 - ((run.passed + run.failed + run.timedOut + run.error) / run.total) * 100}%`,
          }}
        />
      </div>

      {Object.keys(run.params).length > 0 && (
        <div className="text-xs text-gray-500 mb-3 font-mono">
          params: {JSON.stringify(run.params)}
        </div>
      )}

      {run.status === 'completed' && failedCount > 0 && (
        <div className="mb-4 border rounded">
          <button
            className="w-full flex items-center gap-2 px-3 py-2 text-sm bg-red-50/60 rounded-t"
            onClick={() => setGroupsOpen((v) => !v)}
          >
            <span className="font-medium text-red-700">失败分组</span>
            <span className="text-xs text-gray-500">按错误签名聚类，同类失败一目了然</span>
            <span className="ml-auto text-xs text-gray-400">
              {groupsOpen ? '收起 ▲' : '展开 ▼'}
            </span>
          </button>
          {groupsOpen && (
            <div className="p-3 space-y-3">
              {groups === null && <div className="text-xs text-gray-400">加载中…</div>}
              {groups?.length === 0 && <div className="text-xs text-gray-400">无分组数据</div>}
              {groups?.map((g) => (
                <div key={g.sig} className="border rounded p-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-mono bg-red-100 text-red-800 px-1.5 py-0.5 rounded">
                      {g.count} 例
                    </span>
                    <span className="text-sm font-medium truncate max-w-[420px]" title={g.label}>
                      {g.label}
                    </span>
                    <span className="text-xs text-gray-400 ml-auto">
                      历史：出现于 {g.history.occurrenceRuns} 次运行 · 首见{' '}
                      {fmtTime(g.history.firstSeenAt)}
                    </span>
                  </div>
                  <div className="mt-1 space-y-1">
                    {g.items.map((it) => (
                      <div
                        key={it.executionId ?? it.caseId}
                        className="flex items-center gap-2 text-xs"
                      >
                        <span className="font-mono">{it.caseId}</span>
                        <Badge s={it.status} />
                        <span className="text-gray-400">{fmtDuration(it.durationMs)}</span>
                        {it.screenshotUrl && (
                          <a
                            href={it.screenshotUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sky-600"
                          >
                            截图
                          </a>
                        )}
                        {it.traceUrl && traceLink(it.traceUrl, it.executionId)}
                      </div>
                    ))}
                    {g.count > g.items.length && (
                      <div className="text-xs text-gray-400">
                        …其余 {g.count - g.items.length} 例略
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 border-b">
            <th className="py-1.5 pr-2">用例</th>
            <th className="py-1.5 pr-2">环境</th>
            <th className="py-1.5 pr-2">状态</th>
            <th className="py-1.5 pr-2">尝试</th>
            <th className="py-1.5 pr-2">耗时</th>
            <th className="py-1.5 pr-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {run.items.map((it) => (
            <tr key={it.id} className="border-b align-top">
              <td className="py-1.5 pr-2">
                <div className="font-mono text-xs">{it.caseId}</div>
                {it.lastError && (
                  <div
                    className="text-xs text-red-600 mt-0.5 max-w-md truncate"
                    title={stripAnsi(it.lastError)}
                  >
                    {stripAnsi(it.lastError)}
                  </div>
                )}
              </td>
              <td className="py-1.5 pr-2">
                {it.env ? (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-sky-50 text-sky-700">
                    {it.env}
                  </span>
                ) : (
                  <span className="text-xs text-gray-300">-</span>
                )}
              </td>
              <td className="py-1.5 pr-2">
                <Badge s={it.status} />
              </td>
              <td className="py-1.5 pr-2 text-xs text-gray-500">
                {it.attempt}/{it.maxAttempts}
              </td>
              <td className="py-1.5 pr-2 text-xs text-gray-500">{fmtDuration(it.durationMs)}</td>
              <td className="py-1.5 pr-2 text-xs space-x-2">
                {it.status === 'running' && (
                  <button className="text-sky-600" onClick={() => watchRun(it)}>
                    📺 实时画面
                  </button>
                )}
                {it.executionId && (
                  <button className="text-sky-600" onClick={() => void openExec(it.executionId!)}>
                    详情
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {liveExecId && (
        <div className="fixed bottom-4 right-4 bg-gray-900 text-white rounded-lg p-3 w-[480px] shadow-xl z-50">
          <div className="flex justify-between items-center mb-2 text-xs">
            <span>实时画面（只读） · {liveExecId.slice(0, 14)}…</span>
            <button onClick={() => setLiveExecId(null)}>✕</button>
          </div>
          {Object.keys(frames).length > 1 && (
            <div className="flex gap-1 mb-1.5 flex-wrap">
              {Object.entries(frames).map(([key, f], i) => (
                <button
                  key={key}
                  onClick={() => setActiveScreen(key)}
                  title={f.label}
                  className={`px-1.5 py-0.5 rounded text-[10px] max-w-[140px] truncate ${(activeScreen ?? Object.keys(frames)[0]) === key ? 'bg-sky-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}
                >
                  {f.label || `屏${i + 1}`}
                </button>
              ))}
            </div>
          )}
          {(() => {
            const keys = Object.keys(frames);
            const active =
              activeScreen && frames[activeScreen] ? frames[activeScreen] : frames[keys[0]];
            return active ? (
              <img
                alt="live"
                className="w-full rounded bg-black"
                src={`data:image/jpeg;base64,${active.data}`}
              />
            ) : (
              <div className="h-48 flex items-center justify-center text-gray-500 text-xs">
                等待画面帧…
              </div>
            );
          })()}
          <div className="mt-2 h-20 overflow-auto bg-black rounded p-1 font-mono text-[10px] text-green-400">
            {liveLog.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        </div>
      )}

      {liteTraceExec && (
        <TraceLiteModal executionId={liteTraceExec} onClose={() => setLiteTraceExec(null)} />
      )}

      {selectedExec && (
        <div
          className="fixed inset-0 bg-black/40 flex justify-end"
          onClick={() => setSelectedExec(null)}
        >
          <div
            className="bg-white w-[640px] max-w-[90vw] h-full overflow-auto p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between mb-2">
              <h3 className="font-semibold">
                执行详情 <ShortId id={selectedExec.id} />
              </h3>
              <button onClick={() => setSelectedExec(null)}>✕</button>
            </div>
            <div className="text-sm mb-2">
              <Badge s={selectedExec.status} />{' '}
              {selectedExec.flaky && <span className="text-xs text-yellow-600">flaky</span>}{' '}
              <span className="text-xs text-gray-500">{fmtDuration(selectedExec.durationMs)}</span>
            </div>
            {selectedExec.error?.message && (
              <pre className="bg-red-50 text-red-700 text-xs p-2 rounded mb-3 whitespace-pre-wrap">
                {stripAnsi(selectedExec.error.message)}
              </pre>
            )}
            {selectedExec.artifacts && (
              <div className="mb-3 text-xs space-y-1">
                {selectedExec.artifacts.screenshots?.map((s) => (
                  <div key={s}>
                    <img alt="failure" className="border rounded max-w-full mb-1" src={s} />
                    <a className="text-sky-600 break-all" href={s} target="_blank" rel="noreferrer">
                      {s.split('/').pop()}
                    </a>
                  </div>
                ))}
                {selectedExec.artifacts.trace && (
                  <div className="flex items-center gap-2 flex-wrap">
                    {traceLink(selectedExec.artifacts.trace, selectedExec.id)}
                    <span className="text-gray-300">|</span>
                    <a
                      className="text-sky-600 break-all"
                      href={selectedExec.artifacts.trace}
                      target="_blank"
                      rel="noreferrer"
                    >
                      下载 zip
                    </a>
                  </div>
                )}
                {selectedExec.artifacts.log && (
                  <div>
                    日志:{' '}
                    <a
                      className="text-sky-600 break-all"
                      href={selectedExec.artifacts.log}
                      target="_blank"
                      rel="noreferrer"
                    >
                      run.log
                    </a>
                  </div>
                )}
              </div>
            )}
            <div className="text-xs font-semibold text-gray-500 mb-1">日志（尾部 200 行）</div>
            <pre className="bg-gray-900 text-gray-100 text-[10px] p-2 rounded overflow-auto max-h-96 whitespace-pre-wrap">
              {selectedExec.logTail.map(stripAnsi).join('\n') || '（无日志）'}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
