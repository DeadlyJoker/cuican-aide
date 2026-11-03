import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { canonicalActionIntent } from "@crewon/contracts";
import { LocalProjectDocuments } from "@crewon/store";
import type {
  ToolExecutionCommand,
  ToolRuntimePort,
} from "@crewon/tool-broker";
import { createLocalProjectDocumentToolRuntime } from "./local-project-document-tool-runtime.ts";

test("real tool broker and page store share revisions, changes, conflicts and approval", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "crewon-document-tool-")),
  );
  const runtime = createLocalProjectDocumentToolRuntime(root);
  assert.throws(
    () => createLocalProjectDocumentToolRuntime(root, ""),
    /scope_invalid/,
  );
  const page = new LocalProjectDocuments(root);
  let stop = () => {};
  try {
    const changed = new Promise<void>((resolve) => {
      stop = page.subscribe("script", resolve);
    });
    const save = command(
      runtime,
      "project_document_save",
      { documentId: "script", expectedRevision: 0, content: "Agent 第一版" },
      "save",
    );
    await assert.rejects(
      async () =>
        runtime.execute(
          { ...save, approvalProof: null },
          new AbortController().signal,
        ),
      /tool_approval_proof_invalid/,
    );
    assert.equal(page.read("script"), null);
    const result = await runtime.execute(save, new AbortController().signal);
    assert.equal(result.status, "completed");
    assert.equal(result.result.isError, false);
    await Promise.race([
      changed,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("file notification missing")),
          3000,
        ).unref(),
      ),
    ]);
    assert.equal(page.read("script")?.content, "Agent 第一版");
    page.save({
      documentId: "script",
      expectedRevision: 1,
      content: "页面第二版",
    });
    const read = await runtime.execute(
      command(
        runtime,
        "project_document_read",
        { documentId: "script" },
        "read",
      ),
      new AbortController().signal,
    );
    assert.equal(read.status, "completed");
    assert.equal(JSON.parse(read.result.output).content, "页面第二版");
    const conflict = await runtime.execute(
      command(
        runtime,
        "project_document_save",
        { documentId: "script", expectedRevision: 1, content: "过期覆盖" },
        "conflict",
      ),
      new AbortController().signal,
    );
    assert.equal(conflict.status, "completed");
    assert.equal(conflict.result.isError, true);
    assert.match(conflict.result.output, /project_document_revision_conflict/);
    assert.equal(page.read("script")?.content, "页面第二版");
    assert.equal(
      readFileSync(join(root, "documents/script/0000000001.md"), "utf8"),
      "Agent 第一版",
    );
    const escape = await runtime.execute(
      command(
        runtime,
        "project_document_read",
        { documentId: "../../secret" },
        "escape",
      ),
      new AbortController().signal,
    );
    assert.equal(escape.status, "completed");
    assert.equal(escape.result.isError, true);
  } finally {
    stop();
    await runtime.close?.();
    rmSync(root, { recursive: true, force: true });
  }
});

function command(
  runtime: ToolRuntimePort,
  name: string,
  value: object,
  callId: string,
): ToolExecutionCommand {
  const input = JSON.stringify(value);
  const policy = runtime.executionPolicy("function", name)!;
  const actionIntent = {
    schemaVersion: "crewon.action-intent.v0" as const,
    runId: "run-document",
    segmentId: "segment-document",
    callId,
    tool: { kind: "function" as const, name, inputDigest: sha(input) },
    policySnapshotId: "policy-document",
    workspaceBindingId: null,
    ...policy,
  };
  const actionDigest = sha(canonicalActionIntent(actionIntent));
  return {
    schemaVersion: "crewon.tool-invocation.v0",
    executionId: callId,
    executionLease: {
      workItemId: "work-document",
      stepId: "step-document",
      attemptId: "attempt-document",
      leaseId: "lease-document",
      leaseEpoch: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    actionIntent,
    actionDigest,
    approvalProof:
      policy.approvalRequirement === "none"
        ? null
        : {
            schemaVersion: "crewon.tool-approval-proof.v0",
            approvalId: "approval-document",
            actionDigest,
            policySnapshotId: "policy-document",
            approvalRevision: 2,
            decidedAt: "2026-11-03T00:00:00.000Z",
          },
    idempotencyKey: `run-document/tool/${callId}`,
    runId: "run-document",
    segmentId: "segment-document",
    callId,
    kind: "function",
    name,
    input,
  };
}
function sha(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
