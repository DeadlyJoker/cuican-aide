import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { DesktopPluginUiAssetBroker } from "./desktopPluginUiAssets.ts";
import { deferred, uiLease } from "./desktopPluginUiAssets.test-support.ts";

const absent = {
  error: {
    category: "notFound",
    code: "plugin_ui_mount_unavailable",
    message: "The requested resource was not found.",
    requestId: "fixture-request",
  },
};

describe("native lease recovery over real HTTP", () => {
  for (const stage of [
    "preflight",
    "preflight-timeout",
    "preflight-body-timeout",
    "post-dispatch",
  ] as const)
    it(`handles ${stage} connection loss without treating a late CAS as stable old authority`, async () => {
      let current = {
        ...uiLease(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      let armed = false,
        disconnected = false,
        reads = 0,
        posts = 0,
        deletes = 0;
      const oldObserved = deferred<void>();
      const commit = deferred<void>();
      const committed = deferred<void>();
      const server = createServer((req, res) => {
        expect(req.headers.authorization).toBe("Bearer named-http-session");
        if (req.method === "DELETE") {
          deletes++;
          res.setHeader("content-type", "application/json");
          res.end('{"closed":true}');
          return;
        }
        if (req.method === "POST") posts++;
        if (
          armed &&
          !disconnected &&
          ((stage !== "post-dispatch" && req.method === "GET") ||
            req.method === "POST")
        ) {
          disconnected = true;
          if (req.method === "POST")
            void commit.promise.then(() => {
              current = {
                ...current,
                expiresAt: new Date(
                  Date.parse(current.expiresAt) + 60_000,
                ).toISOString(),
              };
              committed.resolve();
            });
          if (stage === "preflight-body-timeout") {
            res.setHeader("content-type", "application/json");
            res.write('{"schemaVersion":');
          } else if (stage !== "preflight-timeout") req.socket.destroy();
          return;
        }
        if (armed && disconnected && req.method === "GET") {
          reads++;
          oldObserved.resolve();
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(current));
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const owner = new DesktopPluginUiAssetBroker({
        session: () => ({
          baseUrl: origin,
          origin: "http://crewon.localhost",
          csrfToken: "named-http-csrf",
          sessionToken: "named-http-session",
          generation: 1,
        }),
      });
      try {
        const binding = await owner.adopt({
          lease: current,
          expectedControlOrigin: origin,
        });
        armed = true;
        const result = owner.renewResult(binding.bindingRef);
        if (stage === "preflight-body-timeout") {
          await expect(result).rejects.toThrow();
          expect(owner.allows(binding.entryUrl)).toBe(false);
          expect(owner.usage.bindings).toBe(1);
          expect(posts).toBe(0);
        } else if (stage !== "post-dispatch") {
          expect(await result).toEqual({ kind: "deferred", lease: current });
          expect(owner.allows(binding.entryUrl)).toBe(true);
          expect(posts).toBe(0);
        } else {
          const refusal = expect(result).rejects.toThrow(
            "renewal_outcome_unknown",
          );
          await oldObserved.promise;
          // The server-side work can finish after an old reconciliation snapshot.
          // No new request or grant may use that snapshot as stable authority.
          commit.resolve();
          await committed.promise;
          await refusal;
          expect(owner.allows(binding.entryUrl)).toBe(false);
          expect(posts).toBe(1);
          expect(deletes).toBe(1);
        }
        expect(reads).toBe(stage === "preflight-body-timeout" ? 0 : 1);
        expect(owner.usage.requests).toBe(0);
      } finally {
        if (stage === "preflight-body-timeout")
          await expect(owner.close()).rejects.toThrow();
        else await owner.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }, 15_000);

  it("retires more than 32 authenticated absent mounts without consuming owner capacity", async () => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method === "DELETE") {
        res.statusCode = 404;
        res.end(JSON.stringify(absent));
      } else res.end(JSON.stringify(lease));
    });
    let lease = {
      ...uiLease(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const owner = new DesktopPluginUiAssetBroker({
      session: () => ({
        baseUrl: origin,
        origin: "http://crewon.localhost",
        csrfToken: "named-http-csrf",
        sessionToken: "named-http-session",
        generation: 1,
      }),
    });
    try {
      for (let i = 0; i < 35; i++) {
        lease = { ...lease, mountRef: uiLease(i + 1).mountRef };
        const binding = await owner.adopt({
          lease,
          expectedControlOrigin: origin,
        });
        await owner.release(binding.bindingRef);
        expect(owner.usage.bindings).toBe(0);
      }
    } finally {
      await owner.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

for (const refusal of [
  "unauthorized",
  "forbidden",
  "server",
  "malformed",
  "foreign-session",
] as const)
  it(`keeps ${refusal} cleanup quarantined instead of granting retirement`, async () => {
    const lease = {
      ...uiLease(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    let generation = 1;
    const owner = new DesktopPluginUiAssetBroker({
      session: () => ({
        baseUrl: "http://127.0.0.1:12345",
        origin: "http://crewon.localhost",
        csrfToken: "fixture-csrf",
        sessionToken: "fixture-token",
        generation,
      }),
      fetch: async (_input, init) => {
        if (init?.method !== "DELETE")
          return new Response(JSON.stringify(lease), {
            headers: { "content-type": "application/json" },
          });
        if (refusal === "foreign-session") generation++;
        const status =
          refusal === "unauthorized"
            ? 401
            : refusal === "forbidden"
              ? 403
              : refusal === "server"
                ? 500
                : 404;
        return new Response(
          JSON.stringify(
            refusal === "malformed"
              ? { error: { ...absent.error, code: "route_not_found" } }
              : absent,
          ),
          { status, headers: { "content-type": "application/json" } },
        );
      },
    });
    const binding = await owner.adopt({
      lease,
      expectedControlOrigin: "http://127.0.0.1:12345",
    });
    await expect(owner.release(binding.bindingRef)).rejects.toThrow();
    expect(owner.usage).toMatchObject({
      bindings: 1,
      requests: 0,
      operations: 0,
      cleanupRequests: 0,
    });
    expect(owner.allows(binding.entryUrl)).toBe(false);
    await expect(owner.close()).rejects.toThrow();
  });
