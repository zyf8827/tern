import { useCallback, useEffect, useState } from 'react';
import { api, fmtTime } from './lib';
import type { ProjectInfo } from './ProjectsPage';

export interface EnvVariable {
  key: string;
  description: string;
  secret: boolean;
}
export type DeviceProxyMode = 'auto' | 'on' | 'off';
export interface EnvironmentInfo {
  name: string;
  description: string;
  complete: boolean;
  missingKeys: string[];
  values: Record<string, string | null>;
  deviceProxy: DeviceProxyMode;
  updatedAt: string;
}
const DEVICE_PROXY_LABEL: Record<DeviceProxyMode, string> = {
  auto: '自动',
  on: '开启',
  off: '关闭',
};
const DEVICE_PROXY_HINT: Record<DeviceProxyMode, string> = {
  auto: '自动（推荐）：运行参数含 http 内网地址时，worker 自动经本机 127.0.0.1 反代访问，使浏览器获得 secure context（getUserMedia 可用）。BASE_URL 等参数保持原始值。',
  on: '开启：强制经 worker 本机反代访问（调试代理链路用）。BASE_URL 等参数保持原始值。',
  off: '关闭：不启用反代。device 用例（麦克风/摄像头）在 http 内网地址下会因非安全源被浏览器禁止。',
};
export interface WebhookInfo {
  id: number;
  project: string | null;
  type: string;
  hasSecret: boolean;
  notifyOn: 'always' | 'failure';
  enabled: boolean;
  createdAt: string;
}

