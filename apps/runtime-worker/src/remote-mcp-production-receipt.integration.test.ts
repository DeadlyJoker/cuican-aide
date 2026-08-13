import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer, type Server } from "node:https";
import { inspect } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { compileAgentVersion } from "@crewon/agent-version";
import { canonicalActionIntent } from "@crewon/contracts";
import type { ToolExecutionCommand } from "@crewon/tool-broker";

import {
  loadAgentVersionRuntimeFactory,
  loadRemoteMcpManifestBindings,
} from "./runtime-binding-config.ts";
import { takeRuntimeNativeBootstrap } from "./runtime-native-bootstrap.ts";
import { createRuntimeNativeRemoteMcpOwner } from "./runtime-native-remote-mcp.ts";
import type { PinnedHttpPort } from "./pinned-node-http.ts";
import { PinnedNodeHttpTransport } from "./pinned-node-http.ts";
import {
  TEST_CA_CERT,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";

const SECRET = "remote-mcp-production-secret-sentinel";
const PACKAGED_GATE_CHILD = "CREWON_REMOTE_MCP_PACKAGED_GATE_CHILD";

if (process.env[PACKAGED_GATE_CHILD] === "1") {
  // The packaged sidecar intentionally remains plain JavaScript for Node startup.
  const { readAndInstallRuntimeNativeBootstrap } = await import(
    // @ts-ignore no declaration file is shipped for the sidecar module
    "../../crewon-ui/src-tauri/sidecars/runtime-worker-bootstrap.mjs"
  );
  await readAndInstallRuntimeNativeBootstrap();
}

test("released production composition transport gate reconciles a remote receipt exactly once", async (t) => {
  if (process.env[PACKAGED_GATE_CHILD] !== "1") {
    await runPackagedGateChild(t);
    return;
  }
  const remote = await ControlledTlsRemoteReceiptServer.listen(t);
  const paths = releasedManifests(t, remote.endpoint.href);
  const identities = loadRemoteMcpManifestBindings(paths.bindingPath);
  assert.equal(identities.length, 1);

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
      transport: remote.transport,
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
  for (const path of [paths.bindingPath, paths.remotePath]) {
    const released = readFileSync(path, "utf8");
    assert.doesNotMatch(released, /8\.8\.8\.8|127\.0\.0\.1/u);
  }
  assert.deepEqual(remote.protocols, ["TLSv1.3", "TLSv1.3"]);
  assert.deepEqual(remote.serverNames, ["localhost", "localhost"]);
  assert.deepEqual(remote.admittedPorts, [
    remote.endpoint.port,
    remote.endpoint.port,
  ]);
  assert.deepEqual(remote.admittedAddresses, ["8.8.8.8", "8.8.8.8"]);
});

async function runPackagedGateChild(t: TestContext): Promise<void> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    [PACKAGED_GATE_CHILD]: "1",
  };
  delete environment["NODE_TEST_CONTEXT"];
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", fileURLToPath(import.meta.url)],
    {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  child.stdin.end(`${JSON.stringify(nativeCredentialEnvelope())}\n`);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const output = `${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`;
  assert.equal(code, 0, output);
  assert.match(output, /pass 1/u);
  assert.doesNotMatch(output, new RegExp(SECRET, "u"));
}

class ControlledTlsRemoteReceiptServer {
  readonly #receipts = new Map<string, string>();
  readonly #server: Server;
  readonly endpoint: URL;
  readonly transport: PinnedHttpPort;
  readonly phases: string[] = [];
  readonly authorizations: string[] = [];
  readonly idempotencyKeys: string[] = [];
  readonly bodies: unknown[] = [];
  readonly protocols: Array<string | null> = [];
  readonly serverNames: Array<string | false | null> = [];
  readonly admittedPorts: string[] = [];
  readonly admittedAddresses: string[] = [];
  executeCount = 0;

  private constructor(server: Server, endpoint: URL) {
    this.#server = server;
    this.endpoint = endpoint;
    const network = new PinnedNodeHttpTransport({
      certificateAuthority: TEST_CA_CERT,
    });
    this.transport = {
      request: (input, signal) => {
        this.admittedPorts.push(input.target.endpoint.port);
        this.admittedAddresses.push(input.target.address);
        assert.equal(input.target.endpoint.href, this.endpoint.href);
        assert.equal(input.target.endpoint.pathname, "/mutations");
        assert.equal(input.target.address, "8.8.8.8");
        assert.equal(input.target.family, 4);
        assert.equal(input.maxRequestBytes, 256 * 1024);
        assert.equal(input.maxResponseBytes, 256 * 1024);
        return network.request(
          {
            ...input,
            target: { ...input.target, address: "127.0.0.1" },
          },
          signal,
        );
      },
    };
  }

  static async listen(
    t: TestContext,
  ): Promise<ControlledTlsRemoteReceiptServer> {
    let fixture: ControlledTlsRemoteReceiptServer | undefined;
    const server = createHttpsServer(
      {
        key: TEST_SERVER_KEY,
        cert: TEST_SERVER_CERT,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
      },
      (request, response) => fixture?.handle(request, response),
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("remote_mcp_tls_test_address_invalid");
    fixture = new ControlledTlsRemoteReceiptServer(
      server,
      new URL(`https://localhost:${address.port}/mutations`),
    );
    t.after(() => fixture?.close());
    return fixture;
  }

  private handle(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ): void {
    assert.equal(request.method, "POST");
    const socket = request.socket as TLSSocket;
    this.protocols.push(socket.getProtocol());
    this.serverNames.push(socket.servername);
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const encoded = Buffer.concat(chunks);
      assert.ok(encoded.byteLength <= 256 * 1024);
      const body = JSON.parse(encoded.toString("utf8")) as {
        phase: "execute" | "reconcile";
        providerExecutionId: string;
        toolName: string;
      };
      this.phases.push(body.phase);
      this.bodies.push(body);
      this.authorizations.push(request.headers.authorization ?? "");
      this.idempotencyKeys.push(String(request.headers["idempotency-key"]));
      if (body.phase === "execute") {
        this.executeCount += 1;
        this.#receipts.set(
          body.providerExecutionId,
          `receipt:${body.providerExecutionId}`,
        );
        socket.destroy();
        return;
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
      assert.ok(responseBody.byteLength <= 256 * 1024);
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": responseBody.byteLength,
      });
      response.end(responseBody);
    });
  }

  private async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => (error ? reject(error) : resolve()));
    });
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
            idleTimeoutMs: 60_000,
            sequencePolicy: "required",
          },
          mcpStdioConfigPath: null,
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

function nativeCredentialEnvelope() {
  const privateKey =
    "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----";
  return {
    schemaVersion: "crewon.worker-native-bootstrap.v4",
    provider: null,
    apiKey: null,
    probe: { port: 3211, token: "worker-private-token" },
    workspace: {
      trustedLocalPath: process.cwd(),
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
      deadlineMs: 35_000,
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
