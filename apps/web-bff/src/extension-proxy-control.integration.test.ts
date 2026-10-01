import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStandaloneControlApiWithExtensions } from "../../control-api/src/standalone-composition.ts";
import { InMemoryArtifactStore } from "../../../packages/artifacts/src/in-memory-artifact-store.ts";
import { SqliteRunStore } from "../../../packages/store/src/sqlite-run-store.ts";
import { extensionManifestFixture } from "../../../packages/domain/src/extension-manifest.test-support.ts";
import { parseExtensionManifest } from "../../../packages/domain/src/extension-manifest.ts";
import { extensionCanonicalJson } from "../../../packages/domain/src/extension-configuration.ts";
import { parseExtensionHostRequest } from "../../../packages/contracts/src/extension-host-api.ts";
import {
  releaseActivation,
  releaseBundle,
} from "../../../packages/store/src/agent-version-release-store-conformance.test-support.ts";
import { createWebBff } from "./web-bff.ts";

test("real BFF-to-Control HTTP preserves plugin configuration, activation and task authority", async (context) => {
  const publicOrigin = "https://extension-bff.example.test";
  const accessToken = "extension-bff-identity-control-access-token";
  const controlCsrfToken = "extension-bff-control-csrf-token-at-least-32";
  const serviceToken = "extension-bff-control-service-token-at-least-32";
  const cookie = "crewon_session=bff-plugin-fixture";
  const actor = {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  };
  const root = mkdtempSync(join(tmpdir(), "crewon-bff-extension-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "control.sqlite");
  const manifest = parseExtensionManifest(
    extensionManifestFixture("crewon.comfyui-krea2"),
  );
  const registration = {
    manifest,
    manifestDigest: `sha256:${createHash("sha256").update(extensionCanonicalJson(manifest)).digest("hex")}`,
    implementationDigest: `sha256:${"b".repeat(64)}`,
  };
  const target = {
    executionAuthority: "crewonKernel",
    agentVersionId: "agent-1",
    agentVersionContentDigest: `sha256:${"a".repeat(64)}`,
    materializationDigest: `sha256:${"1".repeat(64)}`,
    authorityId: "authority-agent-1",
    runtimeGeneration: "ts-v0",
    policySnapshotId: "policy-1",
    workspaceBindingId: null,
  };
  const seed = new SqliteRunStore(databasePath);
  await seed.registerAgentVersion({
    schemaVersion: "crewon.agent-version-asset.v0",
    tenantId: actor.tenantId,
    agentVersionId: target.agentVersionId,
    contentDigest: target.agentVersionContentDigest,
    createdAt: "2026-10-01T00:00:00.000Z",
    definitionJson: JSON.stringify({
      schemaVersion: "crewon.agent-version.v0",
      agentVersionId: target.agentVersionId,
      runtimeGeneration: target.runtimeGeneration,
      policySnapshotId: target.policySnapshotId,
    }),
  });
  const release = releaseBundle("c", [target.agentVersionId]);
  await seed.activateAgentVersionRelease({
    bundle: release,
    activation: releaseActivation(release, "bff-release-1", null),
    expectedActiveReleaseId: null,
  });
  await seed.close();

  // The Worker host is synthetic; Control HTTP, persistence and admission are real.
  const workerToken = "extension-bff-private-worker-token-at-least-32";
  const host = createServer(async (incoming, outgoing) => {
    assert.equal(incoming.url, "/private/v0/extensions");
    assert.equal(incoming.headers.authorization, `Bearer ${workerToken}`);
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const request = parseExtensionHostRequest(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    assert.deepEqual(request.actor, actor);
    const common = {
      protocol: "crewon.extension-host-response.v0",
      operation: request.operation,
      actor: request.actor,
    };
    const response =
      request.operation === "catalog"
        ? { ...common, registrations: [registration] }
        : request.operation === "validateConfiguration"
          ? {
              ...common,
              registration: request.registration,
              configurationDigest: request.configuration.contentDigest,
            }
          : {
              ...common,
              registration: request.registration,
              configurationDigest: request.configuration.contentDigest,
              agentVersionId: request.agentVersionId,
              result: { outcome: "ready", target },
            };
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    host.closeAllConnections();
    await new Promise<void>((resolve) => host.close(() => resolve()));
  });
  const address = host.address();
  assert.ok(address !== null && typeof address !== "string");
  const control = await createStandaloneControlApiWithExtensions({
    actor,
    databasePath,
    defaultAgentVersionId: target.agentVersionId,
    sessionToken: accessToken,
    csrfToken: controlCsrfToken,
    allowedOrigins: [publicOrigin],
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "fixture-key",
    heartbeatIntervalMs: null,
    outboxScanIntervalMs: null,
    automationScanIntervalMs: null,
    extensionWorker: {
      origin: `http://127.0.0.1:${address.port}`,
      token: workerToken,
    },
  });
  context.after(() => control.app.close());
  const controlOrigin = await control.app.listen({
    host: "127.0.0.1",
    port: 0,
  });
  const proxied: string[] = [];
  const app = createWebBff({
    publicOrigin,
    controlTarget: controlOrigin,
    controlBffToken: serviceToken,
    controlCsrfToken,
    csrfSecret: "extension-bff-browser-csrf-secret-at-least-32",
    identity: {
      resolve: async (input) =>
        input.cookie === cookie
          ? {
              controlAccessToken: accessToken,
              sessionId: "extension-bff-session-identity-at-least-32",
              expiresAt: "2030-01-01T00:00:00.000Z",
            }
          : null,
    },
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${accessToken}`);
      assert.equal(
        headers.get("x-crewon-bff-authorization"),
        `Bearer ${serviceToken}`,
      );
      assert.equal(headers.get("cookie"), null);
      proxied.push(String(input));
      return fetch(input, init);
    },
  });
  const bootstrap = await app.handle(
    new Request(`${publicOrigin}/control-api/session`, { headers: { cookie } }),
  );
  const csrf = ((await bootstrap.json()) as { csrfToken: string }).csrfToken;
  const json = async (
    path: string,
    method = "GET",
    body?: unknown,
    key = "read",
  ) => {
    const response = await app.handle(
      new Request(`${publicOrigin}${path}`, {
        method,
        headers: {
          cookie,
          "origin": publicOrigin,
          "x-csrf-token": csrf,
          "content-type": "application/json",
          "idempotency-key": key,
          "authorization": "Bearer forged-browser-token",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, any>,
    };
  };
  const base = `/api/v1/extensions/${manifest.pluginId}`;
  const catalog = await json("/api/v1/extensions");
  assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
  assert.equal(catalog.body.extensions[0].pluginId, manifest.pluginId);
  const saved = await json(
    `${base}/configuration`,
    "PUT",
    {
      pluginVersion: manifest.version,
      expectedRevision: 0,
      parameters: { format: "mp4" },
      credentialBindings: [
        {
          slotId: "provider",
          credentialBindingId: "fixture-credential-binding",
        },
      ],
    },
    "bff-save-1",
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.configuration.tenantId, actor.tenantId);
  assert.equal(saved.body.configuration.spaceId, actor.spaceId);
  assert.deepEqual(
    (await json(`${base}/configuration?revision=1`)).body.configuration,
    saved.body.configuration,
  );
  const runtime = await json(
    `${base}/runtime?agentVersionId=${target.agentVersionId}&configurationRevision=1`,
  );
  assert.equal(runtime.status, 200, JSON.stringify(runtime.body));
  assert.equal(runtime.body.readiness.outcome, "ready");
  const activated = await json(
    `${base}/activation`,
    "PUT",
    {
      configurationRevision: 1,
      expectedRevision: 0,
      state: "enabled",
      agentVersionId: target.agentVersionId,
    },
    "bff-activate-1",
  );
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  const thread = await json(
    "/api/v1/threads",
    "POST",
    { title: "BFF plugin task" },
    "bff-thread-1",
  );
  assert.equal(thread.status, 201, JSON.stringify(thread.body));
  const taskBody = {
    threadId: thread.body.thread.threadId,
    expectedThreadRevision: thread.body.thread.revision,
    intent: {
      kind: "generate",
      input: { prompt: "Proxy admission only; no provider request." },
    },
  };
  const created = await json(`${base}/tasks`, "POST", taskBody, "bff-task-1");
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const repeated = await json(`${base}/tasks`, "POST", taskBody, "bff-task-1");
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.equal(repeated.body.runId, created.body.runId);
  const task = await json(`${base}/tasks/${created.body.runId}`);
  assert.equal(task.status, 200, JSON.stringify(task.body));
  assert.ok(JSON.stringify(task.body).includes(created.body.runId));
  const calls = proxied.length;
  assert.equal(
    (await json(`${base}/configuration?tenantId=other`)).status,
    400,
  );
  assert.equal(proxied.length, calls);
  assert.equal(
    (await app.handle(new Request(`${publicOrigin}${base}/activation`))).status,
    401,
  );
  assert.equal(proxied.length, calls);
});
