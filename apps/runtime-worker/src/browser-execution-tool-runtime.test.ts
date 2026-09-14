import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import test, { type TestContext } from "node:test";

import { canonicalActionIntent, type ActionIntent } from "@crewon/contracts";
import {
  type ToolExecutionCommand,
  type ToolExecutionResolution,
} from "@crewon/tool-broker";

import {
  BrowserExecutionToolRuntime,
  browserExecutionPolicy,
  createConfiguredBrowserExecutionToolRuntime,
} from "./browser-execution-tool-runtime.ts";
import { createConfiguredToolRuntime } from "./runtime-process-environment.ts";

const token = "a".repeat(64);
const actInput = JSON.stringify({
  sessionId: "session-1",
  generation: 0,
  observationId: "observation-1",
  action: "click",
  target: { targetId: "target-1" },
});

test("C05 config registers only an explicitly authenticated numeric loopback bridge", async () => {
  assert.equal(createConfiguredBrowserExecutionToolRuntime({}), undefined);
  for (const environment of [
    { CREWON_BROWSER_BRIDGE_URL: "http://127.0.0.1:1234" },
    { CREWON_BROWSER_BRIDGE_TOKEN: token },
    ...[
      "http://localhost:1234",
      "http://127.0.0.2:1234",
      "https://127.0.0.1:1234",
      "http://127.0.0.1:1234/path",
      "http://127.0.0.1:1234?x=1",
      "http://user@127.0.0.1:1234",
      "http://2130706433:1234",
    ].map((url) => ({
      CREWON_BROWSER_BRIDGE_URL: url,
      CREWON_BROWSER_BRIDGE_TOKEN: token,
    })),
    {
      CREWON_BROWSER_BRIDGE_URL: "http://127.0.0.1:1234",
      CREWON_BROWSER_BRIDGE_TOKEN: "short",
    },
  ]) {
    assert.throws(() =>
      createConfiguredBrowserExecutionToolRuntime(environment),
    );
  }
  const runtime = await createConfiguredToolRuntime({
    CREWON_BROWSER_BRIDGE_URL: "http://127.0.0.1:1234",
    CREWON_BROWSER_BRIDGE_TOKEN: token,
  });
  assert.deepEqual(
    runtime?.definitions().map((definition) => definition.name),
    [
      "crewon_browser_observe",
      "crewon_browser_act",
      "crewon_browser_act_scoped",
    ],
  );
  assert.deepEqual(runtime?.executionPolicy("function", "crewon_browser_act"), {
    effect: "mutation",
    recovery: "reconcilable",
    resourceBindingId: "desktop-browser",
    credentialBindingId: null,
    executionTarget: { kind: "control", bindingId: "desktop-browser" },
    capability: "browser.act.v1",
    approvalRequirement: "perAction",
    limits: {
      timeoutMs: 30000,
      maxOutputBytes: 9216,
      maxArtifactBytes: 10485760,
    },
  });
  assert.equal(runtime?.executionPolicy("custom", "crewon_browser_act"), null);
  assert.equal(
    runtime?.executionPolicy("function", "crewon_browser_act_scoped")
      ?.approvalRequirement,
    "none",
  );
  assert.equal(
    runtime?.executionPolicy("function", "crewon_browser_act_scoped")
      ?.capability,
    "browser.act.scoped.v1",
  );
});

test("C05 sends the original validated command with private bearer authentication over real HTTP", async (t) => {
  const requests: {
    path: string | undefined;
    authorization: string | undefined;
    body: unknown;
  }[] = [];
  const bridge = await server(t, async (request, response) => {
    requests.push({
      path: request.url,
      authorization: request.headers.authorization,
      body: await body(request),
    });
    json(response, completed());
  });
  const runtime = new BrowserExecutionToolRuntime({ url: bridge.url, token });
  const value = command();
  assert.deepEqual(await runtime.execute(value, signal()), completed());
  assert.deepEqual(requests, [
    {
      path: "/v1/browser/execute",
      authorization: `Bearer ${token}`,
      body: { command: value },
    },
  ]);
});

