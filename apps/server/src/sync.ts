import type { Runtime } from './runtime.js';
import type { ProjectSyncResult } from '@tern/sdk';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { prepareCase, scanCaseFiles, parseFrontmatter } from '@tern/case-bundler';
import { checkAuthRef, normalizeAuthConfig } from './auth-config.js';
import { syncEnvVariables } from './envs.js';
import { lintCaseAssets, syncProjectAssets } from './assets.js';
import { projectDir, type ProjectRow } from './repos.js';

/** 读取项目仓库允许 import 的第三方依赖（repo 根或 cases 目录的 package.json dependencies） */
function readAllowedDeps(repoDir: string, casesDir: string): string[] {
  for (const base of [path.join(repoDir, casesDir), repoDir]) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(base, 'package.json'), 'utf8'));
      const deps = pkg.dependencies ?? {};
      if (Object.keys(deps).length) return Object.keys(deps);
    } catch {
      // 继续尝试上一级
    }
  }
  return [];
}

function gitHead(dir: string): string | null {
  try {
    const out = execSync('git rev-parse HEAD', {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString().trim() || null;
  } catch {
    return null;
  }
}

function recordSyncRun(
  rt: Runtime,
  project: ProjectRow,
  r: Omit<ProjectSyncResult, 'projectId' | 'name' | 'invalidCases'> & {
    invalidCases: { caseId: string; error: string }[];
  },
  startedAt: string,
): number {
  const id = rt.db.insertReturningId(
    'INSERT INTO sync_runs (project_id, started_at) VALUES (?, ?)',
    project.id, startedAt
  );
  rt.db
    .prepare(
      'UPDATE sync_runs SET finished_at=?, added=?, updated=?, removed=?, invalid=?, git_commit=?, error=? WHERE id=?',
    )
    .run(
      new Date().toISOString(),
      r.added,
      r.updated,
      r.removed,
      r.invalid,
      r.commit,
      r.error,
      id,
    );
  return id;
}

/**
 * 同步单个项目的用例：扫描 casesDir → frontmatter/lint/打包 → 入库。
 * caseId = `<项目名>/<相对路径>`，全局唯一；frontmatter 的 version/module/auth 一并入库。
 */
export async function syncProjectCases(
  rt: Runtime,
  project: ProjectRow,
): Promise<ProjectSyncResult> {
  const db = rt.db;
  const startedAt = new Date().toISOString();
  const repoDir = projectDir(rt, project);
  const result: ProjectSyncResult = {
    projectId: project.id,
    name: project.name,
    added: 0,
    updated: 0,
    removed: 0,
    invalid: 0,
    commit: null,
    error: null,
    invalidCases: [],
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const authSnapshot = normalizeAuthConfig(JSON.parse(project.auth || '{}') || undefined);
  const defaultTags = JSON.parse(project.default_tags || '[]') as string[];

  const casesDirAbs = path.join(repoDir, project.cases_dir || 'cases');
  if (!existsSync(casesDirAbs)) {
    const stale = db
      .prepare(
        `SELECT COUNT(*) AS n FROM cases WHERE project_id=? AND status IN ('active','invalid','disabled')`,
      )
      .get(project.id) as { n: number };
    db.prepare(`UPDATE cases SET status='deleted', updated_at=? WHERE project_id=?`).run(
      new Date().toISOString(),
      project.id,
    );
    result.removed = stale.n;
    result.error = `用例目录不存在: ${casesDirAbs}`;
    db.prepare('UPDATE projects SET last_synced_at=?, sync_error=? WHERE id=?').run(
      new Date().toISOString(),
      result.error,
      project.id,
    );
    recordSyncRun(rt, project, result, startedAt);
    return result;
  }

  try {
    const allowedDeps = readAllowedDeps(repoDir, project.cases_dir || 'cases');
    // 资产先行入库（用例的 devices / ternAsset 引用 lint 依赖资产表）
    const assetsStat = syncProjectAssets(rt, project);
    result.assetsAdded = assetsStat.added;
    result.assetsRemoved = assetsStat.removed;
    const files = scanCaseFiles(casesDirAbs);
    const now = new Date().toISOString();
    const seen = new Set<string>();

    for (const absPath of files) {
      let prep;
      try {
        prep = prepareCase({
          absPath,
          casesDir: casesDirAbs,
          bundlesDir: rt.cfg.bundlesDir,
          allowedDeps,
        });
      } catch (e) {
        const relPath = path.relative(casesDirAbs, absPath).split(path.sep).join('/');
        prep = {
          ok: false,
          relPath,
          caseId: relPath.replace(/\.spec\.ts$/, ''),
          project: '',
          source: '',
          contentHash: '',
          bundleHash: null,
          bundlePath: null,
          frontmatter: null,
          assetRefs: [],
          issues: [{ code: 'BUNDLE_ERROR', message: (e as Error).message }],
        };
      }
      const caseId = `${project.name}/${prep.caseId}`;
      seen.add(caseId);

      // auth 解析：frontmatter 只存名字（default / 账号名 / none / 多配方名），
      // 登录配方在创建 run 时从仓库现读并快照（docs/auth-design.md §3）
      const fm = prep.frontmatter as ReturnType<typeof parseFrontmatter> | null;
      let authName: string | null = null;
      if (fm && !fm.errors.length && fm.meta.auth) {
        try {
          checkAuthRef(authSnapshot, fm.meta.auth, `用例 ${caseId}`);
          authName = fm.meta.auth;
        } catch (e) {
          prep.issues.push({
            code: (e as { code?: string }).code ?? 'AUTH_PROFILE_NOT_FOUND',
            message: (e as Error).message,
          });
        }
      }
      // 资产引用 lint（devices / ternAsset）；结果随用例入库（cases.assets）
      const assetLint = lintCaseAssets(rt, project.id, prep);
      prep.issues.push(...assetLint.issues);
      const caseAssetsJson = assetLint.assetsJson;
      if (prep.issues.length > 0) result.invalid++;

      const fmMeta = fm?.meta;
      const title = fmMeta?.title ?? '(无 title)';
      const description = fmMeta?.description ?? '';
      const timeoutS = fmMeta?.timeout ?? rt.cfg.caseDefaultTimeoutS;
      const retries = fmMeta?.retries ?? 0;
      const disabled = fmMeta?.disabled ? 1 : 0;
      const version = fmMeta?.version ?? null;
      const module = fmMeta?.module ?? null;
      const extraMeta = JSON.stringify(fmMeta?.meta ?? {});
      const traceMode = fmMeta?.trace ?? null;
      const lastError = prep.issues.length
        ? prep.issues.map((i) => `[${i.code}] ${i.message}`).join('\n')
        : null;
      if (lastError) result.invalidCases.push({ caseId, error: lastError });

      const status = prep.issues.length ? 'invalid' : disabled ? 'disabled' : 'active';
      const filePath = `${project.dir_name ?? project.name}/${project.cases_dir || 'cases'}/${prep.relPath}`;
      const existing = db
        .prepare('SELECT id, content_hash, bundle_hash, status, trace_mode FROM cases WHERE id = ?')
        .get(caseId) as
        | {
            id: string;
            content_hash: string;
            bundle_hash: string | null;
            status: string;
            trace_mode: string | null;
          }
        | undefined;

      if (!existing) {
        db.prepare(
          `INSERT INTO cases (id, project_id, title, description, file_path, source, timeout_s, retries, disabled, version, module, auth, meta, content_hash, bundle_hash, status, last_error, assets, trace_mode, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          caseId,
          project.id,
          title,
          description,
          filePath,
          prep.source,
          timeoutS,
          retries,
          disabled,
          version,
          module,
          authName,
          extraMeta,
          prep.contentHash,
          prep.bundleHash,
          status,
          lastError,
          caseAssetsJson,
          traceMode,
          now,
          now,
        );
        if (!prep.issues.length) result.added++;
      } else if (
        existing.content_hash !== prep.contentHash ||
        existing.status !== status ||
        existing.bundle_hash !== prep.bundleHash ||
        // trace_mode 变化也要落库：否则平台升级后（旧 sync 未写过该列）内容未变的用例永远不回填
        (existing.trace_mode ?? null) !== traceMode
      ) {
        // bundle_hash 参与比较：用例源码未变但共享库（_lib 相对依赖）变化时，
        // esbuild 产物已不同，必须刷新 bundle 指针否则修改不生效
        db.prepare(
          `UPDATE cases SET project_id=?, title=?, description=?, file_path=?, source=?, timeout_s=?, retries=?, disabled=?, version=?, module=?, auth=?, meta=?, content_hash=?, bundle_hash=?, status=?, last_error=?, assets=?, trace_mode=?, updated_at=? WHERE id=?`,
        ).run(
          project.id,
          title,
          description,
          filePath,
          prep.source,
          timeoutS,
          retries,
          disabled,
          version,
          module,
          authName,
          extraMeta,
          prep.contentHash,
          prep.bundleHash,
          status,
          lastError,
          caseAssetsJson,
          traceMode,
          now,
          caseId,
        );
        result.updated++;
      }

      if (!prep.issues.length) {
        db.prepare('DELETE FROM case_tags WHERE case_id = ?').run(caseId);
        const insTag = db.prepare(`${db.insertOrIgnore('case_tags', ['case_id', 'tag'])} VALUES (?, ?)`);
        for (const t of new Set([...(fmMeta?.tags ?? []), ...defaultTags])) insTag.run(caseId, t);
      }
    }

    // 该项目内消失的文件 → deleted（只影响本项目，不动其他 project）
    const activeRows = db
      .prepare(
        `SELECT id FROM cases WHERE project_id=? AND status IN ('active','invalid','disabled')`,
      )
      .all(project.id) as { id: string }[];
    for (const row of activeRows) {
      if (!seen.has(row.id)) {
        db.prepare(`UPDATE cases SET status='deleted', updated_at=? WHERE id=?`).run(now, row.id);
        result.removed++;
      }
    }

    result.commit = gitHead(repoDir);
    // 环境变量清单镜像（tern.yaml env.variables → env_variables 表）；告警进 sync 报告
    result.envWarnings = syncEnvVariables(rt, project.id, repoDir);
    db.prepare(
      'UPDATE projects SET last_commit=?, last_synced_at=?, sync_error=NULL WHERE id=?',
    ).run(result.commit, now, project.id);
    recordSyncRun(rt, project, result, startedAt);
    rt.log.info(
      {
        project: project.name,
        added: result.added,
        updated: result.updated,
        removed: result.removed,
        invalid: result.invalid,
      },
      'project sync completed',
    );
    rt.events.emit('system', 'sync.completed', { ...result });
  } catch (e) {
    result.error = (e as Error).message;
    db.prepare('UPDATE projects SET last_synced_at=?, sync_error=? WHERE id=?').run(
      new Date().toISOString(),
      result.error,
      project.id,
    );
    recordSyncRun(rt, project, result, startedAt);
    rt.log.error({ err: result.error, project: project.name }, 'project sync failed');
  }
  return result;
}
