/*
 * exec-kit 事件 reporter：作为自定义 reporter 被 playwright test runner 加载，
 * 把 runner 事件以 NDJSON POST 到本机 TERN_REPORT_PORT，由 worker 父进程消费。
 * 必须保持零依赖纯 CJS；module.exports 直接是 Reporter 类（playwright 约定）。
 */
'use strict';
const http = require('http');

class TernReporter {
  constructor() {
    this.queue = [];
    this.timer = null;
    this.closed = false;
    this.counts = { passed: 0, failed: 0, skipped: 0, flaky: 0, interrupted: 0 };
  }

  _send(ev) {
    if (this.closed) return;
    if (!ev.ts) ev.ts = new Date().toISOString();
    this.queue.push(ev);
    if (this.queue.length >= 20) {
      this._flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this._flush();
      }, 120);
    }
  }

  _flush(done) {
    if (!this.queue.length) {
      if (done) done();
      return;
    }
    const lines =
      this.queue
        .splice(0)
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n';
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(process.env.TERN_REPORT_PORT || 0),
        method: 'POST',
        path: '/event',
        headers: {
          'content-type': 'application/x-ndjson',
          'content-length': Buffer.byteLength(lines),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          if (done) done();
        });
      },
    );
    req.on('error', () => {
      if (done) done();
    });
    req.end(lines);
  }

  onBegin(config, suite) {
    this._send({ type: 'begin', total: suite.allTests().length });
  }

  onTestBegin(test) {
    this._send({ type: 'testBegin', title: test.title });
  }

  onTestEnd(test, result) {
    const outcome = test.outcome();
    if (outcome === 'expected') this.counts.passed++;
    else if (outcome === 'flaky') {
      this.counts.passed++;
      this.counts.flaky++;
    } else if (outcome === 'skipped') this.counts.skipped++;
    else this.counts.failed++;
    if (result.status === 'interrupted') this.counts.interrupted++;
    this._send({
      type: 'testEnd',
      title: test.title,
      status: result.status,
      outcome,
      duration: result.duration,
      error: result.error ? { message: result.error.message, stack: result.error.stack } : null,
    });
  }

  onStepBegin(step) {
    this._send({ type: 'step', title: step.title, category: step.category, phase: 'begin' });
  }

  onStepEnd(step) {
    this._send({ type: 'step', title: step.title, category: step.category, phase: 'end' });
  }

  onStdOut(chunk) {
    this._send({ type: 'stdout', text: chunk.toString() });
  }

  onStdErr(chunk) {
    this._send({ type: 'stderr', text: chunk.toString() });
  }

  onError(error) {
    this._send({ type: 'error', message: error.message, stack: error.stack });
  }

  onEnd() {
    const self = this;
    self._send({ type: 'end', ...self.counts });
    return new Promise((resolve) => {
      if (self.timer) {
        clearTimeout(self.timer);
        self.timer = null;
      }
      self._flush(() => {
        self.closed = true;
        resolve({ status: 'passed' });
      });
    });
  }
}

module.exports = TernReporter;
