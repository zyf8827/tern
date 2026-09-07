// Webhook 通知（支持 Generic HTTP Webhook 与 DingTalk 机器人）
// run 终态时对匹配的 webhook（项目级 + 全局）发送通知；notified_at 幂等。
// 发送 fire-and-forget：超时 5s、重试 2 次，失败只告警不影响 run 主流程。
import { createHmac } from 'node:crypto';
import type { Runtime } from './runtime.js';
import { failureSummary } from './failure-summary.js';

export interface WebhookRow {
  id: number;
  project_id: number | null;
  type: string;
  url: string;
  secret: string;
  notify_on: string;
  enabled: number;
}

export interface WebhookPayload {
  event: 'run.finished' | 'test';
  timestamp: string;
  markdown: { title: string; text: string };
  run?: {
    id: string;
    title: string;
    project: string | null;
    status: string;
    passed: number;
    failed: number;
    skipped: number;
    total: number;
    durationMs: number | null;
    env: string | null;
    link: string;
  };
  summary?: {
    failedGroups?: Array<{ label: string; count: number }>;
  };
}

function dingTalkUrl(wh: WebhookRow): string {
  if (!wh.secret) return wh.url;
  const timestamp = Date.now();
  const sign = encodeURIComponent(
    Buffer.from(
      createHmac('sha256', wh.secret).update(`${timestamp}\n${wh.secret}`).digest(),
    ).toString('base64'),
  );
  const sep = wh.url.includes('?') ? '&' : '?';
  return `${wh.url}${sep}timestamp=${timestamp}&sign=${sign}`;
}

