import { afterEach, describe, expect, it, vi } from "vitest";

import { publicActionFailure } from "../../app/action-error";

describe("public action failure redaction", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns a request reference without exposing exception details", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = publicActionFailure(
      new Error("SQL /data/private.db token=super-secret"),
      "Action failed",
    );

    expect(failure.message).toContain(failure.requestId);
    expect(failure.message).toContain("Action failed");
    expect(JSON.stringify(failure)).not.toMatch(/private|secret|sql/i);
    expect(logged).toHaveBeenCalledOnce();
    expect(logged.mock.calls[0]?.[0]).not.toMatch(/private|secret|sql/i);
  });
});
