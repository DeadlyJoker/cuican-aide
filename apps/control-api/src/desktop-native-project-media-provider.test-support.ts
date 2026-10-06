import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { SystemProviderProbeDnsResolver } from "../../../packages/media-runtime/src/provider-probe-egress.ts";
import {
  PinnedNodeHttpTransport,
  type PinnedHttpRequest,
} from "../../../packages/media-runtime/src/pinned-node-http.ts";
import { materialPng } from "../../runtime-worker/src/project-material-png.test-support.ts";

/** Only DNS and provider sockets are named substitutes. Original Native policies and material services stay intact. */
export function nativeMediaProvider(t: TestContext) {
  const baseUrl = "https://named-comfy.provider.example:8443/";
  const images = [0, 1].map((n) => {
    const image = {
      filename: `native-source-${n}.png`,
      subfolder: "source",
      type: "output" as const,
    };
    return {
      ...image,
      url: new URL(`/view?${new URLSearchParams(image)}`, baseUrl).href,
    };
  });
  const files = new Map<string, Buffer>();
  const state = {
    sourceGets: 0,
    uploads: 0,
    targetGets: 0,
    onUpload: undefined as undefined | (() => Promise<void>),
  };
  t.mock.method(
    SystemProviderProbeDnsResolver.prototype,
    "resolveAll",
    async (hostname: string) => {
      assert.equal(hostname, "named-comfy.provider.example");
      return [{ address: "8.8.8.8", family: 4 }];
    },
  );
  t.mock.method(
    PinnedNodeHttpTransport.prototype,
    "request",
    async (req: PinnedHttpRequest, signal: AbortSignal) => {
      signal.throwIfAborted();
      assert.equal(req.target.endpoint.origin + "/", baseUrl);
      assert.equal(req.target.address, "8.8.8.8");
      const url = req.target.endpoint;
      if (req.method === "POST") {
        assert.equal(url.pathname, "/upload/image");
        const body = Buffer.from(req.body!),
          text = body.toString("latin1");
        const boundary = req.headers!["content-type"]!.split("boundary=")[1]!;
        const name = /name="image"; filename="([^"\r\n]+)"/u.exec(text)![1]!;
        const subfolder = /name="subfolder"\r\n\r\n([^\r\n]+)/u.exec(text)![1]!;
        const start =
          body.indexOf(Buffer.from("Content-Type: image/png\r\n\r\n")) +
          Buffer.byteLength("Content-Type: image/png\r\n\r\n");
        const end = body.indexOf(Buffer.from(`\r\n--${boundary}--`), start);
        assert.ok(start > 0 && end > start);
        files.set(
          `/view?${new URLSearchParams({ filename: name, subfolder, type: "output" })}`,
          Buffer.from(body.subarray(start, end)),
        );
        state.uploads++;
        await state.onUpload?.();
        signal.throwIfAborted();
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(
            JSON.stringify({ name, subfolder, type: "output" }),
          ),
        };
      }
      assert.equal(url.pathname, "/view");
      const index = images.findIndex((i) => i.url === url.href);
      if (index >= 0) {
        state.sourceGets++;
        return {
          status: 200,
          headers: { "content-type": "image/png" },
          body: materialPng(index === 0 ? 2 : 3, 1),
        };
      }
      state.targetGets++;
      const bytes = files.get(url.pathname + url.search);
      return bytes
        ? {
            status: 200,
            headers: { "content-type": "image/png" },
            body: Buffer.from(bytes),
          }
        : { status: 404, headers: {}, body: Buffer.alloc(0) };
    },
  );
  return { images, files, state };
}
