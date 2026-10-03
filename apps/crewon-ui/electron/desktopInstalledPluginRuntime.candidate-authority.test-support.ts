import assert from "node:assert/strict";
import { createServer } from "node:https";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { parseAgentVersionAsset } from "@crewon/agent-version";
import { SqliteRunStore } from "@crewon/store";
import {
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";
import { DESKTOP_PLUGIN_APPROVAL_FILE } from "./desktopPluginBootstrap.ts";
import { DESKTOP_RUNTIME_OWNER as actor } from "./desktopExtensionRuntime.ts";
import type { IsolationFixture } from "./desktopInstalledPluginRuntime.fault-isolation.test-support.ts";
import { installedPluginReleaseDigester as digester } from "../../runtime-worker/src/plugins/installed-plugin-release-document.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function candidateAuthorityGate() {
  const entered = deferred<Readonly<{ identity: unknown; target: unknown }>>();
  const held = deferred<void>(),
    closed = deferred<void>();
  let socketClosed = false;
  return {
    entered: entered.promise,
    closed: closed.promise,
    enter: entered.resolve,
    release: () => held.resolve(),
    wait: held.promise,
    socketClosed: () => socketClosed,
    markClosed() {
      socketClosed = true;
      closed.resolve();
    },
  };
}

/** Named candidate metadata authority: every allow is derived from this actual Native
 * private profile/approval, disabled selection, installed package and published target.
 * It issues no Run, task, quotation, IO dispatch or payment permission. */
