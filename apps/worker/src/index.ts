import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import pino from 'pino';
import {
  TernClient,
  type AssignTask,
  type AuthSpec,
  type RunArtifacts,
  type RunEvent,
  type ServerMsg,
  type WorkerMsg,
} from '@tern/sdk';
// exec-kit runner placeholder
function runCase(): any { throw new Error('stub'); }
// device-proxy placeholder

const workerDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function env(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}
function envInt(name: string, def: number): number {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : def;
}

const cfg = {
  serverUrl: env('SERVER_URL', 'http://127.0.0.1:7430').replace(/\/$/, ''),
  token: env('WORKER_TOKEN', ''),
  name: env('WORKER_NAME', hostname()),
  maxSlots: envInt('MAX_SLOTS', 1),
  heartbeatMs: envInt('HEARTBEAT_MS', 10000),
  runsDir: path.resolve(env('RUNS_DIR', path.join(workerDir, '../.runs'))),
  hardTimeoutS: envInt('CASE_HARD_TIMEOUT_S', 600),
  artifactMode: env('ARTIFACT_MODE', 'upload'),
  version: '0.1.0',
};

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { component: 'worker', name: cfg.name },
});

interface ActiveRun {
  task: AssignTask;
  /** auth 阶段尚未启动 runner 时为 null */
  handle: ReturnType<typeof runCase> | null;
  sidecar: ScreencastSidecar | null;
  /** server 请求了实时画面（可能早于 runner 启动，就绪后补开） */
  screencastRequested: boolean;
  /** server 已取消该 run（cancel 报文可能在 pre-run/登录任一时刻到达） */
  cancelled: boolean;
  /** 取消信号：pre-run 阶段的 await 与其竞争，取消先行时立刻收敛、不再启动 runner */
  cancelRace: Promise<typeof CANCELLED>;
  resolveCancel: (value: typeof CANCELLED) => void;
}

const CANCELLED = 'cancelled' as const;

/** pre-run 阶段的取消竞争：强制结束报文在 await 期间到达时先行返回 CANCELLED */
function raceCancel<T>(entry: ActiveRun, p: Promise<T>): Promise<T | typeof CANCELLED> {
  return Promise.race([p, entry.cancelRace]);
}

class Worker {
  closed = false;
  private ws: WebSocket | null = null;
  private client = new TernClient({ baseUrl: cfg.serverUrl });
  private activeRuns = new Map<string, ActiveRun>();
  /** F9：设备反向代理（http 非安全 origin → 本机 127.0.0.1，HTTP+WS 透传） */
  private deviceProxy = new DeviceProxyManager();
  /** 会话缓存：缓存键 → storageState 文件（docs/auth-design.md §7，默认 worker 本 run 内复用） */
  private sessionCache = new Map<string, string>();
  /** 进行中的登录（同键并发派发时只登一次） */
  private pendingAuth = new Map<string, Promise<string>>();
  private authCacheDir = path.join(tmpdir(), 'tern-auth');
  private backoff = 1000;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatIntervalMs = cfg.heartbeatMs;
  private cliPath: string;
  private nodeModulesDir: string;
  private pwVersion: string;

  constructor() {
    if (!cfg.token) throw new Error('WORKER_TOKEN 未配置');
    this.cliPath = playwrightCliPathOf(import.meta.url);
    const testPkgDir = path.dirname(require.resolve('@playwright/test/package.json'));
    this.nodeModulesDir = path.resolve(testPkgDir, '../..');
    this.pwVersion = this.readPlaywrightVersion();
    mkdirSync(path.join(cfg.runsDir, 'bundles'), { recursive: true });
    mkdirSync(this.authCacheDir, { recursive: true });
  }

