import type { RunEvent } from '@tern/sdk';

interface ScreenInfo {
  sessionId: string;
  targetId: string;
  label: string;
  lastFrameAt: number;
}

/**
 * CDP screencast 侧车：连接 runner 启动的浏览器（--remote-debugging-port），
 * 仅当有观战者时推送浏览器渲染帧。「只读」由协议保证：帧只从浏览器流出，
 * 不存在任何输入回传通道。零额外依赖（原生 fetch + WebSocket）。
 *
 * 多屏：连浏览器级 endpoint 并 Target.setAutoAttach，覆盖全部现存与运行中新开的
 * page target（Playwright 多 context/多标签页各算一屏）；每屏独立起流、独立限频，
 * 帧带屏标识（targetId）与显示名（页面标题，退回 URL 路径）。
 */
export class ScreencastSidecar {
  private ws: WebSocket | null = null;
  private stopped = false;
  private nextId = 1;
  private screens = new Map<string, ScreenInfo>(); // key: CDP sessionId

  private constructor(
    private readonly cdpPort: number,
    private readonly onFrame: (base64Jpeg: string, screen: string, screenLabel: string) => void,
    private readonly minFrameIntervalMs: number,
  ) {}

  static async start(
    cdpPort: number,
    onFrame: (base64Jpeg: string, screen: string, screenLabel: string) => void,
    minFrameIntervalMs = 180,
  ): Promise<ScreencastSidecar> {
    const sidecar = new ScreencastSidecar(cdpPort, onFrame, minFrameIntervalMs);
    await sidecar.connect();
    return sidecar;
  }

  private async findBrowserWsUrl(): Promise<string> {
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.cdpPort}/json/version`);
        const info = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
      } catch {
        // 浏览器可能尚未监听，稍后重试
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`CDP 端口 ${this.cdpPort} 上未找到浏览器 endpoint`);
  }

  private labelOf(info: { title?: string; url?: string }): string {
    if (info.title) return info.title;
    try {
      if (info.url) return new URL(info.url).pathname || info.url;
    } catch {
      /* 非法 URL 原样返回 */
    }
    return info.url || '未命名页面';
  }

  /** flatten 会话：消息带 sessionId 路由到具体 target */
  private send(method: string, params: Record<string, unknown>, sessionId?: string): void {
    if (!this.ws) return;
    this.ws.send(
      JSON.stringify({ id: this.nextId++, method, params, ...(sessionId ? { sessionId } : {}) }),
    );
  }

  private async connect(): Promise<void> {
    const wsUrl = await this.findBrowserWsUrl();
    if (this.stopped) return;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), {
        once: true,
      });
    });
    ws.addEventListener('message', (ev) => {
      let msg: {
        method?: string;
        params?: {
          data?: string;
          sessionId?: string;
          targetInfo?: { targetId?: string; type?: string; title?: string; url?: string };
        };
        sessionId?: string;
      };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (
        msg.method === 'Target.attachedToTarget' &&
        msg.params?.targetInfo?.type === 'page' &&
        msg.params.sessionId
      ) {
        const { sessionId, targetInfo } = msg.params as {
          sessionId: string;
          targetInfo: { targetId: string; title?: string; url?: string };
        };
        this.screens.set(sessionId, {
          sessionId,
          targetId: targetInfo.targetId,
          label: this.labelOf(targetInfo),
          lastFrameAt: 0,
        });
        this.send(
          'Page.startScreencast',
          { format: 'jpeg', quality: 50, maxWidth: 1280, everyNthFrame: 1 },
          sessionId,
        );
        return;
      }
      if (msg.method === 'Target.detachedFromTarget' && msg.params?.sessionId) {
        this.screens.delete(msg.params.sessionId);
        return;
      }
      if (msg.method === 'Target.targetInfoChanged' && msg.params?.targetInfo?.targetId) {
        for (const s of this.screens.values()) {
          if (s.targetId === msg.params!.targetInfo!.targetId)
            s.label = this.labelOf(msg.params!.targetInfo!);
        }
        return;
      }
      if (msg.method === 'Page.screencastFrame' && msg.params?.data && msg.sessionId) {
        const screen = this.screens.get(msg.sessionId);
        const now = Date.now();
        if (screen && now - screen.lastFrameAt >= this.minFrameIntervalMs) {
          screen.lastFrameAt = now;
          try {
            this.onFrame(msg.params.data, screen.targetId, screen.label);
          } catch {
            /* ignore */
          }
        }
        // 必须 ack，否则浏览器停止推帧
        this.send('Page.screencastFrameAck', { sessionId: msg.params.sessionId }, msg.sessionId);
      }
    });
    this.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  }

  stop(): void {
    this.stopped = true;
    for (const s of this.screens.values()) {
      try {
        this.send('Page.stopScreencast', {}, s.sessionId);
      } catch {
        /* ignore */
      }
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.screens.clear();
  }
}

export function frameEvent(data: string, screen?: string, screenLabel?: string): RunEvent {
  return { type: 'frame', ts: new Date().toISOString(), data, screen, screenLabel };
}