test("C05 rejects input, policy, approval, digest and expired execution lease before dispatch", async (t) => {
  let requests = 0;
  const bridge = await server(t, (_request, response) => {
    requests++;
    json(response, completed());
  });
  const runtime = new BrowserExecutionToolRuntime({ url: bridge.url, token });
  const valid = command();
  const commands = [
    command("crewon_browser_observe", JSON.stringify({ runId: "forged-run" })),
    command("crewon_browser_act", JSON.stringify({ arbitraryCode: "eval()" })),
    command("crewon_browser_act", actInput, {
      capability: "browser.observe.v1",
    }),
    command("crewon_browser_act", actInput, { approvalRequirement: "none" }),
    command("crewon_browser_act", actInput, {
      limits: {
        timeoutMs: 30000,
        maxOutputBytes: 9217,
        maxArtifactBytes: 10485760,
      },
    }),
    { ...valid, approvalProof: null },
    { ...valid, input: "{}" },
    {
      ...valid,
      executionLease: {
        ...valid.executionLease,
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
    },
  ];
  for (const value of commands)
    await assert.rejects(runtime.execute(value, signal()));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(runtime.execute(valid, aborted.signal));
  assert.equal(requests, 0);
});

test("C05 uncertain dispatch returns unknown once; reconciliation and cancellation never replay execute", async (t) => {
  const paths: string[] = [];
  const bridge = await server(t, async (request, response) => {
    await body(request);
    paths.push(request.url!);
    if (request.url === "/v1/browser/execute") {
      response.destroy();
      return;
    }
    if (request.url === "/v1/browser/reconcile") {
      json(response, completed());
      return;
    }
    json(response, {
      status: "canceled",
      executionId: "execution-1",
      providerReceiptId: "receipt-1",
    });
  });
  const runtime = new BrowserExecutionToolRuntime({ url: bridge.url, token });
  assert.deepEqual(await runtime.execute(command(), signal()), unknown());
  const expired = command();
  const recovery = {
    ...expired,
    executionLease: {
      ...expired.executionLease,
      expiresAt: "2000-01-01T00:00:00.000Z",
    },
  };
  assert.deepEqual(await runtime.reconcile(recovery, signal()), completed());
  assert.equal((await runtime.cancel(recovery, signal())).status, "canceled");
  assert.deepEqual(paths, [
    "/v1/browser/execute",
    "/v1/browser/reconcile",
    "/v1/browser/cancel",
  ]);
});

test("C05 cancellation during dispatch actively notifies the host with an independent request", async (t) => {
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const paths: string[] = [];
  const bridge = await server(t, async (request, response) => {
    await body(request);
    paths.push(request.url!);
    if (request.url === "/v1/browser/execute") {
      started();
      return;
    }
    json(response, {
      status: "canceled",
      executionId: "execution-1",
      providerReceiptId: "receipt-1",
    });
  });
  const runtime = new BrowserExecutionToolRuntime({ url: bridge.url, token });
  const controller = new AbortController();
  const result = runtime.execute(command(), controller.signal);
  await pending;
  controller.abort(new Error("user takeover"));
  assert.deepEqual(await result, unknown());
  assert.deepEqual(paths, ["/v1/browser/execute", "/v1/browser/cancel"]);
});

test("C05 rejects response identity substitution, unknown fields, oversized UTF-8 output and redirects", async (t) => {
  const valid = completed();
  const invalid: unknown[] = [
    { ...valid, executionId: "other" },
    { ...valid, result: { ...valid.result, callId: "other" } },
    { ...valid, result: { ...valid.result, output: "字".repeat(3073) } },
    { ...valid, result: { ...valid.result, extra: "unsafe" } },
    { ...valid, providerReceiptId: null },
    { ...unknown(), extra: true },
    "x".repeat(20000),
  ];
  let next: unknown = invalid[0];
  let redirect = false;
  let redirectsFollowed = 0;
  const bridge = await server(t, (request, response) => {
    if (request.url === "/redirected") {
      redirectsFollowed++;
      json(response, valid);
      return;
    }
    if (redirect) {
      response.writeHead(302, { location: "/redirected" });
      response.end();
      return;
    }
    json(response, next);
  });
  const runtime = new BrowserExecutionToolRuntime({ url: bridge.url, token });
  for (const invalidResult of invalid) {
    next = invalidResult;
    assert.deepEqual(await runtime.execute(command(), signal()), unknown());
  }
  next = { ...valid, result: { ...valid.result, output: "字".repeat(3072) } };
  assert.deepEqual(await runtime.execute(command(), signal()), next);
  redirect = true;
  assert.deepEqual(await runtime.execute(command(), signal()), unknown());
  assert.equal(redirectsFollowed, 0);
});

test("C05 download requires the F01 port before dispatch, verifies real binary bytes and imports using the true Run", async (t) => {
  const content = Buffer.from("name,total\n销售,42\n", "utf8");
  const receipt = {
    receiptId: "download-1",
    name: "report.csv",
    mediaType: "text/csv",
    sizeBytes: content.byteLength,
    sha256: digest(content.toString("utf8")),
  };
  const paths: string[] = [];
  const inputs: unknown[] = [];
  let corruptBytes = false;
  const bridge = await server(t, async (request, response) => {
    paths.push(request.url!);
    inputs.push(await body(request));
    if (request.url === "/v1/browser/download") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(corruptBytes ? Buffer.from("corrupt") : content);
      return;
    }
    const result = completed();
    json(response, {
      ...result,
      result: {
        ...result.result,
        output: JSON.stringify({ downloadReceipt: receipt }),
      },
    });
  });
  const download = command(
    "crewon_browser_act",
    actInput.replace('"click"', '"download"'),
  );
  await assert.rejects(
    new BrowserExecutionToolRuntime({ url: bridge.url, token }).execute(
      download,
      signal(),
    ),
    /browser_download_import_unavailable/,
  );
  assert.deepEqual(paths, []);
  const imports: unknown[] = [];
  const file = {
    inputId: "input-1",
    sourceRunId: "run-1",
    name: receipt.name,
    mediaType: receipt.mediaType,
    byteLength: content.byteLength,
    contentDigest: receipt.sha256,
  };
  const runtime = new BrowserExecutionToolRuntime({ url: bridge.url, token });
  runtime.setDownloadImporter(async (input) => {
    imports.push(input);
    return {
      ...file,
      ownerActorId: "private-owner",
      inspection: {
        sheets: Array.from({ length: 1000 }, () => ({ name: "huge-sheet" })),
      },
    };
  });
  const result = await runtime.execute(download, signal());
  assert.equal(result.status, "completed");
  if (result.status === "completed")
    assert.deepEqual(JSON.parse(result.result.output), {
      status: "completed",
      file,
    });
  assert.deepEqual(paths, ["/v1/browser/execute", "/v1/browser/download"]);
  assert.deepEqual(inputs[1], { command: download, receiptId: "download-1" });
  assert.deepEqual(imports, [
    {
      runId: "run-1",
      executionId: "execution-1",
      name: "report.csv",
      mediaType: "text/csv",
      content: new Uint8Array(content),
    },
  ]);
  corruptBytes = true;
  assert.deepEqual(await runtime.reconcile(download, signal()), unknown());
  assert.equal(imports.length, 1);
});

