// 环境管理（docs/platform-enhancements.md F1）
// 模型：清单在仓库（tern.yaml env.variables，sync 镜像到 env_variables 表，只读）；
// 环境与值在平台（environments 表，值整体 AES-256-GCM 加密存储）。
// 回显策略由清单驱动：secret: true 或未在清单声明的键永不回显（fail-closed）。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as yamlParse } from 'yaml';
import type { Runtime } from './runtime.js';
import { ApiError } from './errors.js';
import { decryptJson, encryptJson, getSecretKey } from './crypto.js';
import type {
  CreateEnvironmentPayload,
  DeviceProxyMode,
  EnvironmentInfo,
  EnvVariable,
  UpdateEnvironmentPayload,
} from '@tern/sdk';

const ENV_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const VAR_KEY_RE = /^[A-Z][A-Z0-9_]*$/;
const SUSPICIOUS_KEY = /(TOKEN|SECRET|PASS|KEY|CREDENTIAL)/;
const DEVICE_PROXY_MODES: readonly DeviceProxyMode[] = ['auto', 'on', 'off'];

/** 环境级设备反向代理模式（docs/device-proxy-design.md）：非法值一律回落 auto */
function normalizeDeviceProxy(raw: string | null | undefined): DeviceProxyMode {
  return (DEVICE_PROXY_MODES as readonly string[]).includes(raw ?? '')
    ? (raw as DeviceProxyMode)
    : 'auto';
}

interface EnvRow {
  id: number;
  project_id: number;
  name: string;
  description: string;
  values_enc: string;
  device_proxy: string | null;
  created_at: string;
  updated_at: string;
}

/** 解析 tern.yaml 的 env.variables 节点（变量清单契约） */
export function parseEnvVariables(yamlContent: string): {
  variables: EnvVariable[];
  warnings: string[];
} {
  const warnings: string[] = [];
  let doc: Record<string, unknown>;
  try {
    doc = (yamlParse(yamlContent) ?? {}) as Record<string, unknown>;
  } catch {
    return { variables: [], warnings }; // yaml 语法错误由 readRepoMeta 统一报
  }
  const node = (doc.env as Record<string, unknown> | undefined)?.variables;
  if (node == null) return { variables: [], warnings };
  if (typeof node !== 'object' || Array.isArray(node)) {
    throw new ApiError(
      400,
      'BAD_META',
      'tern.yaml 的 env.variables 必须是「变量名: {description, secret}」映射',
    );
  }
  const variables: EnvVariable[] = [];
  for (const [key, def] of Object.entries(node as Record<string, unknown>)) {
    if (!VAR_KEY_RE.test(key)) {
      warnings.push(`环境变量名 "${key}" 不符合 [A-Z][A-Z0-9_]*，已忽略`);
      continue;
    }
    const d = (def ?? {}) as { description?: unknown; secret?: unknown };
    if (d.description !== undefined && typeof d.description !== 'string') {
      warnings.push(`环境变量 "${key}" 的 description 必须是字符串，已忽略`);
    }
    const secret = d.secret === true;
    if (!secret && SUSPICIOUS_KEY.test(key)) {
      warnings.push(`环境变量 "${key}" 名字疑似凭据但未标记 secret: true（值将明文回显）`);
    }
    variables.push({
      key,
      description: typeof d.description === 'string' ? d.description : '',
      secret,
    });
  }
  return { variables, warnings };
}

/** sync 时镜像清单（整体替换），返回告警（命名/防呆/清单删除后的残留值提示） */
export function syncEnvVariables(rt: Runtime, projectId: number, repoDir: string): string[] {
  const file = ['tern.yaml', 'tern.yml']
    .map((f) => path.join(repoDir, f))
    .find((f) => existsSync(f));
  if (!file) return [];
  const { variables, warnings } = parseEnvVariables(readFileSync(file, 'utf8'));
  const tx = rt.db.transaction(() => {
    rt.db.prepare('DELETE FROM env_variables WHERE project_id=?').run(projectId);
    const ins = rt.db.prepare(
      'INSERT INTO env_variables (project_id, key, description, secret, position) VALUES (?, ?, ?, ?, ?)',
    );
    variables.forEach((v, i) => ins.run(projectId, v.key, v.description, v.secret ? 1 : 0, i));
  });
  tx();
  if (variables.length > 0) {
    const keys = new Set(variables.map((v) => v.key));
    for (const env of envRows(rt, projectId)) {
      const vals = decryptJson<Record<string, string>>(env.values_enc, key(rt)) ?? {};
      const orphan = Object.keys(vals).filter((k) => !keys.has(k));
      if (orphan.length) {
        warnings.push(
          `环境 "${env.name}" 存在清单已删除的残留值: ${orphan.join(', ')}（可在环境编辑中清理）`,
        );
      }
    }
  }
  return warnings;
}

function key(rt: Runtime): Buffer {
  return getSecretKey(rt.cfg.dataDir);
}

