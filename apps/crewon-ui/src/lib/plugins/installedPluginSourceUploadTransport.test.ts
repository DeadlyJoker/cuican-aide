// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
import { createPluginProjectSourceUploadsClient } from "@crewon/plugin-sdk/project-source-uploads";
import type { PluginUiServices } from "@crewon/plugin-sdk/ui";
import { createControlPluginUiHost } from "./controlPluginUiHost";
import { createDesktopPluginUiHost } from "./desktopPluginUiHost";
import {
  controlUiItem,
  controlUiResponse,
} from "./controlPluginUi.test-support";
import {
  uiHarness,
  uiLease,
  uiProps,
  deferred,
  flush,
} from "./pluginUiLoader.test-support";
import { desktopPluginUiAssetUrl } from "../desktop/desktopPluginUiProtocol";
import { capturePluginSourceUploadPartBytes } from "./installedPluginSourceUploadTransport";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
const locator = {
  uploadId: "novel-upload",
  partIndex: 0,
  rawDigest: `sha256:${"a".repeat(64)}`,
};
function acknowledgement(length: number) {
  return {
    disposition: "committed",
    upload: {
      uploadId: locator.uploadId,
      revision: 2,
      phase: "receiving",
      fileName: "小说.txt",
      format: "txt",
      byteLength: length,
      fileDigest: locator.rawDigest,
      partBytes: 65536,
      partCount: 1,
      receivedParts: [
        { index: 0, byteLength: length, rawDigest: locator.rawDigest },
      ],
      prepared: null,
      failureCode: null,
      updatedAt: "2026-10-08T00:00:00.000Z",
    },
  };
}
async function fixture(
  surface: "web" | "desktop",
  unsupported = false,
  reply?: () => Promise<Response>,
) {
  const origin = "http://127.0.0.1:32100";
  vi.stubGlobal(
    "location",
    surface === "web"
      ? { protocol: "http:", origin }
      : { protocol: "file:", origin: "null" },
  );
  const original = uiLease();
  const lease = {
    ...original,
    descriptor: {
      ...original.descriptor,
      requires: [...original.descriptor.requires, {
        service: "crewon.project-source-uploads",
        apiVersion: unsupported ? "2" : "1",
        optional: true,
      }],
    },
  };
  const h = uiHarness();
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT")
      return (
        reply?.() ??
        controlUiResponse(acknowledgement((init.body as Uint8Array).byteLength))
      );
    return controlUiResponse(
      init?.method === "DELETE" ? { closed: true } : lease,
    );
  });
  const client = new ControlApiClient({
    baseUrl: origin,
    accessToken: "host-session",
    csrfToken: "host-csrf",
    fetch,
  });
  let current = true;
  const shared = {
    client,
    assertCurrent: () => {
      if (!current) throw new Error("scope_changed");
    },
    onDiagnostic: vi.fn(),
    importer: async () => ({ default: h.definition }),
  };
  const host =
    surface === "web"
      ? createControlPluginUiHost(shared)
      : createDesktopPluginUiHost({
          ...shared,
          assets: {
            version: 1,
            adopt: async () => ({
              bindingRef: "c".repeat(64),
              entryUrl: desktopPluginUiAssetUrl("c".repeat(64), "ui/index.js"),
              controlOrigin: origin,
            }),
            release: async () => {},
            invalidate: async () => {},
          },
        });
  const mountedLease = await host.acquireMount(
    controlUiItem(lease),
    "workbench",
    new AbortController().signal,
  );
  const mount = await host.loader.mount({
    root: h.root,
    lease: mountedLease,
    props: uiProps(),
  });
  const services: PluginUiServices = h.instances[0].services;
  const uploads = createPluginProjectSourceUploadsClient(services, {
    raw: services.projectSourceUploads,
  });
  return {
    services,
    uploads,
    host,
    mount,
    fetch,
    revoke: () => {
      current = false;
    },
  };
}

