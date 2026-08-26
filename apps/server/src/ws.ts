import type { Runtime } from './runtime.js';
import {
  handleAccept,
  handleHello,
  handleReject,
  handleResult,
  handleRunEvent,
  markWorkerOffline,
} from './runtime.js';
import type { WebSocket } from 'ws';
import type {
  ResultMsg,
  RunEvent,
  RunEventMsg,
  ServerMsg,
  SubscribeMsg,
  WorkerMsg,
} from '@tern/sdk';

const appSubs = new Map<WebSocket, Set<string>>();

export function attachEventBus(rt: Runtime): void {
  rt.events.on((env) => {
    // 协议约定：{ type: 'event', topic, event: { type, ts, payload }, id? }
    const msg = JSON.stringify({ type: 'event', ...env });
    for (const [socket, topics] of appSubs) {
      if (topics.has(env.topic)) {
        try {
          socket.send(msg);
        } catch {
          /* ignore */
        }
      }
    }
  });
}

function sendToWorker(rt: Runtime, workerId: string, msg: ServerMsg): boolean {
  const conn = rt.workers.get(workerId);
  if (!conn?.socket) return false;
  try {
    conn.socket.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

function adjustWatchers(rt: Runtime, runId: string, delta: number): void {
  const before = rt.watchers.get(runId) ?? 0;
  const after = Math.max(0, before + delta);
  rt.watchers.set(runId, after);
  const run = rt.runs.get(runId);
  if (!run) return;
  if (before === 0 && after === 1) {
    sendToWorker(rt, run.workerId, { type: 'screencast_on', runId });
  } else if (before >= 1 && after === 0) {
    sendToWorker(rt, run.workerId, { type: 'screencast_off', runId });
  }
}

export function handleWorkerConnection(rt: Runtime, socket: WebSocket, ip: string): void {
  let authed = false;
  let workerId: string | null = null;
  let lastRunId: string | undefined;

  socket.on('message', (raw: Buffer) => {
    let msg: WorkerMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!authed) {
      if (msg.type !== 'hello') return;
      authed = true;
      workerId = null;
      handleHello(rt, socket, ip, msg);
      // handleHello 设置了 worker 连接，取回 id
      for (const conn of rt.workers.values()) {
        if (conn.socket === socket) workerId = conn.id;
      }
      if (workerId) {
        lastRunId = msg.lastRunId;
      }
      return;
    }
    if (!workerId) return;
    switch (msg.type) {
      case 'heartbeat': {
        const conn = rt.workers.get(workerId);
        if (conn) conn.lastSeen = Date.now();
        rt.db
          .prepare(
            `UPDATE workers SET last_heartbeat_at=?, status=CASE WHEN ? IS NOT NULL THEN 'busy' ELSE status END WHERE id=?`,
          )
          .run(new Date().toISOString(), msg.currentRunId ?? null, workerId);
        break;
      }
      case 'accept':
        handleAccept(rt, workerId, msg.runId, msg.runToken);
        break;
      case 'reject':
        handleReject(rt, workerId, msg.runId, msg.runToken);
        break;
      case 'run_event': {
        const m = msg as RunEventMsg;
        handleRunEvent(rt, m.runId, m.runToken, m.event);
        break;
      }
      case 'result':
        handleResult(rt, workerId, msg as ResultMsg);
        break;
      default:
        break;
    }
  });

  socket.on('close', () => {
    if (authed && workerId) {
      const conn = rt.workers.get(workerId);
      // 仅当 socket 仍是当前连接时标记下线（被替换时不触发）
      if (conn && conn.socket === socket) {
        markWorkerOffline(rt, workerId);
        void lastRunId;
      }
    }
  });
}

export function handleAppConnection(rt: Runtime, socket: WebSocket): void {
  const topics = new Set<string>();
  appSubs.set(socket, topics);

  socket.on('message', (raw: Buffer) => {
    let msg: SubscribeMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'subscribe') {
      const added: string[] = [];
      for (const t of msg.topics ?? []) {
        if (!topics.has(t)) {
          topics.add(t);
          added.push(t);
          if (t.startsWith('execution:')) {
            adjustWatchers(rt, t.slice(10), +1);
            // 补发每屏最新帧，观战者秒见画面而不用等下一帧
            const frames = rt.frames.get(t.slice(10));
            if (frames) {
              for (const [screen, f] of frames) {
                socket.send(
                  JSON.stringify({
                    type: 'event',
                    topic: t,
                    event: {
                      type: 'execution.frame',
                      ts: new Date(f.ts).toISOString(),
                      payload: { data: f.data, screen, screenLabel: f.label },
                    },
                  }),
                );
              }
            }
          }
        }
      }
      if (added.length > 0) {
        socket.send(JSON.stringify({ type: 'subscribed', topics: added }));
      }
    } else if (msg.type === 'unsubscribe') {
      for (const t of msg.topics ?? []) {
        if (topics.delete(t) && t.startsWith('execution:')) {
          adjustWatchers(rt, t.slice(10), -1);
        }
      }
    }
  });

  socket.on('close', () => {
    for (const t of topics) {
      if (t.startsWith('execution:')) adjustWatchers(rt, t.slice(10), -1);
    }
    appSubs.delete(socket);
  });
}
