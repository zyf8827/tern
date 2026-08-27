/**
 * Execution loop helper prototype.
 * Consolidated into runner.ts.
 */
export interface DraftRunOptions {
  casePath: string;
  timeoutMs: number;
}

export async function runDraftCase(opts: DraftRunOptions) {
  // Prototype runner loop placeholder
  return { success: true, duration: 0 };
}
