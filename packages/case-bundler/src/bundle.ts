import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { parseFrontmatter } from './frontmatter.js';
import { extractAssetRefs, extractImports, lintCase } from './lint.js';

export { parseFrontmatter } from './frontmatter.js';
export type { CaseMeta } from './frontmatter.js';
export { extractAssetRefs, extractImports, lintCase, checkCasePath, checkImports } from './lint.js';
export type { LintIssue } from './lint.js';

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface PrepareCaseInput {
  /** 用例文件绝对路径 */
  absPath: string;
  /** cases/ 根目录绝对路径 */
  casesDir: string;
  /** bundle 输出根目录（data/bundles） */
  bundlesDir: string;
  /** 允许 import 的依赖（cases/package.json dependencies keys） */
  allowedDeps: string[];
  /** 源码内容（可选，缺省读文件） */
  source?: string;
}

export interface PrepareCaseResult {
  ok: boolean;
  relPath: string;
  caseId: string;
  project: string;
  source: string;
  contentHash: string;
  bundleHash: string | null;
  bundlePath: string | null;
  frontmatter: ReturnType<typeof parseFrontmatter>;
  /** 用例静态引用的测试资产路径（ternAsset('...') 字面量调用） */
  assetRefs: string[];
  issues: { code: string; message: string }[];
}

/** 对单个用例文件执行：frontmatter 解析 → lint → esbuild 打包（内容寻址缓存）。同步实现，适配 SQLite 事务模型 */
export function prepareCase(input: PrepareCaseInput): PrepareCaseResult {
  const source = input.source ?? readFileSync(input.absPath, 'utf8');
  const relPath = path.relative(input.casesDir, input.absPath).split(path.sep).join('/');
  const caseId = relPath.replace(/\.spec\.ts$/, '');
  const project = caseId.split('/')[0];
  const contentHash = sha256Hex(source);
  const fm = parseFrontmatter(source);

  const metaErrors = fm ? fm.errors : ['未找到 @tern frontmatter 注释块'];
  const imports = extractImports(source);
  const issues = lintCase({ relPath, metaErrors, imports, allowedDeps: input.allowedDeps });

  const result: PrepareCaseResult = {
    ok: false,
    relPath,
    caseId,
    project,
    source,
    contentHash,
    bundleHash: null,
    bundlePath: null,
    frontmatter: fm,
    assetRefs: extractAssetRefs(source),
    issues,
  };
  if (issues.length > 0) return result;

  // esbuild 打包为自包含 CJS（playwright 与 node 内置保持 external）
  const buildResult = buildSync({
    entryPoints: [input.absPath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['playwright', 'playwright-core', '@playwright/test'],
    write: false,
    metafile: true,
    logLevel: 'silent',
    sourcemap: false,
    legalComments: 'none',
  });
  // 注意：esbuild 的 warnings（如宿主环境 tsconfig extends 缺失）不影响产物正确性，
  // 不作为用例校验失败依据
  const js = buildResult.outputFiles?.[0]?.text;
  if (!js) {
    issues.push({ code: 'BUNDLE_EMPTY', message: 'esbuild 产物为空' });
    return result;
  }
  const bundleHash = sha256Hex(js);
  const bundlePath = path.join(input.bundlesDir, bundleHash.slice(0, 2), `${bundleHash}.cjs`);
  mkdirSync(path.dirname(bundlePath), { recursive: true });
  try {
    writeFileSync(bundlePath, js, { flag: 'wx' });
  } catch {
    // 已存在（内容寻址），直接复用
  }
  result.ok = true;
  result.bundleHash = bundleHash;
  result.bundlePath = bundlePath;
  return result;
}

/** 扫描 cases 目录，返回用例文件绝对路径列表（排除 _ 前缀目录与隐藏目录） */
export function scanCaseFiles(casesDir: string): string[] {
  const out: string[] = [];
  function walk(dir: string, depth: number): void {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries.sort()) {
      if (e.startsWith('.') || e.startsWith('_')) continue;
      const full = path.join(dir, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 16) walk(full, depth + 1);
      } else if (e.endsWith('.spec.ts')) {
        out.push(full);
      }
    }
  }
  walk(casesDir, 0);
  return out.sort();
}
