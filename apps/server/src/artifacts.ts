import { createWriteStream, mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Runtime } from './runtime.js';

/** 校验产物相对路径，防路径穿越；返回安全的绝对路径（允许 Unicode 目录名） */
export function safeArtifactPath(
  rt: Runtime,
  batchId: string,
  runId: string,
  relName: string,
): string | null {
  const clean = path.normalize(relName).replace(/^[/\\]+/, '');
  if (!clean) return null;
  const segs = clean.split(/[/\\]/);
  for (const seg of segs) {
    if (seg === '..' || seg.startsWith('.') || seg.trim() === '') return null;
  }
  if (/[\0\r\n]/.test(clean)) return null;
  const dir = path.join(rt.cfg.artifactsDir, batchId, runId);
  const full = path.resolve(dir, clean);
  if (!full.startsWith(path.resolve(dir))) return null;
  return full;
}

/** 保存 worker 上传的单个产物文件（流式落盘）；日志类文件由 server 实时落盘，跳过 */
export async function saveArtifactStream(
  rt: Runtime,
  batchId: string,
  runId: string,
  relName: string,
  file: NodeJS.ReadableStream,
): Promise<void> {
  const target = safeArtifactPath(rt, batchId, runId, relName);
  if (!target) throw new Error(`非法的产物文件名: ${relName}`);
  const base = path.basename(relName);
  if (base === 'run.log' || base === 'events.jsonl') return;
  await mkdir(path.dirname(target), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(target);
    file.pipe(out);
    out.on('finish', () => resolve());
    out.on('error', reject);
    file.on('error', reject);
  });
}

export function ensureRunDir(rt: Runtime, batchId: string, runId: string): void {
  mkdirSync(path.join(rt.cfg.artifactsDir, batchId, runId), { recursive: true });
}
