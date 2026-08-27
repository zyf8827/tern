import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { genPlaywrightConfig } from './config-template.js';
import type { RunOptions, RunEvent, RunStatus } from '@tern/sdk';

function reporterCjsPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'reporter.cjs');
}

/** 解析 @playwright/test 自带 CLI 的绝对路径（相对于调用方模块解析） */
export function playwrightCliPathOf(fromModule: string): string {
  const req = createRequire(fromModule);
  const pkgJsonPath = req.resolve('@playwright/test/package.json');
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { bin?: Record<string, string> };
  const bin = pkg.bin?.['playwright'] ?? 'cli.js';
  return path.join(path.dirname(pkgJsonPath), bin);
}

export interface RunCaseInput {
  /** 本次执行的运行目录（每次 run 独立） */
  runRoot: string;
  /** bundle JS 内容 */
  bundleCode: string;
  timeoutS: number;
  retries: number;
  options: RunOptions;
  params: Record<string, string>;
  /**
   * F8 设备输入：fake 麦克风/摄像头文件（已解析为 worker 本地绝对路径）。
   * micFile → --use-file-for-fake-audio-capture；cameraFile → video 版本；
   * enable=true（无文件）→ 仅 fake-device + 自动授权。
   */
  devices?: { micFile?: string | null; cameraFile?: string | null; enable?: boolean } | null;
  /** F8 资产映射：相对路径 → worker 本地绝对路径（注入 TERN_ASSETS + ternAsset() 全局函数） */
  assetsMap?: Record<string, string>;
  /** 进程级墙钟上限（秒） */
  hardTimeoutS: number;
  /** @playwright/test cli.js 绝对路径 */
  playwrightCliPath: string;
  /**
   * 提供给 run 目录的 node_modules 源（通常为 worker 的 node_modules）。
   * runRoot 需位于系统临时目录——不能放在 .gitignore 命中的路径下
   * （playwright 会忽略 gitignore 的路径导致 No tests found），
   * 因此用符号链接让 run 目录获得模块解析能力。
   */
  nodeModulesDir: string;
  /**
   * 登录态文件（playwright storageState），由调用方先完成登录流程生成。
   * runner 以页面自然通道注入（见 authPrologueCode），不走 use.storageState。
   */
  authStatePath?: string | null;
  onEvent: (ev: RunEvent) => void;
}

export interface RunCaseResult {
  status: Extract<RunStatus, 'passed' | 'failed' | 'timed_out' | 'error' | 'skipped' | 'cancelled'>;
  flaky: boolean;
  durationMs: number;
  error: { name: string; message: string; stack?: string } | null;
  resultsDir: string;
  stderrTail: string;
}

export interface RunCaseHandle {
  promise: Promise<RunCaseResult>;
  cancel: () => void;
  cdpPort: number;
}

interface ReporterEvent {
  type: 'begin' | 'testBegin' | 'testEnd' | 'step' | 'stdout' | 'stderr' | 'error' | 'end';
  ts: string;
  title?: string;
  file?: string;
  status?: string;
  outcome?: string;
  duration?: number;
  error?: { message?: string; stack?: string } | null;
  text?: string;
  message?: string;
  stack?: string;
  phase?: 'begin' | 'end';
  category?: string;
  passed?: number;
  failed?: number;
  skipped?: number;
  flaky?: number;
  interrupted?: number;
}

