import assert from "node:assert/strict";
import { createServer } from "node:https";
import {
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";
import {
  installedProcessActor as actor,
  installedProcessScope as scope,
} from "../../runtime-worker/src/installed-plugin-worker-process.test-support.ts";
import { taskProcessServiceToken } from "./installed-plugin-tasks-process-authorities.test-support.ts";

/** Named installation epoch authority, separate from execution, credit quote and enterprise login. */
export async function createFullAppInstallationAuthority() {
  const requests: string[] = [];
  const failures: unknown[] = [];
  const pending = new Set<Promise<void>>();
  let closed = false;
  let closing: Promise<void> | null = null;
  const server = createServer(
    { key: TEST_SERVER_KEY, cert: TEST_SERVER_CERT, minVersion: "TLSv1.3" },
    (request, response) => {
      if (closed || pending.size >= 32) {
        response.writeHead(503).end();
        return;
      }
      const work = Promise.resolve()
        .then(async () => {
          assert.equal(request.method, "POST");
          assert.equal(request.url, "/installation-policy");
          assert.equal(
            request.headers.authorization,
            `Bearer ${taskProcessServiceToken}`,
          );
          let size = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            size += Buffer.byteLength(chunk);
            assert.ok(size <= 16 * 1024);
            chunks.push(Buffer.from(chunk));
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            actor: unknown;
            action: unknown;
            resource: Record<string, unknown>;
          };
          assert.deepEqual(body.actor, actor);
          assert.equal(typeof body.action, "string");
          assert.ok(String(body.action).startsWith("pluginInstallation:"));
          assert.equal(body.resource.kind, "pluginInstallation");
          assert.equal(body.resource.tenantId, scope.tenantId);
          assert.equal(body.resource.spaceId, scope.spaceId);
          assert.equal(body.resource.profileId, scope.profileId);
          assert.ok(requests.length < 512);
          requests.push(String(body.action));
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              outcome: "allow",
              authorityEpoch: "named-full-app-installation-epoch-1",
            }),
          );
        })
        .catch((error: unknown) => {
          failures.push(error);
          if (!response.headersSent && !response.destroyed)
            response
              .writeHead(500)
              .end('{"fixture":"installation_authority_failed"}');
          else response.destroy();
        })
        .finally(() => pending.delete(work));
      pending.add(work);
    },
  );
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `https://localhost:${address.port}`,
    port: address.port,
    requests: () => [...requests],
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      server.closeAllConnections();
      const physical = new Promise<void>((accept, reject) => {
        server.close((error) => (error ? reject(error) : accept()));
      });
      closing = (async () => {
        await physical;
        await Promise.allSettled([...pending]);
        assert.deepEqual(failures, []);
      })();
      return closing;
    },
  };
}
