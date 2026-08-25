import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import type { GitCredentialInput, GitCredentialType } from '@tern/sdk';
import { ApiError } from './errors.js';

export interface ResolvedGitAuth {
  gitUrl: string;
  type: GitCredentialType;
  username: string | null;
  secret: string | null;
}

export interface GitAuthSession {
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

/** 从 https URL 拆出嵌入的 user:pass，存储时只保留干净地址 */
export function stripEmbeddedCredentials(url: string): {
  cleanUrl: string;
  username: string | null;
  secret: string | null;
} {
  const raw = url.trim();
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    try {
      const u = new URL(raw);
      const username = u.username ? decodeURIComponent(u.username) : null;
      const secret = u.password ? decodeURIComponent(u.password) : null;
      u.username = '';
      u.password = '';
      let clean = u.toString();
      if (!raw.endsWith('/') && clean.endsWith('/')) clean = clean.slice(0, -1);
      return { cleanUrl: clean, username, secret };
    } catch {
      return { cleanUrl: raw, username: null, secret: null };
    }
  }
  return { cleanUrl: raw, username: null, secret: null };
}

export function detectGitProtocol(url: string): 'http' | 'ssh' | 'file' {
  const u = url.trim();
  if (u.startsWith('file://') || (u.startsWith('/') && !u.includes('://'))) return 'file';
  if (/^git@/.test(u) || u.startsWith('ssh://')) return 'ssh';
  return 'http';
}

export function toHttpUrl(url: string): string {
  const u = url.trim();
  const scp = u.match(/^git@([^:]+):(.+)$/);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  if (u.startsWith('ssh://')) {
    try {
      const parsed = new URL(u.replace(/^ssh:\/\//, 'https://'));
      let s = parsed.toString();
      if (s.endsWith('/')) s = s.slice(0, -1);
      return s;
    } catch {
      return u;
    }
  }
  return u;
}

export function toSshUrl(url: string): string {
  const u = url.trim();
  if (u.startsWith('git@') || u.startsWith('ssh://')) return u;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return u;
    const p = parsed.pathname.replace(/^\//, '');
    return `git@${parsed.host}:${p}`;
  } catch {
    return u;
  }
}

/**
 * 解析 git 地址 + 凭据：
 * - 默认 HTTP，账号密码可选（公开库可空）
 * - SSH 必须显式提供私钥（容器内禁用宿主机密钥 / ssh-agent）
 * - URL 内嵌的 user:pass 会被拆出，不落进 git_url
 */
export function resolveGitAuth(
  gitUrl: string,
  credential?: GitCredentialInput | null,
): ResolvedGitAuth {
  const stripped = stripEmbeddedCredentials(gitUrl);
  const username = (credential?.username ?? stripped.username)?.trim() || null;
  const explicitSecret = credential?.secret != null && String(credential.secret).trim() !== '';
  const secret = explicitSecret ? String(credential!.secret) : stripped.secret;
  let url = stripped.cleanUrl;
  const urlProtocol = detectGitProtocol(url);

  // 未显式声明时：ssh URL → ssh（必须带私钥）；否则 HTTP
  let type: GitCredentialType = credential?.type ?? (urlProtocol === 'ssh' ? 'ssh' : 'none');
  if (type === 'none' && (username || secret)) type = 'password';

  if (type === 'ssh') {
    if (urlProtocol === 'http') url = toSshUrl(url);
  } else if (urlProtocol === 'ssh') {
    // 显式 HTTP 账号密码 / 无认证：把 ssh 地址改写成 https，避免走宿主机 ssh
    url = toHttpUrl(url);
  }

  const protocol = detectGitProtocol(url);
  if (protocol === 'ssh' && !secret) {
    throw new ApiError(
      400,
      'GIT_SSH_KEY_REQUIRED',
      'SSH 协议必须提供私钥（平台运行在容器内，不会使用宿主机 ~/.ssh 或 ssh-agent）',
    );
  }

  const effectiveType: GitCredentialType =
    type === 'password' && !secret && !username
      ? 'none'
      : type === 'none' && secret
        ? 'password'
        : type;

  return { gitUrl: url, type: effectiveType, username, secret: secret || null };
}

/** 准备一次 git 调用的隔离环境：临时 ASKPASS / 私钥文件，用完即删 */
export function beginGitAuth(cred: {
  type: GitCredentialType;
  username?: string | null;
  secret?: string | null;
}): GitAuthSession {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    // 禁用容器/宿主机转发过来的 ssh-agent，避免误用宿主机密钥
    SSH_AUTH_SOCK: '',
  };
  const dir = path.join(os.tmpdir(), `tern-git-${ulid().toLowerCase()}`);
  mkdirSync(dir, { recursive: true });

  if (cred.type === 'password' && cred.secret) {
    const askpass = path.join(dir, 'askpass.sh');
    writeFileSync(
      askpass,
      `#!/bin/sh
case "$1" in
  *[Uu]sername*) printf '%s\\n' "$TERN_GIT_USER" ;;
  *) printf '%s\\n' "$TERN_GIT_PASS" ;;
esac
`,
    );
    chmodSync(askpass, 0o700);
    env.GIT_ASKPASS = askpass;
    env.TERN_GIT_USER = cred.username ?? '';
    env.TERN_GIT_PASS = cred.secret;
    env.GCM_INTERACTIVE = 'never';
  } else if (cred.type === 'ssh' && cred.secret) {
    const keyFile = path.join(dir, 'id_key');
    const key = String(cred.secret).replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
    writeFileSync(keyFile, key);
    chmodSync(keyFile, 0o600);
    const knownHosts = path.join(dir, 'known_hosts');
    writeFileSync(knownHosts, '');
    chmodSync(knownHosts, 0o600);
    // 路径由我们生成（tmpdir + ulid），无空格；IdentitiesOnly + 清空 SSH_AUTH_SOCK 杜绝宿主机密钥
    env.GIT_SSH_COMMAND = [
      'ssh',
      `-i ${keyFile}`,
      '-o IdentitiesOnly=yes',
      '-o IdentityAgent=none',
      '-o StrictHostKeyChecking=accept-new',
      `-o UserKnownHostsFile=${knownHosts}`,
      '-o PreferredAuthentications=publickey',
      '-o PasswordAuthentication=no',
    ].join(' ');
  }

  return {
    env,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

export function gitExec(
  dir: string,
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const extra = opts.env ?? process.env;
  // 关掉 credential helper，避免去读宿主机/容器默认凭据库
  const argv = ['-c', 'credential.helper=', ...args];
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      argv,
      { cwd: dir, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: extra },
      (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr).trim().split('\n').slice(-3).join(' ');
          reject(new Error(`git ${args[0]} 失败: ${tail || (err as Error).message}`));
        } else {
          resolve(String(stdout).trim());
        }
      },
    );
  });
}

export async function gitWithAuth(
  dir: string,
  args: string[],
  cred: { type: GitCredentialType; username?: string | null; secret?: string | null },
  timeoutMs?: number,
): Promise<string> {
  const session = beginGitAuth(cred);
  try {
    return await gitExec(dir, args, { timeoutMs, env: session.env });
  } finally {
    session.cleanup();
  }
}
