import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { inspect } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { compileAgentVersion } from "@crewon/agent-version";
import { canonicalActionIntent } from "@crewon/contracts";
import type { ToolExecutionCommand } from "@crewon/tool-broker";

import {
  loadAgentVersionRuntimeFactory,
  loadRemoteMcpManifestBindings,
} from "./runtime-binding-config.ts";
import {
  installRuntimeNativeBootstrap,
  takeRuntimeNativeBootstrap,
} from "./runtime-native-bootstrap.ts";
import { createRuntimeNativeRemoteMcpOwner } from "./runtime-native-remote-mcp.ts";
import type { PinnedHttpPort, PinnedHttpRequest } from "./pinned-node-http.ts";

const SECRET = "remote-mcp-production-secret-sentinel";

test("released production composition transport gate reconciles a remote receipt exactly once", async (t) => {
  const remote = new HermeticRemoteReceiptTransport();
  const paths = releasedManifests(t, "https://mcp.example:8443/mutations");
  const identities = loadRemoteMcpManifestBindings(paths.bindingPath);
  assert.equal(identities.length, 1);

  installRuntimeNativeBootstrap(nativeV3Envelope());
  const bootstrap = takeRuntimeNativeBootstrap();
  assert.ok(
    bootstrap?.credentialBindings !== null &&
      bootstrap?.credentialBindings !== undefined,
  );
  assert.doesNotMatch(inspect(bootstrap), new RegExp(SECRET, "u"));
  const owner = createRuntimeNativeRemoteMcpOwner({
    credentials: bootstrap.credentialBindings,
    expectedAuthority: bootstrap.credentialBindings.authority,
    manifestBindings: identities,
  });
  t.after(() => owner.destroy());
  const production = owner.dependencies;
  assert.equal(production.mode, "production");
  if (production.mode !== "production")
    throw new Error("production_dependencies_expected");
  const dependencies = {
    mode: "production" as const,
    credentialLeaseFactory: production.credentialLeaseFactory,
    tenantEgressFactory: (identity: (typeof identities)[number]) => ({
      policy: production.tenantEgressFactory(identity).policy,
      dns: {
        resolveAll: async () => [{ address: "8.8.8.8", family: 4 as const }],
      },
      transport: remote,
    }),
  };
  const version = compileAgentVersion(agentSource(), { sha256 });
  const factory = loadAgentVersionRuntimeFactory(
    paths.bindingPath,
    {},
    dependencies,
  );

  const first = await factory.create({ tenantId: "tenant-1", version });
  const command = mutationCommand();
  await assert.rejects(
    first.toolRuntime.execute!(command, signal()),
    (error: unknown) =>
      error instanceof Error &&
      "certainty" in error &&
      error.certainty === "possiblySent" &&
      !inspect(error).includes(SECRET),
  );
  await first.close!();

  const recovered = await factory.create({ tenantId: "tenant-1", version });
  t.after(() => recovered.close!());
  assert.deepEqual(await recovered.toolRuntime.reconcile!(command, signal()), {
    status: "completed",
    executionId: command.executionId,
    providerReceiptId: `receipt:${command.executionId}`,
    result: {
      schemaVersion: "crewon.tool-result.v0",
      callId: command.callId,
      output: '[structured]\n{"created":true}',
      isError: false,
      artifactRef: null,
    },
  });

  assert.deepEqual(remote.phases, ["execute", "reconcile"]);
  assert.equal(remote.executeCount, 1);
  assert.equal(new Set(remote.idempotencyKeys).size, 2);
  assert.equal(
    remote.idempotencyKeys.every((key) =>
      /^crewon-mcp-v1-[a-f0-9]{64}$/u.test(key),
    ),
    true,
  );
  assert.deepEqual(remote.authorizations, [
    `Bearer ${SECRET}`,
    `Bearer ${SECRET}`,
  ]);
  assert.equal(
    remote.bodies.every((body) => !JSON.stringify(body).includes(SECRET)),
    true,
  );
  assert.doesNotMatch(
    readFileSync(paths.bindingPath, "utf8"),
    new RegExp(SECRET, "u"),
  );
  assert.doesNotMatch(
    readFileSync(paths.remotePath, "utf8"),
    new RegExp(SECRET, "u"),
  );
});

