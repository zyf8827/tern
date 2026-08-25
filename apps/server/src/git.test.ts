import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  beginGitAuth,
  detectGitProtocol,
  resolveGitAuth,
  stripEmbeddedCredentials,
  toHttpUrl,
  toSshUrl,
} from './git.js';
import { ApiError } from './errors.js';

test('从 https URL 拆出嵌入的账号密码', () => {
  const r = stripEmbeddedCredentials('https://alice:s3cret@git.example.com/team/portal.git');
  assert.equal(r.cleanUrl, 'https://git.example.com/team/portal.git');
  assert.equal(r.username, 'alice');
  assert.equal(r.secret, 's3cret');
});

test('file:// 与 ssh URL 不解析 userinfo', () => {
  assert.equal(stripEmbeddedCredentials('file:///tmp/repo').cleanUrl, 'file:///tmp/repo');
  assert.equal(
    stripEmbeddedCredentials('git@git.example.com:team/portal.git').cleanUrl,
    'git@git.example.com:team/portal.git',
  );
});

test('协议探测', () => {
  assert.equal(detectGitProtocol('https://git.example.com/a.git'), 'http');
  assert.equal(detectGitProtocol('http://git.example.com/a.git'), 'http');
  assert.equal(detectGitProtocol('git@host:group/repo.git'), 'ssh');
  assert.equal(detectGitProtocol('ssh://git@host/group/repo.git'), 'ssh');
  assert.equal(detectGitProtocol('file:///tmp/x'), 'file');
  assert.equal(detectGitProtocol('/abs/path'), 'file');
});

test('http ↔ ssh 地址互转', () => {
  assert.equal(
    toSshUrl('https://git.example.com/team/portal.git'),
    'git@git.example.com:team/portal.git',
  );
  assert.equal(
    toHttpUrl('git@git.example.com:team/portal.git'),
    'https://git.example.com/team/portal.git',
  );
  assert.equal(
    toSshUrl('git@git.example.com:team/portal.git'),
    'git@git.example.com:team/portal.git',
  );
});

test('默认 HTTP：无凭据保持干净地址', () => {
  const r = resolveGitAuth('https://git.example.com/team/portal.git');
  assert.equal(r.gitUrl, 'https://git.example.com/team/portal.git');
  assert.equal(r.type, 'none');
  assert.equal(r.secret, null);
});

test('显式 type=none 时把 ssh 地址改写为 https', () => {
  const r = resolveGitAuth('git@git.example.com:team/portal.git', { type: 'none' });
  assert.equal(r.gitUrl, 'https://git.example.com/team/portal.git');
  assert.equal(r.type, 'none');
});

test('password 凭据：ssh 地址改写为 https', () => {
  const r = resolveGitAuth('git@git.example.com:team/portal.git', {
    type: 'password',
    username: 'alice',
    secret: 's3cret',
  });
  assert.equal(r.gitUrl, 'https://git.example.com/team/portal.git');
  assert.equal(r.type, 'password');
  assert.equal(r.username, 'alice');
  assert.equal(r.secret, 's3cret');
});

test('ssh 凭据：https 地址改写为 ssh，且必须带私钥', () => {
  const r = resolveGitAuth('https://git.example.com/team/portal.git', {
    type: 'ssh',
    secret: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
  });
  assert.equal(r.gitUrl, 'git@git.example.com:team/portal.git');
  assert.equal(r.type, 'ssh');
});

test('ssh 无私钥直接拒绝（不用宿主机密钥）', () => {
  assert.throws(
    () => resolveGitAuth('git@git.example.com:team/portal.git'),
    (e: unknown) => e instanceof ApiError && e.code === 'GIT_SSH_KEY_REQUIRED',
  );
  assert.throws(
    () => resolveGitAuth('https://git.example.com/a.git', { type: 'ssh' }),
    (e: unknown) => e instanceof ApiError && e.code === 'GIT_SSH_KEY_REQUIRED',
  );
});

test('URL 内嵌密码升级为 password 凭据并清洗地址', () => {
  const r = resolveGitAuth('https://bob:pw@git.example.com/a.git');
  assert.equal(r.gitUrl, 'https://git.example.com/a.git');
  assert.equal(r.type, 'password');
  assert.equal(r.username, 'bob');
  assert.equal(r.secret, 'pw');
});

test('beginGitAuth password：写 ASKPASS 且不走 ssh-agent', () => {
  const s = beginGitAuth({ type: 'password', username: 'u', secret: 'p' });
  try {
    assert.equal(s.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(s.env.SSH_AUTH_SOCK, '');
    assert.ok(s.env.GIT_ASKPASS && existsSync(s.env.GIT_ASKPASS));
    assert.equal(statSync(s.env.GIT_ASKPASS).mode & 0o777, 0o700);
    assert.equal(s.env.TERN_GIT_USER, 'u');
    assert.equal(s.env.TERN_GIT_PASS, 'p');
    const body = readFileSync(s.env.GIT_ASKPASS, 'utf8');
    assert.match(body, /TERN_GIT_USER/);
  } finally {
    s.cleanup();
    assert.equal(existsSync(s.env.GIT_ASKPASS ?? ''), false);
  }
});

test('beginGitAuth ssh：私钥 0600、IdentitiesOnly、禁用 agent', () => {
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';
  const s = beginGitAuth({ type: 'ssh', secret: pem });
  try {
    assert.equal(s.env.SSH_AUTH_SOCK, '');
    assert.match(s.env.GIT_SSH_COMMAND ?? '', /IdentitiesOnly=yes/);
    assert.match(s.env.GIT_SSH_COMMAND ?? '', /IdentityAgent=none/);
    assert.match(s.env.GIT_SSH_COMMAND ?? '', /PasswordAuthentication=no/);
    const m = (s.env.GIT_SSH_COMMAND ?? '').match(/-i (\S+)/);
    assert.ok(m, `GIT_SSH_COMMAND=${s.env.GIT_SSH_COMMAND}`);
    const keyFile = m![1];
    assert.ok(existsSync(keyFile));
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    assert.equal(readFileSync(keyFile, 'utf8').trimEnd(), pem);
  } finally {
    s.cleanup();
  }
});
