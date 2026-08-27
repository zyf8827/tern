import type { RunOptions } from '@tern/sdk';

export interface GenConfigInput {
  timeoutS: number;
  retries: number;
  options: RunOptions;
  cdpPort: number;
  reporterPath: string;
  outputDir: string;
  headless: boolean;
  /** 设备模拟启动参数（fake mic/camera；文件路径已解析为 worker 本地绝对路径） */
  deviceArgs?: string[];
}

/**
 * 生成 runner 使用的临时 playwright.config.cjs。
 * 值直接内联（批次参数经环境变量注入，BASE_URL → use.baseURL）。
 * 登录态不经 use.storageState 注入（CDP 写入的 cookie 在新内核上不被网络栈附带），
 * 而是由 case.spec.js 头部的 prologue 以页面自然通道写入，见 runner.authPrologueCode。
 */
export function genPlaywrightConfig(input: GenConfigInput): string {
  const { timeoutS, retries, options, cdpPort, reporterPath, outputDir, headless, deviceArgs } =
    input;
  const cfg = `// 由 tern exec-kit 生成（勿手改）
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: 'case.spec.js',
  workers: 1,
  fullyParallel: false,
  timeout: ${Math.round(timeoutS * 1000)},
  retries: ${retries},
  outputDir: ${JSON.stringify(outputDir)},
  reporter: [[${JSON.stringify(reporterPath)}]],
  use: {
    baseURL: process.env.BASE_URL || undefined,
    screenshot: 'only-on-failure',
    trace: ${JSON.stringify(options.trace)},
    video: ${options.video ? "'on'" : "'off'"},
    headless: ${headless},
    launchOptions: {
      args: ['--remote-debugging-port=${cdpPort}'${deviceArgs && deviceArgs.length ? `, ...${JSON.stringify(deviceArgs)}` : ''}],
    },
  },
});
`;
  return cfg;
}
