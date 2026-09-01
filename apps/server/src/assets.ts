// 测试资产（docs/test-assets-design.md）：repo assetsDir（缺省 <casesDir>/_assets）
// → sha256 内容寻址入库（data/assets/）→ 随任务下发 worker（hash 缓存下载）。
// 用例经 ternAsset('<相对路径>') 引用（exec-kit prologue 注入全局函数）；
// frontmatter devices 引用资产作为 fake 麦克风/摄像头输入。
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  type Dirent,
} from 'node:fs';
import path from 'node:path';
import type { Runtime } from './runtime.js';
import type { ProjectRow } from './repos.js';
import type { PrepareCaseResult } from '@tern/case-bundler';

export interface AssetRow {
  project_id: number;
  path: string;
  hash: string;
  size: number;
  status: string;
  updated_at: string;
}

/** 单文件上限（可配） */
function maxBytes(): number {
  const v = Number(process.env.ASSET_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 64 * 1024 * 1024;
}

/** 项目资产根目录：tern.yaml assetsDir 覆盖，缺省 <casesDir>/_assets */
export function assetsRoot(rt: Runtime, project: ProjectRow): string {
  const rel = project.assets_dir?.trim() || path.join(project.cases_dir || 'cases', '_assets');
  return path.join(rt.cfg.reposDir, project.dir_name ?? project.name, rel);
}

function walk(dir: string, base: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[];
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, base, out);
    else if (e.isFile()) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
}

export function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** WAV（RIFF/WAVE）文件头校验——devices.mic 要求 */
export function isWavFile(file: string): boolean {
  try {
    const fd = readFileSync(file);
    return (
      fd.length > 44 &&
      fd.toString('ascii', 0, 4) === 'RIFF' &&
      fd.toString('ascii', 8, 12) === 'WAVE'
    );
  } catch {
    return false;
  }
}

/** sync：扫描 assetsDir → 内容寻址入库；返回增删计数（进 sync 报告） */
export function syncProjectAssets(
  rt: Runtime,
  project: ProjectRow,
): { added: number; removed: number } {
  const root = assetsRoot(rt, project);
  const rels: string[] = [];
  if (existsSync(root)) walk(root, root, rels);

  const now = new Date().toISOString();
  const existing = new Map(
    (
      rt.db
        .prepare('SELECT path, hash, status FROM assets WHERE project_id=?')
        .all(project.id) as AssetRow[]
    ).map((r) => [r.path, r]),
  );
  let added = 0;
  for (const rel of rels.sort()) {
    const abs = path.join(root, rel);
    let size: number;
    try {
      size = statSync(abs).size;
    } catch {
      continue;
    }
    if (size > maxBytes()) continue; // 超限文件跳过（lint 会因"资产不存在"报错指出）
    const prev = existing.get(rel);
    let hash: string;
    let unchanged = false;
    if (prev && prev.status === 'active') {
      try {
        if (statSync(path.join(rt.cfg.assetsDir, prev.hash.slice(0, 2), prev.hash)).size === size) {
          hash = prev.hash;
          unchanged = true;
        } else hash = sha256File(abs);
      } catch {
        hash = sha256File(abs);
      }
    } else {
      hash = sha256File(abs);
    }
    if (!unchanged) {
      const target = path.join(rt.cfg.assetsDir, hash.slice(0, 2), hash);
      try {
        copyFileSync(abs, target);
      } catch {
        // 已存在（内容寻址）或目标目录缺失：建目录重试一次
        try {
          mkdirSync(path.dirname(target), { recursive: true });
          copyFileSync(abs, target);
        } catch {
          /* 真失败则交给下发端点的 404 暴露 */
        }
      }
    }
    if (!prev) {
      rt.db
        .prepare(
          'INSERT INTO assets (project_id, path, hash, size, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(project.id, rel, hash, size, 'active', now);
      added++;
    } else if (prev.hash !== hash || prev.status !== 'active') {
      rt.db
        .prepare(
          'UPDATE assets SET hash=?, size=?, status=?, updated_at=? WHERE project_id=? AND path=?',
        )
        .run(hash, size, 'active', now, project.id, rel);
      added++;
    }
    existing.delete(rel);
  }
  // 仓库中消失的资产 → deleted（保留行，历史 run 的 scope 快照仍可追溯；不再下发）
  let removed = 0;
  for (const [rel] of existing) {
    rt.db
      .prepare("UPDATE assets SET status='deleted', updated_at=? WHERE project_id=? AND path=?")
      .run(now, project.id, rel);
    removed++;
  }
  return { added, removed };
}

export function activeAssetMap(rt: Runtime, projectId: number): Map<string, AssetRow> {
  return new Map(
    (
      rt.db
        .prepare("SELECT * FROM assets WHERE project_id=? AND status='active'")
        .all(projectId) as AssetRow[]
    ).map((r) => [r.path, r]),
  );
}

/**
 * 用例资产引用 lint（sync 内逐用例调用）：
 * - devices 引用的资产必须存在（mic 另要求 WAV 头）
 * - ternAsset() 静态引用的资产必须存在
 * 返回 issues（空数组 = 通过）与规范化后的 per-case assets JSON（入库 cases.assets）。
 */
export function lintCaseAssets(
  rt: Runtime,
  projectId: number,
  prep: PrepareCaseResult,
): { issues: { code: string; message: string }[]; assetsJson: string } {
  const issues: { code: string; message: string }[] = [];
  const map = activeAssetMap(rt, projectId);

  const fmMeta = prep.frontmatter?.meta;
  const devicesSpec = fmMeta?.devices;
  let devices: { mic?: string; camera?: string } | null = null;
  if (devicesSpec && !Array.isArray(devicesSpec)) {
    devices = devicesSpec as { mic?: string; camera?: string };
    for (const [k, rel] of Object.entries(devices)) {
      const row = map.get(rel);
      if (!row) {
        issues.push({
          code: 'ASSET_NOT_FOUND',
          message: `devices.${k} 引用的资产不存在: ${rel}（放入项目 _assets/ 目录并 push/sync）`,
        });
        continue;
      }
      if (k === 'mic' && !isWavFile(path.join(rt.cfg.assetsDir, row.hash.slice(0, 2), row.hash))) {
        issues.push({
          code: 'ASSET_BAD_FORMAT',
          message: `devices.mic 需要 WAV（PCM）文件: ${rel}（ffmpeg -ar 16000 -ac 1 转换）`,
        });
      }
    }
  }

  for (const rel of prep.assetRefs) {
    if (!map.has(rel)) {
      issues.push({
        code: 'ASSET_NOT_FOUND',
        message: `ternAsset("${rel}") 引用的资产不存在（放入项目 _assets/ 目录并 push/sync）`,
      });
    }
  }

  // cases.assets 列：devices 原样（对象含文件路径 / 数组仅启用 fake 设备 / null）+ 全部引用路径
  const refs = [
    ...new Set([
      ...(devices ? (Object.values(devices).filter(Boolean) as string[]) : []),
      ...prep.assetRefs,
    ]),
  ];
  return {
    issues,
    assetsJson: JSON.stringify({ devices: devicesSpec ?? null, refs }),
  };
}

/** project 删除时清理资产行（文件按内容寻址共享，不删盘） */
export function purgeProjectAssets(rt: Runtime, projectId: number): void {
  rt.db.prepare('DELETE FROM assets WHERE project_id=?').run(projectId);
}
