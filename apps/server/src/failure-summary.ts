import { stripAnsi } from './ansi.js';
// 失败摘要（docs/platform-enhancements.md F4）
// 按 error_sig 聚合一次 run 的失败用例；同签名跨全表统计「首见/最近/出现 run 数」。
import type { Runtime } from './runtime.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ApiError } from './errors.js';
import { normalizeErrorLine } from './error-sig.js';
import type { FailureGroup, FailureSummary } from '@tern/sdk';

const FAIL_STATES = "('failed','timed_out','error')";

interface FailRow {
  sig: string | null;
  case_id: string;
  status: string;
  duration_ms: number | null;
  error: string | null;
  artifacts: string | null;
  run_id: string;
}

export function failureSummary(rt: Runtime, runId: string): FailureSummary {
  const db = rt.db;
  const run = db.prepare('SELECT id FROM batches WHERE id=?').get(runId);
  if (!run) throw new ApiError(404, 'RUN_NOT_FOUND', `测试运行不存在: ${runId}`);
  const rows = db
    .prepare(
      `SELECT r.error_sig AS sig, bi.case_id, r.status, r.duration_ms, r.error, r.artifacts, r.id AS run_id
       FROM batch_items bi JOIN case_runs r ON r.id = bi.final_run_id
       WHERE bi.batch_id = ? AND bi.status IN ${FAIL_STATES} AND r.id IS NOT NULL
       ORDER BY bi.position`,
    )
    .all(runId) as FailRow[];

  const bySig = new Map<string, FailRow[]>();
  for (const r of rows) {
    const sig = r.sig ?? 'status:unknown';
    const list = bySig.get(sig) ?? [];
    list.push(r);
    bySig.set(sig, list);
  }

  const groups: FailureGroup[] = [];
  for (const [sig, list] of bySig) {
    const first = list[0];
    const errObj = first.error ? (JSON.parse(first.error) as { message?: string }) : null;
    if (errObj?.message) errObj.message = stripAnsi(errObj.message);
    const label = sig.startsWith('status:')
      ? `${sig.slice(7)}（无错误消息）`
      : normalizeErrorLine(errObj?.message ?? '');
    // 跨 run 历史（同签名全表）
    const hist = db
      .prepare(
        `SELECT COUNT(DISTINCT batch_id) AS runs, MIN(finished_at) AS first_at, MAX(finished_at) AS last_at
         FROM case_runs WHERE error_sig = ?`,
      )
      .get(sig) as { runs: number; first_at: string | null; last_at: string | null };

    groups.push({
      sig,
      label,
      count: list.length,
      items: list.slice(0, 20).map((r) => {
        const artifacts = r.artifacts
          ? (JSON.parse(r.artifacts) as { screenshots?: string[]; trace?: string })
          : null;
        return {
          caseId: r.case_id,
          executionId: r.run_id,
          status: r.status,
          durationMs: r.duration_ms,
          error: errObj,
          screenshotUrl: artifacts?.screenshots?.[0] ?? null,
          traceUrl: artifacts?.trace ?? null,
          logTail: readLogTail(rt, runId, r.run_id),
        };
      }),
      history: { occurrenceRuns: hist.runs, firstSeenAt: hist.first_at, lastSeenAt: hist.last_at },
    });
  }
  groups.sort((a, b) => b.count - a.count);
  return { runId, groups };
}

function readLogTail(rt: Runtime, batchId: string, runId: string): string[] {
  try {
    const text = readFileSync(path.join(rt.cfg.artifactsDir, batchId, runId, 'run.log'), 'utf8');
    return text.split('\n').filter(Boolean).slice(-20);
  } catch {
    return [];
  }
}
