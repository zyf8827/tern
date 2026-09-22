import type { SqlDb } from './sql-db.js';

export type EventBusListener = (env: {
  topic: string;
  event: { type: string; ts: string; payload: unknown };
  id?: number;
}) => void;

const PERSIST_TYPES = new Set([
  'batch.updated',
  'item.updated',
  'run.updated',
  'run.item.updated',
  'run.started',
  'run.finished',
  'execution.started',
  'execution.finished',
  'worker.updated',
  'sync.completed',
  'system.alert',
]);

/**
 * 事件总线：状态类事件持久化到 events 表并扇出给 app 订阅者；
 * 日志/步骤/帧只扇出不落库。
 */
export class EventBus {
  private listeners = new Set<EventBusListener>();

  constructor(private db: SqlDb) {}

  on(l: EventBusListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** emit 一个事件；persist=false 的事件（log/step/frame）只做实时扇出 */
  emit(topic: string, type: string, payload: unknown, persist = true): void {
    const ts = new Date().toISOString();
    let id: number | undefined;
    if (persist && PERSIST_TYPES.has(type)) {
      id = this.db.insertReturningId(
        'INSERT INTO events (ts, topic, type, payload) VALUES (?, ?, ?, ?)',
        ts, topic, type, JSON.stringify(payload ?? {})
      );
    }
    const env = { topic, event: { type, ts, payload }, id };
    for (const l of this.listeners) {
      try {
        l(env);
      } catch {
        // listener 异常不影响总线
      }
    }
  }
}
