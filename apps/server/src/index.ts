import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import pino from 'pino';
import { watch, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { EventBus } from './events.js';
import {
  discoverLocalProjectsInner,
  enqueue,
  projectDir,
  syncAllProjects,
  updateProjectRepo,
  updateProjectRepoInner,
  type ProjectRow,
} from './repos.js';
import { reviveRun, schedulerTick, type Runtime } from './runtime.js';
import { fireDueSchedules } from './schedules.js';
import { attachEventBus, handleAppConnection, handleWorkerConnection } from './ws.js';
import { registerApi } from './api.js';
import type { WebSocket } from 'ws';

const cfg = loadConfig();
const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { component: 'server' } });
const db = openDb(cfg.dataDir);
const events = new EventBus(db);

const rt: Runtime = {
  cfg,
  db,
  events,
  log,
  workers: new Map(),
  runs: new Map(),
  frames: new Map(),
  watchers: new Map(),
  pendingCancels: new Map(),
};

// ---- 启动恢复（§6.7）----
db.prepare(`UPDATE workers SET status='offline', current_run_id=NULL`).run();
db.prepare(
  `UPDATE batch_items SET status='pending', claimed_worker_id=NULL, lease_until=NULL WHERE status='claimed'`,
).run();
db.prepare(
  `UPDATE case_runs SET status='lost', finished_at=? WHERE status='running' AND id NOT IN (SELECT final_run_id FROM batch_items)`,
).run(new Date().toISOString());

const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
await app.register(websocket, { options: { maxPayload: 8 * 1024 * 1024 } });
await app.register(multipart, {
  limits: { fileSize: 100 * 1024 * 1024, files: 50 },
});

// registerApi placeholder

app.get('/ws/worker', { websocket: true }, (socket: WebSocket, req) => {
  const ip = req.ip ?? '';
  handleWorkerConnection(rt, socket, ip);
});

app.get('/ws/app', { websocket: true }, (socket: WebSocket, req) => {
  // Origin 校验：同源或白名单
  const origin = req.headers.origin;
  if (origin) {
    const allowed = cfg.appOrigins ?? [
      `http://localhost:${cfg.port}`,
      `http://127.0.0.1:${cfg.port}`,
    ];
    try {
      const o = new URL(origin);
      const sameHost = o.host === req.headers.host;
      if (!sameHost && !allowed.includes(origin)) {
        socket.close(4003, 'origin not allowed');
        return;
      }
    } catch {
      socket.close(4003, 'bad origin');
      return;
    }
  }
  handleAppConnection(rt, socket);
});

// 产物静态服务
await app.register(fastifyStatic, {
  root: cfg.artifactsDir,
  prefix: '/artifacts/',
  decorateReply: false,
  setHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Content-Options', 'nosniff');
  },
});

// F3：自托管 Playwright trace viewer。默认随 apps/web 构建内置（public/trace-viewer，
// 资源来自 playwright-core/lib/vite/traceViewer，见 apps/web/scripts/copy-trace-viewer.mjs）；
// TRACE_VIEWER_DIR 可覆盖为外部目录（docker 等场景），存在时以独立静态路由优先生效。
if (existsSync(path.join(cfg.traceViewerDir, 'index.html'))) {
  await app.register(fastifyStatic, {
    root: cfg.traceViewerDir,
    prefix: '/trace-viewer/',
    decorateReply: false,
  });
  log.info({ dir: cfg.traceViewerDir }, 'trace viewer enabled at /trace-viewer/');
} else {
  log.info('trace viewer 资源未安装（TRACE_VIEWER_DIR），trace 链接回退为下载');
}

// Web 管理端静态资源（apps/server/public，由 apps/web 构建输出）
const publicDir = path.resolve(import.meta.dirname ?? '.', '../public');
if (existsSync(publicDir)) {
  await app.register(fastifyStatic, {
    root: publicDir,
    decorateReply: true,
    wildcard: true, // 动态读盘：web 重新构建（资源 hash 变化）后无需重启 server；wildcard:false 只认启动时的文件
    setHeaders(res, pathname) {
      // index.html 禁缓存：发版后浏览器立即拿新入口（assets 带内容 hash，可被缓存）
      if (pathname === '/' || pathname.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  });
  // 根路径显式回 index.html（静态插件对目录请求的处理不可靠，见 / 500 问题）
  app.get('/', (_req, reply) => {
    reply.header('Cache-Control', 'no-cache');
    reply.type('text/html').send(readFileSync(path.join(publicDir, 'index.html')));
  });
  app.setNotFoundHandler((req, reply) => {
    if (
      req.url.startsWith('/api/') ||
      req.url.startsWith('/ws/') ||
      req.url.startsWith('/artifacts/') ||
      req.url.startsWith('/assets/')
    ) {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'not found' } });
      return;
    }
    if (existsSync(path.join(publicDir, 'index.html'))) {
      reply.header('Cache-Control', 'no-cache');
      reply.type('text/html').send(readFileSync(path.join(publicDir, 'index.html')));
      return;
    }
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'not found' } });
  });
}

