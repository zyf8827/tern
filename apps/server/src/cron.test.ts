import test from 'node:test';
import assert from 'node:assert/strict';
import { nextCron, parseCron, isValidCron } from './cron.js';

const T = (s: string) => new Date(s); // 输入用本地解析无所谓，nextCron 内部按 UTC 分钟粒度运算

test('每分钟 / 每小时 / 基本字段', () => {
  assert.equal(
    nextCron('* * * * *', T('2026-09-17T10:30:00Z')).toISOString(),
    '2026-09-17T10:31:00.000Z',
  );
  assert.equal(
    nextCron('0 * * * *', T('2026-09-17T10:30:00Z')).toISOString(),
    '2026-09-17T11:00:00.000Z',
  );
  assert.equal(
    nextCron('0 9 * * *', T('2026-09-17T10:00:00Z')).toISOString(),
    '2026-09-18T09:00:00.000Z',
  );
});

test('工作日 9 点（周六跳到周一）', () => {
  assert.equal(
    nextCron('0 9 * * 1-5', T('2026-09-18T10:00:00Z')).toISOString(),
    '2026-09-21T09:00:00.000Z',
  ); // 周五→周一
  assert.equal(
    nextCron('0 9 * * 1-5', T('2026-09-18T08:00:00Z')).toISOString(),
    '2026-09-18T09:00:00.000Z',
  ); // 当天未到
});

test('步长与列表', () => {
  assert.equal(
    nextCron('*/15 * * * *', T('2026-09-17T10:20:00Z')).toISOString(),
    '2026-09-17T10:30:00.000Z',
  );
  assert.equal(
    nextCron('5,35 * * * *', T('2026-09-17T10:06:00Z')).toISOString(),
    '2026-09-17T10:35:00.000Z',
  );
  assert.equal(
    nextCron('0 9-17/4 * * *', T('2026-09-17T12:01:00Z')).toISOString(),
    '2026-09-17T13:00:00.000Z',
  );
});

test('日与周同时受限时 OR 语义（1 号或每个周一）', () => {
  // 2026-09-20 是周日：当天 00:00 已过（不含），下一个命中是 09-21（周一）
  assert.equal(
    nextCron('0 0 1 * 1', T('2026-09-20T00:00:00Z')).toISOString(),
    '2026-09-21T00:00:00.000Z',
  );
  assert.equal(
    nextCron('0 0 1 * 1', T('2026-09-29T00:00:00Z')).toISOString(),
    '2026-10-01T00:00:00.000Z',
  );
});

test('月末与跨年', () => {
  assert.equal(
    nextCron('0 0 31 * *', T('2026-12-31T01:00:00Z')).toISOString(),
    '2027-01-31T00:00:00.000Z',
  );
  assert.equal(
    nextCron('0 0 1 1 *', T('2026-09-17T00:00:00Z')).toISOString(),
    '2027-01-01T00:00:00.000Z',
  );
});

test('闰年 2 月 29', () => {
  assert.equal(
    nextCron('0 0 29 2 *', T('2026-09-17T00:00:00Z')).toISOString(),
    '2028-02-29T00:00:00.000Z',
  );
});

test('from 恰好是触发点 → 取下一次（不含当前分钟）', () => {
  assert.equal(
    nextCron('30 * * * *', T('2026-09-17T10:30:00Z')).toISOString(),
    '2026-09-17T11:30:00.000Z',
  );
});

test('非法表达式', () => {
  for (const bad of [
    '* * * *',
    '60 * * * *',
    '* 24 * * *',
    '*/0 * * * *',
    'a * * * *',
    '1-99 * * * *',
    '* * 0 * *',
    '5,, * * * *',
  ]) {
    assert.throws(() => parseCron(bad), { name: 'Error' }, `应拒绝: ${bad}`);
    assert.equal(isValidCron(bad), false);
  }
  // 2 月 30 日永远不触发
  assert.equal(isValidCron('0 0 30 2 *'), false);
  assert.equal(isValidCron('*/20 * * * *'), true);
});
