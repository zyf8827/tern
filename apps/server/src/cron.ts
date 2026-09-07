// 5 字段 cron 解析（docs/platform-enhancements.md §F6）：分 时 日 月 周。
// 支持 *、n、a-b、a-b/n、*/n、逗号列表；日/周同时受限时按标准 cron 的 OR 语义。
// 零依赖纯函数；nextCron 返回 from 之后（不含）的第一个匹配分钟。
export interface CronExpr {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  dows: Set<number>;
  dayRestricted: boolean; // 日与周是否都受限（OR 语义判定）
}

const RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week（0=周日）
];

function parseField(field: string, idx: number): { values: Set<number>; restricted: boolean } {
  const [min, max] = RANGES[idx];
  const values = new Set<number>();
  let restricted = false;
  for (const part of field.split(',')) {
    if (!part) throw new Error(`cron 字段 ${idx + 1} 含空片段: "${field}"`);
    let range = part;
    let step = 1;
    const slash = part.indexOf('/');
    if (slash >= 0) {
      range = part.slice(0, slash);
      step = Number(part.slice(slash + 1));
      if (!Number.isInteger(step) || step < 1) throw new Error(`cron 步长非法: "${part}"`);
    }
    let lo: number, hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else {
      const m = /^(\d+)(?:-(\d+))?$/.exec(range);
      if (!m) throw new Error(`cron 字段语法非法: "${part}"`);
      lo = Number(m[1]);
      hi = m[2] !== undefined ? Number(m[2]) : slash >= 0 ? max : lo;
    }
    if (lo < min || hi > max || lo > hi)
      throw new Error(`cron 字段越界（字段 ${idx + 1} 允许 ${min}-${max}）: "${part}"`);
    if (range !== '*' || slash >= 0) restricted = true;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, restricted };
}

export function parseCron(expr: string): CronExpr {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5)
    throw new Error(`cron 表达式必须是 5 个字段（分 时 日 月 周）: "${expr}"`);
  const [minute, hour, dom, mon, dow] = fields.map((f, i) => parseField(f, i));
  return {
    minutes: minute.values,
    hours: hour.values,
    days: dom.values,
    months: mon.values,
    dows: dow.values,
    dayRestricted: dom.restricted && dow.restricted,
  };
}

function dayMatches(c: CronExpr, d: Date): boolean {
  if (!c.months.has(d.getUTCMonth() + 1)) return false;
  const domOk = c.days.has(d.getUTCDate());
  const dowOk = c.dows.has(d.getUTCDay());
  return c.dayRestricted ? domOk || dowOk : domOk && dowOk;
}

/** 返回 from 之后（不含）的第一个匹配时间（分钟精度，UTC）；4 年内无匹配则抛错 */
export function nextCron(expr: string, from: Date): Date {
  const c = parseCron(expr);
  const start = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000); // 下一分钟整
  const limitMs = 4 * 366 * 24 * 3600 * 1000;
  let day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  for (
    let elapsed = 0;
    elapsed < limitMs;
    elapsed += 24 * 3600 * 1000, day = new Date(day.getTime() + 24 * 3600 * 1000)
  ) {
    if (!dayMatches(c, day)) continue;
    const firstDay =
      day.getTime() === Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
    // 首日从 start 的下一分钟开始扫；day 本身是 UTC 午夜，分钟基准取自 start
    const fromMin = firstDay ? start.getUTCHours() * 60 + start.getUTCMinutes() : 0;
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m++) {
        const t = h * 60 + m;
        if (t < fromMin) continue;
        if (!c.hours.has(h) || !c.minutes.has(m)) continue;
        return new Date(day.getTime() + t * 60_000);
      }
    }
  }
  throw new Error(`cron 表达式在 4 年内没有触发时间: "${expr}"`);
}

export function isValidCron(expr: string): boolean {
  try {
    nextCron(expr, new Date());
    return true;
  } catch {
    return false;
  }
}
