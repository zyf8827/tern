export interface LintIssue {
  code: string;
  message: string;
}

const KEBAB = /^[a-z][a-z0-9-]*$/;

/** 校验用例相对路径（相对 cases/ 根目录），如 portal/login/login-basic.spec.ts */
export function checkCasePath(relPath: string): LintIssue[] {
  const issues: LintIssue[] = [];
  if (!relPath.endsWith('.spec.ts')) {
    issues.push({ code: 'PATH_EXT', message: `用例文件必须以 .spec.ts 结尾: ${relPath}` });
    return issues;
  }
  const segs = relPath.slice(0, -'.spec.ts'.length).split('/');
  for (const seg of segs) {
    if (!KEBAB.test(seg)) {
      issues.push({
        code: 'PATH_NAME',
        message: `路径段 "${seg}" 不符合小写 kebab-case 规范（[a-z0-9-]）: ${relPath}`,
      });
    }
  }
  return issues;
}

/** 校验 frontmatter 元数据 */
export function checkMetaErrors(metaErrors: string[]): LintIssue[] {
  return metaErrors.map((m) => ({ code: 'META', message: m }));
}

const ALLOWED_BARE = new Set(['playwright', 'playwright-core', '@playwright/test']);

/** 提取 import/require 的模块说明符 */
export function extractImports(source: string): string[] {
  const specs = new Set<string>();
  const patterns = [
    /import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /export\s+[\s\S]*?from\s+['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) specs.add(m[1]);
  }
  return [...specs];
}

/**
 * 扫描 ternAsset('...') 字面量调用，收集用例静态引用的测试资产路径。
 * 只识别字符串字面量；动态拼接的路径无法静态校验（运行期 ternAsset 会明确报错）。
 */
export function extractAssetRefs(source: string): string[] {
  const refs = new Set<string>();
  const re = /\bternAsset\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) refs.add(m[1]);
  return [...refs];
}

/**
 * 校验 import 白名单：
 * - playwright / playwright-core / @playwright/test
 * - node: 前缀内置模块
 * - 相对导入（同仓库 _lib / 其他用例目录）
 * - cases/package.json 声明的 dependencies
 * 禁止平台内部模块（@tern/*）
 */
export function checkImports(specs: string[], allowedDeps: string[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const deps = new Set(allowedDeps);
  for (const spec of specs) {
    if (spec.startsWith('node:')) continue;
    if (spec.startsWith('./') || spec.startsWith('../')) continue;
    if (ALLOWED_BARE.has(spec)) continue;
    // 解析裸包名（含 scope）
    const parts = spec.split('/');
    const bare = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (deps.has(bare)) continue;
    if (bare === '@tern' || bare.startsWith('@tern/')) {
      issues.push({
        code: 'IMPORT_PLATFORM',
        message: `禁止 import 平台内部模块: ${spec}（用例只能依赖 @playwright/test、相对路径与 cases/package.json 声明的依赖）`,
      });
      continue;
    }
    issues.push({
      code: 'IMPORT_NOT_ALLOWED',
      message: `import "${spec}" 不在白名单内：允许 @playwright/test、node: 内置、相对路径、cases/package.json 中声明的依赖（当前引用了未声明的 "${bare}"）`,
    });
  }
  return issues;
}

export function lintCase(input: {
  relPath: string;
  metaErrors: string[];
  imports: string[];
  allowedDeps: string[];
}): LintIssue[] {
  return [
    ...checkCasePath(input.relPath),
    ...checkMetaErrors(input.metaErrors),
    ...checkImports(input.imports, input.allowedDeps),
  ];
}
