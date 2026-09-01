import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { parseTraceDir, unzipToDir } from './trace-view.js';

/** 最小 zip 写入器（store/deflate 均写），仅单测构造夹具用 */
function buildZip(files: Record<string, Buffer>, deflate = false): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = deflate ? deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

const NDJSON = [
  JSON.stringify({ version: 8, type: 'context-options' }),
  JSON.stringify({
    type: 'before',
    callId: 'call@1',
    startTime: 100.0,
    class: 'Frame',
    method: 'goto',
    params: { url: 'http://x' },
  }),
  JSON.stringify({
    type: 'before',
    callId: 'call@2',
    startTime: 150.5,
    class: 'Frame',
    method: 'waitForSelector',
  }),
  JSON.stringify({ type: 'after', callId: 'call@1', endTime: 102.25 }),
  JSON.stringify({
    type: 'after',
    callId: 'call@2',
    endTime: 151.0,
    error: { message: '\x1b[31mTimeoutError\x1b[39m: 5000ms exceeded' },
  }),
  JSON.stringify({
    type: 'screencast-frame',
    sha1: 'page@f-1.jpeg',
    width: 1280,
    height: 720,
    frameSwapWallTime: 1789800817497,
  }),
  JSON.stringify({
    type: 'console',
    messageType: 'warning',
    text: 'hi',
    location: { url: 'http://x/a.js' },
  }),
  JSON.stringify({ type: 'frame-snapshot', foo: 1 }),
].join('\n');

const NETWORK = [
  JSON.stringify({
    type: 'resource-snapshot',
    snapshot: {
      request: { method: 'GET', url: 'http://x/' },
      response: { status: 200 },
      time: 12.4,
    },
  }),
].join('\n');

test('unzipToDir + parseTraceDir：动作/胶片/控制台/网络与 ANSI 清洗', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tern-trace-'));
  try {
    const zip = buildZip(
      {
        '0-trace.trace': Buffer.from(NDJSON, 'utf8'),
        '0-trace.network': Buffer.from(NETWORK, 'utf8'),
        'resources/page@f-1.jpeg': Buffer.from([0xff, 0xd8, 0xff]),
      },
      true,
    );
    const zipPath = path.join(dir, 'trace.zip');
    writeFileSync(zipPath, zip);
    const dest = path.join(dir, 'extracted');
    unzipToDir(zipPath, dest);
    assert.deepEqual(readdirSync(dest).sort(), ['0-trace.network', '0-trace.trace', 'resources']);
    assert.equal(readFileSync(path.join(dest, 'resources/page@f-1.jpeg')).length, 3);

    const view = parseTraceDir(dest, '/artifacts/r/e/trace-extracted');
    assert.equal(view.actions.length, 2);
    const goto = view.actions.find((a) => a.callId === 'call@1')!;
    assert.equal(goto.title, 'Frame.goto');
    assert.equal(goto.durationMs, 2250);
    assert.equal(goto.error, null);
    const wait = view.actions.find((a) => a.callId === 'call@2')!;
    assert.equal(wait.error, 'TimeoutError: 5000ms exceeded'); // ANSI 已剥离
    assert.equal(view.frames.length, 1);
    assert.equal(view.frames[0].url, '/artifacts/r/e/trace-extracted/resources/page@f-1.jpeg');
    assert.equal(view.console.length, 1);
    assert.equal(view.network.length, 1);
    assert.equal(view.network[0].status, 200);
    // 幂等：已解压不重复
    unzipToDir(zipPath, dest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unzipToDir：路径穿越条目被跳过', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tern-trace-evil-'));
  try {
    const zip = buildZip({ '../evil.txt': Buffer.from('x') });
    const zipPath = path.join(dir, 'evil.zip');
    writeFileSync(zipPath, zip);
    const dest = path.join(dir, 'out');
    unzipToDir(zipPath, dest);
    const names = readdirSync(dest);
    assert.equal(names.includes('evil.txt'), false);
    assert.equal(existsSync(path.join(dir, 'evil.txt')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function existsSync(p: string): boolean {
  try {
    return readdirSync(path.dirname(p)).includes(path.basename(p));
  } catch {
    return false;
  }
}

// 避免 mkdirSync 未用告警（夹具里仅经 unzipToDir 间接使用）
void mkdirSync;