test("C05 failed file import recovers by receipt lookup without replaying the browser action", async (t) => {
  const content = Buffer.from("name,total\nsales,42\n");
  const paths: string[] = [];
  const bridge = await server(t, async (request, response) => {
    await body(request);
    paths.push(request.url!);
    if (request.url === "/v1/browser/download") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(content);
      return;
    }
    const result = completed();
    json(response, {
      ...result,
      result: {
        ...result.result,
        output: JSON.stringify({
          downloadReceipt: {
            receiptId: "download-1",
            name: "data.csv",
            mediaType: "text/csv",
            sizeBytes: content.length,
            sha256: digest(content.toString()),
          },
        }),
      },
    });
  });
  let imports = 0;
  const runtime = new BrowserExecutionToolRuntime({
    url: bridge.url,
    token,
    importDownloadedFile: async () => {
      if (++imports === 1) throw new Error("temporarily unavailable");
      return {
        inputId: "input-1",
        sourceRunId: "run-1",
        name: "data.csv",
        mediaType: "text/csv",
        byteLength: content.byteLength,
        contentDigest: digest(content.toString()),
      };
    },
  });
  const download = command(
    "crewon_browser_act_scoped",
    actInput.replace('"click"', '"download"'),
  );
  assert.deepEqual(await runtime.execute(download, signal()), unknown());
  assert.equal(
    (await runtime.reconcile(download, signal())).status,
    "completed",
  );
  assert.deepEqual(paths, [
    "/v1/browser/execute",
    "/v1/browser/download",
    "/v1/browser/reconcile",
    "/v1/browser/download",
  ]);
});

