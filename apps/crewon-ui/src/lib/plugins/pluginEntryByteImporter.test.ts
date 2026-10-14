// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import pageDocument from "../../../index.html?raw";
import { createPluginEntryByteImporter } from "./pluginEntryByteImporter";
import { uiLease } from "./pluginUiLoader.test-support";
const bytes = new TextEncoder().encode(
  "export default {apiVersion:'crewon.plugin-ui.v1',pluginId:'example.workbench',mount(){return{update(){},dispose(){}}}};",
).buffer;
const sha = "f4760573d16071fdd5c257c2657151b6d923183e60902c16b6d42b4819dd5e1c";
const lease = {
  ...uiLease(),
  publicAssets: ["ui/index.js"],
  descriptor: {
    ...uiLease().descriptor,
    requires: [
      {
        service: "crewon.plugin-ui-resources",
        apiVersion: "1",
        optional: true,
      },
    ],
    files: [{ path: "ui/index.js", byteLength: bytes.byteLength, sha256: sha }],
  },
};
function fixture() {
  const values = new Map<string, ArrayBuffer>();
  const store = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: ArrayBuffer) => {
      values.set(key, value);
    }),
  };
  const fetch = vi.fn<typeof globalThis.fetch>();
  const importer = vi.fn(async () => ({ default: "module" }));
  const createUrl = vi.fn(() => "blob:https://test/unique-instance");
  const revokeUrl = vi.fn();
  const make = (ownerKey = "account-a") =>
    createPluginEntryByteImporter({
      ownerKey,
      fetch,
      store,
      importModule: importer,
      createModuleUrl: createUrl,
      revokeModuleUrl: revokeUrl,
    });
  return { values, store, fetch, importer, createUrl, revokeUrl, make };
}
const request = (serial = 1) => ({
  url:
    "/api/v1/plugins/ui/mounts/" +
    uiLease(serial).mountRef +
    "/assets/ui/index.js",
  lease: { ...lease, mountRef: uiLease(serial).mountRef },
  signal: new AbortController().signal,
});
describe("immutable entry bytes across page reload", () => {
  it("permits verified native Blob modules in the delivered page without eval or inline scripts", () => {
    const html = pageDocument;
    const scriptPolicy = /script-src ([^;]+)/u.exec(html)?.[1].split(" ");
    expect(scriptPolicy).toContain("blob:");
    expect(scriptPolicy).toContain("'self'");
    expect(scriptPolicy).not.toContain("'unsafe-eval'");
    expect(scriptPolicy).not.toContain("'unsafe-inline'");
  });
  afterEach(() => vi.unstubAllGlobals());
  it("uses persisted verified bytes only after revalidating the new exact mount, including a new importer instance", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(
      new Response(bytes, { headers: { "content-type": "text/javascript" } }),
    );
    await f.make()(request());
    expect(f.store.put).toHaveBeenCalledOnce();
    f.fetch.mockResolvedValueOnce(new Response(null, { status: 304 }));
    await f.make()(request(2));
    expect(f.fetch).toHaveBeenLastCalledWith(
      request(2).url,
      expect.objectContaining({
        headers: {
          "x-crewon-plugin-ui-code-cache": "entry-bytes.v1",
          "if-none-match": '"sha256:' + sha + '"',
        },
      }),
    );
    expect(f.createUrl).toHaveBeenCalledTimes(2);
    expect(f.revokeUrl).toHaveBeenCalledTimes(2);
    expect(f.importer).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
  it("does not use another account's cached bytes or turn authorization/transport errors into offline success", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(
      new Response(bytes, {
        headers: { "content-type": "application/javascript" },
      }),
    );
    await f.make()(request());
    f.fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(f.make("account-b")(request(2))).rejects.toThrow(
      "entry_read_unavailable",
    );
    expect(
      new Headers(f.fetch.mock.calls[1][1]?.headers).has("if-none-match"),
    ).toBe(false);
    f.fetch.mockRejectedValueOnce(new Error("connection failed"));
    await expect(f.make()(request(3))).rejects.toThrow("connection failed");
    expect(f.importer).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
  it("rejects corrupted cached/received bytes and rejects a bodyless reply without a verified cache", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(
      new Response(bytes, {
        headers: { "content-type": "application/javascript" },
      }),
    );
    await f.make()(request());
    for (const key of f.values.keys()) f.values.set(key, new ArrayBuffer(1));
    f.fetch.mockResolvedValueOnce(new Response(null, { status: 304 }));
    await expect(f.make()(request(2))).rejects.toThrow(
      "entry_read_unavailable",
    );
    f.fetch.mockResolvedValueOnce(
      new Response(new Uint8Array(bytes.byteLength), {
        headers: { "content-type": "application/javascript" },
      }),
    );
    await expect(f.make()(request(3))).rejects.toThrow("integrity_failed");
    expect(f.importer).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
  it("keeps undeclared/split packages on native imports and does not fetch after cancellation", async () => {
    const f = fixture();
    await f.make()({ ...request(), lease: uiLease() });
    expect(f.importer).toHaveBeenCalledWith(request().url);
    expect(f.fetch).not.toHaveBeenCalled();
    const signal = AbortSignal.abort();
    await expect(f.make()({ ...request(), signal })).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
