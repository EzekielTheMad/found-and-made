import { once } from "node:events";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createHttpBaseline,
  genericHttpError,
  httpBaseline,
  unknownApiRoute,
} from "../../server/middleware/http-baseline";

describe("HTTP baseline", () => {
  const servers: ReturnType<express.Express["listen"]>[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  });

  it("returns correlated generic API errors without leaking details", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = express();
    app.disable("x-powered-by");
    app.use(httpBaseline);
    app.get("/api/failure", () => {
      throw new Error("private implementation detail");
    });
    app.use("/api", unknownApiRoute);
    app.use(genericHttpError);

    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/api/failure`);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-powered-by")).toBeNull();
    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(body).not.toContain("private implementation detail");
    expect(body).not.toContain("stack");

    const problem = JSON.parse(body) as {
      requestId: string;
      status: number;
      title: string;
    };
    expect(problem).toEqual({
      requestId: response.headers.get("x-request-id"),
      status: 500,
      title: "Request failed",
      type: "about:blank",
    });
    expect(errorLog).toHaveBeenCalledOnce();
    expect(errorLog.mock.calls[0]?.join(" ")).not.toContain(
      "private implementation detail",
    );
  });

  it("sets HSTS for secure deployments and prevents private HTML caching", async () => {
    const app = express();
    app.use(
      createHttpBaseline({ enableHsts: true, enableOriginIsolation: true }),
    );
    app.get("/account", (_request, response) =>
      response.status(200).type("html").send("account"),
    );
    app.get("/public/recipes/one", (_request, response) =>
      response.status(200).type("html").send("public"),
    );
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    const privateResponse = await fetch(`http://127.0.0.1:${port}/account`, {
      headers: { accept: "text/html" },
    });
    expect(privateResponse.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expect(privateResponse.headers.get("strict-transport-security")).toBe(
      "max-age=31536000",
    );
    expect(privateResponse.headers.get("cross-origin-opener-policy")).toBe(
      "same-origin",
    );
    expect(privateResponse.headers.get("origin-agent-cluster")).toBe("?1");

    const nonHtmlClient = await fetch(`http://127.0.0.1:${port}/account`);
    expect(nonHtmlClient.headers.get("cache-control")).toBeNull();

    const publicResponse = await fetch(
      `http://127.0.0.1:${port}/public/recipes/one`,
      { headers: { accept: "text/html" } },
    );
    expect(publicResponse.headers.get("cache-control")).toBeNull();
  });

  it("does not advertise secure-context isolation on plain HTTP LAN deployments", async () => {
    const app = express();
    app.use(createHttpBaseline());
    app.get("/recipes/one", (_request, response) => response.send("recipe"));
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/recipes/one`);
    expect(response.headers.get("cross-origin-opener-policy")).toBeNull();
    expect(response.headers.get("origin-agent-cluster")).toBeNull();
  });
});
