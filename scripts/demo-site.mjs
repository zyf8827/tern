#!/usr/bin/env node
// Tern 演示站点：带登录的 Web 应用，供 demo 用例验证登录态。
// 同时模拟接口登录（docs/auth-design.md §2）：GET /api/auth/mock-login?clientId=…
// 成功种 session_token（host-only 会话 cookie）+ HTTP 200 {success:true,code:0,data}；
// 设备未授权等业务失败仍是 HTTP 200 {success:false,code:-10001,msg} 且不种 cookie。
// 用法: node scripts/demo-site.mjs [port]   （默认 7501）
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? process.env.PORT ?? 7501);
const USER = 'demo-user';
const PASS = 'demo-pass';
// 预置合法 token（storage-login 直写 cookie 的演示值）
const sessions = new Map([['s3cret', USER]]);
const tokens = new Map();
// clientId → 账号（模拟「设备绑定账号」；default/admin/auditor 各一台设备）
const DEVICES = new Map([
  ['dfe87d72-e89d-4941-8de1-92dffeeb1211', 'demo-user'],
  ['0b7fd2e6-1c52-4a7e-9a44-6f5f2f9f0a01', 'admin'],
  ['7c1f3a58-92d0-4d3e-b1c7-2a8e5d4c6b02', 'auditor'],
]);
const mockLoginCalls = [];
const deadTokens = new Set();

function sessionTokenOf(req) {
  const token = (req.headers.cookie ?? '').match(/(?:^|;\s*)session_token=([^;]+)/)?.[1];
  return token && !deadTokens.has(token) ? token : null;
}

const loginPage = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>演示系统 · 登录</title></head>
<body style="font-family: sans-serif; max-width: 360px; margin: 60px auto;">
  <h1>演示系统登录</h1>
  <form id="login-form">
    <p><input id="username" placeholder="用户名" autocomplete="off" style="width:100%;padding:8px"></p>
    <p><input id="password" type="password" placeholder="密码" style="width:100%;padding:8px"></p>
    <button id="login-btn" type="button" style="padding:8px 24px">登录</button>
    <p id="message" style="min-height:1.4em"></p>
  </form>
  <script>
    document.getElementById('login-btn').addEventListener('click', async () => {
      const msg = document.getElementById('message');
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('username').value,
          password: document.getElementById('password').value,
        }),
      });
      if (res.ok) { window.location.href = '/'; return; }
      const body = await res.json().catch(() => ({}));
      msg.textContent = body.error || '用户名或密码错误';
      msg.style.color = '#b91c1c';
    });
  </script>
