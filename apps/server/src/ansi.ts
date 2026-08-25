/** 剥离 ANSI 颜色转义序列（Playwright reporter 输出带色码，入库/展示前统一清洗） */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}
