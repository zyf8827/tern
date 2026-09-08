import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { DeviceProxyManager, isInsecureOrigin, rewriteInsecureParams } from './device-proxy.js';

test('isInsecureOrigin: http+IP 命中，localhost/https/非 URL 不命中', () => {
  assert.equal(isInsecureOrigin('http://192.0.2.1:31008'), 'http://192.0.2.1:31008');
  assert.equal(isInsecureOrigin('http://example.com:8080/page/'), 'http://example.com:8080');
  assert.equal(isInsecureOrigin('http://127.0.0.1:8083'), null);
  assert.equal(isInsecureOrigin('http://localhost:8083'), null);
  assert.equal(isInsecureOrigin('https://192.0.2.1'), null);
  assert.equal(isInsecureOrigin('not-a-url'), null);
});

test('rewriteInsecureParams: 按前缀重写并保留 path；off 直通；非地址值不动', async () => {
  const fake = async (origin: string) => ({ origin: 'http://127.0.0.1:7777', target: origin });
  const params = {
    BASE_URL: 'http://10.1.1.5:9000/page/',
    API_BASE_URL: 'http://10.1.1.5:9000',
    NOTE: '不是地址的普通值',
    LOCAL: 'http://127.0.0.1:1234/x',
  };
  const r = await rewriteInsecureParams(params, 'auto', fake);
  assert.equal(r.params.BASE_URL, 'http://127.0.0.1:7777/page/');
  assert.equal(r.params.API_BASE_URL, 'http://127.0.0.1:7777');
  assert.equal(r.params.NOTE, '不是地址的普通值'); // 非 URL 值原样
  assert.equal(r.params.LOCAL, 'http://127.0.0.1:1234/x'); // localhost 不重写
  assert.deepEqual(r.applied.map((a) => a.key).sort(), ['API_BASE_URL', 'BASE_URL']);
  assert.equal(r.applied[0]!.from, 'http://10.1.1.5:9000');

  const off = await rewriteInsecureParams(params, 'off', fake);
  assert.equal(off.params, params);
  assert.equal(off.applied.length, 0);

  const none = await rewriteInsecureParams({ X: '1' }, 'auto', fake);
  assert.equal(none.applied.length, 0);
});

/** 起一个真实目标（HTTP echo + WS echo），经代理访问断言透传行为 */
async function startTarget(): Promise<{ origin: string; close: () => Promise<void> }> {
  // upgrade 事件的 socket 是 Duplex（http.Server 升级连接），connection 的是 net.Socket；统一按 Duplex 收集
  const sockets = new Set<import('node:stream').Duplex>();
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ path: req.url, host: req.headers.host }));
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  // WS echo：回显 101 + 握手头，再原样回传帧字节
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const accept = req.headers['sec-websocket-key'];
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => {
      // keep-alive / 已升级的连接会挂住 server.close，先统一销毁
      for (const s of sockets) s.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('DeviceProxyManager: HTTP 透传（Host 重写）与 WS 101 握手头透传', async () => {
  const target = await startTarget();
  const manager = new DeviceProxyManager();
  try {
    const proxy = await manager.acquire(target.origin);
    assert.ok(proxy.origin.startsWith('http://127.0.0.1:'));

    // HTTP：路径透传、Host 重写为目标 host:port
    const res = await fetch(`${proxy.origin}/some/path?q=1`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { path: string; host: string };
    assert.equal(body.path, '/some/path?q=1');
    assert.equal(body.host, target.origin.replace('http://', ''));

    // WS：上游 101 响应头（含 Sec-WebSocket-Accept）原样回写，随后双向字节透传
    const wsEcho = await new Promise<string>((resolve, reject) => {
      const key = 'dGhlIHNhbXBsZSBub25jZQ==';
      const sock = net.connect(Number(proxy.origin.split(':')[2]), '127.0.0.1', () => {
        sock.write(
          `GET /ws/test HTTP/1.1\r\nHost: ${proxy.origin.replace('http://', '')}\r\n` +
            'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      let buf = '';
      const timer = setTimeout(
        () => reject(new Error(`ws handshake timeout, got: ${buf.slice(0, 200)}`)),
        4000,
      );
      sock.on('data', (d) => {
        buf += d.toString('latin1');
        if (buf.includes('\r\n\r\n')) {
          clearTimeout(timer);
          resolve(buf);
        }
      });
      sock.on('error', reject);
    });
    assert.ok(wsEcho.includes('101 Switching Protocols'), '101 状态行透传');
    assert.ok(
      wsEcho.includes(`Sec-WebSocket-Accept: dGhlIHNhbXBsZSBub25jZQ==`),
      '上游握手 Accept 头原样透传（不伪造）',
    );

    // 同 origin 复用同一代理端口
    const again = await manager.acquire(target.origin);
    assert.equal(again.origin, proxy.origin);
  } finally {
    await manager.closeAll();
    await target.close();
  }
});