// attachEventBus placeholder

// ---- 用例项目初始化：发现本地仓库 → git 项目拉取更新 + 全量同步 ----
// suppressWatch：平台自身的 git 操作（fetch/reset/clean）会触发 fs.watch，
// 误触发再同步形成回环；操作期间与结束后短窗口内忽略 watch 事件
let suppressWatchUntil = 0;
const suppressWatch = () => {
  suppressWatchUntil = Date.now() + 15_000;
};

suppressWatch();
void syncAllProjects(rt)
  .catch((e) => log.error({ err: (e as Error).message }, 'initial sync failed'))
  .finally(() => suppressWatch());

// fs.watch 自动同步（防抖 2s）：repos 目录内容变化 → 重新发现 + 重扫受影响项目
let watchTimer: NodeJS.Timeout | null = null;
function scheduleRescan(): void {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    if (Date.now() < suppressWatchUntil) return;
    suppressWatch();
    // 注意调用 *Inner 版本：本任务已在串行队列内，内部不能再 enqueue（会队列自等待死锁）
    void enqueue(async () => {
      await discoverLocalProjectsInner(rt);
      const rows = rt.db.prepare('SELECT * FROM projects WHERE enabled = 1').all() as ProjectRow[];
      for (const row of rows) {
        if (existsSync(projectDir(rt, row))) {
          await updateProjectRepoInner(rt, row.id).catch(() => {});
        }
      }
    }).finally(() => suppressWatch());
  }, 2000);
}
if (cfg.syncWatch) {
  try {
    watch(cfg.reposDir, { recursive: true }, (_event, filename) => {
      if (Date.now() < suppressWatchUntil) return;
      if (!filename) return scheduleRescan();
      const name = String(filename);
      if (
        name.includes('node_modules') ||
        path.basename(name).startsWith('.') ||
        name.includes('.incoming-')
      )
        return;
      scheduleRescan();
    });
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'fs.watch 不可用，仅手动/定时同步');
  }
}

// git 项目定期自动拉取（每 30s 检查一次到期项目）
setInterval(() => {
  const rows = rt.db
    .prepare(`SELECT * FROM projects WHERE source='git' AND enabled=1 AND pull_interval_sec > 0`)
    .all() as ProjectRow[];
  const now = Date.now();
  for (const row of rows) {
    const last = row.last_synced_at ? Date.parse(row.last_synced_at) : 0;
    if (Number.isFinite(last) && now - last >= row.pull_interval_sec * 1000) {
      suppressWatch();
      void updateProjectRepo(rt, row.id)
        .catch((e) =>
          log.warn({ err: (e as Error).message, project: row.name }, 'scheduled pull failed'),
        )
        .finally(() => suppressWatch());
    }
  }
}, 30_000).unref();

// 调度循环
setInterval(() => {
  try {
    // server 重启后：running 项若无 live run，懒恢复（进入孤儿宽限，等待 worker 重连）
    const orphanRuns = db
      .prepare(
        `SELECT r.id FROM case_runs r JOIN batch_items bi ON bi.id = r.batch_item_id
         WHERE r.status='running' AND bi.status='running'`,
      )
      .all() as { id: string }[];
    for (const r of orphanRuns) {
      if (!rt.runs.has(r.id)) reviveRun(rt, r.id);
    }
    // schedulerTick placeholder
  } catch (e) {
    log.error({ err: (e as Error).message }, 'scheduler tick failed');
  }
}, 300);

// F6：定时任务巡检（15s；错过补跑/防重叠逻辑见 schedules.ts）
setInterval(() => {
  try {
    // fireDueSchedules placeholder
  } catch (e) {
    log.error({ err: (e as Error).message }, 'schedule tick failed');
  }
}, 15_000).unref();

// 产物保留清理（每小时检查一次）
setInterval(() => {
  try {
    const cutoff = new Date(
      Date.now() - cfg.artifactRetentionDays * 24 * 3600 * 1000,
    ).toISOString();
    const batches = db
      .prepare(
        `SELECT id FROM batches WHERE finished_at IS NOT NULL AND finished_at < ? AND status IN ('completed','cancelled')`,
      )
      .all(cutoff) as { id: string }[];
    for (const b of batches) {
      const dir = path.join(cfg.artifactsDir, b.id);
      if (existsSync(dir)) {
        rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch {
    /* ignore */
  }
}, 3600 * 1000).unref();

await app.listen({ port: cfg.port, host: cfg.host });
log.info(
  { port: cfg.port, reposDir: cfg.reposDir, dataDir: cfg.dataDir },
  `tern server v${cfg.version} listening`,
);
