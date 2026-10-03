import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  TEST_CA_CERT,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";

export const installedProcessActor = Object.freeze({
  principalId: "installed-process-principal",
  actorId: "installed-process-actor",
  tenantId: "installed-process-tenant",
  spaceId: "installed-process-space",
});
export const installedProcessScope = Object.freeze({
  tenantId: installedProcessActor.tenantId,
  spaceId: installedProcessActor.spaceId,
  profileId: "installed-process-profile",
});
export const installedProcessDefaultAgent = "installed-process-default-agent";
const serviceToken = "installed-process-authority-token-000001";
const repository = fileURLToPath(new URL("../../..", import.meta.url));

type Result = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;
export type InstalledProcessChild = Readonly<{
  child: ChildProcessWithoutNullStreams;
  completion: Promise<Result>;
  stdout(): string;
  stderr(): string;
  finished(): boolean;
}>;
type AuthorityRequest = Readonly<{
  path: string;
  body: Record<string, unknown>;
}>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function installedProcessCompletion(child: InstalledProcessChild) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `installed_process_timeout\n${child.stdout()}\n${child.stderr()}`,
              ),
            ),
          15_000,
        );
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function removeOwned(directory: string) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await removeOwned(join(directory, entry.name));
  await rm(directory, { recursive: true, force: true });
}

