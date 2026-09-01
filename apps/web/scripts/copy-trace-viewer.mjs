// F3：自托管 Playwright trace viewer。
// 资源来自 playwright-core 自带的 lib/vite/traceViewer（相对路径构建，可子路径托管），
// 构建时复制到 apps/server/public/trace-viewer/，由 server 的静态路由开箱即用提供
// （/trace-viewer/index.html?trace=<zip 地址>）。TRACE_VIEWER_DIR 仍可覆盖为外部目录。
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkgRoot = path.dirname(require.resolve('playwright-core/package.json'));
const src = path.join(pkgRoot, 'lib', 'vite', 'traceViewer');
if (!existsSync(path.join(src, 'index.html'))) {
  console.error(`[copy-trace-viewer] 未找到 trace viewer 资源: ${src}（playwright-core 版本不含 lib/vite/traceViewer？）`);
  process.exit(1);
}
const dest = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server/public/trace-viewer');
mkdirSync(path.dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-trace-viewer] ${src} -> ${dest}`);
