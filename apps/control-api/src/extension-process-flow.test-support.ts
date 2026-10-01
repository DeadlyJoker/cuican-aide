import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

export const EXTENSION_PROCESS_ACTOR = {
  principalId: "extension-process-principal",
  actorId: "extension-process-actor",
  tenantId: "extension-process-tenant",
  spaceId: "extension-process-space",
};
export const EXTENSION_PROCESS_DEFAULT_AGENT =
  "extension-process-default-agent";
export const EXTENSION_PROCESS_PLUGIN_AGENT = "extension-process-comfy-agent";
export const EXTENSION_PROCESS_PLUGIN_TEXT =
  "Plugin task admission verified. No image was generated.";
export const EXTENSION_PROCESS_DEFAULT_TEXT =
  "Default Agent behavior is unchanged.";
export const EXTENSION_PROCESS_TOKEN =
  "extension-process-worker-private-token-0001";
const SESSION = "extension-process-session-token-00001";
const CSRF = "extension-process-csrf-token-0000001";
const ORIGIN = "http://127.0.0.1:5175";
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export type ProcessResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;
export type OwnedExtensionProcess = Readonly<{
  child: ChildProcessWithoutNullStreams;
  completion: Promise<ProcessResult>;
  stdout(): string;
  stderr(): string;
  finished(): boolean;
}>;

export async function freeExtensionProcessPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

