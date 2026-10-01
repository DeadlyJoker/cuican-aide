#!/usr/bin/env node
/** Real model + existing CrewON release/Run/Worker diagnostic; not a product admission API. */
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { DirectResponsesTransport } from "../packages/agent-responses/src/index.ts";
import {
  RunApplicationService,
  ThreadApplicationService,
} from "../packages/application/src/index.ts";
import {
  SqliteRunStore,
  SqliteExternalOperationStore,
  migrateSqliteExternalOperations,
} from "../packages/store/src/index.ts";
import { activateStandaloneRuntimeAgentVersionRelease } from "../apps/runtime-worker/src/agent-version-release-composition.ts";
import {
  compileRuntimeAgentVersion,
  createStandaloneRuntimeWorker,
} from "../apps/runtime-worker/src/standalone-composition.ts";
import {
  ProductionComfyHttp,
  comfyServiceUrl,
} from "../apps/runtime-worker/src/extensions/comfyui-http.ts";
import { ComfyToolRuntime } from "../apps/runtime-worker/src/extensions/comfyui-tool-runtime.ts";

const INSTRUCTIONS = `You operate the image generation tools for this one task.
Use the user's visual description as the image prompt. Submit exactly once using crewon_comfyui_krea2__submit.
An accepted submission is not a generated image. Keep the returned operationId and call crewon_comfyui_krea2__observe to inspect it.
If queued or running, query that same operation again, up to eight observations. Never call submit again, even if a result is uncertain or recovery happened.
If succeeded, return the verified image URL using Markdown image syntax and briefly describe the result in Chinese.
If still pending, failed, or unknown, report the actual status and operationId. Never fabricate success, images, URLs, or task IDs.
Do not use any other tools. Do not repeat the operation ID or internal implementation details when an image has succeeded.`;

const { values } = parseArgs({
  options: {
    "output-dir": { type: "string" },
    "base-url": { type: "string" },
    "model-endpoint": { type: "string" },
    "model-id": { type: "string" },
    "api-key-environment": { type: "string" },
    "env-file": { type: "string" },
    "request-profile": { type: "string", default: "responsesLite" },
    "prompt": { type: "string" },
    "resume": { type: "boolean", default: false },
    "pause-after-submit": { type: "boolean", default: false },
  },
});

const outputDir = resolve(required(values["output-dir"], "output-dir"));
await mkdir(outputDir, { recursive: true, mode: 0o700 });
if (values["env-file"]) process.loadEnvFile(resolve(values["env-file"]));
const snapshotPath = join(outputDir, "agent-flow.json");
const databasePath = join(outputDir, "control.sqlite");
const implementationDigest = await implementationIdentity();
let snapshot;
if (values.resume) {
  if (
    values.prompt ||
    values["base-url"] ||
    values["model-endpoint"] ||
    values["model-id"] ||
    values["api-key-environment"]
  )
    throw new Error("resume_uses_immutable_saved_configuration");
  if ((await stat(snapshotPath)).size > 32_768)
    throw new Error("saved_configuration_too_large");
  snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  if (
    snapshot.schemaVersion !== "crewon.comfy-agent-diagnostic.v0" ||
    snapshot.implementationDigest !== implementationDigest
  )
    throw new Error("diagnostic_implementation_changed");
  const { bindingDigest, ...content } = snapshot;
  if (bindingDigest !== sha256(JSON.stringify(content)))
    throw new Error("saved_configuration_digest_mismatch");
  await stat(databasePath);
} else {
  for (const file of [snapshotPath, databasePath]) {
    if (
      await stat(file).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      })
    )
      throw new Error("diagnostic_already_exists_use_resume");
  }
  const modelEndpoint = new URL(
    required(values["model-endpoint"], "model-endpoint"),
  );
  if (
    modelEndpoint.protocol !== "https:" ||
    modelEndpoint.username ||
    modelEndpoint.password ||
    modelEndpoint.search ||
    modelEndpoint.hash
  )
    throw new Error("model_endpoint_invalid");
  const credentialEnvironment = required(
    values["api-key-environment"],
    "api-key-environment",
  );
  if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(credentialEnvironment))
    throw new Error("credential_environment_invalid");
  const prompt = required(values.prompt, "prompt");
  if (prompt.length > 2_000) throw new Error("prompt_too_large");
  const runId = randomUUID();
  const content = {
    schemaVersion: "crewon.comfy-agent-diagnostic.v0",
    implementationDigest,
    runId,
    threadId: randomUUID(),
    tenantId: "comfy-diagnostic-tenant",
    spaceId: "comfy-diagnostic-space",
    actorId: "comfy-diagnostic-actor",
    principalId: "comfy-diagnostic-principal",
    bindingId: `comfy-${runId}`,
    agentVersionId: `comfy-agent-${runId}`,
    baseUrl: comfyServiceUrl(required(values["base-url"], "base-url")),
    modelEndpoint: modelEndpoint.href,
    modelId: required(values["model-id"], "model-id"),
    credentialEnvironment,
    requestProfile: values["request-profile"],
    prompt,
  };
  snapshot = { ...content, bindingDigest: sha256(JSON.stringify(content)) };
}
const apiKey = process.env[snapshot.credentialEnvironment];
if (!apiKey?.trim()) throw new Error("model_credential_unavailable");
const transport = new DirectResponsesTransport({
  endpoint: snapshot.modelEndpoint,
  model: snapshot.modelId,
  apiKey,
  requestProfile: snapshot.requestProfile,
  storeResponses: false,
  sequencePolicy: "whenPresent",
  idleTimeoutMs: 60_000,
});
if (!values.resume)
  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
