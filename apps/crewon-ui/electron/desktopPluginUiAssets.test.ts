import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopPluginUiAssetBroker } from "./desktopPluginUiAssets.ts";
import {
  uiLease,
  deferred,
  flush,
} from "./desktopPluginUiAssets.test-support.ts";
import { desktopPluginUiAssetUrl } from "../src/lib/desktop/desktopPluginUiProtocol.ts";

const owners: DesktopPluginUiAssetBroker[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close().catch(() => {});
  vi.useRealTimers();
});
function fixture(controlOwner?: ChildProcess) {
  const content = new TextEncoder().encode("export default 7");
  const original = uiLease();
  const lease = {
    ...original,
    descriptor: {
      ...original.descriptor,
      files: original.descriptor.files.map((file, index) =>
        index
          ? file
          : {
              path: "ui/index.js",
              byteLength: content.byteLength,
              sha256: createHash("sha256").update(content).digest("hex"),
            },
      ),
    },
  };
  const state = {
    generation: 1,
    available: true,
    lease,
    failClose: false,
    body: content,
    type: "text/javascript; charset=utf-8",
    handler: null as
      | ((url: URL, init: RequestInit) => Promise<Response> | Response)
      | null,
  };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (state.handler) return state.handler(url, init!);
    if (init?.method === "DELETE")
      return new Response(JSON.stringify({ closed: !state.failClose }), {
        headers: { "content-type": "application/json" },
      });
    if (url.pathname.includes("/assets/"))
      return new Response(state.body, {
        headers: { "content-type": state.type },
      });
    return new Response(JSON.stringify(state.lease), {
      headers: { "content-type": "application/json" },
    });
  });
  const owner = new DesktopPluginUiAssetBroker({
    ...(controlOwner ? { controlOwner: () => controlOwner } : {}),
    session: () => {
      if (!state.available) throw new Error("runtime_unavailable");
      return {
        baseUrl: "http://127.0.0.1:12345/",
        origin: "http://crewon.localhost",
        csrfToken: "native-csrf",
        sessionToken: "native-token",
        generation: state.generation,
      };
    },
    fetch,
  });
  owners.push(owner);
  const adopt = () =>
    owner.adopt({ lease, expectedControlOrigin: "http://127.0.0.1:12345" });
  return { owner, state, fetch, lease, content, adopt };
}
describe("native installed UI asset owner", () => {
  it("rejects outer actor, token, URL and accessor fields before reading the current session or sending HTTP", async () => {
    const f = fixture(),
      reads = vi.fn(() => f.lease);
    for (const field of ["actor", "token", "url"])
      await expect(
        f.owner.adopt({
          lease: f.lease,
          expectedControlOrigin: "http://127.0.0.1:12345",
          [field]: "forged",
        }),
      ).rejects.toThrow("desktop_plugin_ui_adoption_input_invalid");
    const input = { expectedControlOrigin: "http://127.0.0.1:12345" };
    Object.defineProperty(input, "lease", { enumerable: true, get: reads });
    await expect(
      f.owner.adopt(
        input as Parameters<DesktopPluginUiAssetBroker["adopt"]>[0],
      ),
    ).rejects.toThrow("desktop_plugin_ui_adoption_input_invalid");
    expect(reads).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.owner.usage.bindings).toBe(0);
  });
  it("pins the full actual lease and uses only captured native credentials, approved finite bytes and MIME", async () => {
    const f = fixture(),
      binding = await f.adopt();
    const result = await f.owner.read(new Request(binding.entryUrl));
    expect(await result.text()).toBe("export default 7");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(f.fetch).toHaveBeenCalledTimes(4);
    for (const [, init] of f.fetch.mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer native-token",
      );
      expect(new Headers(init?.headers).get("origin")).toBe(
        "http://crewon.localhost",
      );
      expect(init?.redirect).toBe("error");
    }
    expect(
      f.owner.allows(desktopPluginUiAssetUrl(binding.bindingRef, "node.mjs")),
    ).toBe(false);
    await f.owner.release(binding.bindingRef);
    await f.owner.release(binding.bindingRef);
    expect(
      f.fetch.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(1);
    expect(f.owner.usage).toMatchObject({
      bindings: 0,
      operations: 0,
      requests: 0,
      reservedBytes: 0,
    });
  });

  it.each(["digest", "publisher", "publicAssets", "revision"])(
    "rejects changed %s during adoption and closes the observed mount",
    async (field) => {
      const f = fixture();
      f.state.lease = structuredClone(f.lease);
      if (field === "digest")
        f.state.lease = {
          ...f.state.lease,
          packageDigest: `sha256:${"8".repeat(64)}`,
        };
      if (field === "publisher")
        f.state.lease = {
          ...f.state.lease,
          descriptor: {
            ...f.state.lease.descriptor,
            publisherId: "foreign.publisher",
          },
        };
      if (field === "publicAssets")
        f.state.lease = { ...f.state.lease, publicAssets: ["ui/index.js"] };
      if (field === "revision")
        f.state.lease = {
          ...f.state.lease,
          selectionRevision: f.state.lease.selectionRevision + 1,
        };
      await expect(f.adopt()).rejects.toThrow(
        "desktop_plugin_ui_lease_changed",
      );
      expect(f.owner.usage.bindings).toBe(0);
      expect(f.fetch.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
    },
  );

  it.each(["hash", "MIME", "length"])(
    "rejects wrong asset %s without publishing JavaScript",
    async (kind) => {
      const f = fixture(),
        binding = await f.adopt();
      if (kind === "hash")
        f.state.body = new TextEncoder().encode("export default 8");
      if (kind === "MIME") f.state.type = "text/html";
      if (kind === "length")
        f.state.body = new TextEncoder().encode("export default 77");
      await expect(f.owner.read(new Request(binding.entryUrl))).rejects.toThrow(
        /desktop_plugin_ui_asset_(integrity_invalid|limit)/u,
      );
    },
  );

  it("denies URL normalization, external/private paths and methods before any upstream egress", async () => {
    const f = fixture(),
      b = await f.adopt();
    f.fetch.mockClear();
    for (const url of [
      b.entryUrl + "?token=bad",
      b.entryUrl.replace("ui/index.js", "ui/%2e%2e/node.mjs"),
      b.entryUrl.replace("crewon-plugin://ui", "https://evil.example"),
      desktopPluginUiAssetUrl(b.bindingRef, "node.mjs"),
    ]) {
      expect(f.owner.allows(url)).toBe(false);
      await expect(async () =>
        f.owner.read(new Request(url)),
      ).rejects.toThrow();
    }
    await expect(async () =>
      f.owner.read(new Request(b.entryUrl, { method: "POST" })),
    ).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("withdraws synchronously and waits for actual cancellation and DELETE before freeing a lease", async () => {
    const f = fixture(),
      b = await f.adopt(),
      cancel = deferred<void>(),
      close = deferred<Response>();
    let assetEntered = false;
    f.state.handler = (url, init) => {
      if (init.method === "DELETE") return close.promise;
      if (!url.pathname.includes("/assets/"))
        return new Response(JSON.stringify(f.lease), {
          headers: { "content-type": "application/json" },
        });
      assetEntered = true;
      return new Response(
        new ReadableStream({ pull() {}, cancel: () => cancel.promise }),
        { headers: { "content-type": f.state.type } },
      );
    };
    const read = f.owner.read(new Request(b.entryUrl));
    void read.catch(() => {});
    await flush();
    expect(assetEntered).toBe(true);
    let done = false;
    const releasing = f.owner.release(b.bindingRef).then(() => {
      done = true;
    });
    expect(f.owner.allows(b.entryUrl)).toBe(false);
    await flush();
    expect(done).toBe(false);
    expect(f.owner.usage.bindings).toBe(1);
    cancel.resolve();
    await flush();
    expect(done).toBe(false);
    close.resolve(
      new Response('{"closed":true}', {
        headers: { "content-type": "application/json" },
      }),
    );
    await releasing;
    await expect(read).rejects.toThrow();
    expect(f.owner.usage).toMatchObject({
      bindings: 0,
      requests: 0,
      operations: 0,
    });
  });

  it("retains a real failed cancellation owner and makes explicit close fail", async () => {
    const f = fixture(),
      b = await f.adopt();
    f.state.handler = (url) =>
      url.pathname.includes("/assets/")
        ? new Response(
            new ReadableStream({
              pull() {},
              cancel() {
                throw new Error("physical_cancel_failed");
              },
            }),
            { headers: { "content-type": f.state.type } },
          )
        : Promise.resolve(
            new Response(JSON.stringify(f.lease), {
              headers: { "content-type": "application/json" },
            }),
          );
    const read = f.owner.read(new Request(b.entryUrl));
    void read.catch(() => {});
    await flush();
    await expect(f.owner.release(b.bindingRef)).rejects.toThrow(
      "desktop_plugin_ui_cleanup_uncertain",
    );
    await expect(read).rejects.toThrow("physical_cancel_failed");
    await expect(f.owner.close()).rejects.toThrow(
      "desktop_plugin_ui_cleanup_failed",
    );
    expect(f.owner.usage.bindings).toBe(1);
  });

  it("does not publish a late adoption after generation changes, and keeps failed cleanup quarantined", async () => {
    const f = fixture(),
      held = deferred<Response>();
    f.state.handler = (_url, init) =>
      init.method === "DELETE"
        ? new Response('{"closed":false}', {
            headers: { "content-type": "application/json" },
          })
        : held.promise;
    const adopting = f.adopt();
    void adopting.catch(() => {});
    f.state.generation++;
    held.resolve(
      new Response(JSON.stringify(f.lease), {
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(adopting).rejects.toThrow(
      "desktop_plugin_ui_adoption_cleanup_failed",
    );
    expect(f.owner.usage.bindings).toBe(1);
    await expect(f.owner.close()).rejects.toThrow(
      "desktop_plugin_ui_cleanup_failed",
    );
  });

  it("rechecks current permission after bytes and never calls a new GET once invalidated", async () => {
    const f = fixture(),
      b = await f.adopt();
    let reads = 0;
    f.state.handler = (url, init) => {
      if (init.method === "DELETE")
        return new Response('{"closed":true}', {
          headers: { "content-type": "application/json" },
        });
      if (url.pathname.includes("/assets/")) {
        f.state.generation++;
        return new Response(f.content, {
          headers: { "content-type": f.state.type },
        });
      }
      reads++;
      return new Response(JSON.stringify(f.lease), {
        headers: { "content-type": "application/json" },
      });
    };
    await expect(f.owner.read(new Request(b.entryUrl))).rejects.toThrow(
      "desktop_plugin_ui_scope_changed",
    );
    expect(reads).toBe(1);
  });

  it("retains the whole byte pipeline budget while the final authority request is pending", async () => {
    const f = fixture(),
      b = await f.adopt(),
      held = deferred<Response>();
    let freshness = 0;
    f.state.handler = (url, init) => {
      if (init.method === "DELETE")
        return new Response('{"closed":true}', {
          headers: { "content-type": "application/json" },
        });
      if (url.pathname.includes("/assets/"))
        return new Response(f.content, {
          headers: { "content-type": f.state.type },
        });
      return ++freshness === 2
        ? held.promise
        : new Response(JSON.stringify(f.lease), {
            headers: { "content-type": "application/json" },
          });
    };
    const reading = f.owner.read(new Request(b.entryUrl));
    await flush();
    expect(freshness).toBe(2);
    expect(f.owner.usage).toMatchObject({ operations: 1, requests: 1 });
    expect(f.owner.usage.reservedBytes).toBe(
      512 * 1024 + 2 * f.content.byteLength,
    );
    held.resolve(
      new Response(JSON.stringify(f.lease), {
        headers: { "content-type": "application/json" },
      }),
    );
    await reading;
    expect(f.owner.usage.reservedBytes).toBe(0);
  });

  it("admits a declared 32MiB asset through freshness and into the finite asset read without allocating a test payload", async () => {
    const f = fixture();
    const lease = {
      ...f.lease,
      descriptor: {
        ...f.lease.descriptor,
        files: f.lease.descriptor.files.map((v) =>
          v.path === "ui/index.js" ? { ...v, byteLength: 32 * 1024 * 1024 } : v,
        ),
      },
    };
    f.state.lease = lease;
    const b = await f.owner.adopt({
      lease,
      expectedControlOrigin: "http://127.0.0.1:12345",
    });
    let asset = false;
    f.state.handler = (url, init) => {
      if (init.method === "DELETE")
        return new Response('{"closed":true}', {
          headers: { "content-type": "application/json" },
        });
      if (url.pathname.includes("/assets/")) {
        asset = true;
        throw new Error("fixture_no_large_payload");
      }
      return new Response(JSON.stringify(lease), {
        headers: { "content-type": "application/json" },
      });
    };
    await expect(f.owner.read(new Request(b.entryUrl))).rejects.toThrow(
      "fixture_no_large_payload",
    );
    expect(asset).toBe(true);
  });

  it("gives DELETE an independent bounded allowance when 16 asset operations occupy every GET slot", async () => {
    const f = fixture(),
      leases = new Map<string, typeof f.lease>(),
      bindings = [];
    for (let i = 0; i < 17; i++) {
      const lease = { ...f.lease, mountRef: uiLease(i + 2).mountRef };
      leases.set(lease.mountRef, lease);
      f.state.lease = lease;
      bindings.push(
        await f.owner.adopt({
          lease,
          expectedControlOrigin: "http://127.0.0.1:12345",
        }),
      );
    }
    const held = deferred<void>();
    f.state.handler = async (url, init) => {
      if (init.method === "DELETE")
        return new Response('{"closed":true}', {
          headers: { "content-type": "application/json" },
        });
      await held.promise;
      if (url.pathname.includes("/assets/"))
        return new Response(f.content, {
          headers: { "content-type": f.state.type },
        });
      return new Response(
        JSON.stringify(leases.get(url.pathname.split("/").at(-1)!)),
        { headers: { "content-type": "application/json" } },
      );
    };
    const reading = bindings
      .slice(0, 16)
      .map((b) => f.owner.read(new Request(b.entryUrl)));
    expect(f.owner.usage).toMatchObject({ requests: 16, operations: 16 });
    await f.owner.release(bindings[16].bindingRef);
    expect(f.owner.usage.bindings).toBe(16);
    held.resolve();
    await Promise.all(reading);
    await f.owner.close();
    expect(f.owner.usage.bindings).toBe(0);
  });

  it("retires a mount only after its actual native Control child has terminated and local cancellation physically settles", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    try {
      await once(child, "spawn");
      const f = fixture(child),
        b = await f.adopt(),
        cancelling = deferred<void>();
      f.state.handler = (url, init) => {
        if (init.method === "DELETE")
          throw new Error("old_control_no_longer_listening");
        if (url.pathname.includes("/assets/"))
          return new Response(
            new ReadableStream({ pull() {}, cancel: () => cancelling.promise }),
            { headers: { "content-type": f.state.type } },
          );
        return new Response(JSON.stringify(f.lease), {
          headers: { "content-type": "application/json" },
        });
      };
      const reading = f.owner.read(new Request(b.entryUrl));
      void reading.catch(() => {});
      await flush();
      child.kill("SIGTERM");
      await once(child, "close");
      let complete = false;
      const closing = f.owner.invalidate().then(() => {
        complete = true;
      });
      await flush();
      expect(complete).toBe(false);
      expect(f.owner.usage.bindings).toBe(1);
      cancelling.resolve();
      await closing;
      await expect(reading).rejects.toThrow();
      expect(f.owner.usage).toMatchObject({
        bindings: 0,
        requests: 0,
        operations: 0,
      });
      expect(
        f.fetch.mock.calls.some(([, init]) => init?.method === "DELETE"),
      ).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "close");
      }
    }
  });

  it("does not retire an uncertain local reader even when the actual old Control child has terminated", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    try {
      await once(child, "spawn");
      const f = fixture(child),
        b = await f.adopt();
      f.state.handler = (url) =>
        url.pathname.includes("/assets/")
          ? new Response(
              new ReadableStream({
                pull() {},
                cancel() {
                  throw new Error("physical_reader_unknown");
                },
              }),
              { headers: { "content-type": f.state.type } },
            )
          : new Response(JSON.stringify(f.lease), {
              headers: { "content-type": "application/json" },
            });
      const reading = f.owner.read(new Request(b.entryUrl));
      void reading.catch(() => {});
      await flush();
      child.kill("SIGTERM");
      await once(child, "close");
      await expect(f.owner.invalidate()).rejects.toThrow(
        "desktop_plugin_ui_cleanup_failed",
      );
      await expect(reading).rejects.toThrow("physical_reader_unknown");
      await expect(f.owner.close()).rejects.toThrow(
        "desktop_plugin_ui_cleanup_failed",
      );
      expect(f.owner.usage.bindings).toBe(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "close");
      }
    }
  });
});
