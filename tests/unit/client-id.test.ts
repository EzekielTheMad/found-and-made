import { describe, expect, it } from "vitest";

import { createClientId } from "../../app/client-id";

describe("createClientId", () => {
  it("uses randomUUID when the browser exposes it", () => {
    expect(
      createClientId({
        randomUUID: () => "12345678-1234-4123-8123-123456789abc",
      }),
    ).toBe("12345678-1234-4123-8123-123456789abc");
  });

  it("creates a version 4 identifier when randomUUID is unavailable", () => {
    const id = createClientId({
      getRandomValues(array) {
        array.fill(0xaa);
        return array;
      },
    });

    expect(id).toBe("aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa");
  });
});