describe("original mounted web and desktop source-upload transport", () => {
  for (const surface of ["web", "desktop"] as const) {
    it(`${surface}: original SDK sends private native bytes through original authenticated client`, async () => {
      const f = await fixture(surface);
      try {
        const bytes = new Uint8Array([0, 255, 226, 128, 168]);
        const pending = f.uploads.writePart(locator, bytes);
        bytes.fill(9);
        const response = await pending;
        expect(response.upload.receivedParts[0].byteLength).toBe(5);
        const write = f.fetch.mock.calls.find(
          ([, init]) => init?.method === "PUT",
        )!;
        expect(String(write[0])).toBe(
          `http://127.0.0.1:32100/api/v1/plugins/ui/mounts/${"mount_" + "1".padStart(32, "0")}/source-uploads/novel-upload/parts/0/${"a".repeat(64)}`,
        );
        expect(Array.from(write[1]!.body as Uint8Array)).toEqual([
          0, 255, 226, 128, 168,
        ]);
        const headers = new Headers(write[1]!.headers);
        expect(headers.get("content-type")).toBe("application/octet-stream");
        expect(headers.get("authorization")).toBe("Bearer host-session");
        expect(headers.get("x-csrf-token")).toBe("host-csrf");
        expect(write[1]!.credentials).toBe("include");
        expect(write[1]!.redirect).toBe("manual");
        expect(
          f.fetch.mock.calls.some(([url]) => String(url).endsWith("/actions")),
        ).toBe(false);
      } finally {
        await f.mount.stop();
      }
    });
    it(`${surface}: unsupported declaration cannot advertise a usable raw port`, async () => {
      const f = await fixture(surface, true);
      try {
        expect(f.services.projectSourceUploads).toBeUndefined();
        await expect(
          f.uploads.writePart(locator, new Uint8Array([1])),
        ).rejects.toThrow();
        expect(
          f.fetch.mock.calls.some(([, init]) => init?.method === "PUT"),
        ).toBe(false);
      } finally {
        await f.mount.stop();
      }
    });
    it(`${surface}: stopped or withdrawn original mount cannot write`, async () => {
      const f = await fixture(surface);
      f.revoke();
      await expect(
        f.uploads.writePart(locator, new Uint8Array([1])),
      ).rejects.toThrow("scope_changed");
      expect(
        f.fetch.mock.calls.some(([, init]) => init?.method === "PUT"),
      ).toBe(false);
      await f.mount.stop();
      await expect(
        f.uploads.writePart(locator, new Uint8Array([1])),
      ).rejects.toThrow();
    });
  }
  it("in-flight part belongs to original mount lifetime and has no automatic retry", async () => {
    const gate = deferred<Response>();
    const f = await fixture("web", false, () => gate.promise);
    const pending = f.uploads.writePart(locator, new Uint8Array([1]));
    void pending.catch(() => {});
    await flush();
    const write = f.fetch.mock.calls.find(
      ([, init]) => init?.method === "PUT",
    )!;
    expect(write).toBeDefined();
    await f.mount.stop();
    await expect(pending).rejects.toThrow();
    expect(write[1]!.signal!.aborted).toBe(true);
    gate.resolve(controlUiResponse(acknowledgement(1)));
    await flush();
    expect(
      f.fetch.mock.calls.filter(([, init]) => init?.method === "PUT"),
    ).toHaveLength(1);
  });
  it("native byte validation ignores shadows and rejects shared, fake, detached and excessive bytes", () => {
    const bytes = new Uint8Array([1, 2]);
    const getter = vi.fn(() => {
      throw new Error("getter_read");
    });
    Object.defineProperty(bytes, "byteLength", { get: getter });
    expect(Array.from(capturePluginSourceUploadPartBytes(bytes))).toEqual([
      1, 2,
    ]);
    expect(getter).not.toHaveBeenCalled();
    const detached = new Uint8Array([1]);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    for (const value of [
      new Uint8Array(0),
      new Uint8Array(65537),
      new Uint8Array(new SharedArrayBuffer(1)),
      new Proxy(bytes, {}),
      Object.create(Uint8Array.prototype),
      detached,
    ])
      expect(() => capturePluginSourceUploadPartBytes(value)).toThrow(
        "plugin_ui_source_upload_bytes_invalid",
      );
  });
});