export function runCase(input: RunCaseInput): RunCaseHandle {
  let cancelRequested = false;
  let timedOut = false;
  let child: ReturnType<typeof spawn> | null = null;
  let reporterServer: Server | null = null;
  let cdpPort = 0;

  const startedAt = Date.now();
  const hardMs = Math.max(input.hardTimeoutS, input.timeoutS + 30) * 1000;

  const promise = new Promise<RunCaseResult>((resolve) => {
    void (async () => {
      // 1. 组装运行目录（临时目录 + node_modules 符号链接）
      mkdirSync(input.runRoot, { recursive: true });
      const caseFile = path.join(input.runRoot, 'case.spec.js');
      writeFileSync(
        caseFile,
        assetsPrologueCode() +
          authPrologueCode(input.authStatePath, input.params.BASE_URL) +
          input.bundleCode,
      );
      try {
        symlinkSync(input.nodeModulesDir, path.join(input.runRoot, 'node_modules'), 'dir');
      } catch {
        // 已存在
      }

      // 2. reporter 事件接收端点（仅监听 127.0.0.1）
      let stderrTail = '';
      const firstFailureRef: { value: { message: string; stack?: string } | null } = {
        value: null,
      };
      const endStats: Required<
        Pick<ReporterEvent, 'passed' | 'failed' | 'skipped' | 'flaky' | 'interrupted'>
      > = {
        passed: 0,
        failed: 0,
        skipped: 0,
        flaky: 0,
        interrupted: 0,
      };
      let hadEnd = false;

      reporterServer = createServer((req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 404;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          for (const line of body.split('\n')) {
            if (!line.trim()) continue;
            try {
              handleReporterEvent(JSON.parse(line) as ReporterEvent);
            } catch {
              /* 跳过坏行 */
            }
          }
          res.statusCode = 204;
          res.end();
        });
      });
      function handleReporterEvent(ev: ReporterEvent): void {
        const ts = ev.ts ?? new Date().toISOString();
        switch (ev.type) {
          case 'begin':
            input.onEvent({ type: 'started', ts });
            break;
          case 'testBegin':
            input.onEvent({ type: 'log', ts, level: 'info', text: `▶ ${ev.title}` });
            break;
          case 'testEnd': {
            const outcome = ev.outcome ?? 'unexpected';
            const dur = Math.round(ev.duration ?? 0);
            const mark =
              outcome === 'expected'
                ? '✓'
                : outcome === 'flaky'
                  ? '↻'
                  : outcome === 'skipped'
                    ? '⏭'
                    : '✗';
            input.onEvent({
              type: 'log',
              ts,
              level: outcome === 'unexpected' ? 'error' : 'info',
              text: `${mark} ${ev.title} (${outcome}${dur ? `, ${dur}ms` : ''})`,
            });
            if (outcome === 'expected') endStats.passed++;
            else if (outcome === 'flaky') {
              endStats.passed++;
              endStats.flaky++;
            } else if (outcome === 'skipped') endStats.skipped++;
            else {
              endStats.failed++;
              if (ev.error?.message && !firstFailureRef.value) {
                firstFailureRef.value = { message: ev.error.message, stack: ev.error.stack };
              }
            }
            if (ev.status === 'interrupted') endStats.interrupted++;
            break;
          }
          case 'step':
            input.onEvent({
              type: 'step',
              ts,
              step: { title: ev.title ?? '', category: ev.category, phase: ev.phase ?? 'begin' },
            });
            break;
          case 'stdout':
            if (ev.text)
              input.onEvent({ type: 'log', ts, level: 'info', text: ev.text.replace(/\n+$/, '') });
            break;
          case 'stderr':
            if (ev.text) {
              stderrTail = (stderrTail + ev.text).slice(-2000);
              input.onEvent({ type: 'log', ts, level: 'error', text: ev.text.replace(/\n+$/, '') });
            }
            break;
          case 'error':
            if (ev.message && !firstFailureRef.value)
              firstFailureRef.value = { message: ev.message, stack: ev.stack };
            if (ev.message) input.onEvent({ type: 'log', ts, level: 'error', text: ev.message });
            break;
          case 'end':
            hadEnd = true;
            Object.assign(endStats, {
              passed: ev.passed ?? endStats.passed,
              failed: ev.failed ?? endStats.failed,
              skipped: ev.skipped ?? endStats.skipped,
              flaky: ev.flaky ?? endStats.flaky,
              interrupted: ev.interrupted ?? endStats.interrupted,
            });
            break;
        }
      }
      await new Promise<void>((resolveListen) => {
        reporterServer!.listen(0, '127.0.0.1', resolveListen);
      });
      const reporterPort = (reporterServer!.address() as { port: number }).port;

      // 3. CDP 端口
      cdpPort = await pickFreePort();

      // 4. 生成临时 config
      const reporterPath = reporterCjsPath();
      const outputDir = path.join(input.runRoot, 'test-results');
      const configContent = genPlaywrightConfig({
        timeoutS: input.timeoutS,
        retries: input.retries,
        options: input.options,
        cdpPort,
        reporterPath,
        outputDir,
        headless: process.env.TERN_HEADLESS !== 'false',
        deviceArgs: deviceLaunchArgs(input.devices, input.params.BASE_URL),
      });
      writeFileSync(path.join(input.runRoot, 'playwright.config.cjs'), configContent);

      // 5. 调起 runner（独立进程组）
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) env[k] = v;
      }
      for (const [k, v] of Object.entries(input.params)) {
        if (/^[A-Z_][A-Z0-9_]*$/.test(k)) env[k] = String(v);
      }
      env.TERN_REPORT_PORT = String(reporterPort);
      if (input.assetsMap && Object.keys(input.assetsMap).length) {
        env.TERN_ASSETS = JSON.stringify(input.assetsMap);
      }
      child = spawn(
        process.execPath,
        [
          input.playwrightCliPath,
          'test',
          'case.spec.js',
          `--config=${path.join(input.runRoot, 'playwright.config.cjs')}`,
        ],
        { cwd: input.runRoot, env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] },
      );
      child.stderr?.on('data', (c: Buffer) => {
        const text = c.toString();
        stderrTail = (stderrTail + text).slice(-2000);
        input.onEvent({
          type: 'log',
          ts: new Date().toISOString(),
          level: 'error',
          text: text.replace(/\n+$/, ''),
        });
      });

      // 6. 墙钟看护
      const watchdog = setTimeout(() => {
        timedOut = true;
        killProcessGroup();
      }, hardMs);

      const [code] = await new Promise<[number | null, string | null]>((resolveExit) => {
        child!.on('exit', (c, s) => resolveExit([c, s]));
      });
      clearTimeout(watchdog);
      const durationMs = Date.now() - startedAt;

      // 7. 状态映射
      let status: RunCaseResult['status'];
      let error: RunCaseResult['error'] = null;
      if (cancelRequested) {
        status = 'cancelled';
      } else if (timedOut) {
        status = 'timed_out';
        error = {
          name: 'HardTimeout',
          message: `执行超过墙钟上限 ${Math.round(hardMs / 1000)}s，已被强制终止`,
        };
      } else if (!hadEnd) {
        status = 'error';
        error = {
          name: 'RunnerCrashed',
          message: `runner 进程异常退出（exit=${code ?? 'signal'}），无报告输出。${stderrTail.slice(-500).trim()}`,
        };
      } else if (endStats.failed > 0) {
        status = 'failed';
        error = firstFailureRef.value
          ? {
              name: 'AssertionError',
              message: firstFailureRef.value.message,
              stack: firstFailureRef.value.stack,
            }
          : { name: 'TestFailed', message: `${endStats.failed} 个 test 失败` };
      } else if (endStats.interrupted > 0) {
        status = 'error';
        error = { name: 'Interrupted', message: 'runner 被中断' };
      } else if (endStats.passed + endStats.failed + endStats.skipped === 0) {
        status = 'error';
        error = { name: 'NoTests', message: '未找到任何 test（文件内没有可执行的 test()）' };
      } else if (endStats.skipped > 0 && endStats.passed === 0) {
        status = 'skipped';
      } else {
        status = 'passed';
      }

      reporterServer?.close();
      reporterServer = null;
      resolve({
        status,
        flaky: status === 'passed' && endStats.flaky > 0,
        durationMs,
        error,
        resultsDir: path.join(input.runRoot, 'test-results'),
        stderrTail,
      });
    })();
  });

  function killProcessGroup(): void {
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
  }

  return {
    promise,
    // cdpPort 在异步流程中才确定，必须用 getter 读取最新值
    get cdpPort() {
      return cdpPort;
    },
    cancel() {
      cancelRequested = true;
      killProcessGroup();
    },
  };
}

