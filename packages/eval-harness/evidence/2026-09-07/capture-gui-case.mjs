// Read-only evidence export AFTER GUI submission. Never sends product requests.
// Usage: node capture-gui-case.mjs <database> <new-output.json> <main-thread-id>...
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";

const [databasePath, outputPath, ...threadIds] = process.argv.slice(2);
if (
  !databasePath ||
  !outputPath ||
  !threadIds.length ||
  threadIds.length > 12
) {
  throw new Error(
    "expected database, new output path, and 1–12 GUI thread IDs",
  );
}
const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  const cases = threadIds.map((threadId) => {
    const root = db
      .prepare("SELECT thread_id, tenant_id FROM threads WHERE thread_id = ?")
      .get(threadId);
    if (!root) throw new Error(`GUI thread missing: ${threadId}`);
    const children = db
      .prepare(
        "SELECT thread_id FROM threads WHERE tenant_id = ? AND json_extract(state_json, '$.forkedFromThreadId') = ?",
      )
      .all(root.tenant_id, threadId);
    if (children.length > 32) throw new Error("unexpected branch count");
    const scope = [threadId, ...children.map((row) => row.thread_id)];
    const runs = scope
      .flatMap((id) =>
        db
          .prepare(
            "SELECT r.state_json FROM run_snapshots r JOIN run_thread_bindings b ON b.run_id = r.run_id WHERE b.tenant_id = ? AND b.thread_id = ?",
          )
          .all(root.tenant_id, id),
      )
      .map((row) => {
        const state = JSON.parse(row.state_json);
        const events = db
          .prepare(
            "SELECT event_json FROM run_events WHERE tenant_id = ? AND run_id = ? ORDER BY sequence",
          )
          .all(root.tenant_id, state.runId)
          .map((row) => JSON.parse(row.event_json));
        const deltas = events.filter(
          (event) => event.type === "model.output.delta",
        );
        const messageId = state.outputRef?.startsWith("message:")
          ? state.outputRef.slice(8)
          : null;
        const output = messageId
          ? db
              .prepare(
                "SELECT content FROM messages WHERE tenant_id = ? AND message_id = ?",
              )
              .get(root.tenant_id, messageId)?.content
          : null;
        return {
          runId: state.runId,
          threadId: state.threadId,
          agentVersionId: state.agentVersionId,
          status: state.status,
          createdAt: state.createdAt,
          startedAt:
            events.find((event) => event.type === "run.started")?.occurredAt ??
            null,
          firstDeltaAt: deltas[0]?.occurredAt ?? null,
          terminalAt: state.terminalAt,
          deltaCount: deltas.length,
          usage: state.usage,
          output,
        };
      })
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    if (!runs.length || runs.some((run) => run.status !== "completed"))
      throw new Error("case is not fully completed");
    const messages = db
      .prepare(
        "SELECT role, content FROM messages WHERE tenant_id = ? AND thread_id = ? ORDER BY sequence",
      )
      .all(root.tenant_id, threadId);
    const start = Math.min(...runs.map((run) => Date.parse(run.createdAt)));
    const end = Math.max(...runs.map((run) => Date.parse(run.terminalAt)));
    return {
      threadId,
      input:
        messages.find((message) => message.role === "user")?.content ?? null,
      hasDeliverableConstraintPrompt: messages.some((message) =>
        message.content.includes("未经验证的方向只能标为待评估"),
      ),
      modelRunCount: runs.length,
      durationMs: end - start,
      runs,
    };
  });
  writeFileSync(
    outputPath,
    `${JSON.stringify({ schemaVersion: "crewon.gui-case-evidence.v1", submittedVia: "GUI", evidenceSource: "read-only local Control SQLite after GUI observation", capturedAt: new Date().toISOString(), cases }, null, 2)}\n`,
    { flag: "wx" },
  );
  console.log(
    JSON.stringify(
      cases.map(
        ({
          threadId,
          modelRunCount,
          durationMs,
          hasDeliverableConstraintPrompt,
        }) => ({
          threadId,
          modelRunCount,
          durationMs,
          hasDeliverableConstraintPrompt,
        }),
      ),
      null,
      2,
    ),
  );
} finally {
  db.close();
}
