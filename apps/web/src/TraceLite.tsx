import { useEffect, useState } from 'react';
import { api, stripAnsi, fmtDuration } from './lib';

// F3 修订：trace 轻量在线查看。
// Playwright 官方 viewer 依赖 Service Worker（仅 HTTPS/localhost），平台经 http://<IP>
// 访问时不可用——此组件走服务端解包解析 API（/executions/:id/trace-view），零安全上下文要求。

interface TraceAction {
  callId: string;
  title: string;
  startMs: number | null;
  durationMs: number | null;
  error: string | null;
  params: string;
}
interface TraceConsole {
  level: string;
  text: string;
  url: string;
}
interface TraceFrame {
  url: string;
  width: number;
  height: number;
  wallTime: number;
}
interface TraceNetwork {
  method: string;
  url: string;
  status: number | null;
  durationMs: number | null;
}
interface TraceView {
  actions: TraceAction[];
  console: TraceConsole[];
  frames: TraceFrame[];
  network: TraceNetwork[];
}

/** 非安全上下文（http://<IP>）下为 true：官方 viewer 的 Service Worker 不可用 */
export const officialTraceViewerUsable = (): boolean =>
  typeof window !== 'undefined' && window.isSecureContext === true;

export function TraceLiteModal({
  executionId,
  onClose,
}: {
  executionId: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<TraceView | null>(null);
  const [err, setErr] = useState('');
  const [frameIdx, setFrameIdx] = useState(0);
  const [tab, setTab] = useState<'timeline' | 'network' | 'console'>('timeline');

  useEffect(() => {
    api<TraceView>(`/api/v1/executions/${executionId}/trace-view`)
      .then((v) => {
        setView(v);
        setFrameIdx(Math.max(0, v.frames.length - 1));
      })
      .catch((e) => setErr((e as Error).message));
  }, [executionId]);

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg w-[960px] max-w-[95vw] h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-2 border-b">
          <h3 className="font-semibold">Trace 查看（精简）</h3>
          <span className="text-xs text-gray-400">完整 viewer 需经 localhost / HTTPS 访问</span>
          <div className="ml-auto flex gap-1">
            {(['timeline', 'network', 'console'] as const).map((t) => (
              <button
                key={t}
                className={`px-3 py-1 rounded text-sm ${tab === t ? 'bg-sky-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}
                onClick={() => setTab(t)}
              >
                {t === 'timeline' ? '动作时间线' : t === 'network' ? '网络' : '控制台'}
              </button>
            ))}
            <button className="text-gray-400 hover:text-gray-700 ml-2" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-4 text-sm">
          {err && <div className="text-red-600 text-xs">{err}</div>}
          {!view && !err && <div className="text-gray-400 text-xs">解析中…</div>}
          {view && tab === 'timeline' && (
            <>
              {view.frames.length > 0 && (
                <div className="mb-4">
                  <div className="text-xs font-semibold text-gray-500 mb-1">
                    页面画面（第 {frameIdx + 1}/{view.frames.length} 帧）
                  </div>
                  <img
                    alt="frame"
                    className="border rounded max-h-[360px]"
                    src={view.frames[frameIdx].url}
                  />
                  <input
                    type="range"
                    min={0}
                    max={view.frames.length - 1}
                    value={frameIdx}
                    className="w-full mt-1"
                    onChange={(e) => setFrameIdx(Number(e.target.value))}
                  />
                </div>
              )}
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-500 border-b">
                    <th className="py-1 pr-2">动作</th>
                    <th className="py-1 pr-2">参数</th>
                    <th className="py-1 pr-2">耗时</th>
                    <th className="py-1">结果</th>
                  </tr>
                </thead>
                <tbody>
                  {view.actions.map((a) => (
                    <tr
                      key={a.callId}
                      className={`border-b align-top ${a.error ? 'bg-red-50/60' : a.durationMs == null ? 'bg-orange-50/60' : ''}`}
                    >
                      <td className="py-1 pr-2 font-mono whitespace-nowrap">{a.title}</td>
                      <td className="py-1 pr-2 text-gray-500 max-w-[420px] break-all">
                        {a.params}
                      </td>
                      <td className="py-1 pr-2 whitespace-nowrap">
                        {a.durationMs != null ? fmtDuration(a.durationMs) : '未完成'}
                      </td>
                      <td className="py-1 text-red-600 max-w-[360px] break-all">
                        {a.error ? stripAnsi(a.error) : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {view && tab === 'network' && (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="py-1 pr-2">方法</th>
                  <th className="py-1 pr-2">URL</th>
                  <th className="py-1 pr-2">状态</th>
                  <th className="py-1">耗时</th>
                </tr>
              </thead>
              <tbody>
                {view.network.map((n, i) => (
                  <tr
                    key={i}
                    className={`border-b ${n.status && n.status >= 400 ? 'bg-red-50/60' : ''}`}
                  >
                    <td className="py-1 pr-2 font-mono">{n.method}</td>
                    <td className="py-1 pr-2 break-all text-gray-600">{n.url}</td>
                    <td className="py-1 pr-2">{n.status ?? '-'}</td>
                    <td className="py-1">{fmtDuration(n.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {view && tab === 'console' && (
            <div className="space-y-1 font-mono text-xs">
              {view.console.length === 0 && <div className="text-gray-400">（无控制台消息）</div>}
              {view.console.map((c, i) => (
                <div
                  key={i}
                  className={
                    c.level === 'error'
                      ? 'text-red-600'
                      : c.level === 'warning'
                        ? 'text-amber-600'
                        : 'text-gray-600'
                  }
                >
                  <span className="text-gray-400 mr-1">[{c.level}]</span>
                  {stripAnsi(c.text)}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
