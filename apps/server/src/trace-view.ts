// F3 修订：trace 在线查看的非 SW 依赖方案。
// Playwright 官方 viewer 依赖 Service Worker（仅 HTTPS/localhost 可用），经 http://<IP>
// 访问平台时必然报 "Service workers are not supported"。此处服务端解包 trace.zip 并
// 解析 NDJSON（动作时间线/胶片帧/控制台/网络），供 Web 轻量查看页渲染，零安全上下文要求。
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

// ---- 最小 ZIP 读取器（store + deflate；Playwright trace.zip 即这两种） ----

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

function readCentralDirectory(buf: Buffer): ZipEntry[] {
  // 从尾部找 EOCD（0x06054b50），最多扫最后 64KB
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP EOCD 未找到（不是合法 zip）');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error(`ZIP 中央目录损坏 @${offset}`);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compressedSize, size, localHeaderOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function entryData(buf: Buffer, e: ZipEntry): Buffer {
  const lho = e.localHeaderOffset;
  if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`ZIP 本地头损坏 @${lho}`);
  const nameLen = buf.readUInt16LE(lho + 26);
  const extraLen = buf.readUInt16LE(lho + 28);
  const start = lho + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compressedSize);
  return e.method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
}

/** 解压 zip 到 destDir（路径安全：拒绝绝对路径与 ..；已存在则跳过） */
export function unzipToDir(zipPath: string, destDir: string): void {
  if (existsSync(destDir)) return;
  const buf = readFileSync(zipPath);
  const entries = readCentralDirectory(buf);
  mkdirSync(destDir, { recursive: true });
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;
    const rel = path.normalize(e.name).replace(/^([/\\])+/, '');
    if (rel.split(path.sep).includes('..')) continue; // zip 路径穿越防护
    const out = path.join(destDir, rel);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, entryData(buf, e));
  }
}

// ---- trace NDJSON 解析 ----

export interface TraceAction {
  callId: string;
  title: string;
  parentId?: string;
  startMs: number | null; // 相对首事件的墙钟偏移
  durationMs: number | null; // null = 未完成（超时被杀的动作）
  error: string | null;
  params: string; // 摘要字符串
}

export interface TraceConsoleEntry {
  level: string;
  text: string;
  url: string;
}

export interface TraceFrame {
  url: string; // 资源相对 URL（/artifacts/.../trace-extracted/resources/<sha1>）
  width: number;
  height: number;
  wallTime: number;
}

export interface TraceNetworkEntry {
  method: string;
  url: string;
  status: number | null;
  durationMs: number | null;
}

export interface TraceView {
  actions: TraceAction[];
  console: TraceConsoleEntry[];
  frames: TraceFrame[];
  network: TraceNetworkEntry[];
  /**NDJSON 里出现的未知 type 计数（排障用） */
  ignoredTypes: Record<string, number>;
}

function paramsSummary(params: Record<string, unknown> | undefined): string {
  if (!params || Object.keys(params).length === 0) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}=${s.length > 80 ? `${s.slice(0, 80)}…` : s}`);
  }
  return parts.join(' ').slice(0, 200);
}

/** 解析目录下 *trace.trace / *trace.network（取同后缀中最大的文件；runner/test 两份自动合并） */
export function parseTraceDir(dir: string, resourceBase: string): TraceView {
  const pickLargest = (suffix: string): string | null => {
    const files = readdirSync(dir).filter((f) => f.endsWith(suffix));
    if (files.length === 0) return null;
    return files
      .map((f) => ({ f, size: statSync(path.join(dir, f)).size }))
      .sort((a, b) => b.size - a.size)[0].f;
  };

  const byCall = new Map<string, TraceAction & { startMono: number | null }>();
  const consoleEntries: TraceConsoleEntry[] = [];
  const frames: TraceFrame[] = [];
  const ignoredTypes: Record<string, number> = {};
  let minMono = Number.POSITIVE_INFINITY;

  const traceFile = pickLargest('trace.trace');
  // test.trace（testRunner 侧步骤树）与浏览器 trace 合并解析
  const traceFiles = traceFile
    ? readdirSync(dir)
        .filter((f) => f.endsWith('trace.trace'))
        .map((f) => path.join(dir, f))
    : [];
  for (const file of traceFiles) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = String(e.type ?? '');
      if (type === 'before') {
        const callId = String(e.callId);
        const startMono = Number(e.startTime ?? 0);
        minMono = Math.min(minMono, startMono);
        byCall.set(callId, {
          callId,
          title: String(e.title ?? `${e.class ?? ''}.${e.method ?? ''}`),
          parentId: e.parentId ? String(e.parentId) : undefined,
          startMono,
          startMs: null,
          durationMs: null,
          error: null,
          params: paramsSummary(e.params as Record<string, unknown> | undefined),
        });
      } else if (type === 'after') {
        const a = byCall.get(String(e.callId));
        if (a) {
          const endMono = Number(e.endTime ?? 0);
          a.durationMs = Math.max(0, Math.round((endMono - (a.startMono ?? endMono)) * 1000));
          const err = e.error as { message?: string } | undefined;
          a.error = err?.message
            ? String(err.message)
                .replace(/\[[0-9;]*m/g, '')
                .slice(0, 500)
            : null;
        }
      } else if (type === 'screencast-frame') {
        if (frames.length < 600) {
          frames.push({
            url: `${resourceBase}/resources/${e.sha1}`,
            width: Number(e.width ?? 0),
            height: Number(e.height ?? 0),
            wallTime: Number(e.frameSwapWallTime ?? 0),
          });
        }
      } else if (type === 'console') {
        if (consoleEntries.length < 300) {
          consoleEntries.push({
            level: String(e.messageType ?? 'log'),
            text: String(e.text ?? '').slice(0, 300),
            url: String((e.location as { url?: string } | undefined)?.url ?? '').slice(0, 160),
          });
        }
      } else if (
        type !== 'log' &&
        type !== 'event' &&
        type !== 'frame-snapshot' &&
        type !== 'input' &&
        type !== 'context-options'
      ) {
        ignoredTypes[type] = (ignoredTypes[type] ?? 0) + 1;
      }
    }
  }

  const t0 = Number.isFinite(minMono) ? minMono : 0;
  const actions = [...byCall.values()]
    .map(({ startMono, ...a }) => ({ ...a, startMs: Math.round((startMono ?? t0) - t0) }))
    .sort((x, y) => (x.startMs ?? 0) - (y.startMs ?? 0));

  const network: TraceNetworkEntry[] = [];
  const netFile = pickLargest('trace.network');
  if (netFile) {
    for (const line of readFileSync(path.join(dir, netFile), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e: {
        snapshot?: {
          request?: { method?: string; url?: string };
          response?: { status?: number };
          time?: number;
        };
      };
      try {
        e = JSON.parse(line) as typeof e;
      } catch {
        continue;
      }
      const s = e.snapshot;
      if (!s?.request?.url) continue;
      if (network.length < 500) {
        network.push({
          method: s.request.method ?? 'GET',
          url: s.request.url.slice(0, 300),
          status: s.response?.status ?? null,
          durationMs: s.time != null ? Math.round(s.time) : null,
        });
      }
    }
  }

  return { actions, console: consoleEntries, frames, network, ignoredTypes };
}
