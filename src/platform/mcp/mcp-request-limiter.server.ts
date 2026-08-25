export interface McpRequestLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface WindowState {
  count: number;
  startedAt: number;
}

export class McpRequestLimiter {
  private readonly windows = new Map<string, WindowState>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error("MCP request limit must be a positive whole number");
    if (!Number.isInteger(windowMs) || windowMs < 1_000)
      throw new Error("MCP request window must be at least one second");
  }

  consume(subject: string, now = Date.now()): McpRequestLimitResult {
    const startedAt = Math.floor(now / this.windowMs) * this.windowMs;
    const current = this.windows.get(subject);
    const state =
      current?.startedAt === startedAt ? current : { count: 0, startedAt };
    state.count += 1;
    this.windows.set(subject, state);
    this.evictExpired(startedAt);
    return {
      allowed: state.count <= this.limit,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((startedAt + this.windowMs - now) / 1_000),
      ),
    };
  }

  private evictExpired(currentWindow: number): void {
    for (const [subject, state] of this.windows) {
      if (state.startedAt < currentWindow) this.windows.delete(subject);
    }
  }
}