/** 项目配置：环境（清单来自 tern.yaml，值在平台加密存储）+ 钉钉通知 */
export function ProjectConfigDialog({
  project,
  onClose,
}: {
  project: ProjectInfo;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'env' | 'notify'>('env');
  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg p-5 w-[720px] max-w-[95vw] max-h-[88vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-3">
          <h3 className="font-semibold">项目配置 · {project.name}</h3>
          <div className="flex gap-1 ml-auto">
            <button
              className={`px-3 py-1 rounded text-sm ${tab === 'env' ? 'bg-sky-600 text-white' : 'border'}`}
              onClick={() => setTab('env')}
            >
              环境
            </button>
            <button
              className={`px-3 py-1 rounded text-sm ${tab === 'notify' ? 'bg-sky-600 text-white' : 'border'}`}
              onClick={() => setTab('notify')}
            >
              钉钉通知
            </button>
          </div>
          <button className="text-gray-400 hover:text-gray-700" onClick={onClose}>
            ✕
          </button>
        </div>
        {tab === 'env' ? <EnvsTab project={project} /> : <WebhooksTab project={project} />}
      </div>
    </div>
  );
}

function EnvsTab({ project }: { project: ProjectInfo }) {
  const [vars, setVars] = useState<EnvVariable[]>([]);
  const [envs, setEnvs] = useState<EnvironmentInfo[]>([]);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const [v, e] = await Promise.all([
        api<{ variables: EnvVariable[] }>(`/api/v1/projects/${project.id}/env-variables`),
        api<{ items: EnvironmentInfo[] }>(`/api/v1/projects/${project.id}/environments`),
      ]);
      setVars(v.variables);
      setEnvs(e.items);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [project.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (name: string) => {
    if (!window.confirm(`删除环境 ${name}？（不影响已创建的运行历史）`)) return;
    await api(`/api/v1/projects/${project.id}/environments/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    void load();
  };

  return (
    <div className="space-y-4 text-sm">
      <div className="border rounded p-3 bg-gray-50">
        <div className="text-xs font-semibold text-gray-500 mb-1">
          变量清单（只读，来自用例仓库 tern.yaml 的 env.variables）
        </div>
        {vars.length === 0 ? (
          <div className="text-xs text-gray-400">
            未声明清单。可在 tern.yaml 添加 env.variables
            节点声明项目需要的运行变量（名/说明/是否敏感）。
          </div>
        ) : (
          <div className="space-y-0.5">
            {vars.map((v) => (
              <div key={v.key} className="flex items-center gap-2 text-xs">
                <span className="font-mono font-medium">{v.key}</span>
                {v.secret && (
                  <span className="px-1.5 rounded bg-amber-50 text-amber-700">
                    secret（加密存储，不回显）
                  </span>
                )}
                <span className="text-gray-500">{v.description || '-'}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center mb-2">
          <span className="text-xs font-semibold text-gray-500">
            环境（值保存在平台，secret 加密）
          </span>
          <button
            className="ml-auto bg-sky-600 text-white text-xs px-2 py-1 rounded hover:bg-sky-700"
            onClick={() => setCreating(true)}
          >
            + 新建环境
          </button>
        </div>
        {envs.length === 0 && (
          <div className="text-xs text-gray-400">
            暂无环境。创建「dev / test / staging …」并为清单变量填值后，发起运行时可直接选择环境。
          </div>
        )}
        <div className="space-y-2">
          {envs.map((env) => (
            <div key={env.name} className="border rounded p-2">
              <div className="flex items-center gap-2">
                <span className="font-medium">{env.name}</span>
                {env.complete ? (
                  <span className="px-1.5 py-0.5 rounded-full bg-green-50 text-green-700 text-xs">
                    配齐
                  </span>
                ) : (
                  <span className="px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 text-xs">
                    缺 {env.missingKeys.join(', ')}
                  </span>
                )}
                <span
                  className="px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 text-xs"
                  title={`设备反向代理：${DEVICE_PROXY_HINT[env.deviceProxy]}`}
                >
                  反代 {DEVICE_PROXY_LABEL[env.deviceProxy]}
                </span>
                <span className="text-xs text-gray-400 ml-auto">{fmtTime(env.updatedAt)}</span>
                <button
                  className="text-sky-600 text-xs"
                  onClick={() => setEditing(editing === env.name ? null : env.name)}
                >
                  编辑
                </button>
                <button className="text-red-600 text-xs" onClick={() => void remove(env.name)}>
                  删除
                </button>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                {Object.entries(env.values).map(([k, v]) => (
                  <span key={k} className="text-xs font-mono text-gray-600">
                    {k}={v === null ? '••••' : `"${v}"`}
                  </span>
                ))}
                {Object.keys(env.values).length === 0 && (
                  <span className="text-xs text-gray-400">（未配置任何值）</span>
                )}
              </div>
              {editing === env.name && (
                <EnvValuesForm
                  vars={vars}
                  initial={env.values}
                  initialDeviceProxy={env.deviceProxy}
                  submitLabel="保存（整体替换）"
                  onSubmit={async (values, _name, _desc, deviceProxy) => {
                    await api(
                      `/api/v1/projects/${project.id}/environments/${encodeURIComponent(env.name)}`,
                      {
                        method: 'PATCH',
                        body: JSON.stringify({ values, deviceProxy }),
                      },
                    );
                    setEditing(null);
                    void load();
                  }}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {creating && (
        <div className="border rounded p-3">
          <div className="text-xs font-semibold text-gray-500 mb-2">新建环境</div>
          <EnvValuesForm
            vars={vars}
            withName
            submitLabel="创建"
            onSubmit={async (values, name, desc, deviceProxy) => {
              await api(`/api/v1/projects/${project.id}/environments`, {
                method: 'POST',
                body: JSON.stringify({ name, description: desc, values, deviceProxy }),
              });
              setCreating(false);
              void load();
            }}
          />
        </div>
      )}
      {err && <div className="text-xs text-red-600">{err}</div>}
    </div>
  );
}

function EnvValuesForm({
  vars,
  initial,
  initialDeviceProxy = 'auto',
  withName,
  submitLabel,
  onSubmit,
}: {
  vars: EnvVariable[];
  initial?: Record<string, string | null>;
  initialDeviceProxy?: DeviceProxyMode;
  withName?: boolean;
  submitLabel: string;
  onSubmit: (
    values: Record<string, string>,
    name: string,
    desc: string,
    deviceProxy: DeviceProxyMode,
  ) => Promise<void>;
}) {
  const fields =
    vars.length > 0
      ? vars
      : // 无清单：自由键值（全部按敏感处理）
        [
          {
            key: '',
            description: '（项目未声明清单，自由填写 KEY，值将按敏感处理）',
            secret: true,
          },
        ];
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [deviceProxy, setDeviceProxy] = useState<DeviceProxyMode>(initialDeviceProxy);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const v of fields) {
      const val = initial?.[v.key];
      init[v.key] = val ?? '';
    }
    return init;
  });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr('');
    if (withName && !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      setErr('环境名必须是小写 kebab-case（如 staging）');
      return;
    }
    const final: Record<string, string> = {};
    if (vars.length > 0) {
      for (const v of vars) {
        const val = (values[v.key] ?? '').trim();
        if (val) final[v.key] = val;
      }
    } else {
      // 无清单自由模式：textarea 每行 KEY=VALUE
      for (const line of (values[''] ?? '').split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) final[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
    }
    setBusy(true);
    try {
      await onSubmit(final, name, desc, deviceProxy);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 mt-2">
      {withName && (
        <div className="grid grid-cols-2 gap-2">
          <input
            className="border rounded px-2 py-1 text-sm"
            placeholder="环境名（staging）"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="border rounded px-2 py-1 text-sm"
            placeholder="描述（可选）"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
        </div>
      )}
      {vars.length > 0 ? (
        vars.map((v) => (
          <label key={v.key} className="flex items-center gap-2">
            <span className="w-44 shrink-0 font-mono text-xs">
              {v.key}
              {v.secret ? ' 🔒' : ''}
            </span>
            <input
              type={v.secret ? 'password' : 'text'}
              className="border rounded flex-1 px-2 py-1 text-sm font-mono"
              placeholder={v.secret ? '敏感值，保存后不回显' : v.description || '值'}
              value={values[v.key] ?? ''}
              onChange={(e) => setValues((s) => ({ ...s, [v.key]: e.target.value }))}
              autoComplete="new-password"
            />
          </label>
        ))
      ) : (
        <textarea
          className="border rounded w-full px-2 py-1 font-mono text-xs"
          rows={3}
          placeholder={
            '每行 KEY=VALUE（值将按敏感处理，加密存储）\nBASE_URL=https://staging.example.com'
          }
          value={Object.values(values)[0] ?? ''}
          onChange={(e) => setValues((s) => ({ ...s, '': e.target.value }))}
        />
      )}
      <label className="flex items-center gap-2" title={DEVICE_PROXY_HINT[deviceProxy]}>
        <span className="w-44 shrink-0 text-xs text-gray-600">设备反向代理</span>
        <select
          className="border rounded px-2 py-1 text-sm"
          value={deviceProxy}
          onChange={(e) => setDeviceProxy(e.target.value as DeviceProxyMode)}
        >
          <option value="auto">自动（推荐）</option>
          <option value="on">开启（强制）</option>
          <option value="off">关闭</option>
        </select>
        <span className="text-xs text-gray-400">
          {DEVICE_PROXY_HINT[deviceProxy].split('：')[0]}
        </span>
      </label>
      {err && <div className="text-xs text-red-600">{err}</div>}
      <button
        className="bg-sky-600 text-white text-xs px-3 py-1 rounded hover:bg-sky-700 disabled:opacity-50"
        onClick={() => void submit()}
        disabled={busy}
      >
        {busy ? '保存中…' : submitLabel}
      </button>
    </div>
  );
}

function WebhooksTab({ project }: { project: ProjectInfo }) {
  const [hooks, setHooks] = useState<WebhookInfo[]>([]);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [notifyOn, setNotifyOn] = useState<'always' | 'failure'>('failure');
  const [err, setErr] = useState('');
  const [testing, setTesting] = useState<number | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ items: WebhookInfo[] }>('/api/v1/webhooks');
    setHooks(r.items.filter((h) => h.project === project.name || h.project === null));
  }, [project.name]);
  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    setErr('');
    try {
      await api('/api/v1/webhooks', {
        method: 'POST',
        body: JSON.stringify({ project: project.name, url, secret: secret || undefined, notifyOn }),
      });
      setUrl('');
      setSecret('');
      void load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const test = async (id: number) => {
    setTesting(id);
    setErr('');
    try {
      await api(`/api/v1/webhooks/${id}/test`, { method: 'POST', body: '{}' });
    } catch (e) {
      setErr(`测试消息失败: ${(e as Error).message}`);
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="space-y-4 text-sm">
      <div className="text-xs text-gray-500">
        测试运行结束时向匹配的机器人推送 markdown
        摘要（结果/统计/失败分组/详情链接）。支持加签；「仅失败时」不打扰全绿运行。
      </div>
      <table className="w-full">
        <thead>
          <tr className="text-left text-gray-500 border-b text-xs">
            <th className="py-1 pr-2">Webhook</th>
            <th className="py-1 pr-2">范围</th>
            <th className="py-1 pr-2">加签</th>
            <th className="py-1 pr-2">策略</th>
            <th className="py-1 pr-2">状态</th>
            <th className="py-1">操作</th>
          </tr>
        </thead>
        <tbody>
          {hooks.length === 0 && (
            <tr>
              <td className="py-3 text-xs text-gray-400" colSpan={6}>
                暂无通知配置
              </td>
            </tr>
          )}
          {hooks.map((h) => (
            <tr key={h.id} className="border-b text-xs">
              <td className="py-1.5 pr-2 font-mono max-w-[240px] truncate" title={String(h.id)}>
                #{h.id}
              </td>
              <td className="py-1.5 pr-2">{h.project ?? '全局'}</td>
              <td className="py-1.5 pr-2">{h.hasSecret ? '是' : '否'}</td>
              <td className="py-1.5 pr-2">{h.notifyOn === 'always' ? '每次完成' : '仅失败时'}</td>
              <td className="py-1.5 pr-2">{h.enabled ? '启用' : '停用'}</td>
              <td className="py-1.5 space-x-2 whitespace-nowrap">
                <button
                  className="text-sky-600"
                  onClick={() => void test(h.id)}
                  disabled={testing === h.id}
                >
                  {testing === h.id ? '发送中…' : '发测试'}
                </button>
                <button
                  className="text-gray-600"
                  onClick={async () => {
                    await api(`/api/v1/webhooks/${h.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ enabled: !h.enabled }),
                    });
                    void load();
                  }}
                >
                  {h.enabled ? '停用' : '启用'}
                </button>
                <button
                  className="text-red-600"
                  onClick={async () => {
                    if (window.confirm('删除该 webhook？')) {
                      await api(`/api/v1/webhooks/${h.id}`, { method: 'DELETE' });
                      void load();
                    }
                  }}
                >
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border rounded p-3 space-y-2">
        <div className="text-xs font-semibold text-gray-500">
          为项目 {project.name} 添加钉钉机器人
        </div>
        <input
          className="border rounded w-full px-2 py-1 text-xs font-mono"
          placeholder="https://oapi.dingtalk.com/robot/send?access_token=…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-2">
          <input
            type="password"
            className="border rounded px-2 py-1 text-xs font-mono"
            placeholder="加签密钥 SEC…（可空）"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="new-password"
          />
          <select
            className="border rounded px-2 py-1 text-xs"
            value={notifyOn}
            onChange={(e) => setNotifyOn(e.target.value as 'always' | 'failure')}
          >
            <option value="failure">仅失败时通知</option>
            <option value="always">每次完成都通知</option>
          </select>
        </div>
        {err && <div className="text-xs text-red-600">{err}</div>}
        <button
          className="bg-sky-600 text-white text-xs px-3 py-1 rounded hover:bg-sky-700 disabled:opacity-50"
          onClick={() => void add()}
          disabled={!url}
        >
          添加
        </button>
      </div>
    </div>
  );
}
