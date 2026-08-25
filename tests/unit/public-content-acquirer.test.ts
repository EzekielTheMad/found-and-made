import { describe, expect, it } from "vitest";
import { createServer } from "node:http";

import {
  PublicContentAcquirer,
  isPublicAddress,
  nodeFetchTransport,
} from "#src/platform/network/public-content-acquirer.server";

describe("PublicContentAcquirer", () => {
  it("blocks unsafe URL forms and every private/reserved address class", async () => {
    const transport = transportFor(
      new Response("ok", { headers: { "content-type": "text/html" } }),
    );
    const acquirer = new PublicContentAcquirer({
      fetchTransport: transport,
      resolver: () => Promise.resolve(["93.184.216.34"]),
    });
    for (const url of [
      "file:///etc/passwd",
      "https://user:secret@example.test/",
      "https://example.test/#fragment",
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://localhost/",
    ]) {
      await expect(
        acquirer.acquire({
          preference: ["official_metadata", "public_page"],
          url,
        }),
      ).resolves.toEqual({
        method: "blocked",
        reason: "Public content was blocked",
      });
    }
    expect(transport.calls).toHaveLength(0);
    expect(isPublicAddress("10.0.0.1")).toBe(false);
    expect(isPublicAddress("169.254.1.1")).toBe(false);
    expect(isPublicAddress("224.0.0.1")).toBe(false);
    expect(isPublicAddress("fc00::1")).toBe(false);
    expect(isPublicAddress("fe80::1")).toBe(false);
    expect(isPublicAddress("ff02::1")).toBe(false);
    expect(isPublicAddress("2001:db8::1")).toBe(false);
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("100::")).toBe(false);
    expect(isPublicAddress("2001:20::1")).toBe(false);
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
  });

  it("revalidates DNS on every redirect hop and does not send cookies", async () => {
    const resolverCalls: string[] = [];
    const transport = transportFor(
      new Response(null, {
        headers: { location: "https://blocked.test/next" },
        status: 302,
      }),
    );
    const acquirer = new PublicContentAcquirer({
      resolver: (hostname) => {
        resolverCalls.push(hostname);
        return Promise.resolve(
          hostname === "blocked.test" ? ["127.0.0.1"] : ["93.184.216.34"],
        );
      },
      fetchTransport: transport,
    });

    await expect(
      acquirer.acquire({
        preference: ["official_metadata", "public_page"],
        url: "https://start.test/recipe",
      }),
    ).resolves.toEqual({
      method: "blocked",
      reason: "Public content was blocked",
    });
    expect(resolverCalls).toEqual(["start.test", "blocked.test"]);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.target).toEqual({
      address: "93.184.216.34",
      hostname: "start.test",
    });
    expect(transport.calls[0]?.init.credentials).toBe("omit");
    expect(transport.calls[0]?.init.redirect).toBe("manual");
    expect(
      new Headers(transport.calls[0]?.init.headers).get("cookie"),
    ).toBeNull();
  });

  it("caps response bytes and accepts only HTML or JSON metadata", async () => {
    const oversized = transportFor(
      new Response("this exceeds", {
        headers: { "content-length": "11", "content-type": "text/html" },
      }),
    );
    const blocked = new PublicContentAcquirer({
      byteLimit: 10,
      resolver: () => Promise.resolve(["93.184.216.34"]),
      fetchTransport: oversized,
    });
    await expect(
      blocked.acquire({
        preference: ["official_metadata", "public_page"],
        url: "https://example.test/",
      }),
    ).resolves.toEqual({
      method: "blocked",
      reason: "Public content was blocked",
    });

    const acquirer = new PublicContentAcquirer({
      resolver: () => Promise.resolve(["93.184.216.34"]),
      fetchTransport: transportFor(
        new Response('{"name":"Soup"}', {
          headers: { "content-type": "application/ld+json; charset=utf-8" },
        }),
      ),
    });
    await expect(
      acquirer.acquire({
        preference: ["official_metadata", "public_page"],
        url: "https://example.test/recipe",
      }),
    ).resolves.toEqual({
      canonicalUrl: "https://example.test/recipe",
      method: "official_metadata",
      text: '{"name":"Soup"}',
    });
  });

  it("extracts Recipe JSON-LD from HTML and otherwise returns visible text", async () => {
    const metadata = new PublicContentAcquirer({
      fetchTransport: transportFor(
        new Response(
          `<main>Ignored <script type="application/ld+json">{"@graph":[{"@type":"Thing"},{"@type":"Recipe","name":"Pinned Soup"}]}</script></main>`,
          { headers: { "content-type": "text/html" } },
        ),
      ),
      resolver: () => Promise.resolve(["93.184.216.34"]),
    });
    await expect(
      metadata.acquire({
        preference: ["official_metadata", "public_page"],
        url: "https://example.test/recipe",
      }),
    ).resolves.toEqual({
      canonicalUrl: "https://example.test/recipe",
      method: "official_metadata",
      text: '{"@type":"Recipe","name":"Pinned Soup"}',
    });

    const page = new PublicContentAcquirer({
      fetchTransport: transportFor(
        new Response("<h1>Plain &amp; safe</h1><script>ignored()</script>", {
          headers: { "content-type": "text/html" },
        }),
      ),
      resolver: () => Promise.resolve(["93.184.216.34"]),
    });
    await expect(
      page.acquire({
        preference: ["official_metadata", "public_page"],
        url: "https://example.test/plain",
      }),
    ).resolves.toEqual({
      canonicalUrl: "https://example.test/plain",
      method: "public_page",
      text: "Plain & safe",
    });
  });

  it("discovers a recipe hero and acquires it through the same public-only policy", async () => {
    const imageBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    const transport = transportFor(
      new Response(
        `<script type="application/ld+json">${JSON.stringify({
          "@type": "Recipe",
          image: { url: "/photos/soup.webp" },
          name: "Photo soup",
        })}</script>`,
        { headers: { "content-type": "text/html" } },
      ),
      new Response(imageBytes, {
        headers: { "content-type": "image/webp" },
      }),
    );
    const acquirer = new PublicContentAcquirer({
      fetchTransport: transport,
      resolver: () => Promise.resolve(["93.184.216.34"]),
    });

    await expect(
      acquirer.acquire({
        preference: ["official_metadata", "public_page"],
        url: "https://example.test/recipes/soup",
      }),
    ).resolves.toMatchObject({
      heroImageUrl: "https://example.test/photos/soup.webp",
      method: "official_metadata",
    });
    await expect(
      acquirer.acquireImage("https://example.test/photos/soup.webp"),
    ).resolves.toEqual({ bytes: imageBytes, mimeType: "image/webp" });
    expect(transport.calls[1]?.target.hostname).toBe("example.test");
    expect(
      new Headers(transport.calls[1]?.init.headers).get("cookie"),
    ).toBeNull();
  });

  it("pins the actual Node transport when lookup requests all addresses", async () => {
    const server = createServer((request, response) => {
      expect(request.headers.host).toMatch(/^recipe\.example:/);
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<h1>Pinned recipe</h1>");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an IP test listener");
      }
      const response = await nodeFetchTransport(
        `http://recipe.example:${address.port}/recipe`,
        { headers: { accept: "text/html" }, method: "GET" },
        { address: "127.0.0.1", hostname: "recipe.example" },
      );

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain("Pinned recipe");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

function transportFor(...responses: Response[]) {
  const calls: Array<{
    init: RequestInit;
    target: { address: string; hostname: string };
    url: string;
  }> = [];
  return Object.assign(
    (
      url: string,
      init: RequestInit,
      target: { address: string; hostname: string },
    ): Promise<Response> => {
      calls.push({ init, target, url });
      const response = responses.shift();
      if (!response) throw new Error("No response configured");
      return Promise.resolve(response);
    },
    { calls },
  );
}
