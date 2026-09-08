#!/usr/bin/env node
// tern —— Tern E2E 测试平台 CLI（与 MCP 共享同一 API client）
import { readFileSync } from 'node:fs';
import { TernClient, ApiError } from '@tern/sdk';
import type { GitCredentialInput } from '@tern/sdk';

function usage(): string {
  return `tern —— Tern E2E 测试平台 CLI

用法:
  tern meta                                        查看平台状态
  tern projects [list] [--json]                    列出用例项目
  tern projects add <gitUrl> [--branch b] [--name n] [--pull-interval-s n]
                   [--user u] [--password p] [--ssh-key-file path]
                                                   添加 git 用例仓库（clone + 首次同步）
                                                   默认 HTTP 账号密码；SSH 需提供私钥文件（容器内不用宿主机密钥）
  tern projects sync <id|name>                     强制更新单个项目（git: fetch+reset+clean 后重扫）
  tern projects remove <id|name> [--purge]         移除项目（--purge 同时删除 clone 目录）
  tern projects rename <id|name> <newName>         改名（自动重新同步；caseId 随之换成 新项目名/…）
  tern projects discover                           扫描 REPOS_DIR 注册本地放置的仓库
  tern assets list <project> [--json]               列出项目测试资产（cases/_assets/，含 hash/大小/状态）
  tern env list <project>                          查看项目变量清单（tern.yaml env.variables）与各环境完备性
  tern env create <project> <env> --set K=V,... [--set-secret K=V,...] [--desc s]
                                                   创建环境（secret 值加密存储不回显）
  tern env set <project> <env> --set K=V,... [--set-secret K=V,...]
                                                   整体替换环境值
  tern env rm <project> <env>                      删除环境
  tern sync                                        全量同步所有项目（等同页面"全部更新"）
  tern cases list [--project p] [--version v1,v2] [--module m] [--tags a,b]
                  [--tag-mode any|all] [--q s] [--quarantine exclude|only|all]
                  [--limit n] [--offset n] [--json]
  tern cases show <caseId>                         查看用例元数据与源码
  tern cases quarantine <caseId>                   手动隔离（flaky 治理；默认不参与新建运行）
  tern cases unquarantine <caseId>                 解除隔离
  tern run [--case id | --project p | --tags a,b | --version v | --module m | --suite name]
            [--suite name2] [--exclude-tags x] [--tag-mode any|all] [--worker id|name] [--env name]
            [--params K=V,K=V] [--include-quarantined] [--title t] [--max-attempts n] [--wait] [--timeout-s n] [--json]
                                                   引用测试集（可多个，各用各的 env 绑定，按「用例×环境」去重；
                                                   显式 --env = 覆盖拉平为单一环境）
  tern runs list [--status s] [--project p] [--env name] [--suite name] [--q s] [--created-by x] [--worker id] [--json]
  tern runs show <runId> [--json]
  tern runs wait <runId> [--timeout-s n] [--json]
  tern runs cancel <runId> [--soft]            结束运行：默认强制结束（不等回执，中断全部阶段，
                                                  掉线 worker 重连后补发中断）；--soft 仅通知执行中的用例
  tern runs delete <runId> [--force]               删除 run（级联记录 + 清理截图/trace/日志产物）
  tern suites <project> list [--json]              列出项目测试集（含命中数与健康徽标）
  tern suites <project> show <name> [--json]
  tern suites <project> create <name> [--desc s] [--tag a,b] [--tag-mode any|all] [--exclude-tag x,y]
                   [--module m] [--version v] [--q s] [--include id1,id2] [--exclude id3]
                   [--env name] [--account name] [--param K=V] [--disabled]
  tern suites <project> update <name> [...同 create 的字段，提供才改] [--rename newName]
  tern suites <project> rm <name>
  tern suites <project> preview [--tag a,b ...同 create 的选择器参数]   不落库看命中
  tern retry-failed <runId> [--json]                只重跑该运行中失败的用例
  tern rerun <runId> [--json]                       重跑该运行的全部用例
  tern failures <runId>                            列出失败用例及错误摘要
  tern schedules [list] [--json]                   列出定时任务
  tern schedules create <project> <name> --cron '0 9 * * 1-5' [--env name]
                        [--tags a,b] [--version v] [--module m] [--params K=V]
                        [--worker id] [--title-prefix s] [--disabled]
  tern schedules pause <scheduleId>                暂停
  tern schedules resume <scheduleId>               恢复
  tern schedules rm <scheduleId>                   删除
  tern workers [--json]

环境变量:
  TERN_URL      平台地址（默认本地实例 http://127.0.0.1:7430）
  TERN_TOKEN    可选 API_TOKEN
`;
}

