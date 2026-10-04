import assert from "node:assert/strict";
import { createServer } from "node:https";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { parseAgentVersionAsset } from "@crewon/agent-version";
import { SqliteRunStore } from "@crewon/store";
import {
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";
import {
  installedPluginReleaseDigester as digester,
  readInstalledPluginReleaseDocument,
} from "../../runtime-worker/src/plugins/installed-plugin-release-document.ts";
import { automaticPreparationDirectories } from "./desktopInstalledPluginRuntime.automatic.process.test-support.ts";
import { candidateAuthorityGate } from "./desktopInstalledPluginRuntime.candidate-authority.test-support.ts";
import type { IsolationFixture } from "./desktopInstalledPluginRuntime.fault-isolation.test-support.ts";
import {
  DESKTOP_PLUGIN_APPROVAL_FILE,
  DESKTOP_PLUGIN_APPROVAL_SCHEMA,
  DESKTOP_PLUGIN_APPROVAL_SCHEMA_V3,
} from "./desktopPluginBootstrap.ts";
import { DESKTOP_RUNTIME_OWNER as actor } from "./desktopExtensionRuntime.ts";

/** Named v3 metadata authority, scoped by actual Native approval/profile/SQLite
 * installation, latest configuration and the real published deployment. It never
 * authorizes a Run, task, external operation, charge or supplier request. */
export async function nativeActivationAuthority(f: IsolationFixture) {
  const token = process.env.NATIVE_INSTALLED_AUTHORITY_TOKEN;
  assert.ok(typeof token === "string" && token.length >= 32);
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const pending = new Set<Promise<void>>(),
    failures: unknown[] = [];
  const gates = new Set<ReturnType<typeof candidateAuthorityGate>>();
  const next = new Map<string, ReturnType<typeof candidateAuthorityGate>>();
  let activationDecisions = 0;
  let scheduledActivation: Readonly<{
    ordinal: number;
    gate: ReturnType<typeof candidateAuthorityGate>;
    capture(decision: unknown): void;
  }> | null = null;
  let activationAllowed = true,
    networkAllowed = true,
    packageAllowed = true;
  let historicalObservation:
    | Readonly<{
        pluginId: string;
        publisherId: string;
        version: string;
        packageDigest: string;
      }>
    | undefined;
  let approvalSchema:
    | typeof DESKTOP_PLUGIN_APPROVAL_SCHEMA
    | typeof DESKTOP_PLUGIN_APPROVAL_SCHEMA_V3 = DESKTOP_PLUGIN_APPROVAL_SCHEMA;
  async function packageFacts(identity: unknown, scope: unknown) {
    const current = await f.currentProfile();
    if (!current || !same(current, scope)) return false;
    const approvalPath = join(f.dataDirectory, DESKTOP_PLUGIN_APPROVAL_FILE);
    const privateFile = await lstat(approvalPath);
    assert.ok(privateFile.isFile() && !privateFile.isSymbolicLink());
    assert.equal(privateFile.uid, process.getuid?.());
    assert.equal(privateFile.mode & 0o777, 0o600);
    assert.equal(privateFile.nlink, 1);
    const approval = JSON.parse(await readFile(approvalPath, "utf8"));
    assert.equal(approval.schemaVersion, approvalSchema);
    const source = f.sources.find(
      ({ sourceId: _id, directory: _directory, ...tuple }) =>
        same(tuple, identity),
    );
    if (
      !source ||
      !approval.sources.some(
        ({
          sourceId: _id,
          directory: _directory,
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
        selection !== null &&
        ["disabled", "enabled"].includes(selection.state) &&
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
  async function publishedFacts(
    pluginId: string,
    metadata?: Record<string, unknown>,
  ) {
    const scope = await f.currentProfile();
    if (!scope) return false;
    const directories = await automaticPreparationDirectories(f.dataDirectory);
    if (directories.length !== 1) return false;
    const document = readInstalledPluginReleaseDocument(
      join(f.dataDirectory, directories[0]!, "release.json"),
    );
    const entry = document.entries.find(
      ({ packageIdentity }) => packageIdentity.pluginId === pluginId,
    );
    if (
      !entry ||
      !same(entry.scope, scope) ||
      !(await packageFacts(entry.packageIdentity, scope))
    )
      return false;
    if (
      metadata &&
      (!same(metadata.identity, entry.packageIdentity) ||
        !same(metadata.scope, scope) ||
        !same(metadata.configuration, entry.configuration) ||
        !same(metadata.target, entry.target))
    )
      return false;
    const store = new SqliteRunStore(f.databasePath);
    try {
      const configuration = await store
        .extensionStore()
        .loadLatestExtensionConfiguration({
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          pluginId,
        });
      if (!same(configuration, entry.configuration)) return false;
      const active = await store.loadActiveAgentVersionRelease({
        tenantId: actor.tenantId,
      });
      if (
        !active ||
        !active.bundle.deployments.some(
          ({ agentVersionId }) =>
            agentVersionId === entry.target.agentVersionId,
        )
      )
        return false;
      const asset = await store.loadAgentVersion({
        tenantId: actor.tenantId,
        agentVersionId: entry.target.agentVersionId,
      });
      const deployment = await store.loadAgentVersionDeployment({
        tenantId: actor.tenantId,
        agentVersionId: entry.target.agentVersionId,
      });
      if (!asset || !deployment) return false;
      const compiled = parseAgentVersionAsset(asset, digester);
      return same(entry.target, {
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
          request.headers.authorization === `Bearer ${token}`,
          "activation_authority_token_mismatch",
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
          const namedReportObservation =
            body.purpose === "observe" &&
            f.namedReportExecution !== undefined &&
            same(body.scope, await f.currentProfile()) &&
            f.sources.some(
              ({ sourceId: _source, directory: _directory, ...identity }) =>
                identity.pluginId === "example.professional" &&
                same(identity, body.identity),
            ) &&
            (await f.namedReportExecution.authorizePolicy({
              action: "extension:query",
              resource: {
                kind: "extension",
                tenantId: actor.tenantId,
                spaceId: actor.spaceId,
                pluginId: "example.professional",
              },
            }));
          assert.ok(
            body.purpose === "read" ||
              body.purpose === "submit" ||
              namedReportObservation ||
              (body.purpose === "observe" &&
                same(body.identity, historicalObservation)),
          );
          result = {
            outcome:
              packageAllowed && (await packageFacts(body.identity, body.scope))
                ? "allow"
                : "deny",
          };
        } else if (request.url === "/network") {
          assert.equal(
            body.schemaVersion,
            "crewon.plugin-execution-network.v1",
          );
          assert.equal(
            body.kind,
            "readiness",
            "native_activation_must_not_dispatch_io",
          );
          const metadata = body.metadata as Record<string, unknown>;
          assert.deepEqual(Object.keys(metadata).sort(), [
            "configuration",
            "identity",
            "purpose",
            "scope",
            "target",
          ]);
          assert.ok(
            metadata.purpose === "submit" ||
              (metadata.purpose === "observe" &&
                same(metadata.identity, historicalObservation)),
          );
          const identity = metadata.identity as { pluginId: string };
          result =
            networkAllowed &&
            (await publishedFacts(identity.pluginId, metadata))
              ? {
                  baseUrlParameter: "baseUrl",
                  paths: [
                    ...(metadata.purpose === "submit"
                      ? [{ method: "POST", path: "/prompt" }]
                      : []),
                    { method: "GET", operationPathPrefix: "/history/" },
                    { method: "GET", path: "/queue" },
                  ],
                }
              : null;
        } else {
          assert.equal(request.url, "/activate");
          assert.deepEqual(Object.keys(body).sort(), [
            "action",
            "actor",
            "resource",
          ]);
          assert.deepEqual(body.actor, actor);
          assert.equal(body.action, "extension:activate");
          const resource = body.resource as Record<string, unknown>;
          assert.deepEqual(Object.keys(resource).sort(), [
            "kind",
            "pluginId",
            "spaceId",
            "tenantId",
          ]);
          assert.equal(resource.kind, "extension");
          const validScope =
            resource.tenantId === actor.tenantId &&
            resource.spaceId === actor.spaceId;
          result =
            activationAllowed &&
            validScope &&
            typeof resource.pluginId === "string" &&
            (await publishedFacts(resource.pluginId))
              ? { outcome: "allow" }
              : {
                  outcome: "deny",
                  reasonCode: "native_activation_current_facts_denied",
                };
        }
        let gate = next.get(request.url!);
        if (request.url === "/activate") {
          activationDecisions++;
          const scheduled = scheduledActivation;
          if (scheduled?.ordinal === activationDecisions) {
            assert.equal(gate, undefined);
            scheduledActivation = null;
            // Freeze this actual fact-derived decision before the response-body wait.
            // Releasing the gate below never recomputes it after a fixture fact changes.
            scheduled.capture(
              Object.freeze(JSON.parse(JSON.stringify(result))),
            );
            gate = scheduled.gate;
          }
        }
        if (gate) {
          next.delete(request.url!);
          const encoded = Buffer.from(JSON.stringify(result));
          request.socket.once("close", () => gate.markClosed());
          response.writeHead(200, {
            "content-type": "application/json",
            "content-length": encoded.length,
          });
          response.write(encoded.subarray(0, 1));
          const metadata = body.metadata as Record<string, unknown> | undefined;
          gate.enter({
            identity: metadata?.identity ?? body.resource,
            target: metadata?.target ?? null,
          });
          await Promise.race([gate.wait, gate.closed]);
          if (!response.destroyed) response.end(encoded.subarray(1));
          return;
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
  return {
    origin: `https://localhost:${address.port}`,
    requests,
    expectProjectExecutionApproval() {
      assert.equal(approvalSchema, DESKTOP_PLUGIN_APPROVAL_SCHEMA);
      approvalSchema = DESKTOP_PLUGIN_APPROVAL_SCHEMA_V3;
    },
    allowNamedHistoricalQueryObservation(
      identity: NonNullable<typeof historicalObservation>,
    ) {
      assert.equal(approvalSchema, DESKTOP_PLUGIN_APPROVAL_SCHEMA_V3);
      assert.equal(historicalObservation, undefined);
      assert.ok(
        f.sources.some(
          ({ sourceId: _source, directory: _directory, ...tuple }) =>
            same(tuple, identity),
        ),
      );
      historicalObservation = Object.freeze({ ...identity });
    },
    denyActivation: () => {
      activationAllowed = false;
    },
    denyNetwork: () => {
      networkAllowed = false;
    },
    denyPackage: () => {
      packageAllowed = false;
    },
    holdNext(path: "/network" | "/activate") {
      assert.ok(!next.has(path));
      const gate = candidateAuthorityGate();
      next.set(path, gate);
      gates.add(gate);
      return gate;
    },
    holdActivationDecision(ordinal: number) {
      assert.ok(
        Number.isSafeInteger(ordinal) &&
          ordinal > activationDecisions &&
          ordinal <= 16,
      );
      assert.equal(scheduledActivation, null);
      assert.ok(!next.has("/activate"));
      const gate = candidateAuthorityGate();
      let decision: unknown = null;
      scheduledActivation = {
        ordinal,
        gate,
        capture: (value) => {
          decision = value;
        },
      };
      gates.add(gate);
      return { ...gate, decision: () => decision };
    },
    async close() {
      for (const gate of gates) gate.release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await Promise.allSettled([...pending]);
      if (failures.length)
        throw new AggregateError(
          failures,
          "native_activation_authority_failed",
        );
    },
  };
}
