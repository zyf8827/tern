import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  /** 用例仓库根目录：每个子目录一个 project 仓库（git clone 或本地放置） */
  reposDir: string;
  bundlesDir: string;
  /** 测试资产存储根目录（内容寻址，来自用例仓库 assetsDir） */
  assetsDir: string;
  artifactsDir: string;
  workerToken: string;
  apiToken: string | null;
  syncWatch: boolean;
  /** git 项目默认自动拉取间隔（秒）；0 = 禁用自动拉取 */
  pullIntervalSec: number;
  caseDefaultTimeoutS: number;
  maxBatchItems: number;
  artifactRetentionDays: number;
  appOrigins: string[] | null;
  /** 对外可达地址（通知消息里的链接用）；缺省 http://localhost:<port> */
  publicUrl: string;
  /** Playwright trace viewer 静态资源目录（自托管在线查看）；不存在时回退 zip 下载 */
  traceViewerDir: string;
  version: string;
}

function env(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}
function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return v === 'true' || v === '1';
}

export function loadConfig(): Config {
  const dataDir = path.resolve(env('DATA_DIR', './data'));
  const reposDir = path.resolve(env('REPOS_DIR', './repos'));
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(reposDir, { recursive: true });

  const tokenFile = path.join(dataDir, '.worker-token');
  let workerToken = process.env.WORKER_TOKEN ?? '';
  if (!workerToken) {
    if (existsSync(tokenFile)) {
      workerToken = readFileSync(tokenFile, 'utf8').trim();
    } else {
      workerToken = randomBytes(24).toString('hex');
      writeFileSync(tokenFile, workerToken, { mode: 0o600 });
      // eslint-disable-next-line no-console
      console.log(`[server] WORKER_TOKEN 未配置，已自动生成并写入 ${tokenFile}`);
    }
  }

  let version = '0.0.0';
  try {
    const pkgUrl = new URL('../../package.json', import.meta.url);
    version = JSON.parse(readFileSync(pkgUrl, 'utf8')).version ?? version;
  } catch {
    // ignore
  }

  return {
    port: envInt('PORT', 7430),
    host: env('HOST', '0.0.0.0'),
    dataDir,
    reposDir,
    bundlesDir: path.join(dataDir, 'bundles'),
    assetsDir: path.join(dataDir, 'assets'),
    artifactsDir: path.join(dataDir, 'artifacts'),
    workerToken,
    apiToken: process.env.API_TOKEN || null,
    syncWatch: envBool('SYNC_WATCH', true),
    pullIntervalSec: envInt('PULL_INTERVAL_SEC', 300),
    caseDefaultTimeoutS: envInt('CASE_DEFAULT_TIMEOUT_S', 120),
    maxBatchItems: envInt('MAX_BATCH_ITEMS', 2000),
    artifactRetentionDays: envInt('ARTIFACT_RETENTION_DAYS', 14),
    appOrigins: process.env.APP_ORIGINS ? process.env.APP_ORIGINS.split(',') : null,
    publicUrl: env('PUBLIC_URL', `http://localhost:${envInt('PORT', 7430)}`),
    traceViewerDir: path.resolve(env('TRACE_VIEWER_DIR', path.join(dataDir, 'trace-viewer'))),
    version,
  };
}
