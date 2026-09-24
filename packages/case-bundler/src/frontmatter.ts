import { parse as yamlParse } from 'yaml';

const KEBAB = /^[a-z][a-z0-9-]*$/;

export type CaseTraceMode = 'off' | 'on' | 'retain-on-failure';

export interface CaseMeta {
  title: string;
  description: string;
  project?: string;
  tags: string[];
  /** 被测系统版本（如 v2.3 / 2024.1），用于多维筛选 */
  version?: string;
  /** 功能模块（如 login / order），用于多维筛选 */
  module?: string;
  /** 引用项目 tern.yaml 中定义的 auth profile 名（登录方式） */
  auth?: string;
  /**
   * 设备输入声明（fake 麦克风/摄像头）：
   * - 对象形式：{ mic: 'audio/x.wav', camera: 'video/y4m' }（值为相对 assetsDir 的资产路径）
   * - 数组形式：['mic', 'camera']（仅启用 fake 设备，用默认音/画面）
   */
  devices?: { mic?: string; camera?: string } | string[];
  /**
   * 用例级串行依赖（相对 casesDir 的用例路径，不带 .spec.ts，如 auth/login-page）。
   * 仅在同批次同环境生效。自依赖与环形依赖在 sync 阶段校验并报错。
   */
  depends?: string[];
  timeout?: number;
  retries?: number;
  disabled?: boolean;
  author?: string;
  /**
   * 用例级 trace 覆盖（优先于运行级 options.trace）。
   * 长时录音/推流类用例必须 off：trace 会开启 Network 域 + 页面 screencast，
   * 高频二进制 WS 音频帧与连续重绘的 JPEG 帧持续灌入 CDP 驱动管道，实测会把
   * Playwright 驱动楔死（表现：后续任意 await 永不 settle，用例悬到墙钟上限）。
   */
  trace?: CaseTraceMode;
  meta: Record<string, unknown>;
}

export interface FrontmatterResult {
  meta: CaseMeta;
  raw: string;
  errors: string[];
}

/**
 * 解析用例文件头部的 @tern 标记块注释（YAML frontmatter）：
 *
 * /**
 *  * @tern
 *  * title: ...
 *  * tags: [smoke]
 *  **​/
 */
export function parseFrontmatter(source: string): FrontmatterResult | null {
  const blockRe = /\/\*{2}([\s\S]*?)\*\//g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(source)) !== null) {
    const lines = m[1].split(/\r?\n/).map((l) => l.replace(/^\s*\*? ?/, ''));
    // 找到 @tern 标记行，其后为 YAML 文本
    const idx = lines.findIndex((l) => l.trim() === '@tern');
    if (idx === -1) continue;
    const yamlText = lines
      .slice(idx + 1)
      .join('\n')
      .trim();
    return buildMeta(yamlText, m[0]);
  }
  return null;
}