export async function nativeCandidateAuthority(f: IsolationFixture) {
  const authorityToken = process.env.NATIVE_INSTALLED_AUTHORITY_TOKEN;
  assert.ok(typeof authorityToken === "string" && authorityToken.length >= 32);
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const pending = new Set<Promise<void>>(),
    failures: unknown[] = [];
  let networkAllowed = true,
    packageAllowed = true;
  let nextGate: ReturnType<typeof candidateAuthorityGate> | null = null;
  const gates = new Set<ReturnType<typeof candidateAuthorityGate>>();
  async function packageFacts(identity: unknown, scope: unknown) {
    const current = await f.currentProfile();
    if (!same(current, scope) || current === null) return false;
    const approval = JSON.parse(
      await readFile(
        join(f.dataDirectory, DESKTOP_PLUGIN_APPROVAL_FILE),
        "utf8",
      ),
    );
    const source = f.sources.find(
      ({ sourceId: _id, directory: _dir, ...tuple }) => same(tuple, identity),
    );
    if (
      !source ||
      !approval.sources.some(
        ({
          sourceId: _id,
          directory: _dir,
          ...tuple
        }: Record<string, unknown>) => same(tuple, identity),
      )
    )
      return false;
    const store = new SqliteRunStore(f.databasePath);
    try {
      const ledger = store.pluginInstallationStore();
      const selection = await ledger.loadSelection({
        scope: current,
        pluginId: source.pluginId,
      });
      const installed = await ledger.loadPackage({
        scope: current,
        packageDigest: source.packageDigest,
      });
      return (
        selection?.state === "disabled" &&
        selection.selectedPackageDigest === source.packageDigest &&
        installed !== null &&
        installed.pluginId === source.pluginId &&
        installed.publisherId === source.publisherId &&
        installed.version === source.version
      );
    } finally {
      await store.close();
    }
  }
  async function networkFacts(input: Record<string, unknown>) {
    if (input.kind !== "readiness") return false;
    const metadata = input.metadata as Record<string, unknown>;
    assert.deepEqual(Object.keys(metadata).sort(), [
      "configuration",
      "identity",
      "purpose",
      "scope",
      "target",
    ]);
    assert.equal(metadata.purpose, "submit");
    if (!(await packageFacts(metadata.identity, metadata.scope))) return false;
    const identity = metadata.identity as { pluginId: string };
    const target = metadata.target as { agentVersionId: string };
    const store = new SqliteRunStore(f.databasePath);
    try {
      const configuration = await store
        .extensionStore()
        .loadLatestExtensionConfiguration({
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          pluginId: identity.pluginId,
        });
      if (!same(configuration, metadata.configuration)) return false;
      const asset = await store.loadAgentVersion({
        tenantId: actor.tenantId,
        agentVersionId: target.agentVersionId,
      });
      const deployment = await store.loadAgentVersionDeployment({
        tenantId: actor.tenantId,
        agentVersionId: target.agentVersionId,
      });
      if (!asset || !deployment) return false;
      const compiled = parseAgentVersionAsset(asset, digester);
      return same(metadata.target, {
        executionAuthority: "crewonKernel",
        agentVersionId: compiled.agentVersionId,
        agentVersionContentDigest: compiled.contentDigest,
        materializationDigest: deployment.materializationDigest,
        authorityId: deployment.authorityId,
        runtimeGeneration: compiled.runtimeGeneration,
        policySnapshotId: compiled.policySnapshotId,
        workspaceBindingId: deployment.workspaceBindingId,
      });
    } finally {
      await store.close();
    }
  }
  const server = createServer(
    { key: TEST_SERVER_KEY, cert: TEST_SERVER_CERT, minVersion: "TLSv1.3" },
    (request, response) => {
      const work = (async () => {
        assert.equal(request.method, "POST");
        assert.ok(
          request.headers.authorization === `Bearer ${authorityToken}`,
          "candidate_authority_token_mismatch",
        );
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += Buffer.byteLength(chunk);
          assert.ok(bytes <= 256 * 1024);
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as Record<string, unknown>;
        assert.ok(requests.length < 512);
        requests.push({ path: request.url!, body });
        let result: unknown;
        if (request.url === "/package") {
          assert.equal(
            body.schemaVersion,
            "crewon.plugin-execution-package.v1",
          );
          assert.ok(body.purpose === "read" || body.purpose === "submit");
          result = {
            outcome:
              (await packageFacts(body.identity, body.scope)) &&
              (body.purpose === "read" || packageAllowed)
                ? "allow"
                : "deny",
          };
        } else {
          assert.equal(request.url, "/network");
          assert.equal(
            body.schemaVersion,
            "crewon.plugin-execution-network.v1",
          );
          const approved =
            body.kind === "readiness" &&
            networkAllowed &&
            (await networkFacts(body));
          result = approved
            ? {
                baseUrlParameter: "baseUrl",
                paths: [
                  { method: "POST", path: "/prompt" },
                  { method: "GET", operationPathPrefix: "/history/" },
                  { method: "GET", path: "/queue" },
                ],
              }
            : null;
          if (approved && nextGate) {
            const gate = nextGate;
            nextGate = null;
            const encoded = Buffer.from(JSON.stringify(result));
            request.socket.once("close", () => gate.markClosed());
            response.writeHead(200, {
              "content-type": "application/json",
              "content-length": encoded.length,
            });
            response.write(encoded.subarray(0, 1));
            const metadata = body.metadata as Record<string, unknown>;
            gate.enter({
              identity: metadata.identity,
              target: metadata.target,
            });
            await Promise.race([gate.wait, gate.closed]);
            if (!response.destroyed) response.end(encoded.subarray(1));
            return;
          }
        }
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(result));
      })()
        .catch((error: unknown) => {
          failures.push(error);
          if (!response.headersSent) response.writeHead(500).end();
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
  const origin = `https://localhost:${address.port}`;
  return {
    origin,
    requests,
    denyNetwork: () => {
      networkAllowed = false;
    },
    denyPackage: () => {
      packageAllowed = false;
    },
    holdNextNetwork() {
      assert.equal(nextGate, null);
      nextGate = candidateAuthorityGate();
      gates.add(nextGate);
      return nextGate;
    },
    async close() {
      for (const gate of gates) gate.release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await Promise.allSettled([...pending]);
      if (failures.length)
        throw new AggregateError(failures, "native_candidate_authority_failed");
    },
  };
}