/** 项目变量清单（sync 镜像） */
export function envManifest(rt: Runtime, projectId: number): EnvVariable[] {
  return (
    rt.db
      .prepare(
        'SELECT key, description, secret FROM env_variables WHERE project_id=? ORDER BY position',
      )
      .all(projectId) as { key: string; description: string; secret: number }[]
  ).map((r) => ({ key: r.key, description: r.description, secret: !!r.secret }));
}

function envRows(rt: Runtime, projectId: number): EnvRow[] {
  return rt.db
    .prepare('SELECT * FROM environments WHERE project_id=? ORDER BY name')
    .all(projectId) as EnvRow[];
}

function envRow(rt: Runtime, projectId: number, name: string): EnvRow | undefined {
  return rt.db
    .prepare('SELECT * FROM environments WHERE project_id=? AND name=?')
    .get(projectId, name) as EnvRow | undefined;
}

/** 对外视图：完备性 + 脱敏（清单 secret / 未声明键 → null） */
function envInfo(row: EnvRow, manifest: EnvVariable[], k: Buffer): EnvironmentInfo {
  const values = decryptJson<Record<string, string>>(row.values_enc, k) ?? {};
  const manifestMap = new Map(manifest.map((v) => [v.key, v]));
  const echoed: Record<string, string | null> = {};
  for (const [key, v] of Object.entries(values)) {
    const def = manifestMap.get(key);
    echoed[key] = def && !def.secret ? v : null;
  }
  const missingKeys = manifest.filter((v) => !(v.key in values)).map((v) => v.key);
  return {
    name: row.name,
    description: row.description,
    complete: manifest.length === 0 ? true : missingKeys.length === 0,
    missingKeys,
    values: echoed,
    deviceProxy: normalizeDeviceProxy(row.device_proxy),
    updatedAt: row.updated_at,
  };
}

export function listEnvironments(rt: Runtime, projectId: number): EnvironmentInfo[] {
  const manifest = envManifest(rt, projectId);
  const k = key(rt);
  return envRows(rt, projectId).map((r) => envInfo(r, manifest, k));
}

function validateValues(
  values: Record<string, string>,
  manifest: EnvVariable[],
): { clean: Record<string, string>; unknown: string[] } {
  const clean: Record<string, string> = {};
  const unknown: string[] = [];
  const keys = new Set(manifest.map((v) => v.key));
  for (const [k, v] of Object.entries(values)) {
    if (typeof v !== 'string')
      throw new ApiError(400, 'BAD_ENV_VALUE', `环境变量 "${k}" 的值必须是字符串`);
    if (manifest.length > 0 && !keys.has(k)) unknown.push(k);
    else clean[k] = v;
  }
  return { clean, unknown };
}

export function createEnvironment(
  rt: Runtime,
  projectId: number,
  payload: CreateEnvironmentPayload,
): EnvironmentInfo {
  const name = payload.name?.trim() ?? '';
  if (!ENV_NAME_RE.test(name)) {
    throw new ApiError(400, 'BAD_ENV_NAME', `环境名必须是小写 kebab-case（[a-z0-9-]）: "${name}"`);
  }
  if (envRow(rt, projectId, name)) throw new ApiError(400, 'ENV_EXISTS', `环境已存在: ${name}`);
  if (payload.deviceProxy !== undefined && !DEVICE_PROXY_MODES.includes(payload.deviceProxy)) {
    throw new ApiError(
      400,
      'BAD_ENV_DEVICE_PROXY',
      `deviceProxy 取值非法: ${payload.deviceProxy}（允许 ${DEVICE_PROXY_MODES.join('/')}）`,
    );
  }
  const manifest = envManifest(rt, projectId);
  const { clean, unknown } = validateValues(payload.values ?? {}, manifest);
  if (unknown.length) {
    throw new ApiError(
      400,
      'ENV_UNKNOWN_KEYS',
      `值中的键不在项目变量清单内: ${unknown.join(', ')}（清单在 tern.yaml env.variables 声明）`,
    );
  }
  const now = new Date().toISOString();
  rt.db
    .prepare(
      'INSERT INTO environments (project_id, name, description, values_enc, device_proxy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      projectId,
      name,
      payload.description ?? '',
      encryptJson(clean, key(rt)),
      payload.deviceProxy ?? 'auto',
      now,
      now,
    );
  return envInfo(envRow(rt, projectId, name)!, manifest, key(rt));
}