/** Actual TLS authority and Responses servers. Their identities and decisions are explicitly test fixtures. */
export async function installedWorkerProcessFixture(t: TestContext) {
  assert.match(process.version, /^v24\./u);
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-installed-worker-process-"),
  );
  const databasePath = join(directory, "control.sqlite");
  const caPath = join(directory, "test-authority-ca.pem");
  await writeFile(caPath, TEST_CA_CERT, { mode: 0o600 });
  const authorityRequests: AuthorityRequest[] = [];
  const modelRequests: Record<string, unknown>[] = [];
  const failures: unknown[] = [];
  let packageDecision: "allow" | "deny" = "allow";
  let packageExecutionAllowed = true;
  let executionAllowed = true;
  let wrongPrincipal = false;
  let wrongProfile = false;
  let pendingHold: ReturnType<typeof deferred> | null = null;
  let heldClosed: ReturnType<typeof deferred> | null = null;
  const authority = createHttpsServer(
    { key: TEST_SERVER_KEY, cert: TEST_SERVER_CERT, minVersion: "TLSv1.3" },
    (request, response) => {
      void (async () => {
        assert.equal(request.method, "POST");
        assert.equal(request.headers.authorization, `Bearer ${serviceToken}`);
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += Buffer.byteLength(chunk);
          assert.ok(bytes <= 128 * 1024);
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as Record<string, unknown>;
        const path = request.url!;
        authorityRequests.push({ path, body });
        response.setHeader("content-type", "application/json");
        if (path === "/package" && pendingHold !== null) {
          response.once("close", heldClosed!.resolve);
          response.write('{"outcome":');
          pendingHold.resolve();
          pendingHold = null;
          return;
        }
        let value: unknown;
        switch (path) {
          case "/package":
            assert.equal(
              body.schemaVersion,
              "crewon.plugin-execution-package.v1",
            );
            assert.deepEqual(body.scope, installedProcessScope);
            assert.ok(
              ["read", "submit", "observe"].includes(body.purpose as string),
            );
            value = {
              outcome:
                body.purpose !== "read" && !packageExecutionAllowed
                  ? "deny"
                  : packageDecision,
            };
            break;
          case "/actor":
            assert.equal(
              body.schemaVersion,
              "crewon.plugin-execution-actor.v1",
            );
            assert.deepEqual(body.owner, {
              tenantId: installedProcessActor.tenantId,
              spaceId: installedProcessActor.spaceId,
              actorId: installedProcessActor.actorId,
            });
            value = wrongPrincipal
              ? {
                  ...installedProcessActor,
                  principalId: "unrelated-test-principal",
                }
              : installedProcessActor;
            break;
          case "/profile":
            assert.deepEqual(body.actor, installedProcessActor);
            value = wrongProfile
              ? {
                  ...installedProcessScope,
                  profileId: "unrelated-test-profile",
                }
              : installedProcessScope;
            break;
          case "/policy":
            assert.deepEqual(body.actor, installedProcessActor);
            value = { outcome: executionAllowed ? "allow" : "deny" };
            break;
          default:
            throw new Error("unknown_test_authority_route");
        }
        response.end(JSON.stringify(value));
      })().catch((error: unknown) => {
        failures.push(error);
        response.statusCode = 500;
        response.end('{"fixture":"failed"}');
      });
    },
  );
  const model = createHttpServer((request, response) => {
    void (async () => {
      assert.equal(request.url, "/v1/responses");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      modelRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "text/event-stream" });
      const id = `installed-model-fixture-${modelRequests.length}`;
      const current = modelRequests.at(-1)!;
      const professional = (current.tools as { name: string }[]).some(
        (tool) => tool.name === "example_professional__generate",
      );
      const result = [...(current.input as Record<string, unknown>[])]
        .reverse()
        .find((item) => item.type === "function_call_output");
      if (professional && result === undefined) {
        const call = {
          id: `${id}-call`,
          type: "function_call",
          call_id: `${id}-call`,
          name: "example_professional__generate",
          arguments: JSON.stringify({
            subject: "Actual formal Worker fixture report",
          }),
          status: "completed",
        };
        response.end(
          [
            {
              type: "response.created",
              sequence_number: 0,
              response: { id, status: "in_progress", output: [] },
            },
            {
              type: "response.output_item.done",
              sequence_number: 1,
              output_index: 0,
              item: call,
            },
            {
              type: "response.completed",
              sequence_number: 2,
              response: {
                id,
                status: "completed",
                output: [call],
                usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
              },
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
        );
        return;
      }
      const text = professional
        ? `answer:${(JSON.parse(result!.output as string) as { report: string }).report}`
        : "Original default Agent executed through the formal Worker.";
      const message = {
        id: `${id}-message`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      };
      const events = [
        {
          type: "response.created",
          sequence_number: 0,
          response: { id, status: "in_progress", output: [] },
        },
        {
          type: "response.output_text.delta",
          sequence_number: 1,
          item_id: message.id,
          output_index: 0,
          content_index: 0,
          delta: text,
        },
        {
          type: "response.output_item.done",
          sequence_number: 2,
          output_index: 0,
          item: message,
        },
        {
          type: "response.completed",
          sequence_number: 3,
          response: {
            id,
            status: "completed",
            output: [message],
            usage: {
              input_tokens: 5,
              output_tokens: 2,
              total_tokens: 7,
              input_tokens_details: { cached_tokens: 0 },
            },
          },
        },
      ];
      response.end(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      );
    })().catch((error: unknown) => {
      failures.push(error);
      response.statusCode = 500;
      response.end();
    });
  });
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      authority.once("error", reject);
      authority.listen(0, "127.0.0.1", resolve);
    }),
    new Promise<void>((resolve, reject) => {
      model.once("error", reject);
      model.listen(0, "127.0.0.1", resolve);
    }),
  ]);
  const authorityAddress = authority.address(),
    modelAddress = model.address();
  assert.ok(authorityAddress && typeof authorityAddress !== "string");
  assert.ok(modelAddress && typeof modelAddress !== "string");
  const endpoint = `http://127.0.0.1:${modelAddress.port}/v1/responses`;
  const authorityOrigin = `https://localhost:${authorityAddress.port}`;
  const children = new Set<InstalledProcessChild>();
  const environment: NodeJS.ProcessEnv = {
    PATH: dirname(process.execPath),
    NODE_NO_WARNINGS: "1",
    TZ: "UTC",
    NODE_EXTRA_CA_CERTS: caPath,
    CREWON_CONTROL_SECURITY_MODE: "standalone",
    CREWON_CONTROL_DB_PATH: databasePath,
    CREWON_PRINCIPAL_ID: installedProcessActor.principalId,
    CREWON_ACTOR_ID: installedProcessActor.actorId,
    CREWON_TENANT_ID: installedProcessActor.tenantId,
    CREWON_SPACE_ID: installedProcessActor.spaceId,
    CREWON_RELEASE_PRINCIPAL_ID: installedProcessActor.principalId,
    CREWON_RELEASE_ACTOR_ID: installedProcessActor.actorId,
    CREWON_MODEL_ADAPTER: "responses",
    CREWON_MODEL_ID: "installed-process-fixture-model",
    CREWON_MODEL_CREDENTIAL_REQUIRED: "0",
    CREWON_RESPONSES_ENDPOINT: endpoint,
    CREWON_RESPONSES_STORE: "false",
    CREWON_RESPONSES_IDLE_TIMEOUT_MS: "5000",
    CREWON_AGENT_VERSION_ID: installedProcessDefaultAgent,
    CREWON_AUTHORITY_ID: "installed-process-default-authority",
    CREWON_RUNTIME_GENERATION: "ts-v0",
    CREWON_POLICY_SNAPSHOT_ID: "installed-process-default-policy",
    CREWON_AGENT_INSTRUCTIONS: "Keep the original default Agent behavior.",
    CREWON_RESPONSES_STREAM_MAX_RETRIES: "0",
    CREWON_MODEL_CONTEXT_WINDOW_TOKENS: "32000",
    CREWON_AUTO_COMPACT_AT_TOKENS: "20000",
    CREWON_WORKER_ONCE: "1",
    INSTALLED_PROCESS_AUTHORITY_TOKEN: serviceToken,
  };
  const start = (
    entry: "worker" | "release",
    changes: NodeJS.ProcessEnv = {},
  ) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        join(
          repository,
          `apps/runtime-worker/src/${entry === "release" ? "release-main" : "main"}.ts`,
        ),
      ],
      {
        cwd: repository,
        env: { ...environment, ...changes },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stdin.end();
    let stdout = "",
      stderr = "",
      finished = false;
    const capture = (channel: "stdout" | "stderr", chunk: Buffer) => {
      if (channel === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 128 * 1024)
        child.kill("SIGKILL");
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    const completion = new Promise<Result>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        finished = true;
        resolve({ code, signal });
      });
    });
    const owned = {
      child,
      completion,
      stdout: () => stdout,
      stderr: () => stderr,
      finished: () => finished,
    };
    children.add(owned);
    return owned;
  };
  t.after(async () => {
    try {
      for (const child of children) {
        if (!child.finished()) child.child.kill("SIGTERM");
        const closed = await Promise.race([
          child.completion.then(
            () => true,
            () => true,
          ),
          delay(5000, undefined, { ref: false }).then(() => false),
        ]);
        if (!closed) {
          child.child.kill("SIGKILL");
          await child.completion;
        }
      }
      authority.closeAllConnections();
      model.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => authority.close(() => resolve())),
        new Promise<void>((resolve) => model.close(() => resolve())),
      ]);
      assert.deepEqual(failures, []);
    } finally {
      await removeOwned(directory);
    }
  });
  return {
    directory,
    databasePath,
    endpoint,
    environment,
    start,
    authorityRequests,
    modelRequests,
    configPath: join(directory, "worker-plugin.json"),
    releaseDocumentPath: join(directory, "installed-release.json"),
    installRoot: join(directory, "installed"),
    configuration(timeoutMs = 5000) {
      const authority = (path: string) => ({
        url: `${authorityOrigin}/${path}`,
        serviceTokenEnvironmentVariable: "INSTALLED_PROCESS_AUTHORITY_TOKEN",
      });
      return {
        schemaVersion: "crewon.installed-plugin-worker.v1",
        installRoot: join(directory, "installed"),
        releaseDocumentPath: join(directory, "installed-release.json"),
        actorAuthority: authority("actor"),
        policyAuthority: authority("policy"),
        profileAuthority: authority("profile"),
        packageAuthority: authority("package"),
        networkAuthority: null,
        historicalScope: installedProcessScope,
        timeoutMs,
      };
    },
    denyPackages() {
      packageDecision = "deny";
    },
    denyExecution() {
      executionAllowed = false;
    },
    denyPackageExecution() {
      packageExecutionAllowed = false;
    },
    returnWrongPrincipal() {
      wrongPrincipal = true;
    },
    returnWrongProfile() {
      wrongProfile = true;
    },
    holdPackageResponse() {
      pendingHold = deferred();
      heldClosed = deferred();
      return { started: pendingHold.promise, closed: heldClosed.promise };
    },
  };
}

export type InstalledWorkerProcessFixture = Awaited<
  ReturnType<typeof installedWorkerProcessFixture>
>;