export async function sendDingTalk(
  wh: WebhookRow,
  payload: WebhookPayload | { title: string; text: string },
): Promise<void> {
  const url = dingTalkUrl(wh);
  const markdown = 'markdown' in payload ? payload.markdown : payload;
  const body = JSON.stringify({ msgtype: 'markdown', markdown });
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 3000));
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const json = (await res.json().catch(() => null)) as {
        errcode?: number;
        errmsg?: string;
      } | null;
      if (res.ok && json?.errcode === 0) return;
      lastErr = new Error(`钉钉响应异常 HTTP ${res.status}: ${json?.errmsg ?? ''}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function sendGenericWebhook(
  wh: WebhookRow,
  payload: WebhookPayload | { title: string; text: string },
): Promise<void> {
  const data: WebhookPayload =
    'event' in payload
      ? payload
      : {
          event: 'test',
          timestamp: new Date().toISOString(),
          markdown: payload,
        };
  const body = JSON.stringify(data);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-tern-event': data.event,
    'x-tern-timestamp': data.timestamp,
  };
  if (wh.secret) {
    const sig = createHmac('sha256', wh.secret).update(body).digest('hex');
    headers['x-tern-signature'] = `sha256=${sig}`;
  }

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 3000));
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(wh.url, {
        method: 'POST',
        headers,
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) return;
      lastErr = new Error(`Webhook 响应异常 HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function sendWebhook(
  wh: WebhookRow,
  payload: WebhookPayload | { title: string; text: string },
): Promise<void> {
  if (wh.type === 'dingtalk') {
    return sendDingTalk(wh, payload);
  }
  return sendGenericWebhook(wh, payload);
}

function fmtDur(ms: number | null | undefined): string {
  if (ms == null) return '-';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

/** run 终态通知入口（recomputeRun 调用）；fire-and-forget */
export function notifyRunFinished(rt: Runtime, batchId: string): void {
  const db = rt.db;
  const batch = db
    .prepare(
      'SELECT id, title, project, env_name, status, total, passed, failed, timed_out, error, skipped, created_at, finished_at, notified_at FROM batches WHERE id=?',
    )
    .get(batchId) as
    | {
        id: string;
        title: string;
        project: string | null;
        env_name: string | null;
        status: string;
        total: number;
        passed: number;
        failed: number;
        timed_out: number;
        error: number;
        skipped: number;
        created_at: string;
        finished_at: string | null;
        notified_at: string | null;
      }
    | undefined;
  if (!batch || batch.notified_at) return;
  const failed = batch.failed + batch.timed_out + batch.error;
  const hooks = (
    db
      .prepare(
        `SELECT * FROM webhooks WHERE enabled=1 AND (project_id IS NULL OR project_id = (SELECT id FROM projects WHERE name=?))`,
      )
      .all(batch.project ?? '') as WebhookRow[]
  ).filter((w) => w.notify_on === 'always' || failed > 0);
  if (hooks.length === 0) {
    db.prepare('UPDATE batches SET notified_at=? WHERE id=?').run(
      new Date().toISOString(),
      batchId,
    );
    return;
  }

  // 失败分组 top3（复用 F4 摘要）
  let groupsText = '';
  let failedGroups: Array<{ label: string; count: number }> = [];
  try {
    const summary = failureSummary(rt, batchId);
    if (summary.groups.length) {
      failedGroups = summary.groups.map((g) => ({ label: g.label, count: g.count }));
      groupsText = summary.groups
        .slice(0, 3)
        .map((g) => `- ✗ ${g.label.slice(0, 60)}（${g.count} 例）`)
        .join('\n');
    }
  } catch {
    /* 摘要失败不影响通知 */
  }

  const ok = batch.status === 'completed' && failed === 0;
  const emoji = ok ? '✅' : failed > 0 ? '❌' : '☑️';
  const durationMs = batch.finished_at
    ? Date.parse(batch.finished_at) - Date.parse(batch.created_at)
    : null;
  const link = `${rt.cfg.publicUrl.replace(/\/$/, '')}/runs/${batch.id}`;
  // 多环境并跑（测试集）：按环境分列通过率（如 dev 12/12 · staging 9/12）；单环境沿 env_name
  const envParts: string[] = [];
  if (batch.env_name) envParts.push(batch.env_name);
  else {
    const ctxEnvs = db
      .prepare('SELECT DISTINCT env_name FROM run_envs WHERE batch_id=? AND env_name IS NOT NULL')
      .all(batchId) as { env_name: string }[];
    if (ctxEnvs.length === 1) envParts.push(ctxEnvs[0].env_name);
    else if (ctxEnvs.length > 1) {
      for (const c of ctxEnvs) {
        const rows = db
          .prepare(
            `SELECT COALESCE(SUM(CASE WHEN bi.status='passed' THEN 1 ELSE 0 END), 0) AS p, COUNT(*) AS t
             FROM batch_items bi JOIN run_envs re ON re.id = bi.run_env_id WHERE bi.batch_id=? AND re.env_name=?`,
          )
          .get(batchId, c.env_name) as { p: number; t: number };
        envParts.push(`${c.env_name} ${rows.p}/${rows.t}${rows.p < rows.t ? ' ✗' : ' ✓'}`);
      }
    }
  }
  const text = [
    `${emoji} **Tern 测试运行${ok ? '通过' : failed > 0 ? '失败' : '结束'}**`,
    '',
    `- 运行：${batch.title}`,
    `- 项目：${batch.project ?? '-'}${envParts.length ? ` · 环境 ${envParts.join(' · ')}` : ''}`,
    `- 结果：✓${batch.passed} ✗${failed} ⏭${batch.skipped} 共${batch.total}`,
    `- 耗时：${fmtDur(durationMs)}`,
    groupsText ? `\n**失败分组（top3）**\n${groupsText}` : '',
    `\n[查看详情](${link})`,
  ].join('\n');

  const payload: WebhookPayload = {
    event: 'run.finished',
    timestamp: new Date().toISOString(),
    markdown: { title: 'Tern 测试运行通知', text },
    run: {
      id: batch.id,
      title: batch.title,
      project: batch.project,
      status: batch.status,
      passed: batch.passed,
      failed,
      skipped: batch.skipped,
      total: batch.total,
      durationMs,
      env: envParts.join(' · ') || batch.env_name || null,
      link,
    },
    summary: {
      failedGroups,
    },
  };

  void (async () => {
    let sent = 0;
    const errs: string[] = [];
    for (const wh of hooks) {
      try {
        await sendWebhook(wh, payload);
        sent++;
      } catch (e) {
        errs.push(`#${wh.id}: ${(e as Error).message}`);
      }
    }
    if (sent > 0)
      db.prepare('UPDATE batches SET notified_at=? WHERE id=?').run(
        new Date().toISOString(),
        batchId,
      );
    if (errs.length) {
      rt.log.warn({ runId: batchId, errs }, 'webhook notify failed');
      rt.events.emit('system', 'system.alert', {
        level: 'warn',
        message: `Webhook通知发送失败：${errs.join('；')}`,
      });
    }
  })();
}
