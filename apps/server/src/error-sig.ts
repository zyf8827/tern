// 错误签名（docs/platform-enhancements.md §F4）：
// 归一化错误首行（数字/UUID/时长 → #，压缩空白，小写，截断 160）后 sha1。
// 用于失败聚类与跨 run「同一失败」识别；只看 message，不看 stack（stack 路径噪音大）。
import { createHash } from 'node:crypto';

export interface ErrorLike {
  name?: string;
  message?: string;
}

/** 归一化错误首行（导出供摘要展示 label 复用） */
export function normalizeErrorLine(message: string): string {
  let s = message.split('\n')[0] ?? '';
  s = s.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '#'); // 时间戳
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '#'); // UUID
  s = s.replace(/\d+(\.\d+)?\s*(ms|s\b|sec|seconds)/gi, '#'); // 时长
  s = s.replace(/\d+/g, '#'); // 其余数字（端口/行号/计数）
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();
  if (s.length > 160) s = s.slice(0, 160);
  return s;
}

/** 计算错误签名；无 message 时用状态兜底（如 lost/cancelled） */
export function errorSignature(
  error: ErrorLike | null | undefined,
  status?: string,
): string | null {
  const msg = error?.message?.trim();
  if (!msg) return status ? `status:${status}` : null;
  return `sha1:${createHash('sha1').update(normalizeErrorLine(msg)).digest('hex')}`;
}
