// 把 apps/mcp 打成零依赖单文件 bundle（Node ≥20 直接运行），用于发布到 tern-resources 公共仓库
// 用法：node scripts/bundle-mcp.mjs [输出路径]（默认 dist/tern-mcp.mjs）
import { createRequire } from 'node:module';
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? resolve(root, 'dist/tern-mcp.mjs'));
// esbuild 是 case-bundler 的依赖（pnpm 严格布局），从该包解析
const { build } = createRequire(resolve(root, 'packages/case-bundler/package.json'))('esbuild');

const result = await build({
  entryPoints: [resolve(root, 'apps/mcp/src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  minify: true,
  sourcemap: false,
  outfile: out,
  logLevel: 'info',
});

console.log(`[bundle-mcp] ${out} (${statSync(out).size} bytes)`);