function clientFromEnv(): TernClient {
  return new TernClient({
    // 默认指向本地平台实例；自建/远端平台用 TERN_URL 覆盖
    baseUrl: process.env.TERN_URL ?? 'http://127.0.0.1:7430',
    token: process.env.TERN_TOKEN,
  });
}

function parseArgs(argv: string[]): Record<string, string | boolean | string[]> {
  const out: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const value = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
      // 重复出现的 flag 收集为字符串数组（如 --suite smoke --suite regression；也兼容 --suite a,b）
      if (key in out) {
        const prev = out[key];
        const list: string[] = Array.isArray(prev) ? prev : typeof prev === 'string' ? [prev] : [];
        out[key] = typeof value === 'string' ? [...list, value] : list.length > 0 ? list : value;
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}

function kvParse(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (s ?? '').split(',')) {
    if (!pair) continue;
    const idx = pair.indexOf('=');
    if (idx > 0) out[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return out;
}

const csv = (s: string | boolean | string[] | undefined): string[] | undefined =>
  s === undefined || s === true || s === ''
    ? undefined
    : (Array.isArray(s) ? s : [s])
        .flatMap((x) => String(x).split(','))
        .map((t) => t.trim())
        .filter(Boolean);

const one = (s: string | boolean | string[] | undefined): string | undefined =>
  s === undefined || s === true || Array.isArray(s)
    ? Array.isArray(s)
      ? String(s[0])
      : undefined
    : String(s);

const jsonOut = (_args: Record<string, string | boolean | string[]>, v: unknown) =>
  console.log(JSON.stringify(v, null, 2));

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'cancelled';
}

async function waitRun(c: TernClient, runId: string, timeoutS: number) {
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const b = await c.run(runId);
    if (isTerminal(b.status)) return b;
    if (Date.now() > deadline)
      throw new Error(`等待测试运行超时（${timeoutS}s），当前状态 ${b.status}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function resolveProject(c: TernClient, idOrName: string): Promise<number> {
  const list = await c.projects();
  const hit = list.find((p) => String(p.id) === idOrName || p.name === idOrName);
  if (!hit) throw new Error(`项目不存在: ${idOrName}`);
  return hit.id;
}

function credentialFromArgs(
  args: Record<string, string | boolean | string[]>,
): GitCredentialInput | undefined {
  const keyFile = one(args['ssh-key-file']);
  if (typeof keyFile === 'string' && keyFile) {
    return { type: 'ssh', secret: readFileSync(keyFile, 'utf8') };
  }
  const user = one(args.user);
  const password = one(args.password);
  if (user || password) return { type: 'password', username: user, secret: password };
  return undefined;
}

async function main(): Promise<number> {
  const [cmd, second, ...restAll] = process.argv.slice(2);
  const sub = second && !second.startsWith('--') ? second : undefined;
  const rest = sub ? restAll : [second, ...restAll].filter(Boolean).map(String);
  const args = parseArgs(rest);
  const c = clientFromEnv();
  const wantJson = !!args.json;

  try {
    switch (cmd) {
      case undefined:
      case 'help':
      case '--help':
        console.log(usage());
        return 0;

      case 'meta':
        jsonOut(args, await c.meta());
        return 0;

      case 'projects': {
        if (sub === 'add') {
          const gitUrl = restAll.find((r) => !r.startsWith('--') && r !== 'add');
          if (!gitUrl)
            throw new Error(
              '用法: tern projects add <gitUrl> [--branch b] [--name n] [--user u] [--password p] [--ssh-key-file path]',
            );
          const r = await c.addProject({
            gitUrl,
            branch: args.branch as string | undefined,
            name: args.name as string | undefined,
            pullIntervalSec: args['pull-interval-s'] ? Number(args['pull-interval-s']) : undefined,
            credential: credentialFromArgs(args),
          });
          jsonOut(args, {
            project: r.project,
            sync: {
              added: r.sync.added,
              updated: r.sync.updated,
              invalid: r.sync.invalid,
              error: r.sync.error,
            },
          });
          return r.sync.error ? 1 : r.sync.invalid > 0 ? 2 : 0;
        }
        if (sub === 'sync') {
          const idOrName = restAll.find((r) => !r.startsWith('--') && r !== 'sync');
          if (!idOrName) throw new Error('用法: tern projects sync <id|name>');
          const r = await c.syncProject(await resolveProject(c, idOrName));
          jsonOut(args, r);
          return r.error ? 1 : r.invalid > 0 ? 2 : 0;
        }
        if (sub === 'remove') {
          const idOrName = restAll.find((r) => !r.startsWith('--') && r !== 'remove');
          if (!idOrName) throw new Error('用法: tern projects remove <id|name> [--purge]');
          await c.removeProject(await resolveProject(c, idOrName), args.purge === true);
          console.log('已移除');
          return 0;
        }
        if (sub === 'rename') {
          // 改名 = caseId 第一段切换：服务端自动重新同步（响应带 sync 结果）
          const positional = restAll.filter((r) => !r.startsWith('--') && r !== 'rename');
          const [idOrName, newName] = positional;
          if (!idOrName || !newName)
            throw new Error('用法: tern projects rename <id|name> <newName>');
          const r = await c.updateProject(await resolveProject(c, idOrName), { name: newName });
          if (wantJson) {
            jsonOut(args, r);
          } else {
            console.log(`已改名: ${idOrName} -> ${r.project.name}`);
            if (r.sync)
              console.log(
                `已重新同步: +${r.sync.added} ~${r.sync.updated} -${r.sync.removed}${r.sync.invalid ? ` invalid=${r.sync.invalid}` : ''}`,
              );
          }
          return r.sync?.error ? 1 : 0;
        }
        if (sub === 'discover') {
          jsonOut(args, await c.discoverProjects());
          return 0;
        }
        const list = await c.projects();
        if (wantJson) jsonOut(args, list);
        else
          for (const p of list)
            console.log(
              `${p.enabled ? '' : '[停用] '}${p.id}  ${p.name}  (${p.source}${p.branch ? `@${p.branch}` : ''})  用例 ${p.caseCount}` +
                `  认证 ${p.credential.type}${p.credential.username ? `(${p.credential.username})` : ''}` +
                `  ${p.syncStatus === 'error' ? `同步失败: ${p.syncError ?? ''}` : p.lastCommit ? p.lastCommit.slice(0, 8) : '未同步'}`,
            );
        return 0;
      }

      case 'sync': {
        const r = await c.sync();
        if (wantJson) jsonOut(args, r);
        else {
          for (const p of r.projects) {
            console.log(
              `${p.error ? '✗' : '✓'} ${p.name}: +${p.added} ~${p.updated} -${p.removed} invalid ${p.invalid}` +
                (p.commit ? ` @ ${p.commit.slice(0, 8)}` : '') +
                (p.error ? `  错误: ${p.error}` : ''),
            );
            for (const w of p.envWarnings ?? []) console.log(`   ⚠ ${w}`);
          }
        }
        return r.invalid > 0 ? 2 : 0;
      }

      case 'assets': {
        const p = restAll.find((r) => !r.startsWith('--') && r !== 'list');
        if (!p) throw new Error('用法: tern assets list <project> [--json]');
        const id = await resolveProject(c, p);
        const r = await c.projectAssets(id);
        if (wantJson) {
          jsonOut(args, r);
        } else {
          for (const a of r.items) {
            console.log(
              `${a.status === 'active' ? '' : '[已删] '}${a.path}  ${(a.bytes / 1024).toFixed(0)}KB  ${a.hash.slice(0, 12)}…`,
            );
          }
          console.log(`-- 共 ${r.items.length} 个资产`);
        }
        return 0;
      }

      case 'env': {
        if (sub === 'list') {
          const p = restAll.find((r) => !r.startsWith('--') && r !== 'list');
          if (!p) throw new Error('用法: tern env list <project>');
          const id = await resolveProject(c, p);
          const [{ variables }, { items }] = await Promise.all([
            c.envVariables(id),
            c.environments(id),
          ]);
          jsonOut(args, { variables, environments: items });
          return 0;
        }
        if (sub === 'create' || sub === 'set') {
          const positional = restAll.filter((r) => !r.startsWith('--') && r !== sub);
          const [p, envName] = positional;
          if (!p || !envName)
            throw new Error(
              `用法: tern env ${sub} <project> <env> --set K=V,... [--set-secret K=V,...]`,
            );
          const id = await resolveProject(c, p);
          const values = {
            ...kvParse(args.set as string | undefined),
            ...kvParse(args['set-secret'] as string | undefined),
          };
          const r =
            sub === 'create'
              ? await c.createEnvironment(id, {
                  name: envName,
                  description: args.desc as string | undefined,
                  values,
                })
              : await c.updateEnvironment(id, envName, { values });
          jsonOut(args, r.environment);
          return 0;
        }
        if (sub === 'rm') {
          const positional = restAll.filter((r) => !r.startsWith('--') && r !== 'rm');
          const [p, envName] = positional;
          if (!p || !envName) throw new Error('用法: tern env rm <project> <env>');
          await c.deleteEnvironment(await resolveProject(c, p), envName);
          console.log('已删除');
          return 0;
        }
        throw new Error('用法: tern env list|create|set|rm');
      }

      case 'cases': {
        if (sub === 'list') {
          const r = await c.cases({
            project: args.project as string | undefined,
            version: csv(args.version),
            module: csv(args.module),
            tags: csv(args.tags),
            tagMode: (args['tag-mode'] as 'any' | 'all') ?? 'any',
            q: args.q as string | undefined,
            status: 'active',
            quarantine: (args.quarantine as 'exclude' | 'only' | 'all') ?? undefined,
            limit: args.limit ? Number(args.limit) : 200,
            offset: args.offset ? Number(args.offset) : 0,
          });
          if (wantJson) {
            jsonOut(args, r);
          } else {
            for (const it of r.items) {
              console.log(
                `${it.quarantined ? '[隔离] ' : ''}${it.caseId}  [${it.tags.join(',')}]${it.version ? ` v=${it.version}` : ''}${it.module ? ` m=${it.module}` : ''}` +
                  (it.flakyStats && it.flakyStats.flaky > 0
                    ? `  flaky ${it.flakyStats.flaky}/${it.flakyStats.total}`
                    : '') +
                  `  ${it.title}`,
              );
            }
            console.log(`-- 共 ${r.total} 条（limit ${r.limit} offset ${r.offset}）`);
          }
          return 0;
        }
        if (sub === 'show') {
          const id = rest.find((r) => !r.startsWith('--'));
          if (!id) throw new Error('用法: tern cases show <caseId>');
          jsonOut(args, await c.case(id));
          return 0;
        }
        if (sub === 'quarantine' || sub === 'unquarantine') {
          const id = rest.find((r) => !r.startsWith('--'));
          if (!id) throw new Error(`用法: tern cases ${sub} <caseId>`);
          await c.patchCase(id, { quarantined: sub === 'quarantine' });
          console.log(
            sub === 'quarantine' ? '已隔离（默认不参与新建运行，可显式点名）' : '已解除隔离',
          );
          return 0;
        }
        throw new Error('用法: tern cases list|show|quarantine|unquarantine');
      }

      case 'run': {
        const payload = {
          title: one(args.title),
          project: one(args.project),
          caseIds: args.case
            ? [String(Array.isArray(args.case) ? args.case[0] : args.case)]
            : undefined,
          suites: csv(args.suite),
          version: csv(args.version),
          module: csv(args.module),
          tags: csv(args.tags),
          tagMode: (one(args['tag-mode']) as 'any' | 'all') ?? 'any',
          excludeTags: csv(args['exclude-tags']),
          env: one(args.env),
          workerId: one(args.worker),
          params: kvParse(one(args.params)),
          maxAttempts: args['max-attempts'] ? Number(one(args['max-attempts'])) : undefined,
          includeQuarantined: args['include-quarantined'] === true ? true : undefined,
          createdBy: 'cli',
        };
        if (!payload.suites?.length) delete payload.suites;
        const { run } = await c.createRun(payload);
        if (!args.wait) {
          jsonOut(args, {
            runId: run.id,
            status: run.status,
            total: run.total,
            suites: run.suites,
            envs: run.envs,
          });
          return 0;
        }
        const done = await waitRun(c, run.id, Number(one(args['timeout-s']) ?? 3600));
        const failed = done.failed + done.timedOut + done.error;
        if (wantJson) jsonOut(args, done);
        else
          console.log(
            `测试运行 ${done.id} ${done.status}: 总 ${done.total} 通过 ${done.passed} 失败 ${done.failed} 超时 ${done.timedOut} 错误 ${done.error} 跳过 ${done.skipped}` +
              (done.envs.length ? `（环境: ${done.envs.join(', ')}）` : ''),
          );
        return failed;
      }

      case 'batch':
      case 'runs': {
        const id = rest.find((r) => !r.startsWith('--'));
        if (sub === 'list' || sub === undefined) {
          const r = await c.runs({
            status: (args.status as 'all') ?? undefined,
            project: one(args.project),
            env: one(args.env),
            suite: one(args.suite),
            q: one(args.q),
            createdBy: one(args['created-by']),
            workerId: one(args.worker),
            limit: args.limit ? Number(one(args.limit)) : 20,
            offset: args.offset ? Number(one(args.offset)) : 0,
          });
          jsonOut(args, r);
          return 0;
        }
        if (sub === 'show') {
          if (!id) throw new Error('用法: tern runs show <runId>');
          jsonOut(args, await c.run(id));
          return 0;
        }
        if (sub === 'wait') {
          if (!id) throw new Error('用法: tern runs wait <runId>');
          const b = await waitRun(c, id, Number(args['timeout-s'] ?? 3600));
          const failed = b.failed + b.timedOut + b.error;
          jsonOut(args, wantJson ? b : { id: b.id, status: b.status, failed });
          return wantJson ? 0 : failed;
        }
        if (sub === 'cancel') {
          if (!id) throw new Error('用法: tern runs cancel <runId> [--soft]');
          const soft = args.soft === true;
          await c.cancelRun(id, !soft);
          console.log(soft ? '已取消（软取消：仅通知执行中的用例）' : '已强制结束');
          return 0;
        }
        if (sub === 'delete') {
          if (!id) throw new Error('用法: tern runs delete <runId> [--force]');
          const r = await c.deleteRun(id, args.force === true);
          console.log(`已删除（含 ${r.removedExecutions} 条执行记录与产物文件）`);
          return 0;
        }
        throw new Error('用法: tern runs list|show|wait|cancel|delete');
      }

      case 'suites': {
        const positional = restAll.filter((r) => !r.startsWith('--') && r !== sub);
        const [p, name] = positional;
        const id = p ? await resolveProject(c, p) : undefined;
        if (!id) throw new Error('用法: tern suites <project> list|show|create|update|rm|preview');
        const selectorFromArgs = () => {
          const selector: Record<string, unknown> = {};
          if (csv(args.tags)) selector.tags = csv(args.tags);
          if (one(args['tag-mode'])) selector.tagMode = one(args['tag-mode']);
          if (csv(args['exclude-tags'])) selector.excludeTags = csv(args['exclude-tags']);
          if (csv(args.module)) selector.module = csv(args.module);
          if (csv(args.version)) selector.version = csv(args.version);
          if (one(args.q)) selector.q = one(args.q);
          if (csv(args.include)) selector.includeCaseIds = csv(args.include);
          if (csv(args.exclude)) selector.excludeCaseIds = csv(args.exclude);
          return Object.keys(selector).length ? selector : undefined;
        };
        if (sub === 'list' || sub === undefined) {
          const { items } = await c.suites(id);
          if (wantJson) jsonOut(args, items);
          else
            for (const s of items) {
              const badges = [
                s.env
                  ? `env=${s.env}${s.health.envStatus && s.health.envStatus !== 'ok' ? `(${s.health.envStatus})` : ''}`
                  : null,
                s.account ? `账号=${s.account}` : null,
                s.health.isFullProject ? '全量' : null,
                s.health.resolvedCount === 0 ? '空集!' : null,
                s.health.danglingIncludes.length
                  ? `悬空引用 ${s.health.danglingIncludes.length}`
                  : null,
                s.enabled ? null : '停用',
              ].filter(Boolean);
              console.log(
                `${s.enabled ? '' : '[停用] '}${s.name}  命中 ${s.health.resolvedCount}${s.health.quarantinedExcluded ? `（隔离排除 ${s.health.quarantinedExcluded}）` : ''}` +
                  (badges.length ? `  [${badges.join(' · ')}]` : '') +
                  (s.description ? `  ${s.description}` : ''),
              );
            }
          return 0;
        }
        if (sub === 'show') {
          if (!name) throw new Error('用法: tern suites <project> show <name>');
          jsonOut(args, await c.suite(id, name));
          return 0;
        }
        if (sub === 'create' || sub === 'update') {
          if (!name)
            throw new Error(`用法: tern suites <project> ${sub} <name> [...选择器/绑定参数]`);
          const selector = selectorFromArgs();
          const binding = {
            ...(selector ? { selector } : {}),
            ...(one(args.desc) !== undefined ? { description: one(args.desc) } : {}),
            ...(args.env !== undefined ? { env: one(args.env) || null } : {}),
            ...(args.account !== undefined ? { account: one(args.account) || null } : {}),
            ...(args.param !== undefined || args.params !== undefined
              ? { params: kvParse(one(args.param) ?? one(args.params)) }
              : {}),
            ...(args.disabled !== undefined ? { enabled: args.disabled !== true } : {}),
          };
          const r =
            sub === 'create'
              ? await c.createSuite(id, { name, ...binding })
              : await c.updateSuite(id, name, {
                  ...(one(args.rename) ? { name: one(args.rename) } : {}),
                  ...binding,
                });
          jsonOut(args, r.suite);
          return 0;
        }
        if (sub === 'rm') {
          if (!name) throw new Error('用法: tern suites <project> rm <name>');
          await c.deleteSuite(id, name);
          console.log('已删除');
          return 0;
        }
        if (sub === 'preview') {
          const r = await c.previewSuite(id, { selector: selectorFromArgs() ?? {}, limit: 20 });
          if (wantJson) jsonOut(args, r);
          else {
            console.log(
              `命中 ${r.health.resolvedCount} 条（隔离排除 ${r.health.quarantinedExcluded}${r.health.isFullProject ? '，空选择器=项目全量' : ''}）`,
            );
            for (const it of r.items)
              console.log(`${it.quarantined ? '[隔离] ' : ''}${it.caseId}  ${it.title}`);
            for (const d of r.health.danglingIncludes) console.log(`⚠ 悬空引用: ${d}`);
          }
          return 0;
        }
        throw new Error('用法: tern suites <project> list|show|create|update|rm|preview');
      }

      case 'schedules': {
        if (sub === 'create') {
          const positional = restAll.filter((r) => !r.startsWith('--') && r !== 'create');
          const [project, name] = positional;
          if (!project || !name || !args.cron) {
            throw new Error(
              "用法: tern schedules create <project> <name> --cron '0 9 * * 1-5' [--env name] [--tags a,b]",
            );
          }
          const { schedule } = await c.createSchedule({
            project,
            name,
            cron: String(one(args.cron)),
            env: one(args.env) || undefined,
            scope: {
              ...(csv(args.suite) ? { suites: csv(args.suite) } : {}),
              ...(csv(args.tags) ? { tags: csv(args.tags) } : {}),
              ...(csv(args.version) ? { version: csv(args.version) } : {}),
              ...(csv(args.module) ? { module: csv(args.module) } : {}),
            },
            params: kvParse(one(args.params)),
            workerId: one(args.worker) || undefined,
            titlePrefix: one(args['title-prefix']) || undefined,
            enabled: args.disabled === true ? false : true,
          });
          jsonOut(args, schedule);
          return 0;
        }
        if (sub === 'pause' || sub === 'resume') {
          const id = restAll.find((r) => !r.startsWith('--') && r !== sub);
          if (!id) throw new Error(`用法: tern schedules ${sub} <scheduleId>`);
          jsonOut(args, (await c.updateSchedule(id, { enabled: sub === 'resume' })).schedule);
          return 0;
        }
        if (sub === 'rm') {
          const id = restAll.find((r) => !r.startsWith('--') && r !== 'rm');
          if (!id) throw new Error('用法: tern schedules rm <scheduleId>');
          await c.deleteSchedule(id);
          console.log('已删除');
          return 0;
        }
        const { items } = await c.schedules();
        if (wantJson) jsonOut(args, items);
        else
          for (const s of items)
            console.log(
              `${s.enabled ? '●' : '○'} ${s.id}  ${s.project}/${s.name}  [${s.cron}]${s.env ? ` env=${s.env}` : ''}` +
                `  下次 ${s.nextRunAt.slice(0, 16).replace('T', ' ')}  最近 ${s.lastRunId ?? '-'}`,
            );
        return 0;
      }

      case 'retry-failed': {
        const id = sub ?? rest.find((r) => !r.startsWith('--'));
        if (!id) throw new Error('用法: tern retry-failed <runId>');
        const { run } = await c.retryFailed(id);
        jsonOut(args, { newRunId: run.id, total: run.total });
        return 0;
      }

      case 'rerun': {
        const id = sub ?? rest.find((r) => !r.startsWith('--'));
        if (!id) throw new Error('用法: tern rerun <runId>');
        const { run } = await c.rerun(id);
        jsonOut(args, { newRunId: run.id, total: run.total });
        return 0;
      }

      case 'failures': {
        const id = sub ?? rest.find((r) => !r.startsWith('--'));
        if (!id) throw new Error('用法: tern failures <runId>');
        const b = await c.run(id);
        let n = 0;
        for (const it of b.items) {
          if (!['failed', 'timed_out', 'error'].includes(it.status)) continue;
          n++;
          console.log(`[${it.status}] ${it.caseId}`);
          if (it.lastError) console.log(`   ${it.lastError.slice(0, 300).replace(/\n/g, '\n   ')}`);
          if (it.executionId) {
            const exec = await c.execution(it.executionId);
            for (const s of exec.artifacts?.screenshots ?? []) console.log(`   截图: ${s}`);
            if (exec.artifacts?.trace) console.log(`   trace: ${exec.artifacts.trace}`);
          }
        }
        console.log(n === 0 ? '无失败用例' : `-- 共 ${n} 条失败`);
        return n;
      }

      case 'workers':
        jsonOut(args, await c.workers());
        return 0;

      default:
        console.error(`未知命令: ${cmd}\n`);
        console.log(usage());
        return 1;
    }
  } catch (e) {
    if (e instanceof ApiError) {
      console.error(`API 错误 [${e.code}]: ${e.message}`);
      return 1;
    }
    console.error(`错误: ${(e as Error).message}`);
    return 1;
  }
}

process.exit(await main());
