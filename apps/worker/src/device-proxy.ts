import http from 'node:http';
import net from 'node:net';

/**
 * F9 设备反向代理（docs/device-proxy-design.md）。
 *
 * 背景：getUserMedia 要求 secure context，http://<IP> 被浏览器禁止（device 用例
 * 录音器卡「初始化中」且 REST 无异常）；localhost 天然安全。worker 在本机
 * 127.0.0.1 起 HTTP+WS 双透传代理，把运行参数里的不安全 origin 重写到代理
 * origin，对用例与环境配置完全透明。
 *
 * 实现硬约束（实跑验证）：
 * - Host 头重写为目标 host:port（部分网关校验 Host）；
 * - WS 必须等上游 101 + 完整握手响应头（含 Sec-WebSocket-Accept）原样回写
 *   客户端后才开始双向 pipe——不能伪造 101；
 * - 只监听 127.0.0.1。
 */

export type DeviceProxyMode = 'auto' | 'on' | 'off';

export interface ProxyHandle {
  /** 代理 origin（http://127.0.0.1:<port>） */
  origin: string;
  /** 目标 origin（http://<host>:<port>） */
  target: string;
}

/** origin 是否为「不安全源」：http 且非 localhost 系（与 exec-kit 判定同一语义） */
export function isInsecureOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:') return null;
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')
      return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * 重写运行参数中所有以不安全 origin 开头的值（BASE_URL / API_BASE_URL 等地址类
 * 变量一并覆盖；保留 path/query）。返回重写后的参数与生效明细（进执行日志）。
 */
export async function rewriteInsecureParams(
  params: Record<string, string>,
  mode: DeviceProxyMode,
  acquire: (origin: string) => Promise<ProxyHandle>,
): Promise<{
  params: Record<string, string>;
  applied: { key: string; from: string; to: string }[];
}> {
  if (mode === 'off') return { params, applied: [] };
  const applied: { key: string; from: string; to: string }[] = [];
  const originByKey = new Map<string, string>();
  for (const [key, value] of Object.entries(params)) {
    const origin = isInsecureOrigin(value);
    if (origin) originByKey.set(key, origin);
  }
  if (originByKey.size === 0) return { params, applied };
  // 同一目标 origin 复用一个代理
  const proxies = new Map<string, ProxyHandle>();
  for (const origin of new Set(originByKey.values())) {
    proxies.set(origin, await acquire(origin));
  }
  const next: Record<string, string> = { ...params };
  for (const [key, origin] of originByKey) {
    const proxy = proxies.get(origin)!;
    next[key] = proxy.origin + params[key].slice(origin.length);
    applied.push({ key, from: origin, to: proxy.origin });
  }
  return { params: next, applied };
}

interface ManagedProxy extends ProxyHandle {
  server: http.Server;
  sockets: Set<net.Socket>;
  refs: number;
}

export class DeviceProxyManager {
  private managed = new Map<string, Promise<ManagedProxy>>();

  async acquire(targetOrigin: string): Promise<ProxyHandle> {
    let entry = this.managed.get(targetOrigin);
    if (!entry) {
      entry = this.start(targetOrigin).then((p) => {
        p.refs = 1;
        return p;
      });
      this.managed.set(targetOrigin, entry);
      // 启动失败时清掉占位，允许重试
      entry.catch(() => this.managed.delete(targetOrigin));
    } else {
      entry = entry.then((p) => {
        p.refs += 1;
        return p;
      });
    }
    return entry;
  }

  release(targetOrigin: string): void {
    const entry = this.managed.get(targetOrigin);
    if (!entry) return;
    void entry
      .then((p) => {
        p.refs = Math.max(0, p.refs - 1);
        // 引用归零不立即关闭：同 origin 复用避免反复启停；worker 退出时 closeAll 统一销毁
      })
      .catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    const entries = [...this.managed.values()];
    this.managed.clear();
    await Promise.allSettled(
      entries.map((e) =>
        e.then((p) => {
          // 活跃连接（keep-alive / 已升级 WS）会挂住 server.close，先统一销毁
          for (const s of p.sockets) s.destroy();
          return new Promise<void>((resolve) => p.server.close(() => resolve()));
        }),
      ),
    );
  }

  private async start(targetOrigin: string): Promise<ManagedProxy> {
    const target = new URL(targetOrigin);
    const targetHost = target.hostname;
    const targetPort = Number(target.port) || 80;
    const sockets = new Set<net.Socket>();
    const server = http.createServer((req, res) => {
      const up = http.request(
        {
          host: targetHost,
          port: targetPort,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: `${targetHost}:${targetPort}` },
          // 上游 60s 无响应即放弃：SUT 偶发挂起连接时，把挂死转成 502 而不是
          // 让 runner 侧的轮询请求永远悬着（expect.poll 的 deadline 抢占不了未
          // settle 的回调，用例会一路悬到墙钟上限）
          timeout: 60_000,
        },
        (pr) => {
          res.writeHead(pr.statusCode ?? 502, pr.headers);
          pr.pipe(res);
        },
      );
      up.on('timeout', () => up.destroy(new Error('upstream inactivity timeout')));
      up.on('error', (e) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`tern device proxy: upstream ${targetOrigin} error: ${e.message}`);
      });
      req.pipe(up);
    });

    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });

    server.on('upgrade', (req, socket, head) => {
      const up = net.connect(targetPort, targetHost, () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`, `Host: ${targetHost}:${targetPort}`];
        for (const [k, v] of Object.entries(req.headers)) {
          if (k.toLowerCase() === 'host') continue;
          lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        }
        up.write(lines.join('\r\n') + '\r\n\r\n');
        if (head?.length) up.write(head);
      });
      // 等上游 101 + 完整握手响应头后原样回写（Sec-WebSocket-Accept 必须来自上游）
      let handshake = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        handshake = Buffer.concat([handshake, chunk]);
        const idx = handshake.indexOf('\r\n\r\n');
        if (idx === -1) return;
        up.off('data', onData);
        socket.write(handshake.subarray(0, idx + 4));
        const rest = handshake.subarray(idx + 4);
        if (rest.length) socket.write(rest);
        up.pipe(socket);
        socket.pipe(up);
      };
      up.on('data', onData);
      up.on('error', () => socket.destroy());
      socket.on('error', () => up.destroy());
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as { port: number };
    return {
      origin: `http://127.0.0.1:${addr.port}`,
      target: targetOrigin,
      server,
      sockets,
      refs: 0,
    };
  }
}
