import { useEffect, useState, useCallback } from 'react';
import { api, connectLive, STATUS_STYLE, fmtTime } from './lib';
import { ProjectConfigDialog } from './ProjectConfigDialog';

export interface ProjectInfo {
  id: number;
  name: string;
  description: string;
  source: 'git' | 'local';
  gitUrl: string | null;
  branch: string | null;
  enabled: boolean;
  pullIntervalSec: number;
  credential: { type: 'none' | 'password' | 'ssh'; username: string | null; hasSecret: boolean };
  lastCommit: string | null;
  lastSyncedAt: string | null;
  syncStatus: string | null;
  syncError: string | null;
  caseCount: number;
  updatedAt: string;
}

interface SyncResult {
  projectId: number;
  name: string;
  added: number;
  updated: number;
  removed: number;
  invalid: number;
  commit: string | null;
  error: string | null;
  invalidCases?: { caseId: string; error: string }[];
}

export function ProjectsPage({ onOpenSuites }: { onOpenSuites?: (project: string) => void }) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [credTarget, setCredTarget] = useState<ProjectInfo | null>(null);
  const [configTarget, setConfigTarget] = useState<ProjectInfo | null>(null);
  const [busy, setBusy] = useState<number | 'all' | null>(null);
  const [lastSync, setLastSync] = useState<SyncResult | null>(null);
  const [invalidOpen, setInvalidOpen] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      setProjects(await api<ProjectInfo[]>('/api/v1/projects'));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const h = connectLive(
      (_t, type) => {
        if (type === 'project.updated') void load();
      },
      () => ['projects'],
    );
    return () => h.close();
  }, []);

  const syncOne = async (p: ProjectInfo) => {
    setBusy(p.id);
    setErr('');
    try {
      const r = await api<SyncResult>(`/api/v1/projects/${p.id}/sync`, {
        method: 'POST',
        body: '{}',
      });
      setLastSync(r);
      if ((r.invalidCases?.length ?? 0) > 0) setInvalidOpen(true);
      if (r.error) setErr(`${p.name}: ${r.error}`);
      await load();
    } catch (e) {
      setErr(`${p.name}: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const syncAll = async () => {
    setBusy('all');
    setErr('');
    try {
      await api('/api/v1/sync', { method: 'POST', body: '{}' });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggleEnabled = async (p: ProjectInfo) => {
    await api(`/api/v1/projects/${p.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !p.enabled }),
    });
    await load();
  };

  const remove = async (p: ProjectInfo) => {
    if (
      !window.confirm(
        `移除项目 ${p.name}？（用例从平台下线；clone 目录${p.source === 'git' ? '同时删除' : '保留'}）`,
      )
    )
      return;
    await api(`/api/v1/projects/${p.id}?removeFiles=${p.source === 'git'}`, { method: 'DELETE' });
    await load();
  };

  return (
    <div>
      <div className="flex items-center mb-3 gap-2">
        <h2 className="font-semibold">用例项目</h2>
        <span className="text-xs text-gray-500">
          一个 git 仓库 = 一个 project（根目录 tern.yaml，用例默认在 cases/）
        </span>
        <button
          className="ml-auto border text-sm px-3 py-1 rounded hover:bg-gray-50 disabled:opacity-50"
          onClick={syncAll}
          disabled={busy !== null}
        >
          {busy === 'all' ? '更新中…' : '全部更新'}
        </button>
        <button
          className="bg-sky-600 text-white text-sm px-3 py-1 rounded hover:bg-sky-700"
          onClick={() => setShowAdd(true)}
        >
          + 添加 git 项目
        </button>
      </div>

      {err && <div className="mb-2 text-xs text-red-600 bg-red-50 rounded px-2 py-1">{err}</div>}
      {lastSync && !lastSync.error && (
        <div className="mb-2 text-xs text-gray-500">
          {lastSync.name}: +{lastSync.added} ~{lastSync.updated} -{lastSync.removed} invalid{' '}
          {lastSync.invalid}
          {(lastSync.invalidCases?.length ?? 0) > 0 && (
            <button className="ml-1 text-red-600 underline" onClick={() => setInvalidOpen(true)}>
              查看错误
            </button>
          )}
        </div>
      )}

      {projects.length === 0 && (
        <div className="text-sm text-gray-500">
          暂无项目。点击右上角「添加 git 项目」自动拉取用例仓库；也可以把含 tern.yaml 的目录直接放进
          server 的 REPOS_DIR（默认 ./repos），会自动发现注册。
        </div>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 border-b">
            <th className="py-1.5 pr-2">项目</th>
            <th className="py-1.5 pr-2">来源</th>
            <th className="py-1.5 pr-2">认证</th>
            <th className="py-1.5 pr-2">用例</th>
            <th className="py-1.5 pr-2">最近 commit</th>
            <th className="py-1.5 pr-2">自动拉取</th>
            <th className="py-1.5 pr-2">同步状态</th>
            <th className="py-1.5 pr-2">最近更新</th>
            <th className="py-1.5">操作</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id} className="border-b">
              <td className="py-1.5 pr-2">
                <div className={`font-medium ${p.enabled ? '' : 'text-gray-400 line-through'}`}>
                  {p.name}
                </div>
                <div className="text-xs text-gray-400">{p.description || '-'}</div>
              </td>
              <td className="py-1.5 pr-2 text-xs">
                {p.source === 'git' ? (
                  <div>
                    <span className="px-1.5 py-0.5 rounded bg-gray-100">git</span>
                    {p.branch ? `@${p.branch}` : ''}
                    <div className="text-gray-400 truncate max-w-[220px]" title={p.gitUrl ?? ''}>
                      {p.gitUrl}
                    </div>
                  </div>
                ) : (
                  <span className="px-1.5 py-0.5 rounded bg-gray-100">本地目录</span>
                )}
              </td>
              <td className="py-1.5 pr-2 text-xs text-gray-500">
                {p.source !== 'git' ? '-' : credLabel(p)}
                {p.source === 'git' && (
                  <button
                    className="ml-1 text-sky-600 hover:underline"
                    onClick={() => setCredTarget(p)}
                  >
                    设置
                  </button>
                )}
              </td>
              <td className="py-1.5 pr-2">{p.caseCount}</td>
              <td className="py-1.5 pr-2 font-mono text-xs text-gray-500">
                {p.lastCommit?.slice(0, 8) ?? '-'}
              </td>
              <td className="py-1.5 pr-2 text-xs text-gray-500">
                {p.source === 'git'
                  ? p.pullIntervalSec > 0
                    ? `每 ${p.pullIntervalSec}s`
                    : '关闭'
                  : '-'}
              </td>
              <td className="py-1.5 pr-2">
                <span
                  className={`px-2 py-0.5 rounded-full text-xs ${STATUS_STYLE[p.syncStatus === 'ok' ? 'active' : p.syncStatus === 'error' ? 'invalid' : p.syncStatus === 'syncing' ? 'running' : 'bg-gray-100 text-gray-500']}`}
                >
                  {p.syncStatus ?? '未同步'}
                </span>
                {p.syncError && (
                  <div
                    className="text-xs text-red-600 mt-0.5 max-w-[240px] truncate"
                    title={p.syncError}
                  >
                    {p.syncError}
                  </div>
                )}
              </td>
              <td className="py-1.5 pr-2 text-xs text-gray-500">{fmtTime(p.lastSyncedAt)}</td>
              <td className="py-1.5 text-xs whitespace-nowrap">
                <button
                  className="text-sky-600 hover:underline disabled:opacity-50"
                  onClick={() => void syncOne(p)}
                  disabled={busy !== null}
                >
                  {busy === p.id ? '更新中…' : '更新'}
                </button>
                <button
                  className="ml-2 text-sky-600 hover:underline"
                  onClick={() => setConfigTarget(p)}
                >
                  环境/通知
                </button>
                <button
                  className="ml-2 text-sky-600 hover:underline"
                  onClick={() => onOpenSuites?.(p.name)}
                >
                  测试集
                </button>
                <button
                  className="ml-2 text-gray-600 hover:underline"
                  onClick={() => void toggleEnabled(p)}
                >
                  {p.enabled ? '停用' : '启用'}
                </button>
                <button
                  className="ml-2 text-red-600 hover:underline"
                  onClick={() => void remove(p)}
                >
                  移除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {showAdd && (
        <AddProjectDialog
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            void load();
          }}
        />
      )}
      {credTarget && (
        <CredentialDialog
          project={credTarget}
          onClose={() => setCredTarget(null)}
          onSaved={() => {
            setCredTarget(null);
            void load();
          }}
        />
      )}
      {configTarget && (
        <ProjectConfigDialog project={configTarget} onClose={() => setConfigTarget(null)} />
      )}

      {invalidOpen && lastSync?.invalidCases && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center"
          onClick={() => setInvalidOpen(false)}
        >
          <div
            className="bg-white rounded-lg p-5 w-[640px] max-w-[90vw] max-h-[80vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-semibold mb-2">同步发现 {lastSync.invalid} 个 invalid 用例</h3>
            {lastSync.invalidCases?.map((c) => (
              <div key={c.caseId} className="mb-3">
                <div className="font-mono text-xs">{c.caseId}</div>
                <pre className="bg-red-50 text-red-700 text-xs p-2 rounded whitespace-pre-wrap">
                  {c.error}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function credLabel(p: { credential?: ProjectInfo['credential'] }): string {
  const c = p.credential;
  if (!c || c.type === 'none') return '公开 / 无认证';
  if (c.type === 'password')
    return `HTTP ${c.username ?? '账号'}${c.hasSecret ? '' : '（未设密码）'}`;
  return c.hasSecret ? 'SSH 私钥' : 'SSH（未设私钥）';
}

function GitAuthFields({
  protocol,
  setProtocol,
  username,
  setUsername,
  secret,
  setSecret,
  secretPlaceholder,
}: {
  protocol: 'http' | 'ssh';
  setProtocol: (p: 'http' | 'ssh') => void;
  username: string;
  setUsername: (v: string) => void;
  secret: string;
  setSecret: (v: string) => void;
  secretPlaceholder?: string;
}) {
  return (
    <div className="space-y-2">
      <div>
        <span className="text-gray-500 text-xs">协议</span>
        <div className="flex gap-3 mt-1">
          <label className="flex items-center gap-1 text-sm">
            <input
              type="radio"
              checked={protocol === 'http'}
              onChange={() => setProtocol('http')}
            />
            HTTP/HTTPS（默认，账号密码）
          </label>
          <label className="flex items-center gap-1 text-sm">
            <input type="radio" checked={protocol === 'ssh'} onChange={() => setProtocol('ssh')} />
            SSH（私钥）
          </label>
        </div>
      </div>
      {protocol === 'http' ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-gray-500 text-xs">用户名（公开仓库可空）</span>
            <input
              className="border rounded w-full px-2 py-1"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="block">
            <span className="text-gray-500 text-xs">密码 / Token</span>
            <input
              type="password"
              className="border rounded w-full px-2 py-1"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={secretPlaceholder ?? ''}
              autoComplete="new-password"
            />
          </label>
        </div>
      ) : (
        <label className="block">
          <span className="text-gray-500 text-xs">
            私钥 PEM（容器内不会使用宿主机 ~/.ssh，必须粘贴私钥）
          </span>
          <textarea
            className="border rounded w-full px-2 py-1 font-mono text-xs"
            rows={5}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={secretPlaceholder ?? '-----BEGIN OPENSSH PRIVATE KEY-----'}
          />
        </label>
      )}
    </div>
  );
}

function AddProjectDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [gitUrl, setGitUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [name, setName] = useState('');
  const [interval, setIntervalSec] = useState(300);
  const [protocol, setProtocol] = useState<'http' | 'ssh'>('http');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setErr('');
    setLoading(true);
    try {
      const credential =
        protocol === 'ssh'
          ? { type: 'ssh' as const, secret: secret || undefined }
          : username || secret
            ? {
                type: 'password' as const,
                username: username || undefined,
                secret: secret || undefined,
              }
            : { type: 'none' as const };
      const r = await api<{ sync: SyncResult }>('/api/v1/projects', {
        method: 'POST',
        body: JSON.stringify({
          gitUrl,
          branch: branch || undefined,
          name: name || undefined,
          pullIntervalSec: interval,
          credential,
        }),
      });
      if (r.sync.error) setErr(`${r.sync.name}: ${r.sync.error}`);
      else onAdded();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-white rounded-lg p-5 w-[520px] max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold mb-3">添加 git 用例项目</h3>
        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="text-gray-500 text-xs">Git 仓库地址 *</span>
            <input
              className="border rounded w-full px-2 py-1 font-mono text-xs"
              value={gitUrl}
              onChange={(e) => {
                const v = e.target.value;
                setGitUrl(v);
                if (v.startsWith('git@') || v.startsWith('ssh://')) setProtocol('ssh');
                else if (v.startsWith('http://') || v.startsWith('https://')) setProtocol('http');
              }}
              placeholder="https://git.example.com/team/portal-e2e.git"
              autoFocus
            />
          </label>
          <GitAuthFields
            protocol={protocol}
            setProtocol={setProtocol}
            username={username}
            setUsername={setUsername}
            secret={secret}
            setSecret={setSecret}
          />
          <label className="block">
            <span className="text-gray-500 text-xs">分支（可选，默认远端默认分支）</span>
            <input
              className="border rounded w-full px-2 py-1"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
            />
          </label>
          <label className="block">
            <span className="text-gray-500 text-xs">
              项目名（可选，缺省读仓库 tern.yaml 的 name）
            </span>
            <input
              className="border rounded w-full px-2 py-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="portal"
            />
          </label>
          <label className="block">
            <span className="text-gray-500 text-xs">自动拉取间隔（秒，0 = 手动）</span>
            <input
              type="number"
              min={0}
              max={86400}
              className="border rounded w-full px-2 py-1"
              value={interval}
              onChange={(e) => setIntervalSec(Number(e.target.value))}
            />
          </label>
          <div className="text-xs text-gray-400">
            默认 HTTP 协议，公开仓库无需填写账号。私有仓库填账号密码（或 Token）；SSH
            必须粘贴私钥——平台跑在容器里，用不了宿主机密钥。 每次更新都会强制 reset --hard +
            clean，本地改动将被丢弃。
          </div>
          {err && <div className="text-xs text-red-600">{err}</div>}
          <div className="flex justify-end gap-2">
            <button className="px-3 py-1 rounded border" onClick={onClose}>
              取消
            </button>
            <button
              className="bg-sky-600 text-white px-3 py-1 rounded hover:bg-sky-700 disabled:opacity-50"
              onClick={() => void submit()}
              disabled={!gitUrl || loading || (protocol === 'ssh' && !secret)}
            >
              {loading ? '拉取中…' : '添加并同步'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CredentialDialog({
  project,
  onClose,
  onSaved,
}: {
  project: ProjectInfo;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [protocol, setProtocol] = useState<'http' | 'ssh'>(
    project.credential?.type === 'ssh' ? 'ssh' : 'http',
  );
  const [username, setUsername] = useState(project.credential?.username ?? '');
  const [secret, setSecret] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setErr('');
    setLoading(true);
    try {
      await api(`/api/v1/projects/${project.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          credential:
            protocol === 'ssh'
              ? { type: 'ssh', secret: secret || undefined }
              : username || secret
                ? { type: 'password', username: username || undefined, secret: secret || undefined }
                : { type: 'none' },
        }),
      });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center" onClick={onClose}>
      <div className="bg-white rounded-lg p-5 w-[520px]" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold mb-3">Git 认证 · {project.name}</h3>
        <div className="space-y-3 text-sm">
          <div className="text-xs text-gray-400 font-mono truncate" title={project.gitUrl ?? ''}>
            {project.gitUrl}
          </div>
          <GitAuthFields
            protocol={protocol}
            setProtocol={setProtocol}
            username={username}
            setUsername={setUsername}
            secret={secret}
            setSecret={setSecret}
            secretPlaceholder={
              project.credential?.hasSecret ? '（留空则保留已保存的 secret）' : undefined
            }
          />
          {err && <div className="text-xs text-red-600">{err}</div>}
          <div className="flex justify-end gap-2">
            <button className="px-3 py-1 rounded border" onClick={onClose}>
              取消
            </button>
            <button
              className="bg-sky-600 text-white px-3 py-1 rounded hover:bg-sky-700 disabled:opacity-50"
              onClick={() => void submit()}
              disabled={loading}
            >
              {loading ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