function buildMeta(yamlText: string, raw: string): FrontmatterResult {
  const errors: string[] = [];
  let doc: Record<string, unknown> = {};
  if (!yamlText) {
    errors.push('@tern frontmatter 内容为空');
  } else {
    try {
      const parsed = yamlParse(yamlText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        doc = parsed as Record<string, unknown>;
      } else {
        errors.push('frontmatter 必须是 YAML 映射（key: value）');
      }
    } catch (e) {
      errors.push(`frontmatter YAML 解析失败: ${(e as Error).message}`);
    }
  }

  const meta: CaseMeta = {
    title: '',
    description: '',
    tags: [],
    meta: {},
  };

  if (typeof doc['title'] === 'string' && doc['title'].trim()) {
    meta.title = doc['title'].trim();
  } else {
    errors.push('缺少必填字段 title（字符串）');
  }
  if (doc['description'] !== undefined) {
    meta.description = String(doc['description']);
  }
  if (doc['project'] !== undefined) {
    meta.project = String(doc['project']);
  }
  if (doc['tags'] !== undefined) {
    if (Array.isArray(doc['tags']) && doc['tags'].every((t) => typeof t === 'string')) {
      meta.tags = (doc['tags'] as string[]).map((t) => t.trim().toLowerCase()).filter(Boolean);
    } else if (typeof doc['tags'] === 'string') {
      meta.tags = (doc['tags'] as string)
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
    } else {
      errors.push('tags 必须是字符串数组（如 [smoke, login]）');
    }
  }
  if (doc['timeout'] !== undefined) {
    const n = Number(doc['timeout']);
    if (Number.isFinite(n) && n > 0) meta.timeout = n;
    else errors.push('timeout 必须是正数（秒）');
  }
  if (doc['retries'] !== undefined) {
    const n = Number(doc['retries']);
    if (Number.isInteger(n) && n >= 0) meta.retries = n;
    else errors.push('retries 必须是非负整数');
  }
  if (doc['trace'] !== undefined) {
    const t = String(doc['trace']).trim();
    if (t === 'off' || t === 'on' || t === 'retain-on-failure') meta.trace = t;
    else errors.push(`trace 只允许 off / on / retain-on-failure，当前: ${t}`);
  }
  if (doc['disabled'] !== undefined) {
    meta.disabled = doc['disabled'] === true || doc['disabled'] === 'true';
  }
  if (doc['author'] !== undefined) {
    meta.author = String(doc['author']);
  }
  if (doc['version'] !== undefined) {
    meta.version = String(doc['version']).trim();
  }
  if (doc['module'] !== undefined) {
    meta.module = String(doc['module']).trim();
  }
  if (doc['auth'] !== undefined) {
    const auth = String(doc['auth']).trim();
    if (auth) meta.auth = auth;
  }
  if (doc['devices'] !== undefined) {
    const d = doc['devices'];
    if (Array.isArray(d)) {
      // 数组形式：['mic', 'camera'] —— 仅启用 fake 设备（默认音/画面）
      if (d.every((x) => typeof x === 'string')) {
        const names = (d as string[]).map((x) => x.trim()).filter(Boolean);
        const bad = names.filter((n) => n !== 'mic' && n !== 'camera');
        if (bad.length) errors.push(`devices 数组只允许 'mic' / 'camera'，出现: ${bad.join(', ')}`);
        else if (names.length) meta.devices = names;
      } else {
        errors.push('devices 数组元素必须是字符串（如 [mic, camera]）');
      }
    } else if (d && typeof d === 'object') {
      // 对象形式：{ mic: 'audio/x.wav', camera: 'video/x.y4m' }（值为资产路径）
      const out: { mic?: string; camera?: string } = {};
      let ok = true;
      for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
        if (k !== 'mic' && k !== 'camera') {
          errors.push(`devices 不支持的字段 "${k}"（仅 mic / camera）`);
          ok = false;
          continue;
        }
        if (v === undefined || v === null) continue;
        if (typeof v !== 'string' || !v.trim()) {
          errors.push(`devices.${k} 必须是非空字符串（相对 assetsDir 的资产路径）`);
          ok = false;
          continue;
        }
        if (v.includes('..') || v.startsWith('/')) {
          errors.push(`devices.${k} 路径非法（相对 assetsDir，不允许 .. 或绝对路径）: ${v}`);
          ok = false;
          continue;
        }
        out[k] = v.trim();
      }
      if (ok && Object.keys(out).length) meta.devices = out;
    } else {
      errors.push('devices 必须是对象（{ mic: 资产路径 }）或数组（[mic]）');
    }
  }
  if (doc['depends'] !== undefined) {
    const d = doc['depends'];
    if (!Array.isArray(d)) {
      errors.push('depends 必须是相对用例 ID 的字符串数组（如 [auth/login-page]）');
    } else {
      const list: string[] = [];
      let ok = true;
      for (const item of d) {
        if (typeof item !== 'string' || !item.trim()) {
          errors.push('depends 数组元素必须是非空字符串');
          ok = false;
          break;
        }
        const trimmed = item.trim();
        const segs = trimmed.split('/');
        if (segs.length === 0 || segs.some((s) => !KEBAB.test(s))) {
          errors.push(
            `depends 用例 ID "${trimmed}" 格式非法（各路径段须符合小写 kebab-case，如 auth/login-page）`,
          );
          ok = false;
          break;
        }
        list.push(trimmed);
      }
      if (ok && list.length > 0) {
        meta.depends = [...new Set(list)];
      }
    }
  }

  const known = new Set([
    'title',
    'description',
    'project',
    'tags',
    'version',
    'module',
    'auth',
    'devices',
    'depends',
    'timeout',
    'retries',
    'trace',
    'disabled',
    'author',
  ]);
  for (const [k, v] of Object.entries(doc)) {
    if (!known.has(k)) meta.meta[k] = v;
  }

  return { meta, raw, errors };
}