</body>
</html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const send = (status, body, type = 'text/html; charset=utf-8', headers = {}) => {
    res.writeHead(status, { 'content-type': type, ...headers });
    res.end(body);
  };

  if (req.method === 'GET' && url.pathname === '/login') {
    return send(200, loginPage);
  }

  if (req.method === 'GET' && url.pathname === '/public') {
    return send(200, '<h1 id="public">公开页面 public-ok</h1>');
  }

  // ---- F8 录音页：getUserMedia → MediaRecorder → 回显 blob 字节数（fake mic 全链路验证） ----
  if (req.method === 'GET' && url.pathname === '/record') {
    return send(200, `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>录音</title></head>
<body style="font-family: sans-serif; max-width: 640px; margin: 40px auto;">
  <h2>录音页（音频采集演示）</h2>
  <button id="start">开始录音</button>
  <button id="stop" disabled>停止</button>
  <div id="state">idle</div>
  <div id="result">-</div>
  <script>
    let recorder, chunks;
    document.getElementById('start').onclick = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recorder = new MediaRecorder(stream);
        chunks = [];
        recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: recorder.mimeType });
          document.getElementById('result').textContent = 'bytes=' + blob.size;
          stream.getTracks().forEach((t) => t.stop());
        };
        recorder.start();
        document.getElementById('state').textContent = 'recording';
        document.getElementById('stop').disabled = false;
        document.getElementById('start').disabled = true;
        setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 3000);
      } catch (e) {
        document.getElementById('state').textContent = 'error: ' + e.name;
      }
    };
    document.getElementById('stop').onclick = () => recorder && recorder.stop();
  </script>
</body></html>`);
  }

  // ---- F8 上传回显：multipart 收文件，回显字节数与文件名（API 播种用例的验证端点） ----
  if (req.method === 'POST' && url.pathname === '/api/upload') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const m = /filename="([^"]+)"/.exec(body.toString('utf8', 0, Math.min(body.length, 2048)));
      send(200, JSON.stringify({ ok: true, bytes: body.length, filename: m?.[1] ?? null }), 'application/json');
    });
    return;
  }

  // ---- 接口模拟登录（API Mock Auth） ----
  if (url.pathname === '/api/auth/mock-login') {
    const clientId = url.searchParams.get('clientId') ?? '';
    mockLoginCalls.push(clientId);
    const user = DEVICES.get(clientId);
    if (!user) {
      // 业务失败：HTTP 200 + success:false，不种 cookie
      return send(200, JSON.stringify({ success: false, code: -10001, msg: '设备未授权或未绑定账号' }), 'application/json');
    }
    const token = `tok-${Math.random().toString(36).slice(2, 10)}`;
    sessions.set(token, user);
    return send(200, JSON.stringify({ success: true, code: 0, data: { user, clientId } }), 'application/json', {
      'set-cookie': `session_token=${token}; Path=/`,
    });
  }
  if (url.pathname === '/api/auth/findUserLoginInfo') {
    const token = sessionTokenOf(req);
    const user = token ? sessions.get(token) : undefined;
    if (!user) return send(200, JSON.stringify({ success: false, code: -10001, msg: '未登录' }), 'application/json');
    return send(200, JSON.stringify({ success: true, code: 0, data: { user } }), 'application/json');
  }
  // 测试辅助：使当前 session_token 失效（验证 validate 失败 → 重登）
  if (url.pathname === '/api/auth/_expire' && req.method === 'POST') {
    const token = (req.headers.cookie ?? '').match(/(?:^|;\s*)session_token=([^;]+)/)?.[1];
    if (token) deadTokens.add(token);
    return send(200, JSON.stringify({ success: true }), 'application/json');
  }
  // 测试辅助：mockLogin 调用记录（供 e2e 断言「同一账号只登一次」）
  if (url.pathname === '/api/auth/_echo') {
    return send(200, JSON.stringify({ cookie: req.headers.cookie ?? null }), 'application/json');
  }
  if (url.pathname === '/api/auth/_stats') {
    return send(200, JSON.stringify({ total: mockLoginCalls.length, calls: mockLoginCalls }), 'application/json');
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body); } catch { /* ignore */ }
      if (json.username !== USER || json.password !== PASS) {
        return send(401, JSON.stringify({ ok: false, error: '用户名或密码错误' }), 'application/json');
      }
      const token = `tok-${Math.random().toString(36).slice(2, 10)}`;
      sessions.set(token, USER);
      tokens.set(token, USER);
      return send(200, JSON.stringify({ ok: true, token }), 'application/json', {
        'set-cookie': `session=${token}; Path=/; HttpOnly; SameSite=Lax`,
      });
    });
    return;
  }

  if (url.pathname === '/' || url.pathname.startsWith('/api/userinfo')) {
    // 演示语义：业务页面/接口由 session_token 或 session 还原登录态
    const cookie = (req.headers.cookie ?? '').match(/(?:^|;\s*)(?:session|session_token)=([^;]+)/)?.[1];
    const bearer = (req.headers.authorization ?? '').match(/^Bearer (.+)$/)?.[1];
    const token = cookie ?? bearer;
    const user = sessions.get(token) ?? tokens.get(token);
    if (!user) {
      if (url.pathname === '/') return send(302, '', 'text/plain', { location: '/login' });
      return send(401, JSON.stringify({ ok: false, error: '未登录' }), 'application/json');
    }
    if (url.pathname === '/') {
      return send(200, `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>工作台</title></head>
<body style="font-family: sans-serif; max-width: 640px; margin: 60px auto;">
  <h1 id="welcome">欢迎回来，${user}！已进入工作台</h1>
  <p>这是登录后才能看到的页面。中文渲染检查：订单列表、用户管理、系统设置。</p>
</body></html>`);
    }
    return send(200, JSON.stringify({ ok: true, user }), 'application/json');
  }

  send(404, 'not found');
});

// 监听 0.0.0.0：docker 里的 worker 可通过 host.docker.internal 访问宿主机上的演示站点
server.listen(port, '0.0.0.0', () => {
  console.log(`[demo-site] listening on http://0.0.0.0:${port} (user=${USER} pass=${PASS})`);
});
