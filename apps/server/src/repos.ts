import type { Runtime } from './runtime.js';
import type {
  CreateProjectPayload,
  GitCredentialInput,
  GitCredentialType,
  ProjectInfo,
  ProjectSyncResult,
} from '@tern/sdk';
import { ApiError } from './errors.js';
import { nowISO } from './runtime.js';
import { readAuthRaw } from './auth-config.js';
import { syncProjectCases } from './sync.js';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { parse as yamlParse } from 'yaml';
import { gitWithAuth, resolveGitAuth } from './git.js';

/** 项目仓库根目录下的 meta 文件（描述 project 基本信息与 auth 声明） */
export const META_FILES = ['tern.yaml', 'tern.yml'] as const;

export interface RepoMeta {
  name: string;
  description: string;
  casesDir: string;
  /** 测试资产目录（相对仓库根；null = 缺省 <casesDir>/_assets） */
  assetsDir: string | null;
  defaultTags: string[];
  /** auth profiles：name → 配置（${ENV:VAR} 占位符原样保存，派发时由 worker 解析） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  auth: Record<string, any>;
}

export interface ProjectRow {
  id: number;
  name: string;
  description: string;
  created_at: string;
  source: 'git' | 'local';
  git_url: string | null;
  branch: string | null;
  enabled: number;
  pull_interval_sec: number;
  dir_name: string | null;
  cases_dir: string;
  assets_dir: string | null;
  auth: string;
  default_tags: string;
  last_commit: string | null;
  last_synced_at: string | null;
  sync_status: string | null;
  sync_error: string | null;
  updated_at: string | null;
  cred_type: string;
  cred_user: string | null;
  cred_secret: string | null;
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;

export function projectDir(rt: Runtime, p: ProjectRow): string {
  return path.join(rt.cfg.reposDir, p.dir_name ?? p.name);
}

export function getProject(rt: Runtime, id: number): ProjectRow {
  const row = rt.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
    ProjectRow | undefined;
  if (!row) throw new ApiError(404, 'PROJECT_NOT_FOUND', `项目不存在: ${id}`);
  return row;
}

export function projectInfo(rt: Runtime, r: ProjectRow): ProjectInfo {
  const count = (
    rt.db
      .prepare(`SELECT COUNT(*) AS n FROM cases WHERE project_id = ? AND status = 'active'`)
      .get(r.id) as { n: number }
  ).n;
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    source: r.source,
    gitUrl: r.git_url,
    branch: r.branch,
    enabled: !!r.enabled,
    pullIntervalSec: r.pull_interval_sec,
    credential: {
      type: (r.cred_type as GitCredentialType) || 'none',
      username: r.cred_user ?? null,
      hasSecret: !!r.cred_secret,
    },
    lastCommit: r.last_commit,
    lastSyncedAt: r.last_synced_at,
    syncStatus: r.sync_status,
    syncError: r.sync_error,
    caseCount: count,
    updatedAt: r.updated_at ?? r.created_at,
  };
}

// ---- git 操作（凭据经临时 ASKPASS / 私钥文件注入，不使用宿主机密钥）----

function credOf(row: ProjectRow) {
  return {
    type: ((row.cred_type as GitCredentialType) || 'none') as GitCredentialType,
    username: row.cred_user,
    secret: row.cred_secret,
  };
}

function git(
  dir: string,
  args: string[],
  cred: ReturnType<typeof credOf> = { type: 'none', username: null, secret: null },
  timeoutMs = 120_000,
): Promise<string> {
  return gitWithAuth(dir, args, cred, timeoutMs);
}

export function readRepoMeta(repoDir: string): RepoMeta | null {
  for (const f of META_FILES) {
    const file = path.join(repoDir, f);
    if (!existsSync(file)) continue;
    let doc: Record<string, unknown>;
    try {
      doc = (yamlParse(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
    } catch (e) {
      throw new ApiError(400, 'BAD_META', `${f} 解析失败: ${(e as Error).message}`);
    }
    const name = typeof doc['name'] === 'string' ? doc['name'].trim() : '';
    if (!name) throw new ApiError(400, 'BAD_META', `${f} 缺少必填字段 name`);
    return {
      name,
      description: typeof doc['description'] === 'string' ? doc['description'] : '',
      casesDir:
        typeof doc['casesDir'] === 'string' && doc['casesDir'].trim()
          ? doc['casesDir'].trim()
          : 'cases',
      assetsDir:
        typeof doc['assetsDir'] === 'string' && doc['assetsDir'].trim()
          ? doc['assetsDir'].trim()
          : null,
      defaultTags: Array.isArray(doc['defaultTags'])
        ? (doc['defaultTags'] as unknown[]).map((t) => String(t).toLowerCase()).filter(Boolean)
        : [],
      // 原始 auth 配置（tern.yaml 的 auth:，可被同目录 auth.yaml 覆盖）；归一化在创建 run / 派发时进行
      auth: readAuthRaw(repoDir) ?? {},
    };
  }
  return null;
}

function applyMetaToRow(rt: Runtime, id: number, meta: RepoMeta): void {
  rt.db
    .prepare(
      `UPDATE projects SET description=?, cases_dir=?, assets_dir=?, auth=?, default_tags=?, updated_at=? WHERE id=?`,
    )
    .run(
      meta.description,
      meta.casesDir,
      meta.assetsDir,
      JSON.stringify(meta.auth),
      JSON.stringify(meta.defaultTags),
      nowISO(),
      id,
    );
}

/** 串行队列：git 操作与同步互斥，避免同一仓库并发 clone/pull */
let queueTail: Promise<unknown> = Promise.resolve();
export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueTail.then(fn, fn);
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function cloneRepo(
  rt: Runtime,
  gitUrl: string,
  branch: string | undefined,
  targetDir: string,
  cred: ReturnType<typeof credOf>,
): Promise<void> {
  const tmp = path.join(rt.cfg.reposDir, `.incoming-${ulid().toLowerCase()}`);
  const args = ['clone', '--depth', '1'];
  if (branch) args.push('--branch', branch);
  args.push(gitUrl, tmp);
  try {
    await git(rt.cfg.reposDir, args, cred);
    mkdirSync(path.dirname(targetDir), { recursive: true });
    renameSync(tmp, targetDir);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

/** 添加 git 项目：clone → 读取 tern.yaml → 注册 → 同步用例 */
export async function addGitProject(
  rt: Runtime,
  payload: CreateProjectPayload,
): Promise<{ project: ProjectRow; sync: ProjectSyncResult }> {
  const gitUrlRaw = (payload.gitUrl ?? '').trim();
  if (!gitUrlRaw) throw new ApiError(400, 'BAD_GIT_URL', 'gitUrl 不能为空');
  const resolved = resolveGitAuth(gitUrlRaw, payload.credential);
  return enqueue(async () => {
    const name = (payload.name ?? '').trim();
    if (name && !NAME_RE.test(name)) {
      throw new ApiError(400, 'BAD_NAME', `项目名 "${name}" 不符合 kebab-case 规范`);
    }
    const tmp = path.join(rt.cfg.reposDir, `.incoming-${ulid().toLowerCase()}`);
    const args = ['clone', '--depth', '1'];
    if (payload.branch) args.push('--branch', payload.branch);
    args.push(resolved.gitUrl, tmp);
    try {
      await git(rt.cfg.reposDir, args, resolved);
      const meta = readRepoMeta(tmp);
      if (!meta) {
        throw new ApiError(
          400,
          'META_NOT_FOUND',
          `仓库根目录缺少 meta 文件（${META_FILES.join(' / ')}）`,
        );
      }
      const finalName = name || meta.name;
      if (!NAME_RE.test(finalName)) {
        throw new ApiError(400, 'BAD_NAME', `项目名 "${finalName}" 不符合 kebab-case 规范`);
      }
      const existsRow = rt.db.prepare('SELECT id FROM projects WHERE name = ?').get(finalName);
      if (existsRow) throw new ApiError(409, 'PROJECT_EXISTS', `项目 "${finalName}" 已存在`);
      const finalDir = path.join(rt.cfg.reposDir, finalName);
      if (existsSync(finalDir)) throw new ApiError(409, 'DIR_EXISTS', `目录已存在: ${finalDir}`);
      renameSync(tmp, finalDir);
      const headBranch =
        payload.branch ??
        (await git(finalDir, ['rev-parse', '--abbrev-ref', 'HEAD'], resolved).catch(() => ''));
      const id = rt.db.insertReturningId(
        `INSERT INTO projects (name, description, created_at, source, git_url, branch, enabled, pull_interval_sec, dir_name, cases_dir, auth, default_tags, cred_type, cred_user, cred_secret, updated_at)
           VALUES (?, ?, ?, 'git', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        finalName, meta.description, nowISO(), resolved.gitUrl, headBranch || null, payload.pullIntervalSec ?? rt.cfg.pullIntervalSec, finalName, meta.casesDir, JSON.stringify(meta.auth), JSON.stringify(meta.defaultTags), resolved.type, resolved.username, resolved.secret, nowISO()
      );
      const row = getProject(rt, id);
      const sync = await syncProjectCases(rt, row);
      // 同步会写 last_commit/last_synced_at，重新取最新行返回
      const fresh = getProject(rt, row.id);
      rt.events.emit('projects', 'project.updated', projectInfo(rt, fresh));
      return { project: fresh, sync };
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  });
}

/**
 * 更新一个项目仓库并重新同步用例。
 * git 项目强制对齐远端（fetch + reset --hard + clean -fdx），杜绝本地人工修改；
 * 目录丢失时重新 clone。local 项目仅刷新 meta 并重扫。
 * 注意：内部实现（*Inner）不进串行队列，专供已在队列里的组合任务调用，
 * 避免任务内再 enqueue 造成队列自等待死锁。
 */
export async function updateProjectRepo(rt: Runtime, id: number): Promise<ProjectSyncResult> {
  return enqueue(() => updateProjectRepoInner(rt, id));
}

export async function updateProjectRepoInner(rt: Runtime, id: number): Promise<ProjectSyncResult> {
  const row = getProject(rt, id);
  rt.db
    .prepare(`UPDATE projects SET sync_status='syncing', sync_error=NULL, updated_at=? WHERE id=?`)
    .run(nowISO(), id);
  rt.events.emit('projects', 'project.updated', projectInfo(rt, getProject(rt, id)));
  try {
    const dir = projectDir(rt, row);
    if (row.source === 'git' && row.git_url) {
      const cred = credOf(row);
      if (!existsSync(path.join(dir, '.git'))) {
        rmSync(dir, { recursive: true, force: true });
        await cloneRepo(rt, row.git_url, row.branch ?? undefined, dir, cred);
      } else {
        const branch = row.branch ?? (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], cred));
        await git(dir, ['fetch', 'origin', branch], cred);
        await git(dir, ['reset', '--hard', 'FETCH_HEAD'], cred);
        await git(dir, ['clean', '-fdx'], cred);
      }
    }
    const meta = readRepoMeta(dir);
    if (meta) {
      if (meta.name !== row.name && row.source === 'git') {
        rt.log.warn(
          { project: row.name, metaName: meta.name },
          'meta.name 与注册名不一致，以注册名为准',
        );
      }
      applyMetaToRow(rt, id, meta);
    }
    const fresh = getProject(rt, id);
    const result = await syncProjectCases(rt, fresh);
    rt.db
      .prepare(`UPDATE projects SET sync_status=?, sync_error=NULL, updated_at=? WHERE id=?`)
      .run(result.error ? 'error' : 'ok', nowISO(), id);
    rt.events.emit('projects', 'project.updated', projectInfo(rt, getProject(rt, id)));
    return result;
  } catch (e) {
    const msg = (e as Error).message;
    rt.db
      .prepare(`UPDATE projects SET sync_status='error', sync_error=?, updated_at=? WHERE id=?`)
      .run(msg, nowISO(), id);
    rt.events.emit('projects', 'project.updated', projectInfo(rt, getProject(rt, id)));
    throw e;
  }
}

/**
 * 扫描 reposRoot，自动发现本地放置的用例仓库（含 tern.yaml 即注册为 local project），
 * 并刷新已注册项目的 meta。git 项目目录不在此注册（由 addGitProject 管理）。
 */
export async function discoverLocalProjects(
  rt: Runtime,
): Promise<{ added: string[]; refreshed: number }> {
  return enqueue(() => discoverLocalProjectsInner(rt));
}

export async function discoverLocalProjectsInner(
  rt: Runtime,
): Promise<{ added: string[]; refreshed: number }> {
  {
    const added: string[] = [];
    let refreshed = 0;
    const gitDirs = new Set(
      (
        rt.db
          .prepare(`SELECT dir_name FROM projects WHERE source='git' AND dir_name IS NOT NULL`)
          .all() as {
          dir_name: string;
        }[]
      ).map((r) => r.dir_name),
    );
    let entries: string[] = [];
    try {
      entries = readdirSync(rt.cfg.reposDir);
    } catch {
      return { added, refreshed };
    }
    for (const entry of entries.sort()) {
      if (entry.startsWith('.') || gitDirs.has(entry)) continue;
      const dir = path.join(rt.cfg.reposDir, entry);
      let meta: RepoMeta;
      try {
        const m = readRepoMeta(dir);
        if (!m) continue;
        meta = m;
      } catch (e) {
        rt.log.warn({ dir: entry, err: (e as Error).message }, 'meta 文件解析失败，跳过');
        continue;
      }
      const byDir = rt.db.prepare('SELECT * FROM projects WHERE dir_name = ?').get(entry) as
        ProjectRow | undefined;
      if (byDir) {
        applyMetaToRow(rt, byDir.id, meta);
        refreshed++;
        continue;
      }
      const byName = rt.db.prepare('SELECT * FROM projects WHERE name = ?').get(meta.name) as
        ProjectRow | undefined;
      if (byName) {
        // 已注册项目（如迁移前的旧数据）补上目录映射
        rt.db
          .prepare('UPDATE projects SET dir_name=?, updated_at=? WHERE id=?')
          .run(entry, nowISO(), byName.id);
        applyMetaToRow(rt, byName.id, meta);
        refreshed++;
        continue;
      }
      if (!NAME_RE.test(meta.name)) {
        rt.log.warn({ name: meta.name }, 'meta.name 不符合 kebab-case，跳过注册');
        continue;
      }
      const id = rt.db.insertReturningId(
        `INSERT INTO projects (name, description, created_at, source, enabled, pull_interval_sec, dir_name, cases_dir, auth, default_tags, updated_at)
           VALUES (?, ?, ?, 'local', 1, 0, ?, ?, ?, ?, ?)`,
        meta.name, meta.description, nowISO(), entry, meta.casesDir, JSON.stringify(meta.auth), JSON.stringify(meta.defaultTags), nowISO()
      );
      added.push(meta.name);
      rt.events.emit(
        'projects',
        'project.updated',
        projectInfo(rt, getProject(rt, id)),
      );
    }
    return { added, refreshed };
  }
}

/** 全量同步：发现本地项目 → 逐个更新（git 拉取）+ 重扫用例 */
export async function syncAllProjects(rt: Runtime): Promise<{
  projects: ProjectSyncResult[];
  added: number;
  updated: number;
  removed: number;
  invalid: number;
  error: string | null;
}> {
  await discoverLocalProjects(rt); // 自身会进串行队列，此处调用方在队列外
  const rows = rt.db
    .prepare('SELECT * FROM projects WHERE enabled = 1 ORDER BY id')
    .all() as ProjectRow[];
  const projects: ProjectSyncResult[] = [];
  for (const row of rows) {
    try {
      projects.push(await updateProjectRepo(rt, row.id));
    } catch (e) {
      const res = getProject(rt, row.id);
      projects.push({
        projectId: row.id,
        name: row.name,
        added: 0,
        updated: 0,
        removed: 0,
        invalid: 0,
        commit: res.last_commit,
        error: (e as Error).message,
        invalidCases: [],
      });
    }
  }
  return {
    projects,
    added: projects.reduce((s, p) => s + p.added, 0),
    updated: projects.reduce((s, p) => s + p.updated, 0),
    removed: projects.reduce((s, p) => s + p.removed, 0),
    invalid: projects.reduce((s, p) => s + p.invalid, 0),
    error: null,
  };
}

export function patchProject(
  rt: Runtime,
  id: number,
  body: {
    enabled?: boolean;
    pullIntervalSec?: number;
    branch?: string;
    credential?: GitCredentialInput;
    name?: string;
  },
): ProjectRow {
  const row = getProject(rt, id);
  const enabled = body.enabled ?? !!row.enabled;
  const pull = body.pullIntervalSec ?? row.pull_interval_sec;
  const branch = body.branch ?? row.branch;
  if (pull < 0 || pull > 86_400)
    throw new ApiError(400, 'BAD_INTERVAL', 'pullIntervalSec 取值 0~86400（0 = 不自动拉取）');

  let name = row.name;
  if (body.name !== undefined && body.name !== row.name) {
    // 改名 = 切换 caseId 第一段（项目名/用例路径）。git 项目注册名与仓库 tern.yaml 的 name
    // 不一致时以注册名为准——两边对齐的方式是改完仓库 yaml 后再用本字段同步注册名。
    const next = String(body.name).trim();
    if (!NAME_RE.test(next)) {
      throw new ApiError(
        400,
        'BAD_NAME',
        '项目名需为小写 kebab-case：字母开头，可含小写字母/数字/连字符',
      );
    }
    const taken = rt.db
      .prepare('SELECT id FROM projects WHERE name=? AND id!=?')
      .get(next, row.id) as { id: number } | undefined;
    if (taken) throw new ApiError(409, 'NAME_TAKEN', `项目名已被占用: ${next}`);
    name = next;
    // 克隆目录按名字定位（dir_name 为空时）：连 git 缓存一起搬过去，省一次重新 clone
    if (!row.dir_name) {
      const from = path.join(rt.cfg.reposDir, row.name);
      const to = path.join(rt.cfg.reposDir, next);
      try {
        if (existsSync(path.join(from, '.git')) && !existsSync(to)) renameSync(from, to);
      } catch {
        /* 搬移失败不影响改名：下次 sync 会重新 clone */
      }
    }
  }

  let credType = row.cred_type || 'none';
  let credUser = row.cred_user;
  let credSecret = row.cred_secret;
  let gitUrl = row.git_url;
  if (body.credential) {
    const mergedSecret =
      body.credential.secret != null && String(body.credential.secret).trim() !== ''
        ? body.credential.secret
        : body.credential.type === 'none'
          ? null
          : row.cred_secret;
    const resolved = resolveGitAuth(row.git_url ?? '', {
      type: body.credential.type,
      username: body.credential.username ?? row.cred_user ?? undefined,
      secret: mergedSecret ?? undefined,
    });
    credType = resolved.type;
    credUser = resolved.username;
    credSecret = resolved.secret;
    if (resolved.gitUrl) gitUrl = resolved.gitUrl;
  }

  rt.db
    .prepare(
      `UPDATE projects SET name=?, enabled=?, pull_interval_sec=?, branch=?, git_url=?, cred_type=?, cred_user=?, cred_secret=?, updated_at=? WHERE id=?`,
    )
    .run(
      name,
      enabled ? 1 : 0,
      Math.round(pull),
      branch,
      gitUrl,
      credType,
      credUser,
      credSecret,
      nowISO(),
      row.id,
    );
  const updated = getProject(rt, row.id);
  rt.events.emit('projects', 'project.updated', projectInfo(rt, updated));
  return updated;
}

export async function removeProject(rt: Runtime, id: number, removeFiles: boolean): Promise<void> {
  // 进串行队列：与定时拉取/手动更新互斥，避免删除后又被 clone 回来
  return enqueue(async () => {
    const row = getProject(rt, id);
    const dir = projectDir(rt, row);
    const tx = rt.db.transaction(() => {
      // 先清子表（foreign_keys=ON）：cases 系 + 迁移 7 新表
      rt.db
        .prepare(`DELETE FROM case_tags WHERE case_id IN (SELECT id FROM cases WHERE project_id=?)`)
        .run(id);
      rt.db
        .prepare(
          `DELETE FROM case_stats WHERE case_id IN (SELECT id FROM cases WHERE project_id=?)`,
        )
        .run(id);
      rt.db.prepare(`DELETE FROM cases WHERE project_id=?`).run(id);
      rt.db.prepare('DELETE FROM assets WHERE project_id=?').run(id);
      rt.db.prepare('DELETE FROM env_variables WHERE project_id=?').run(id);
      rt.db.prepare('DELETE FROM environments WHERE project_id=?').run(id);
      rt.db.prepare('DELETE FROM suites WHERE project_id=?').run(id);
      rt.db.prepare('DELETE FROM schedules WHERE project_id=?').run(id);
      rt.db.prepare('DELETE FROM webhooks WHERE project_id=?').run(id);
      rt.db.prepare('DELETE FROM projects WHERE id=?').run(id);
    });
    tx();
    if (removeFiles && row.source === 'git' && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
    rt.events.emit('projects', 'project.updated', { id, removed: true });
    rt.log.info({ project: row.name, removeFiles }, 'project removed');
  });
}