test("C05 cancellation while the file service is pending releases the tool and stops subsequent host actions", async (t) => {
  const content = Buffer.from("name,total\nsales,42\n");
  const paths: string[] = [];
  let importStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    importStarted = resolve;
  });
  let finishImport!: (value: unknown) => void;
  const pendingImport = new Promise<unknown>((resolve) => {
    finishImport = resolve;
  });
  const bridge = await server(t, async (request, response) => {
    await body(request);
    paths.push(request.url!);
    if (request.url === "/v1/browser/download") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(content);
      return;
    }
    if (request.url === "/v1/browser/cancel") {
      json(response, {
        status: "canceled",
        executionId: "execution-1",
        providerReceiptId: "receipt-1",
      });
      return;
    }
    const result = completed();
    json(response, {
      ...result,
      result: {
        ...result.result,
        output: JSON.stringify({
          downloadReceipt: {
            receiptId: "download-1",
            name: "data.csv",
            mediaType: "text/csv",
            sizeBytes: content.length,
            sha256: digest(content.toString()),
          },
        }),
      },
    });
  });
  const runtime = new BrowserExecutionToolRuntime({
    url: bridge.url,
    token,
    importDownloadedFile: () => {
      importStarted();
      return pendingImport;
    },
  });
  const controller = new AbortController();
  const result = runtime.execute(
    command(
      "crewon_browser_act_scoped",
      actInput.replace('"click"', '"download"'),
    ),
    controller.signal,
  );
  await started;
  controller.abort();
  try {
    assert.deepEqual(await result, unknown());
  } finally {
    finishImport({});
  }
  assert.deepEqual(paths, [
    "/v1/browser/execute",
    "/v1/browser/download",
    "/v1/browser/cancel",
  ]);
});

async function server(
  t: TestContext,
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>,
) {
  const instance = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() =>
      response.destroy(),
    );
  });
  await new Promise<void>((resolve) =>
    instance.listen(0, "127.0.0.1", resolve),
  );
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      instance.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = instance.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}` };
}
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
function command(
  name = "crewon_browser_act",
  input = name === "crewon_browser_observe" ? "{}" : actInput,
  overrides: Partial<ActionIntent> = {},
): ToolExecutionCommand {
  const policy = browserExecutionPolicy("function", name);
  assert.ok(policy);
  const actionIntent: ActionIntent = {
    schemaVersion: "crewon.action-intent.v0",
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    tool: { kind: "function", name, inputDigest: digest(input) },
    ...policy,
    policySnapshotId: "policy-1",
    workspaceBindingId: "workspace-1",
    ...overrides,
  };
  const actionDigest = digest(canonicalActionIntent(actionIntent));
  return {
    schemaVersion: "crewon.tool-invocation.v0",
    idempotencyKey: "idempotency-1",
    runId: actionIntent.runId,
    segmentId: actionIntent.segmentId,
    callId: actionIntent.callId,
    kind: "function",
    name,
    input,
    executionId: "execution-1",
    executionLease: {
      workItemId: "work-item-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
    actionDigest,
    actionIntent,
    approvalProof:
      actionIntent.approvalRequirement === "none"
        ? null
        : {
            schemaVersion: "crewon.tool-approval-proof.v0",
            approvalId: "approval-1",
            actionDigest,
            policySnapshotId: actionIntent.policySnapshotId,
            approvalRevision: 2,
            decidedAt: new Date().toISOString(),
          },
  };
}
function completed(): Extract<
  ToolExecutionResolution,
  { status: "completed" }
> {
  return {
    status: "completed",
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    result: {
      schemaVersion: "crewon.tool-result.v0",
      callId: "call-1",
      output: '{"ok":true}',
      isError: false,
      artifactRef: null,
    },
  };
}
function unknown(): ToolExecutionResolution {
  return {
    status: "unknownOutcome",
    executionId: "execution-1",
    providerReceiptId: null,
  };
}
function signal(): AbortSignal {
  return new AbortController().signal;
}
function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