export function updateEnvironment(
  rt: Runtime,
  projectId: number,
  envName: string,
  payload: UpdateEnvironmentPayload,
): EnvironmentInfo {
  const row = envRow(rt, projectId, envName);
  if (!row) throw new ApiError(404, 'ENV_NOT_FOUND', `环境不存在: ${envName}`);
  const manifest = envManifest(rt, projectId);
  let values = decryptJson<Record<string, string>>(row.values_enc, key(rt)) ?? {};
  if (payload.values !== undefined) {
    const { clean, unknown } = validateValues(payload.values, manifest);
    if (unknown.length) {
      throw new ApiError(
        400,
        'ENV_UNKNOWN_KEYS',
        `值中的键不在项目变量清单内: ${unknown.join(', ')}（清单在 tern.yaml env.variables 声明）`,
      );
    }
    values = clean; // 整体替换
  }
  let name = row.name;
  if (payload.name !== undefined && payload.name !== row.name) {
    if (!ENV_NAME_RE.test(payload.name)) {
      throw new ApiError(400, 'BAD_ENV_NAME', `环境名必须是小写 kebab-case: "${payload.name}"`);
    }
    if (envRow(rt, projectId, payload.name))
      throw new ApiError(400, 'ENV_EXISTS', `环境已存在: ${payload.name}`);
    name = payload.name;
  }
  let deviceProxy = normalizeDeviceProxy(row.device_proxy);
  if (payload.deviceProxy !== undefined) {
    if (!DEVICE_PROXY_MODES.includes(payload.deviceProxy)) {
      throw new ApiError(
        400,
        'BAD_ENV_DEVICE_PROXY',
        `deviceProxy 取值非法: ${payload.deviceProxy}（允许 ${DEVICE_PROXY_MODES.join('/')}）`,
      );
    }
    deviceProxy = payload.deviceProxy;
  }
  rt.db
    .prepare(
      'UPDATE environments SET name=?, description=?, values_enc=?, device_proxy=?, updated_at=? WHERE id=?',
    )
    .run(
      name,
      payload.description ?? row.description,
      encryptJson(values, key(rt)),
      deviceProxy,
      new Date().toISOString(),
      row.id,
    );
  return envInfo(envRow(rt, projectId, name)!, manifest, key(rt));
}

export function deleteEnvironment(rt: Runtime, projectId: number, envName: string): void {
  const row = envRow(rt, projectId, envName);
  if (!row) throw new ApiError(404, 'ENV_NOT_FOUND', `环境不存在: ${envName}`);
  rt.db.prepare('DELETE FROM environments WHERE id=?').run(row.id);
}

export interface ResolvedEnvParams {
  params: Record<string, string>;
  secretParams: Record<string, string>;
  /** 环境配置的设备反向代理模式（F9 修订：环境级配置，run 创建时快照进 batch） */
  deviceProxy: DeviceProxyMode;
}

/**
 * createRun 的环境展开（§1.5）：
 * 完备性 fail-fast → 环境值分层（payload.params 显式覆盖优先）→ secret 分装。
 * 显式覆盖按明文语义进 params（可用 payload.secretParams 标记为敏感）。
 */
export function resolveEnvParams(
  rt: Runtime,
  projectId: number,
  envName: string,
  payloadParams: Record<string, string> | undefined,
  secretParamKeys: string[] | undefined,
  secretParamsEnc?: string,
): ResolvedEnvParams {
  const row = envRow(rt, projectId, envName);
  if (!row) throw new ApiError(404, 'ENV_NOT_FOUND', `环境不存在: ${envName}`);
  const manifest = envManifest(rt, projectId);
  const envValues = decryptJson<Record<string, string>>(row.values_enc, key(rt)) ?? {};
  const overrides = payloadParams ?? {};

  if (manifest.length > 0) {
    const missing = manifest
      .filter((v) => !(v.key in envValues) && !(v.key in overrides))
      .map((v) => v.key);
    if (missing.length) {
      throw new ApiError(
        400,
        'MISSING_ENV_VALUES',
        `环境 "${envName}" 缺少清单要求的变量值: ${missing.join(', ')}（在项目环境页填写，或在运行参数中显提供）`,
      );
    }
  }

  const params: Record<string, string> = {};
  const secretParams: Record<string, string> = {};
  const secretSet = new Set(secretParamKeys ?? []);
  const manifestMap = new Map(manifest.map((v) => [v.key, v]));
  for (const [k, v] of Object.entries(envValues)) {
    if (k in overrides) continue; // 显式覆盖走明文通道
    if (manifestMap.get(k)?.secret) secretParams[k] = v;
    else params[k] = v;
  }
  for (const [k, v] of Object.entries(overrides)) params[k] = v;
  for (const k of secretSet) {
    if (params[k] !== undefined) {
      secretParams[k] = params[k];
      delete params[k];
    }
  }
  // 内部透传（retry/调度沿用原 run 已加密的 secret 集）
  if (secretParamsEnc) {
    Object.assign(
      secretParams,
      decryptJson<Record<string, string>>(secretParamsEnc, key(rt)) ?? {},
    );
  }
  return { params, secretParams, deviceProxy: normalizeDeviceProxy(row.device_proxy) };
}

/** project 删除时级联清理 */
export function purgeProjectEnvs(rt: Runtime, projectId: number): void {
  rt.db.prepare('DELETE FROM env_variables WHERE project_id=?').run(projectId);
  rt.db.prepare('DELETE FROM environments WHERE project_id=?').run(projectId);
}
