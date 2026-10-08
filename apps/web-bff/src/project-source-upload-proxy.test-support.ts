import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import {
  projectSourceUploadPartPath,
  parseProjectSourceUploadPartPath,
} from "@crewon/contracts/project-source-uploads";
import { createWebBff } from "./web-bff.ts";

export const sourceUploadBrowserOrigin =
  "https://source-upload-browser.example.test";
export const sourceUploadCookie = "crewon_session=original-source-upload-owner";
export const sourceUploadControlCsrf =
  "source-upload-original-control-csrf-at-least-32";
export const sourceUploadServiceToken =
  "source-upload-original-bff-service-token-at-least-32";
export const sourceUploadSession = Object.freeze({
  sessionId: "source-upload-original-browser-session-at-least-32",
  controlAccessToken: "source-upload-original-owner-control-token-at-least-32",
  expiresAt: "2030-01-01T00:00:00.000Z",
});
export const sourceUploadDigest = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Real native HTTP transport fixture. Identity is an explicit internal test session, not a production PDP or installed mount. */
export async function sourceUploadProxyFixture(t: TestContext) {
  const bytes = new Uint8Array(65_536);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const locator = {
    uploadId: "original-byte-upload",
    partIndex: 0,
    rawDigest: sourceUploadDigest(bytes),
  };
  const path = projectSourceUploadPartPath("mount_" + "a".repeat(32), locator);
  const acknowledgement = {
    disposition: "committed",
    upload: {
      uploadId: locator.uploadId,
      revision: 2,
      phase: "receiving",
      fileName: "story.txt",
      format: "txt",
      byteLength: bytes.length,
      fileDigest: locator.rawDigest,
      partBytes: 65_536,
      partCount: 1,
      receivedParts: [
        { index: 0, byteLength: bytes.length, rawDigest: locator.rawDigest },
      ],
      prepared: null,
      failureCode: null,
      updatedAt: "2026-10-08T08:00:00.000Z",
    },
  };
  const observations: Readonly<{
    path: string;
    method: string;
    headers: IncomingMessage["headers"];
    bytes: Uint8Array;
  }>[] = [];
  const reply: {
    status: number;
    body: unknown;
    headers: Record<string, string>;
  } = { status: 200, body: acknowledgement, headers: {} };
  let upstreamRequests = 0;
  const control = createServer(async (incoming, outgoing) => {
    upstreamRequests++;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const received = new Uint8Array(Buffer.concat(chunks));
      const route = parseProjectSourceUploadPartPath(incoming.url);
      assert.deepEqual(route.locator, locator);
      assert.equal(incoming.method, "PUT");
      assert.equal(
        incoming.headers["content-type"],
        "application/octet-stream",
      );
      assert.equal(incoming.headers["content-encoding"], undefined);
      assert.equal(
        incoming.headers.authorization,
        `Bearer ${sourceUploadSession.controlAccessToken}`,
      );
      assert.equal(
        incoming.headers["x-crewon-bff-authorization"],
        `Bearer ${sourceUploadServiceToken}`,
      );
      assert.equal(incoming.headers["x-csrf-token"], sourceUploadControlCsrf);
      assert.equal(incoming.headers.origin, sourceUploadBrowserOrigin);
      assert.equal(incoming.headers.cookie, undefined);
      assert.equal(incoming.headers["x-actor-id"], undefined);
      assert.equal(sourceUploadDigest(received), route.locator.rawDigest);
      assert.deepEqual(received, bytes);
      observations.push({
        path: incoming.url!,
        method: incoming.method!,
        headers: incoming.headers,
        bytes: received,
      });
      outgoing.writeHead(reply.status, {
        "content-type": "application/json",
        ...reply.headers,
      });
      outgoing.end(JSON.stringify(reply.body));
    } catch (error) {
      outgoing.writeHead(500, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: { code: String(error) } }));
    }
  });
  const controlOrigin = await listen(control);
  let markBodyStarted!: () => void;
  let markBrowserDisconnected!: () => void;
  const bodyStarted = new Promise<void>((resolve) => {
    markBodyStarted = resolve;
  });
  const browserDisconnected = new Promise<void>((resolve) => {
    markBrowserDisconnected = resolve;
  });
  let resolutions = 0;
  const app = createWebBff({
    publicOrigin: sourceUploadBrowserOrigin,
    controlTarget: controlOrigin,
    controlBffToken: sourceUploadServiceToken,
    controlCsrfToken: sourceUploadControlCsrf,
    csrfSecret: "source-upload-browser-csrf-secret-at-least-32",
    identity: {
      async resolve(input) {
        resolutions++;
        return input.cookie === sourceUploadCookie ? sourceUploadSession : null;
      },
    },
  });
  const browser = createServer(async (incoming, outgoing) => {
    const abort = new AbortController();
    const onAbort = () => {
      abort.abort(new Error("browser_disconnected"));
      if (incoming.aborted) markBrowserDisconnected();
    };
    incoming.once("aborted", onAbort);
    outgoing.once("close", onAbort);
    try {
      const headers = new Headers();
      for (const [key, values] of Object.entries(incoming.headersDistinct))
        for (const value of values ?? []) headers.append(key, value);
      const method = incoming.method ?? "GET";
      const incomingChunks: Buffer[] = [];
      if (method !== "GET" && method !== "HEAD") {
        let total = 0;
        for await (const value of incoming) {
          const chunk = Buffer.from(value);
          total += chunk.byteLength;
          // One excess byte reaches the real BFF reader so this fixture can verify its own 64 KiB limit.
          if (total > 65_537) throw new Error("fixture_request_overflow");
          incomingChunks.push(chunk);
          markBodyStarted();
        }
      }
      const request = new Request(
        new URL(incoming.url ?? "/", sourceUploadBrowserOrigin),
        {
          method,
          headers,
          signal: abort.signal,
          ...(method === "GET" || method === "HEAD"
            ? {}
            : {
                body: new Uint8Array(Buffer.concat(incomingChunks)),
              }),
        },
      );
      const response = await app.handle(request, {
        rawTarget: incoming.url ?? "/",
      });
      await respond(outgoing, response);
    } catch (error) {
      if (!outgoing.destroyed) {
        outgoing.writeHead(500, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: { code: String(error) } }));
      }
    } finally {
      incoming.removeListener("aborted", onAbort);
      outgoing.removeListener("close", onAbort);
    }
  });
  const browserOrigin = await listen(browser);
  t.after(async () => {
    await close(browser);
    await close(control);
  });
  const bootstrap = await fetch(browserOrigin + "/control-api/session", {
    headers: { cookie: sourceUploadCookie },
  });
  const { csrfToken } = (await bootstrap.json()) as { csrfToken: string };
  const headers = {
    "cookie": sourceUploadCookie,
    "origin": sourceUploadBrowserOrigin,
    "x-csrf-token": csrfToken,
    "content-type": "application/octet-stream",
  };
  return {
    app,
    bytes,
    locator,
    path,
    acknowledgement,
    observations,
    reply,
    headers,
    browserOrigin,
    controlOrigin,
    bodyStarted,
    browserDisconnected,
    get resolutions() {
      return resolutions;
    },
    get upstreamRequests() {
      return upstreamRequests;
    },
    fetch(target = path, init: RequestInit = {}) {
      return fetch(browserOrigin + target, {
        method: "PUT",
        body: bytes,
        ...init,
        headers: {
          ...headers,
          ...Object.fromEntries(new Headers(init.headers)),
        },
      });
    },
  };
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
async function respond(
  outgoing: ServerResponse,
  response: Response,
): Promise<void> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (outgoing.destroyed) return;
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(bytes);
}