class HermeticRemoteReceiptTransport implements PinnedHttpPort {
  readonly #receipts = new Map<string, string>();
  readonly phases: string[] = [];
  readonly authorizations: string[] = [];
  readonly idempotencyKeys: string[] = [];
  readonly bodies: unknown[] = [];
  executeCount = 0;

  async request(input: PinnedHttpRequest): Promise<{
    status: number;
    headers: Readonly<Record<string, string>>;
    body: Uint8Array;
  }> {
    assert.equal(input.method, "POST");
    assert.equal(
      input.target.endpoint.href,
      "https://mcp.example:8443/mutations",
    );
    assert.equal(input.target.endpoint.pathname, "/mutations");
    assert.deepEqual(input.target, {
      endpoint: new URL("https://mcp.example:8443/mutations"),
      address: "8.8.8.8",
      family: 4,
    });
    assert.equal(input.maxRequestBytes, 256 * 1024);
    assert.equal(input.maxResponseBytes, 256 * 1024);
    assert.equal(input.headers?.accept, "application/json");
    assert.equal(
      input.headers?.["content-type"],
      "application/json; charset=utf-8",
    );
    assert.ok((input.body?.byteLength ?? 0) <= input.maxRequestBytes);
    const body = JSON.parse(new TextDecoder().decode(input.body)) as {
      phase: "execute" | "reconcile";
      providerExecutionId: string;
      toolName: string;
    };
    this.phases.push(body.phase);
    this.bodies.push(body);
    this.authorizations.push(input.headers?.authorization ?? "");
    this.idempotencyKeys.push(String(input.headers?.["idempotency-key"]));
    if (body.phase === "execute") {
      this.executeCount += 1;
      this.#receipts.set(
        body.providerExecutionId,
        `receipt:${body.providerExecutionId}`,
      );
      throw new Error("simulated_crash_after_remote_receipt_commit");
    }
    const providerReceiptId = this.#receipts.get(body.providerExecutionId);
    assert.ok(providerReceiptId !== undefined);
    const responseBody = Buffer.from(
      JSON.stringify({
        schemaVersion: "crewon.remote-mcp-mutation.v1",
        phase: body.phase,
        providerExecutionId: body.providerExecutionId,
        toolName: body.toolName,
        resolution: {
          status: "completed",
          providerReceiptId,
          result: { structuredContent: { created: true } },
        },
      }),
    );
    assert.ok(responseBody.byteLength <= input.maxResponseBytes);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: responseBody,
    };
  }
}