export async function extensionProcessFixture(context: TestContext) {
  assert.match(process.version, /^v24\./u);
  const root = mkdtempSync(join(tmpdir(), "crewon-extension-process-"));
  const databasePath = join(root, "control.sqlite");
  const encryptionKeyPath = join(root, "artifact-fixture-key");
  writeFileSync(encryptionKeyPath, Buffer.alloc(32, 42), { mode: 0o600 });
  const requests: Record<string, unknown>[] = [];
  const modelServer = createServer(async (request, response) => {
    assert.equal(request.url, "/v1/responses");
    assert.equal(request.headers.authorization, undefined);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
    requests.push(input);
    const tools = input.tools as readonly { name?: string }[] | undefined;
    const text = tools?.some(
      ({ name }) => name === "crewon_comfyui_krea2__submit",
    )
      ? EXTENSION_PROCESS_PLUGIN_TEXT
      : EXTENSION_PROCESS_DEFAULT_TEXT;
    const id = `fixture-response-${requests.length}`;
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
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    );
  });
  await new Promise<void>((resolve, reject) => {
    modelServer.once("error", reject);
    modelServer.listen(0, "127.0.0.1", resolve);
  });
  const address = modelServer.address();
  assert.ok(address !== null && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/v1/responses`;
  const children = new Set<OwnedExtensionProcess>();
  const environment: NodeJS.ProcessEnv = {
    PATH: dirname(process.execPath),
    NODE_NO_WARNINGS: "1",
    TZ: "UTC",
    CREWON_CONTROL_SECURITY_MODE: "standalone",
    CREWON_CONTROL_DB_PATH: databasePath,
    CREWON_PRINCIPAL_ID: EXTENSION_PROCESS_ACTOR.principalId,
    CREWON_ACTOR_ID: EXTENSION_PROCESS_ACTOR.actorId,
    CREWON_TENANT_ID: EXTENSION_PROCESS_ACTOR.tenantId,
    CREWON_SPACE_ID: EXTENSION_PROCESS_ACTOR.spaceId,
    CREWON_RELEASE_PRINCIPAL_ID: EXTENSION_PROCESS_ACTOR.principalId,
    CREWON_RELEASE_ACTOR_ID: EXTENSION_PROCESS_ACTOR.actorId,
    CREWON_MODEL_ADAPTER: "responses",
    CREWON_MODEL_ID: "extension-fixture-model",
    CREWON_MODEL_CREDENTIAL_REQUIRED: "0",
    CREWON_RESPONSES_ENDPOINT: endpoint,
    CREWON_RESPONSES_STORE: "false",
    CREWON_RESPONSES_IDLE_TIMEOUT_MS: "5000",
    CREWON_AGENT_VERSION_ID: EXTENSION_PROCESS_DEFAULT_AGENT,
    CREWON_AUTHORITY_ID: "extension-process-default-authority",
    CREWON_RUNTIME_GENERATION: "ts-v0",
    CREWON_POLICY_SNAPSHOT_ID: "extension-process-default-policy",
    CREWON_AGENT_INSTRUCTIONS:
      "Default fixture assistant. Return the verified fixture text.",
    CREWON_RESPONSES_STREAM_MAX_RETRIES: "0",
    CREWON_WORKER_SCAN_INTERVAL_MS: "25",
    CREWON_WORKER_RETRY_AFTER_MS: "0",
    CREWON_WORKER_OWNER_ID: "extension-process-worker",
    CREWON_CONTROL_SESSION_TOKEN: SESSION,
    CREWON_CONTROL_CSRF_TOKEN: CSRF,
    CREWON_CONTROL_ALLOWED_ORIGINS: ORIGIN,
    CREWON_OUTBOX_SCAN_INTERVAL_MS: "25",
    CREWON_OUTBOX_RETENTION_MS: "off",
    CREWON_ARTIFACT_RETENTION: "off",
    CREWON_ARTIFACT_ROOT: join(root, "artifacts"),
    CREWON_ARTIFACT_DB_PATH: join(root, "artifacts.sqlite"),
    CREWON_ARTIFACT_ENCRYPTION_KEY_PATH: encryptionKeyPath,
    CREWON_ARTIFACT_ENCRYPTION_KEY_ID: "extension-process-fixture-key",
  };
  const start = (
    entry: "control" | "worker" | "release",
    changes: NodeJS.ProcessEnv = {},
  ) => {
    const path =
      entry === "control"
        ? join(REPOSITORY_ROOT, "apps/control-api/src/main.ts")
        : join(
            REPOSITORY_ROOT,
            `apps/runtime-worker/src/${entry === "release" ? "release-main" : "main"}.ts`,
          );
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", path],
      {
        cwd: REPOSITORY_ROOT,
        env: { ...environment, ...changes },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stdin.end();
    let stdout = "",
      stderr = "",
      finished = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 128 * 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 128 * 1024) child.kill("SIGKILL");
    });
    const completion = new Promise<ProcessResult>((resolve, reject) => {
      child.once("error", (error) => {
        finished = true;
        reject(error);
      });
      child.once("close", (code, signal) => {
        finished = true;
        resolve({ code, signal });
      });
    });
    void completion.catch(() => undefined);
    const processOwner: OwnedExtensionProcess = {
      child,
      completion,
      stdout: () => stdout,
      stderr: () => stderr,
      finished: () => finished,
    };
    children.add(processOwner);
    return processOwner;
  };
  const stop = async (processOwner: OwnedExtensionProcess) => {
    if (!processOwner.finished()) processOwner.child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        processOwner.completion,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            processOwner.child.kill("SIGKILL");
            reject(new Error("extension_fixture_process_close_timeout"));
          }, 10_000);
        }),
      ]);
      children.delete(processOwner);
      return result;
    } catch (error) {
      processOwner.child.kill("SIGKILL");
      await processOwner.completion;
      children.delete(processOwner);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  context.after(async () => {
    let results: PromiseSettledResult<ProcessResult>[] = [];
    try {
      results = await Promise.allSettled([...children].map(stop));
    } finally {
      modelServer.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        modelServer.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(root, { recursive: true, force: true });
    }
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0)
      throw new AggregateError(errors, "extension_fixture_cleanup_failed");
  });
  return { root, databasePath, endpoint, requests, environment, start, stop };
}

export async function waitForExtensionProcess(
  processOwner: OwnedExtensionProcess,
  marker: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!processOwner.stdout().includes(marker)) {
    assert.equal(
      processOwner.finished(),
      false,
      processOwner.stderr() || processOwner.stdout(),
    );
    assert.ok(
      Date.now() < deadline,
      `Process readiness timed out: ${processOwner.stderr()}`,
    );
    await delay(25);
  }
}

export async function completeExtensionProcess(
  processOwner: OwnedExtensionProcess,
): Promise<ProcessResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      processOwner.completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          processOwner.child.kill("SIGKILL");
          reject(
            new Error(`Process completion timed out: ${processOwner.stderr()}`),
          );
        }, 20_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function extensionProcessHeaders(
  idempotencyKey?: string,
): Record<string, string> {
  return {
    "authorization": `Bearer ${SESSION}`,
    "origin": ORIGIN,
    "x-csrf-token": CSRF,
    "content-type": "application/json",
    ...(idempotencyKey === undefined
      ? {}
      : { "idempotency-key": idempotencyKey }),
  };
}

export async function extensionProcessJson<T>(
  origin: string,
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: extensionProcessHeaders(key),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: (await response.json()) as T };
}