  private readPlaywrightVersion(): string {
    try {
      const pkgPath = require.resolve('@playwright/test/package.json');
      return JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  start(): void {
    log.info({ server: cfg.serverUrl, playwright: this.pwVersion }, 'worker starting');
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(
      `${cfg.serverUrl.replace(/^http/, 'ws')}/ws/worker?token=${encodeURIComponent(cfg.token)}`,
    );
    this.ws = ws;
    const lastRunId = this.pendingReattach();
    let reconnectScheduled = false;
    const scheduleReconnect = () => {
      if (reconnectScheduled || this.closed) return;
      reconnectScheduled = true;
      this.stopHeartbeat();
      this.ws = null;
      log.warn({ backoffMs: this.backoff }, 'connection lost; reconnecting');
      // 断线期间本地继续执行当前用例，事件随 run_event 在重连后继续回传
      setTimeout(() => {
        reconnectScheduled = false;
        this.connect();
      }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15000);
    };

    ws.addEventListener('open', () => {
      this.backoff = 1000;
      log.info('connected to server');
      this.send({
        type: 'hello',
        name: cfg.name,
        version: cfg.version,
        playwrightVersion: this.pwVersion,
        capabilities: { browsers: ['chromium'], maxSlots: cfg.maxSlots },
        lastRunId: lastRunId,
      });
      this.startHeartbeat();
    });

    ws.addEventListener('message', (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'hello_ack' && msg.heartbeatIntervalMs > 0) {
        // 以 server 下发的间隔为准
        this.heartbeatIntervalMs = msg.heartbeatIntervalMs;
        this.startHeartbeat();
      }
      void this.handleServerMsg(msg);
    });

    ws.addEventListener('close', scheduleReconnect);
    // undici WebSocket 连接失败只触发 error 不触发 close；
    // 此处不能调用 ws.close()（会再次触发 error 造成递归），只安排重连
    ws.addEventListener('error', () => scheduleReconnect());
  }

  private pendingReattach(): string | undefined {
    for (const runId of this.activeRuns.keys()) return runId;
    return undefined;
  }

  private send(msg: WorkerMsg): void {
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch {
      /* 断线时静默；结果会在下轮补发失败后由 server 兜底 */
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const currentRunId = this.activeRuns.size ? [...this.activeRuns.keys()][0] : undefined;
      this.send({
        type: 'heartbeat',
        status: this.activeRuns.size ? 'busy' : 'idle',
        currentRunId: currentRunId,
      });
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private async handleServerMsg(msg: ServerMsg): Promise<void> {
    switch (msg.type) {
      case 'hello_ack':
        log.info({ workerId: msg.workerId }, 'registered');
        break;
      case 'hello_reject':
        log.error({ reason: msg.reason }, 'server rejected registration; exiting');
        process.exit(1);
        break;
      case 'assign':
        void this.handleAssign(msg.run);
        break;
      case 'cancel': {
        const run = this.activeRuns.get(msg.runId);
        if (run) {
          log.info({ runId: msg.runId }, 'cancel requested');
          run.cancelled = true;
          // pre-run/auth 阶段的 await 可能还在进行：释放竞争信号让它立刻收敛
          run.resolveCancel(CANCELLED);
          run.handle?.cancel();
        }
        break;
      }
      case 'screencast_on': {
        const run = this.activeRuns.get(msg.runId);
        if (run) {
          run.screencastRequested = true;
          void this.maybeStartScreencast(run);
        }
        break;
      }
      case 'screencast_off': {
        const run = this.activeRuns.get(msg.runId);
        if (run) {
          run.screencastRequested = false;
          run.sidecar?.stop();
          run.sidecar = null;
        }
        break;
      }
      default:
        break;
    }
  }

  /** 有观战者时开启 CDP screencast；cdpPort 在 runner 异步启动后才分配，轮询等待 */
  private async maybeStartScreencast(run: ActiveRun): Promise<void> {
    if (run.sidecar || !run.screencastRequested || !run.handle) return;
    for (let i = 0; i < 75; i++) {
      if (!run.screencastRequested || run.sidecar) return;
      const port = run.handle.cdpPort;
      if (port > 0) {
        try {
          run.sidecar = await ScreencastSidecar.start(port, (data, screen, screenLabel) => {
            this.emitRunEvent(
              run.task.runId,
              run.task.runToken,
              frameEvent(data, screen, screenLabel),
            );
          });
          log.info({ runId: run.task.runId, cdpPort: port }, 'screencast started');
        } catch (e) {
          log.warn({ err: (e as Error).message, runId: run.task.runId }, 'screencast start failed');
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  private emitRunEvent(runId: string, runToken: string, event: RunEvent): void {
    this.send({ type: 'run_event', runId: runId, runToken: runToken, event: event });
  }

  // ---------- 任务执行 ----------

  /** F9：关闭全部本机设备代理（worker 退出时调用） */
  closeDeviceProxies(): Promise<void> {
    return this.deviceProxy.closeAll();
  }

  private async handleAssign(task: AssignTask): Promise<void> {
    if (this.activeRuns.has(task.runId) || this.activeRuns.size >= cfg.maxSlots) {
      this.send({ type: 'reject', runId: task.runId, runToken: task.runToken, reason: 'busy' });
      return;
    }
    log.info(
      { runId: task.runId, case: task.case.caseId, attempt: task.case.attempt },
      'accepted task',
    );
    this.send({ type: 'accept', runId: task.runId, runToken: task.runToken });
    let resolveCancel!: (value: typeof CANCELLED) => void;
    const cancelRace = new Promise<typeof CANCELLED>((resolve) => {
      resolveCancel = resolve;
    });
    // 立即占位：screencast_on 可能早于 runner 启动到达（auth 阶段）
    const entry: ActiveRun = {
      task,
      handle: null,
      sidecar: null,
      screencastRequested: false,
      cancelled: false,
      cancelRace,
      resolveCancel,
    };
    this.activeRuns.set(task.runId, entry);

    // runRoot 放系统临时目录（playwright 忽略 gitignore 路径，不能放仓库内）
    const runRoot = path.join(tmpdir(), 'tern-runs', task.runId);
    mkdirSync(runRoot, { recursive: true });
    let handle: ReturnType<typeof runCase>;
    try {
      // F9：设备反向代理——重写运行参数中的 http 非安全 origin 到本机 127.0.0.1 代理
      // （auth 登录与页面同源走代理，cookie 域自然一致；对用例/环境配置透明）
      let runParams = task.params;
      // pre-run 各阶段与取消竞争：强制结束报文到达后立刻收敛，不再做下载/登录/启动的无用功
      const proxyApplied = await raceCancel(
        entry,
        rewriteInsecureParams(task.params, task.deviceProxy ?? 'auto', (origin) =>
          this.deviceProxy.acquire(origin),
        ),
      );
      if (proxyApplied === CANCELLED) return this.abandonRun(task.runId, entry, runRoot);
      runParams = proxyApplied.params;
      if (proxyApplied.applied.length > 0) {
        for (const a of proxyApplied.applied) {
          this.emitRunEvent(task.runId, task.runToken, {
            type: 'log',
            ts: new Date().toISOString(),
            level: 'info',
            text: `设备代理: ${a.key} ${a.to} -> ${a.from}（HTTP+WS 透传，secure context）`,
          });
        }
        log.info({ runId: task.runId, applied: proxyApplied.applied }, 'device proxy applied');
      }
      const bundleCode = await raceCancel(
        entry,
        this.ensureBundle(task.case.bundleHash, task.case.bundleUrl),
      );
      if (bundleCode === CANCELLED) return this.abandonRun(task.runId, entry, runRoot);
      // F8：随行资产下载（hash 缓存）→ 相对路径 → 本地绝对路径映射
      const assetsMap: Record<string, string> = {};
      for (const a of task.assets ?? []) {
        const local = await raceCancel(entry, this.ensureAsset(a.hash, a.url));
        if (local === CANCELLED) return this.abandonRun(task.runId, entry, runRoot);
        assetsMap[a.path] = local;
      }
      // 设备输入：fake mic/camera 文件解析到本地（无文件仅启用 fake 设备）
      const dev = task.case.devices;
      let devices: {
        micFile?: string | null;
        cameraFile?: string | null;
        enable?: boolean;
      } | null = null;
      if (dev) {
        if (Array.isArray(dev)) {
          devices = { enable: true };
        } else {
          devices = {
            enable: true,
            micFile: dev.mic ? (assetsMap[dev.mic] ?? null) : null,
            cameraFile: dev.camera ? (assetsMap[dev.camera] ?? null) : null,
          };
        }
      }
      // 用例需要登录态 → 先建立/复用会话（storageState），再进入执行
      let authStatePath: string | null = null;
      if (task.case.auth) {
        try {
          const state = await raceCancel(
            entry,
            this.ensureAuthSession(task, runParams, runRoot, path.join(runRoot, 'auth-artifacts')),
          );
          if (state === CANCELLED) return this.abandonRun(task.runId, entry, runRoot);
          authStatePath = state;
        } catch (e) {
          const msg = e instanceof AuthError ? e.message : `登录流程失败: ${(e as Error).message}`;
          log.error({ err: msg, runId: task.runId }, 'auth failed');
          // 登录失败产物（form 模式截图/trace）挂到该 execution；不伪装成断言失败
          const artifacts = await this.uploadArtifacts(
            task,
            path.join(runRoot, 'auth-artifacts'),
          ).catch(() => null);
          this.activeRuns.delete(task.runId);
          await rm(runRoot, { recursive: true, force: true }).catch(() => {});
          this.send({
            type: 'result',
            runId: task.runId,
            runToken: task.runToken,
            status: 'error',
            error: { name: 'AuthError', message: msg },
            artifacts: artifacts ?? undefined,
          });
          return;
        }
      }
      if (entry.cancelled) return this.abandonRun(task.runId, entry, runRoot);
      handle = runCase({
        runRoot: runRoot,
        bundleCode: bundleCode,
        timeoutS: task.case.timeoutS,
        retries: task.case.retries,
        options: task.options,
        params: runParams,
        devices,
        assetsMap,
        hardTimeoutS: cfg.hardTimeoutS,
        playwrightCliPath: this.cliPath,
        nodeModulesDir: this.nodeModulesDir,
        authStatePath,
        onEvent: (ev) => this.emitRunEvent(task.runId, task.runToken, ev),
      });
      entry.handle = handle;
      if (entry.screencastRequested) void this.maybeStartScreencast(entry);
    } catch (e) {
      log.error({ err: (e as Error).message, runId: task.runId }, 'pre-run error');
      this.activeRuns.delete(task.runId);
      this.send({
        type: 'result',
        runId: task.runId,
        runToken: task.runToken,
        status: 'error',
        error: { name: 'PreRunError', message: (e as Error).message },
      });
      return;
    }

    const result = await handle.promise;
    const running = this.activeRuns.get(task.runId);
    running?.sidecar?.stop();

    const artifacts = await this.uploadArtifacts(task, result.resultsDir);
    await rm(runRoot, { recursive: true, force: true }).catch(() => {});

    this.activeRuns.delete(task.runId);
    this.send({
      type: 'result',
      runId: task.runId,
      runToken: task.runToken,
      status: result.status,
      flaky: result.flaky,
      durationMs: result.durationMs,
      error: result.error,
      artifacts: artifacts,
    });
    log.info(
      { runId: task.runId, status: result.status, durationMs: result.durationMs },
      'run finished',
    );
    void this.client;
  }

  /**
   * 强制结束的收敛：停 screencast、摘 activeRuns、删临时目录。
   * 不回传结果——server 侧该 case_runs 已置 cancelled，迟到报文会被拒（见 handleResult）。
   */
  private abandonRun(runId: string, entry: ActiveRun, runRoot: string): void {
    entry.sidecar?.stop();
    this.activeRuns.delete(runId);
    void rm(runRoot, { recursive: true, force: true }).catch(() => {});
    log.info({ runId }, 'run abandoned before start (force-cancelled)');
  }

  /** auth 日志走 run 事件流（写入 run.log 并实时展示） */
  private authLog(task: AssignTask): (text: string) => void {
    return (text) =>
      this.emitRunEvent(task.runId, task.runToken, {
        type: 'log',
        ts: new Date().toISOString(),
        level: 'info',
        text,
      });
  }

  /**
   * 建立或复用登录会话，返回 storageState 路径（docs/auth-design.md §7）。
   * 缓存键 = run + 配方（含解析后的凭据哈希）+ BASE_URL：换 CLIENT_ID / token 会自然 miss。
   * 命中缓存先 validate（如配置）；失效按原配方重登一次。reuse=never 每条用例独立登录。
   */
  private async ensureAuthSession(
    task: AssignTask,
    params: Record<string, string>,
    runRoot: string,
    artifactsDir: string,
  ): Promise<string> {
    const spec: AuthSpec = task.case.auth!;
    const recipe = spec.recipe;
    // F9：使用（可能经设备代理重写后的）运行参数——登录与页面同源，cookie 域一致
    const baseUrl = params.BASE_URL ?? process.env.BASE_URL;
    const log = this.authLog(task);
    // worker 是唯一展开 ${ENV:} 的地方（运行参数 ∪ worker 环境）
    const env: Record<string, string | undefined> = { ...process.env, ...params };
    const resolved = replaceEnvPlaceholders(recipe, env);
    const reuse = recipe.reuse === 'run' ? 'worker' : (recipe.reuse ?? 'worker'); // v1: run 级共享暂按 worker 复用
    const key = createHash('sha256')
      .update(JSON.stringify({ runId: task.testRunId, baseUrl, recipe: resolved }))
      .digest('hex');
    const login = (statePath: string): Promise<string> =>
      resolveAuthState(resolved, {
        baseUrl,
        env: params,
        statePath,
        headless: process.env.TERN_HEADLESS !== 'false',
        artifactsDir,
        log,
      });

    if (reuse === 'worker') {
      const cached = this.sessionCache.get(key);
      if (cached && existsSync(cached)) {
        const ok = await validateAuthState(resolved, cached, { baseUrl, env: params, log });
        if (ok) {
          log(`auth: 复用会话缓存（账号 ${spec.account ?? 'default'}，key ${key.slice(0, 8)}）`);
          return cached;
        }
        log('auth: 会话已失效，按原配方重新登录');
      } else if (cached) {
        this.sessionCache.delete(key);
      }
      const inflight = this.pendingAuth.get(key);
      if (inflight) return inflight;
      const statePath = path.join(this.authCacheDir, `${key}.json`);
      const p = login(statePath)
        .then((p2) => {
          this.sessionCache.set(key, statePath);
          return p2;
        })
        .finally(() => this.pendingAuth.delete(key));
      this.pendingAuth.set(key, p);
      return p;
    }
    // reuse=never：每条用例独立登录，不进缓存
    return login(path.join(runRoot, 'auth-state.json'));
  }

  /** 按 hash 缓存下载 bundle */
  /** F8：测试资产按 hash 下载缓存（同 bundle 模式；返回本地绝对路径） */
  private async ensureAsset(hash: string, urlPath: string): Promise<string> {
    const cachePath = path.join(cfg.runsDir, 'assets', hash);
    if (existsSync(cachePath)) return cachePath;
    const res = await fetch(`${cfg.serverUrl}${urlPath}`, {
      headers: { 'x-worker-token': cfg.token },
    });
    if (!res.ok) throw new Error(`资产下载失败: HTTP ${res.status}（${hash.slice(0, 12)}…）`);
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, buf);
    return cachePath;
  }

  private async ensureBundle(hash: string, urlPath: string): Promise<string> {
    const cachePath = path.join(cfg.runsDir, 'bundles', `${hash}.cjs`);
    if (existsSync(cachePath)) return readFileSync(cachePath, 'utf8');
    const res = await fetch(`${cfg.serverUrl}${urlPath}`, {
      headers: { 'x-worker-token': cfg.token },
    });
    if (!res.ok) throw new Error(`bundle 下载失败: HTTP ${res.status}`);
    const code = await res.text();
    writeFileSync(cachePath, code);
    return code;
  }

  /** 收集目录下产物并上传；目录为空时返回 null（auth 失败路径可能无产物） */
  private async uploadArtifacts(
    task: AssignTask,
    resultsDir: string,
  ): Promise<RunArtifacts | null> {
    const artifacts: RunArtifacts = { screenshots: [], videos: [], attachments: [], missing: [] };
    for (const rel of walkFiles(resultsDir)) {
      if (rel.endsWith('trace.zip') || rel.endsWith('.trace')) artifacts.trace = rel;
      else if (rel.endsWith('.png')) artifacts.screenshots!.push(rel);
      else if (rel.endsWith('.webm')) artifacts.videos!.push(rel);
      else artifacts.attachments!.push(rel);
    }
    const hasFiles = !!(
      artifacts.trace ||
      artifacts.screenshots!.length ||
      artifacts.videos!.length ||
      artifacts.attachments!.length
    );
    if (!hasFiles) return null;
    if (cfg.artifactMode === 'upload') {
      const all = [
        artifacts.trace,
        ...(artifacts.screenshots ?? []),
        ...(artifacts.videos ?? []),
        ...(artifacts.attachments ?? []),
      ];
      for (const rel of all) {
        if (!rel) continue;
        try {
          const buf = readFileSync(path.join(resultsDir, rel));
          const form = new FormData();
          form.append('file', new Blob([new Uint8Array(buf)]), encodeURIComponent(rel));
          const res = await fetch(`${cfg.serverUrl}/api/v1/executions/${task.runId}/artifacts`, {
            method: 'POST',
            headers: { 'x-worker-token': cfg.token, 'x-run-token': task.runToken },
            body: form,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (e) {
          artifacts.missing!.push(rel);
          log.warn(
            { err: (e as Error).message, file: rel, runId: task.runId },
            'artifact upload failed',
          );
        }
      }
    }
    return artifacts;
  }
}

function walkFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e.startsWith('.')) continue; // 跳过 .last-run.json 等内部文件
    const full = path.join(dir, e);
    const rel = prefix ? `${prefix}/${e}` : e;
    if (statSync(full).isDirectory()) out.push(...walkFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

const worker = new Worker();

function shutdown() {
  log.info('shutting down');
  worker.closed = true;
  // F9：关闭本机设备代理（进程退出本身也会关 socket，这里显式收尾）
  void worker.closeDeviceProxies().finally(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

worker.start();