export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/**
 * 生成登录态注入 prologue（拼在 case.spec.js 头部）。
 *
 * 不用 use.storageState / context.addCookies：二者经 CDP 写 cookie，而新内核
 * （Chromium 147+ 实测，147/151 均复现）对 CDP 写入的 cookie 不随网络请求附带
 * （document.cookie 可见、请求头缺失）。页面自然通道（响应 Set-Cookie、
 * document.cookie 写入）不受影响，故 prologue 先导航到目标站，再用
 * document.cookie / localStorage 写入缓存会话。
 *
 * HttpOnly 属性无法（也无需）由 document.cookie 复原：写入的 cookie 为
 * 非 HttpOnly，对用例请求携带无影响。
 */
function authPrologueCode(authStatePath: string | null | undefined, baseUrl?: string): string {
  if (!authStatePath) return '';
  let state: { cookies?: unknown[]; origins?: unknown[] };
  try {
    state = JSON.parse(readFileSync(authStatePath, 'utf8'));
  } catch (e) {
    return (
      '\n;(function () {\n' +
      "  const { test } = require('@playwright/test');\n" +
      '  test.beforeEach(async () => {\n' +
      "    throw new Error('登录态文件读取失败（auth storageState 无效）: " +
      String((e as Error).message).replace(/['\\]/g, '') +
      "');\n" +
      '  });\n' +
      '})();\n'
    );
  }
  const cookies = Array.isArray(state.cookies) ? state.cookies : [];
  const origins = Array.isArray(state.origins) ? state.origins : [];
  if (!cookies.length && !origins.length) return '';
  const payload = JSON.stringify({ baseUrl: baseUrl ?? null, cookies, origins });
  return `
// —— Tern 登录态注入（prologue，平台生成）——
;(function () {
  const state = ${payload};
  const { test } = require('@playwright/test');
  test.beforeEach(async ({ page, baseURL }) => {
    if (!state.cookies.length && !state.origins.length) return;
    const target = state.baseUrl || baseURL;
    if (!target) throw new Error('登录态注入需要 BASE_URL（测试运行参数）');
    let host;
    try { host = new URL(target).hostname; } catch { throw new Error('BASE_URL 非法: ' + target); }
    const usable = state.cookies.filter(function (c) {
      const d = String(c.domain || '').replace(/^\\./, '');
      return d === host || host.endsWith('.' + d);
    });
    const sameOriginStorages = state.origins.filter(function (o) {
      try { return new URL(o.origin).host === new URL(target).host; } catch { return false; }
    });
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(function () {});
    await page.evaluate(function (data) {
      for (const c of data.items) {
        let s = c.name + '=' + c.value + '; path=' + (c.path || '/');
        if (c.expires && c.expires > 0) s += '; expires=' + new Date(c.expires * 1000).toUTCString();
        document.cookie = s;
      }
      for (const o of data.storages) {
        for (const it of o.localStorage || []) localStorage.setItem(it.name, it.value);
      }
    }, { items: usable, storages: sameOriginStorages });
    if (usable.length < state.cookies.length) {
      console.log('[tern-auth] 有 ' + (state.cookies.length - usable.length) + ' 个 cookie 不属于 '
        + host + '，未注入（跨域会话请改用 api 登录配方）');
    }
  });
})();
`;
}

/**
 * F8：设备模拟启动参数（Chromium fake device，WebRTC 官方测试同款）。
 * - 任何 devices 声明都启用 fake 设备 + 权限自动授予（无头无弹窗）
 * - micFile/cameraFile → 文件作为设备输入（音频推流 / 画面回放）
 * - baseUrl 为 http:// 非安全源（非 localhost）时放行 getUserMedia：
 *   浏览器禁止不安全页面录音，企业内网 HTTP 环境必须显式豁免该源
 */
export function deviceLaunchArgs(devices: RunCaseInput['devices'], baseUrl?: string): string[] {
  if (!devices) return [];
  const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
  if (devices.micFile) args.push(`--use-file-for-fake-audio-capture=${devices.micFile}`);
  if (devices.cameraFile) args.push(`--use-file-for-fake-video-capture=${devices.cameraFile}`);
  const insecure = insecureOrigin(baseUrl);
  if (insecure) args.push(`--unsafely-treat-insecure-origin-as-secure=${insecure}`);
  return args;
}

/** http:// 且非 localhost 的源返回 origin（含端口），https/localhost/未配置返回 null */
function insecureOrigin(baseUrl?: string): string | null {
  if (!baseUrl) return null;
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'http:') return null;
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')
      return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * F8：资产访问 prologue（拼在 case.spec.js 最前，先于 auth prologue）。
 * 注入全局 ternAsset(path)：用例以相对 assetsDir 的路径引用随行文件，
 * 返回 worker 本地绝对路径；未下发的路径给出可用清单（fail-fast）。
 */
function assetsPrologueCode(): string {
  return `
// —— Tern 测试资产访问（prologue，平台生成）——
;(function () {
  const map = (() => { try { return JSON.parse(process.env.TERN_ASSETS || '{}'); } catch { return {}; } })();
  globalThis.ternAsset = function (p) {
    if (typeof p !== 'string' || !Object.prototype.hasOwnProperty.call(map, p)) {
      const avail = Object.keys(map);
      throw new Error('ternAsset("' + p + '") 不在本次下发的资产中'
        + (avail.length ? '；可用: ' + avail.join(', ') : '（本次运行未下发任何资产）'));
    }
    return map[p];
  };
})();
`;
}
