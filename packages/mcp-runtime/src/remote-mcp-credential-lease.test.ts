import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import test from "node:test";

import { canonicalActionIntent } from "@crewon/contracts";
import type { ToolExecutionCommand } from "@crewon/tool-broker";

import {
  CrewonRemoteMcpMutationError,
  CrewonRemoteMcpMutationProvider,
  type CrewonRemoteMcpMutationHttpPort,
} from "./crewon-remote-mutation-provider.ts";
import type {
  CrewonRemoteMcpCredentialAcquireInput,
  CrewonRemoteMcpCredentialLease,
  CrewonRemoteMcpCredentialLeasePort,
} from "./remote-mcp-credential-lease.ts";
import {
  credentialAuthorization,
  prepareAuthorization,
} from "./remote-mcp-credential-lease.ts";

test("production reacquires rotated credentials for reconcile", async () => {
  const tokens = ["token-a", "token-b"];
  const authorization: string[] = [];
  const acquired: Array<Omit<CrewonRemoteMcpCredentialAcquireInput, "signal">> =
    [];
  let releases = 0;
  const adapter = provider(
    async (request) => {
      authorization.push(request.headers.authorization ?? "");
      const wire = JSON.parse(new TextDecoder().decode(request.body));
      return response(wire.phase);
    },
    credentialPort((input) => {
      const token = tokens.shift();
      assert.ok(token);
      acquired.push({
        phase: input.phase,
        providerExecutionId: input.providerExecutionId,
        toolName: input.toolName,
      });
      return lease(token, () => {
        releases += 1;
      });
    }),
  );
  const execution = mutationExecution();
  await adapter.execute(execution, signal());
  await adapter.reconcile(execution, signal());
  assert.deepEqual(authorization, ["Bearer token-a", "Bearer token-b"]);
  assert.deepEqual(
    acquired.map(({ phase }) => phase),
    ["execute", "reconcile"],
  );
  assert.equal(releases, 2);
});

test("hung acquire is notSent on deadline or caller abort", async () => {
  for (const cause of ["deadline", "caller"] as const) {
    let posts = 0;
    const controller = new AbortController();
    const adapter = provider(
      async () => {
        posts += 1;
        return response("execute");
      },
      credentialPort(() => new Promise(() => undefined)),
      cause === "deadline" ? 20 : 1_000,
    );
    const pending = adapter.execute(mutationExecution(), controller.signal);
    if (cause === "caller") setTimeout(() => controller.abort(), 10);
    await assert.rejects(
      pending,
      notSent(
        cause === "caller"
          ? "remote_mcp_mutation_aborted"
          : "remote_mcp_mutation_deadline_exceeded",
      ),
    );
    assert.equal(posts, 0);
  }
});

test("late acquired lease is released without waiting", async () => {
  let resolveLease:
    | ((value: CrewonRemoteMcpCredentialLease) => void)
    | undefined;
  let releases = 0;
  const adapter = provider(
    async () => {
      throw new Error("unexpected_send");
    },
    credentialPort(
      () =>
        new Promise((resolve) => {
          resolveLease = resolve;
        }),
    ),
    20,
  );
  await assert.rejects(
    adapter.execute(mutationExecution(), signal()),
    notSent("remote_mcp_mutation_deadline_exceeded"),
  );
  assert.ok(resolveLease);
  resolveLease(
    lease("late", () => {
      releases += 1;
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(releases, 1);
});

test("sealed sink ignores late apply after abort and revokes the header", async () => {
  const controller = new AbortController();
  const headers: Record<string, string> = {};
  let sink: { applyBearer(token: string): void } | undefined;
  const auth = credentialAuthorization(
    config(
      credentialPort(() => ({
        apply(value) {
          sink = value;
          return new Promise(() => undefined);
        },
        release: () => undefined,
      })),
    ),
  );
  const pending = prepareAuthorization(
    auth,
    headers,
    {
      phase: "execute",
      providerExecutionId: "execution-1",
      toolName: "provider.original-tool",
    },
    controller.signal,
    controller.signal,
    AbortSignal.timeout(1_000),
  );
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending);
  assert.ok(sink);
  assert.doesNotThrow(() => sink?.applyBearer("late-secret"));
  assert.equal(headers.authorization, undefined);
  assert.equal(inspect(headers).includes("late-secret"), false);
});

test("rejects missing, invalid, and duplicate bearer apply before send", async () => {
  const cases: Array<(sink: { applyBearer(token: string): void }) => void> = [
    () => undefined,
    (sink) => sink.applyBearer("contains space"),
    (sink) => {
      sink.applyBearer("first");
      sink.applyBearer("second");
    },
  ];
  for (const apply of cases) {
    let posts = 0;
    let releases = 0;
    const adapter = provider(
      async () => {
        posts += 1;
        return response("execute");
      },
      credentialPort(() => ({
        apply,
        release: () => {
          releases += 1;
        },
      })),
    );
    await assert.rejects(
      adapter.execute(mutationExecution(), signal()),
      notSent("remote_mcp_mutation_credential_apply_failed"),
    );
    assert.equal(posts, 0);
    assert.equal(releases, 1);
  }
});

test("credential errors are code-only and hung release cannot mask success", async () => {
  const secret = "credential-lifecycle-secret";
  await redactedFailure(
    provider(
      async () => {
        throw new Error("unexpected_send");
      },
      credentialPort(() => {
        throw new Error(secret);
      }),
    ).execute(mutationExecution(), signal()),
    "remote_mcp_mutation_credential_acquire_failed",
    secret,
  );
  await redactedFailure(
    provider(
      async () => {
        throw new Error("unexpected_send");
      },
      credentialPort(() => ({
        apply: () => {
          throw new Error(secret);
        },
        release: () => {
          throw new Error(secret);
        },
      })),
    ).execute(mutationExecution(), signal()),
    "remote_mcp_mutation_credential_apply_failed",
    secret,
  );
  const completed = provider(
    async () => response("execute"),
    credentialPort(() => lease("valid", () => new Promise(() => undefined))),
  ).execute(mutationExecution(), signal());
  assert.deepEqual(
    await Promise.race([
      completed,
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 50),
      ),
    ]),
    { status: "unknownOutcome", providerReceiptId: null },
  );
});