const operationDatabase = new DatabaseSync(databasePath);
operationDatabase.exec(
  "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
);
migrateSqliteExternalOperations(operationDatabase);
const network = new ProductionComfyHttp({
  baseUrl: snapshot.baseUrl,
  tenantId: snapshot.tenantId,
  bindingId: snapshot.bindingId,
});
const tools = new ComfyToolRuntime({
  scope: {
    tenantId: snapshot.tenantId,
    runId: snapshot.runId,
    bindingDigest: snapshot.bindingDigest,
  },
  bindingId: snapshot.bindingId,
  baseUrl: snapshot.baseUrl,
  store: new SqliteExternalOperationStore(operationDatabase),
  // Only this isolated diagnostic's explicitly requested image is authorized here.
  approvalRequirement: "none",
  http: {
    request: async (input) => {
      await appendFile(
        join(outputDir, "comfy-http.jsonl"),
        JSON.stringify({
          at: new Date().toISOString(),
          method: input.method,
          path: input.path,
        }) + "\n",
        { mode: 0o600 },
      );
      return network.request(input);
    },
  },
});
const actor = {
  tenantId: snapshot.tenantId,
  spaceId: snapshot.spaceId,
  actorId: snapshot.actorId,
  principalId: snapshot.principalId,
};
const route = {
  authorityId: "comfy-diagnostic-authority",
  runtimeGeneration: "ts-v0",
  agentVersionId: snapshot.agentVersionId,
  policySnapshotId: "comfy-diagnostic-policy",
  workspaceBindingId: null,
};
const config = {
  databasePath,
  runtimeTenantId: snapshot.tenantId,
  route,
  transport,
  toolRuntime: tools,
  agentInstructions: INSTRUCTIONS,
  streamMaxRetries: 0,
  maxToolRounds: 12,
  modelContextWindowTokens: 128_000,
  autoCompactAtTokens: null,
  scanIntervalMs: null,
  retryAfterMs: 0,
  leaseDurationMs: 120_000,
  afterToolProviderResolved: async (resolution) => {
    if (
      values["pause-after-submit"] &&
      resolution.status === "completed" &&
      !resolution.result.isError
    ) {
      const output = JSON.parse(resolution.result.output);
      if (output.submission === "accepted")
        throw new Error("diagnostic_pause_after_submit");
    }
  },
};
const version = compileRuntimeAgentVersion(config);
const clock = { now: () => new Date().toISOString() };
const authorization = {
  authorize: async ({ actor: caller, resource }) =>
    caller.tenantId === actor.tenantId &&
    caller.spaceId === actor.spaceId &&
    caller.actorId === actor.actorId &&
    resource.tenantId === actor.tenantId &&
    resource.spaceId === actor.spaceId
      ? { outcome: "allow" }
      : { outcome: "deny", reasonCode: "diagnostic_scope_mismatch" },
};
let runtime;
let authority;
let timer;
try {
  if (!values.resume) {
    await activateStandaloneRuntimeAgentVersionRelease({
      ...config,
      actor,
      authorization,
      clock,
      activationId: `release-${snapshot.runId}`,
    });
    authority = new SqliteRunStore(databasePath);
    const ids = {
      nextId: (kind) =>
        kind === "run"
          ? snapshot.runId
          : kind === "thread"
            ? snapshot.threadId
            : randomUUID(),
    };
    const threads = new ThreadApplicationService({
      store: authority,
      authorization,
      clock,
      ids,
      digester: { sha256 },
    });
    await threads.createThread(actor, {
      kind: "thread.create",
      idempotencyKey: "image-thread",
      title: "ComfyUI 真实 Agent 联调",
    });
    await threads.appendMessage(actor, {
      kind: "thread.message.append",
      idempotencyKey: "image-prompt",
      threadId: snapshot.threadId,
      expectedRevision: 1,
      role: "user",
      content: snapshot.prompt,
    });
    await new RunApplicationService({
      store: authority,
      authorization,
      clock,
      ids,
    }).createRun(actor, {
      kind: "run.create",
      idempotencyKey: "image-run",
      threadId: snapshot.threadId,
      route,
    });
    await authority.close();
    authority = undefined;
  }
  runtime = await createStandaloneRuntimeWorker(config);
  console.log(
    JSON.stringify({
      stage: "worker_started",
      runId: snapshot.runId,
      model: snapshot.modelId,
      agentVersionId: version.agentVersionId,
      agentVersionContentDigest: version.contentDigest,
      resumed: values.resume,
    }),
  );
  const outcome = await Promise.race([
    runtime.worker.wake(),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("diagnostic_deadline")),
        300_000,
      );
    }),
  ]);
  clearTimeout(timer);
  await runtime.close();
  runtime = undefined;
  authority = new SqliteRunStore(databasePath);
  const state = await authority.loadRun({
    tenantId: snapshot.tenantId,
    runId: snapshot.runId,
  });
  const events = await authority.listRunEvents(
    { tenantId: snapshot.tenantId, runId: snapshot.runId },
    0,
    256,
  );
  const messages = await authority.listMessages(
    { tenantId: snapshot.tenantId, threadId: snapshot.threadId },
    0,
    100,
  );
  const rows = operationDatabase
    .prepare(
      "SELECT record_json FROM extension_external_operations WHERE tenant_id = ? AND run_id = ? AND binding_digest = ? LIMIT 16",
    )
    .all(snapshot.tenantId, snapshot.runId, snapshot.bindingDigest);
  const operations = rows.map((row) => JSON.parse(row.record_json));
  const requests = (
    await readFile(join(outputDir, "comfy-http.jsonl"), "utf8").catch(
      (error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      },
    )
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const evidence = {
    schemaVersion: "crewon.comfy-agent-evidence.v0",
    runId: snapshot.runId,
    agentVersionContentDigest: version.contentDigest,
    outcome,
    runStatus: state?.status,
    externalSubmissions: requests.filter((request) => request.method === "POST")
      .length,
    operations,
    events,
    messages,
  };
  await writeFile(
    join(
      outputDir,
      values.resume
        ? outcome.kind === "idle"
          ? "replay-evidence.json"
          : "resumed-evidence.json"
        : "first-evidence.json",
    ),
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
  const finalMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  const succeeded =
    operations.length === 1 && operations[0].status === "succeeded";
  console.log(
    JSON.stringify({
      stage: "worker_stopped",
      outcome,
      runStatus: state?.status,
      externalSubmissions: evidence.externalSubmissions,
      operationStatus: operations[0]?.status ?? null,
      assistant: finalMessage?.content ?? null,
    }),
  );
  if (
    values["pause-after-submit"] &&
    outcome.kind === "retried" &&
    outcome.code === "diagnostic_pause_after_submit"
  )
    process.exitCode = 0;
  else if (
    !(
      outcome.kind === "completed" ||
      (outcome.kind === "idle" && state?.status === "completed")
    ) ||
    !succeeded ||
    evidence.externalSubmissions !== 1
  )
    process.exitCode = 2;
} finally {
  clearTimeout(timer);
  try {
    await runtime?.close();
  } finally {
    try {
      await authority?.close();
    } finally {
      operationDatabase.close();
    }
  }
}

function required(value, name) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`missing_${name}`);
  return value.trim();
}
function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
async function implementationIdentity() {
  const files = [
    "comfyui-tool-catalog.ts",
    "comfyui-api.ts",
    "comfyui-http.ts",
    "comfyui-krea2-workflow.ts",
    "comfyui-tool-runtime.ts",
  ];
  const parts = await Promise.all(
    files.map(async (file) => [
      file,
      sha256(
        await readFile(
          new URL(
            `../apps/runtime-worker/src/extensions/${file}`,
            import.meta.url,
          ),
        ),
      ),
    ]),
  );
  return sha256(JSON.stringify({ files: parts, instructions: INSTRUCTIONS }));
}
