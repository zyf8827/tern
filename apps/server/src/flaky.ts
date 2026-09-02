// flaky 治理（docs/platform-enhancements.md F5）
// 滚动窗口（默认 50 次终态执行）物化到 case_stats；窗口内 flaky 率超阈值自动隔离，
// 连续 10 次通过自动恢复；手动设置优先于自动规则（auto 不覆盖 manual）。
import type { Runtime } from './runtime.js';

const WINDOW = 50;
const RECOVER_STREAK = 10;

function threshold(): number {
  const v = Number(process.env.FLAKY_QUARANTINE_THRESHOLD);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.3;
}
function minSamples(): number {
  const v = Number(process.env.FLAKY_QUARANTINE_MIN_SAMPLES);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 10;
}

/** outcome：终态 + 是否判定为 flaky（runner 内重试通过 或 run 级 attempt>1 后通过） */
export function recordCaseOutcome(
  rt: Runtime,
  caseId: string,
  status: string,
  flaky: boolean,
): void {
  const db = rt.db;
  const row = db.prepare('SELECT * FROM case_stats WHERE case_id=?').get(caseId) as
    { history: string } | undefined;
  const hist: string[] = row ? JSON.parse(row.history || '[]') : [];
  let code: string;
  if (flaky && status === 'passed') code = 'F';
  else if (status === 'passed') code = 'p';
  else if (status === 'failed' || status === 'timed_out' || status === 'error') code = 'f';
  else if (status === 'skipped') code = 's';
  else code = 'c'; // cancelled 等不参与 flaky 率但进窗口
  hist.push(code);
  while (hist.length > WINDOW) hist.shift();
  const total = hist.filter((c) => c !== 's' && c !== 'c').length;
  const passed = hist.filter((c) => c === 'p' || c === 'F').length;
  const failed = hist.filter((c) => c === 'f').length;
  const flakyCount = hist.filter((c) => c === 'F').length;
  const now = new Date().toISOString();
  if (row) {
    db.prepare(
      'UPDATE case_stats SET total=?, passed=?, failed=?, flaky=?, history=?, updated_at=? WHERE case_id=?',
    ).run(total, passed, failed, flakyCount, JSON.stringify(hist), now, caseId);
  } else {
    db.prepare(
      'INSERT INTO case_stats (case_id, total, passed, failed, flaky, history, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(caseId, total, passed, failed, flakyCount, JSON.stringify(hist), now);
  }
  evaluateQuarantine(rt, caseId, hist);
}

/** 自动隔离/恢复规则；manual 不被覆盖 */
function evaluateQuarantine(rt: Runtime, caseId: string, hist: string[]): void {
  const db = rt.db;
  const kase = db
    .prepare('SELECT quarantined, quarantined_by FROM cases WHERE id=?')
    .get(caseId) as { quarantined: number; quarantined_by: string | null } | undefined;
  if (!kase) return;
  const effective = hist.filter((c) => c !== 's' && c !== 'c');
  const flakyCount = hist.filter((c) => c === 'F').length;
  const rate = effective.length ? flakyCount / effective.length : 0;
  const shouldQuarantine = effective.length >= minSamples() && rate >= threshold();
  const streak = countTrailingPass(hist);

  if (shouldQuarantine && !kase.quarantined) {
    db.prepare('UPDATE cases SET quarantined=1, quarantined_by=? WHERE id=?').run('auto', caseId);
    rt.events.emit('system', 'system.alert', {
      level: 'warn',
      message: `用例 ${caseId} flaky 率 ${(rate * 100).toFixed(0)}%（近 ${effective.length} 次，flaky ${flakyCount} 次）≥ 阈值 ${threshold()}，已自动隔离（照常可显式运行，默认不参与新建运行）`,
    });
    rt.log.warn({ caseId, rate }, 'case auto-quarantined');
  } else if (kase.quarantined && kase.quarantined_by === 'auto' && streak >= RECOVER_STREAK) {
    db.prepare('UPDATE cases SET quarantined=0, quarantined_by=? WHERE id=?').run(
      'auto-recovered',
      caseId,
    );
    rt.events.emit('system', 'system.alert', {
      level: 'info',
      message: `用例 ${caseId} 连续 ${streak} 次通过，已自动解除隔离`,
    });
  }
}

function countTrailingPass(hist: string[]): number {
  let n = 0;
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i] === 'p') n++;
    else break;
  }
  return n;
}

/** 手动隔离开关（manual 优先：auto 规则不再翻转 manual 设置，直到恢复条件满足后重新进入 auto 域） */
export function setCaseQuarantine(rt: Runtime, caseId: string, quarantined: boolean): void {
  const db = rt.db;
  const kase = db.prepare('SELECT id FROM cases WHERE id=?').get(caseId);
  if (!kase) return;
  db.prepare('UPDATE cases SET quarantined=?, quarantined_by=? WHERE id=?').run(
    quarantined ? 1 : 0,
    quarantined ? 'manual' : null,
    caseId,
  );
  rt.events.emit('system', 'system.alert', {
    level: 'info',
    message: `用例 ${caseId} 已${quarantined ? '手动隔离' : '手动解除隔离'}`,
  });
}