test("runtime rejects illegal cross-shapes and explicit invalid deadlines", () => {
  const validPort = credentialPort(() => lease("secret"));
  const invalid: unknown[] = [
    {
      endpoint: "https://provider.example/mutate",
      auth: { kind: "bearer", token: "secret" },
      network: productionNetwork(),
    },
    {
      endpoint: "http://127.0.0.1/mutate",
      auth: { kind: "credentialLease", port: validPort },
      network: { mode: "standaloneLoopback" },
    },
    {
      endpoint: "https://provider.example/mutate",
      auth: { kind: "credentialLease", port: validPort, token: "escape" },
      network: productionNetwork(),
    },
    ...[null, undefined, "20"].map((deadlineMs) => ({
      ...config(validPort),
      deadlineMs,
    })),
  ];
  for (const candidate of invalid) {
    assert.throws(
      () => new CrewonRemoteMcpMutationProvider(candidate as never),
      code("remote_mcp_mutation_config_invalid"),
    );
  }
});

function provider(
  post: CrewonRemoteMcpMutationHttpPort["post"],
  port: CrewonRemoteMcpCredentialLeasePort,
  deadlineMs = 30_000,
) {
  return new CrewonRemoteMcpMutationProvider({
    ...config(port),
    deadlineMs,
    network: { mode: "production", http: { post } },
  });
}
function config(port: CrewonRemoteMcpCredentialLeasePort) {
  return {
    endpoint: "https://provider.example/mutate",
    auth: { kind: "credentialLease" as const, port },
    network: productionNetwork(),
  };
}
function productionNetwork() {
  return {
    mode: "production" as const,
    http: { post: async () => new Response() },
  };
}
function credentialPort(
  acquire: CrewonRemoteMcpCredentialLeasePort["acquire"],
): CrewonRemoteMcpCredentialLeasePort {
  return { acquire };
}
function lease(
  token: string,
  release: () => void | Promise<void> = () => undefined,
): CrewonRemoteMcpCredentialLease {
  return { apply: (sink) => sink.applyBearer(token), release };
}
function response(phase: string): Response {
  return new Response(
    JSON.stringify({
      schemaVersion: "crewon.remote-mcp-mutation.v1",
      phase,
      providerExecutionId: "execution-1",
      toolName: "provider.original-tool",
      resolution: { status: "unknownOutcome", providerReceiptId: null },
    }),
    { headers: { "content-type": "application/json" } },
  );
}
function signal(): AbortSignal {
  return new AbortController().signal;
}
function code(expected: string) {
  return (error: unknown) =>
    error instanceof CrewonRemoteMcpMutationError && error.code === expected;
}
function notSent(expected: string) {
  return (error: unknown) =>
    code(expected)(error) &&
    (error as CrewonRemoteMcpMutationError).certainty === "notSent";
}
async function redactedFailure(
  pending: Promise<unknown>,
  expected: string,
  secret: string,
) {
  let caught: unknown;
  try {
    await pending;
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof CrewonRemoteMcpMutationError);
  assert.equal(caught.code, expected);
  assert.equal(caught.certainty, "notSent");
  assert.equal(inspect(caught).includes(secret), false);
}

function mutationExecution() {
  const input = '{"value":"hello"}';
  const actionIntent = {
    schemaVersion: "crewon.action-intent.v0" as const,
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    tool: {
      kind: "function" as const,
      name: "mcp__remote__original-tool",
      inputDigest: sha256(input),
    },
    effect: "mutation" as const,
    recovery: "reconcilable" as const,
    policySnapshotId: "policy-1",
    workspaceBindingId: "workspace-1",
    resourceBindingId: null,
    credentialBindingId: "credential-1",
    executionTarget: { kind: "remote" as const, bindingId: "mcp-provider-1" },
    capability: "mcp.tool.mutate",
    approvalRequirement: "none" as const,
    limits: { timeoutMs: 30_000, maxOutputBytes: 4096, maxArtifactBytes: 8192 },
  };
  const command: ToolExecutionCommand = {
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
    name: "mcp__remote__original-tool",
    input,
  };
  return {
    providerExecutionId: command.executionId,
    toolName: "provider.original-tool",
    command,
  };
}
function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
