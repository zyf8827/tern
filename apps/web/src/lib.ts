// Web 端 API / WS 工具（fetch + 原生 WebSocket）

/** 剥离 ANSI 颜色转义序列（旧数据入库时未清洗，展示前兜底） */
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/** 展示用短 ID：保留类型前缀 + ULID 前 8 位（b_01M2VT6N / r_01M2W712C / w_01M2VQAY） */
export function shortId(id: string | null | undefined, keep = 8): string {
  if (!id) return '';
  const m = id.match(/^([a-z]+)_([0-9A-Za-z]+)$/);
  return m ? `${m[1]}_${m[2].slice(0, keep)}` : id;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const err = json?.error as { message?: string } | undefined;
    throw new Error(err?.message ?? `HTTP ${res.status}`);
  }
  return json as T;
}

export function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws/app`;
}

/** 订阅 -推送 WS 连接；返回 unsubscribe 句柄 */
export interface LiveHandle {
  close: () => void;
}

export function connectLive(
  onEvent: (topic: string, type: string, payload: unknown) => void,
  topics: () => string[],
): LiveHandle {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  function open() {
    if (closed) return;
    ws = new WebSocket(wsUrl());
    ws.addEventListener('open', () => {
      const t = topics();
      if (t.length) ws!.send(JSON.stringify({ type: 'subscribe', topics: t }));
    });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === 'event') onEvent(msg.topic, msg.event.type, msg.event.payload);
      } catch {
        /* ignore */
      }
    });
    ws.addEventListener('close', () => {
      if (!closed) retry = setTimeout(open, 2000);
    });
    ws.addEventListener('error', () => ws?.close());
  }
  open();

  return {
    close() {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    },
  };
}

// ---- 状态徽章配色 ----
export const STATUS_STYLE: Record<string, string> = {
  passed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  timed_out: 'bg-orange-100 text-orange-800',
  error: 'bg-purple-100 text-purple-800',
  skipped: 'bg-gray-100 text-gray-600',
  cancelled: 'bg-gray-100 text-gray-600',
  lost: 'bg-red-100 text-red-700',
  running: 'bg-blue-100 text-blue-800 animate-pulse',
  claimed: 'bg-blue-50 text-blue-700',
  pending: 'bg-yellow-50 text-yellow-700',
  completed: 'bg-green-100 text-green-800',
  active: 'bg-green-50 text-green-700',
  invalid: 'bg-red-50 text-red-700',
  deleted: 'bg-gray-100 text-gray-400',
  disabled: 'bg-gray-100 text-gray-500',
  online: 'bg-green-100 text-green-800',
  offline: 'bg-gray-100 text-gray-500',
};

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}秒`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m}分${rs}秒`;
  return `${Math.floor(m / 60)}时${m % 60}分${rs}秒`;
}

/** 展示时间统一按东八区（UTC+8）格式化：入库统一 UTC ISO；东八区无夏令时，固定 +8 即可 */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const ms = Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(ms)) return iso.replace('T', ' ');
  return new Date(ms + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
}
