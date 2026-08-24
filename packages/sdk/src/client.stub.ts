/**
 * Temporary HTTP client stub for @tern/sdk
 * Replaced when server API solidifies.
 */
export class TernClientStub {
  constructor(public baseUrl: string = 'http://localhost:3000') {}

  async ping(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async getStatus(): Promise<{ status: string }> {
    return { status: 'stub' };
  }
}