function releasedManifests(t: TestContext, endpoint: string) {
  const directory = mkdtempSync(join(tmpdir(), "crewon-remote-production-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remotePath = join(directory, "remote-mcp.json");
  const bindingPath = join(directory, "runtime-bindings.json");
  const version = compileAgentVersion(agentSource(), { sha256 });
  writeFileSync(remotePath, JSON.stringify(remoteConfig(endpoint)), "utf8");
  writeFileSync(
    bindingPath,
    JSON.stringify({
      schemaVersion: "crewon.agent-version-runtime-bindings.v0",
      bindings: [
        {
          tenantId: "tenant-1",
          agentVersionId: "agent-version-1",
          contentDigest: version.contentDigest,
          authorityId: "authority-1",
          workspaceBindingId: "workspace-1",
          provider: {
            kind: "directResponses",
            endpoint: "https://provider.example/v1/responses",
            apiKeyEnvironment: null,
            storeResponses: false,
            requestProfile: "standard",
            idleTimeoutMs: 60_000,
            sequencePolicy: "required",
          },
          mcpStdioConfigPath: null,
          deviceToolConfigPath: null,
          remoteMcpConfigPath: remotePath,
        },
      ],
    }),
    "utf8",
  );
  return { bindingPath, remotePath };
}

function remoteConfig(endpoint: string) {
  return {
    schemaVersion: "crewon.remote-mcp-runtime.v0",
    servers: [
      {
        serverId: "remote",
        serverBindingId: "remote-1",
        mode: "production",
        endpoint,
        credentialBindingId: "credential-1",
        tools: [
          {
            descriptor: {
              name: "create_record",
              description: "Creates one record.",
              inputSchema: { type: "object", additionalProperties: false },
            },
            policy: policy(),
          },
        ],
      },
    ],
  };
}

function policy() {
  return {
    effect: "mutation" as const,
    recovery: "reconcilable" as const,
    resourceBindingId: null,
    credentialBindingId: "credential-1",
    executionTarget: { kind: "remote" as const, bindingId: "remote-1" },
    capability: "records.create",
    approvalRequirement: "none" as const,
    limits: {
      timeoutMs: 30_000,
      maxOutputBytes: 64_000,
      maxArtifactBytes: 1_000_000,
    },
  };
}

function mutationCommand(): ToolExecutionCommand {
  const input = "{}";
  const actionIntent = {
    schemaVersion: "crewon.action-intent.v0" as const,
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    tool: {
      kind: "function" as const,
      name: "mcp__remote__create_record",
      inputDigest: sha256(input),
    },
    policySnapshotId: "policy-1",
    workspaceBindingId: "workspace-1",
    ...policy(),
  };
  return {
    schemaVersion: "crewon.tool-invocation.v0",
    executionId: "execution-1",
    executionLease: {
      workItemId: "work-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    actionDigest: sha256(canonicalActionIntent(actionIntent)),
    actionIntent,
    approvalProof: null,
    idempotencyKey: "run-1/tool/call-1",
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    kind: "function",
    name: "mcp__remote__create_record",
    input,
  };
}

function agentSource() {
  return {
    schemaVersion: "crewon.agent-version-source.v0" as const,
    agentVersionId: "agent-version-1",
    runtimeGeneration: "ts-v0",
    policySnapshotId: "policy-1",
    instructions: null,
    model: {
      adapterName: "direct-responses",
      adapterVersion: "1",
      modelId: "model-1",
      contextWindowTokens: 128_000,
      autoCompactAtTokens: 96_000,
    },
    execution: { streamMaxRetries: 0, maxToolRounds: 16 },
    resources: { workspaceRequired: true, governedContextDigest: null },
    tools: [],
  };
}

function nativeV3Envelope() {
  const privateKey =
    "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----";
  const certificate =
    "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----";
  return {
    schemaVersion: "crewon.worker-native-bootstrap.v3",
    provider: null,
    apiKey: null,
    probe: { port: 3211, token: "worker-private-token" },
    workspace: {
      privateServer: {
        port: 0,
        token: "workspace-private-token-at-least-32-bytes",
      },
      authority: {
        tenantId: "tenant-1",
        spaceId: "space-1",
        workspaceBindingId: "workspace-1",
        incarnationId: "incarnation-1",
        deviceBindingId: "device-binding-1",
        deviceId: "device-1",
        runtimeBindingId: "runtime-generation-1",
        policySnapshotId: "policy-1",
      },
      signing: { keyId: "workspace-key-1", privateKeyPem: privateKey },
      gateway: {
        endpoint: "https://gateway.example/",
        deadlineMs: 35_000,
        tls: {
          keyPem: privateKey,
          certificatePem: certificate,
          caCertificatePem: certificate,
          servername: "gateway.example",
        },
      },
    },
    credentialBindings: {
      schemaVersion: "crewon.remote-mcp-private-credentials.v1",
      authority: {
        tenantId: "tenant-1",
        workspaceBindingId: "workspace-1",
        runtimeBindingId: "runtime-generation-1",
        agentVersionId: "agent-version-1",
      },
      bindings: [{ credentialBindingId: "credential-1", bearerToken: SECRET }],
    },
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}
