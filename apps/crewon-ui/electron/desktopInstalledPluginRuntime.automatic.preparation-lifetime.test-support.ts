import assert from "node:assert/strict";
import { createServer, request as httpsRequest } from "node:https";
import type { ClientRequest } from "node:http";
import {
  TEST_CA_CERT,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";
import { DESKTOP_RUNTIME_OWNER as actor } from "./desktopExtensionRuntime.ts";

/** A real HTTPS proxy which delays one verified original actor response. It
 * forwards the actual request and never constructs an actor or allow decision. */
export async function holdActualNativePreparationActor(originalUrl: string) {
  const original = new URL(originalUrl);
  assert.equal(original.protocol, "https:");
  const pending = new Set<Promise<void>>();
  const outgoing = new Set<ClientRequest>();
  const failures: unknown[] = [];
  let enter!: (
    proof: Readonly<{ status: number; actualActor: typeof actor }>,
  ) => void;
  const entered = new Promise<
    Readonly<{ status: number; actualActor: typeof actor }>
  >((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let captured = false;
  let closing: Promise<void> | null = null;
  const server = createServer(
    { key: TEST_SERVER_KEY, cert: TEST_SERVER_CERT, minVersion: "TLSv1.3" },
    (request, response) => {
      const work = Promise.resolve()
        .then(async () => {
          assert.equal(request.method, "POST");
          assert.equal(request.url, "/actual-actor");
          assert.ok(typeof request.headers.authorization === "string");
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of request) {
            size += Buffer.byteLength(chunk);
            assert.ok(size <= 128 * 1024);
            chunks.push(Buffer.from(chunk));
          }
          const body = Buffer.concat(chunks);
          const result = await new Promise<{
            status: number;
            contentType: string;
            body: Buffer;
          }>((resolve, reject) => {
            const forwarded = httpsRequest(
              original,
              {
                method: "POST",
                ca: TEST_CA_CERT,
                minVersion: "TLSv1.3",
                agent: false,
                headers: {
                  "authorization": request.headers.authorization!,
                  "content-type":
                    request.headers["content-type"] ?? "application/json",
                },
              },
              (actual) => {
                const parts: Buffer[] = [];
                let bytes = 0;
                actual.on("data", (chunk: Buffer) => {
                  bytes += chunk.length;
                  if (bytes > 128 * 1024)
                    actual.destroy(new Error("native_actor_reply_too_large"));
                  else parts.push(chunk);
                });
                actual.once("error", reject);
                actual.once("end", () =>
                  resolve({
                    status: actual.statusCode!,
                    contentType: String(actual.headers["content-type"]),
                    body: Buffer.concat(parts),
                  }),
                );
              },
            );
            outgoing.add(forwarded);
            forwarded.once("close", () => outgoing.delete(forwarded));
            forwarded.once("error", reject);
            forwarded.setTimeout(5000, () =>
              forwarded.destroy(new Error("native_actor_forward_timeout")),
            );
            forwarded.end(body);
          });
          assert.equal(result.status, 200);
          const actualActor = JSON.parse(result.body.toString("utf8"));
          assert.deepEqual(actualActor, actor);
          if (!captured) {
            captured = true;
            enter({ status: result.status, actualActor });
            await held;
          }
          if (!response.destroyed)
            response
              .writeHead(result.status, { "content-type": result.contentType })
              .end(result.body);
        })
        .catch((error: unknown) => {
          failures.push(error);
          if (!response.headersSent && !response.destroyed)
            response.writeHead(500).end();
          else response.destroy();
        })
        .finally(() => pending.delete(work));
      pending.add(work);
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `https://localhost:${address.port}/actual-actor`,
    entered,
    release,
    async joined() {
      await Promise.allSettled([...pending]);
    },
    close() {
      if (closing !== null) return closing;
      closing = (async () => {
        release();
        server.closeAllConnections();
        for (const request of outgoing) request.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await Promise.allSettled([...pending]);
        if (failures.length)
          throw new AggregateError(failures, "native_actor_proxy_failed");
      })();
      return closing;
    },
  };
}
