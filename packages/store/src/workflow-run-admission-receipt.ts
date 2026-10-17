import {
  RunStoreError,
  canonicalJson,
  type CommitRunResult,
  type CommitWorkflowRunStartInput,
  type CommitWorkflowRunStartResult,
  type WorkflowRunAdmissionAuthority,
  type WorkflowRunInputAuthority,
} from "@crewon/application";
import {
  MAX_WORKFLOW_DEFINITION_BYTES,
  reduceRunLifecycleEvent,
} from "@crewon/domain";
import {
  validateWorkflowAdmissionAuthority,
  validateWorkflowAdmissionPreparation,
  workflowAdmissionDigest,
} from "./workflow-run-admission-validation.ts";
import { resolveMessageRunEvidence } from "./message-run-evidence.ts";
import {
  workflowRootInputContent,
  workflowRootInputReceipt,
} from "./workflow-root-input.ts";

export const MAX_WORKFLOW_ADMISSION_RECEIPT_BYTES =
  MAX_WORKFLOW_DEFINITION_BYTES * 2 + 16_384;
export type WorkflowAdmissionReceiptRow = Readonly<{
  tenant_id: string;
  run_id: string;
  fingerprint: string | null;
  result_json: string | null;
  authority_json: string | null;
}>;

/** Pure receipt validation: SQLite keeps its synchronous transaction; PostgreSQL can await its own reads. */
export function decodeWorkflowAdmissionReceipt(
  input: CommitWorkflowRunStartInput,
  row: WorkflowAdmissionReceiptRow,
) {
  if (row.tenant_id !== input.tenantId)
    throw new RunStoreError("tenant_id_mismatch");
  if (row.fingerprint === null)
    throw new RunStoreError("workflow_run_admission_receipt_invalid");
  if (row.fingerprint !== input.idempotency.requestFingerprint)
    throw new RunStoreError("idempotency_conflict");
  try {
    if (row.result_json === null || row.authority_json === null)
      throw new Error("missing workflow receipt");
    const stored = JSON.parse(row.result_json) as ReturnType<
      typeof workflowRootInputReceipt
    >;
    // Compound-start evidence belongs to the receipt/read model, never the
    // public command response. Legacy receipts have only these original fields.
    const run: CommitRunResult = {
      disposition: stored.disposition,
      state: stored.state,
      events: stored.events,
      workItems: stored.workItems,
      outbox: stored.outbox,
    };
    const authority = JSON.parse(
      row.authority_json,
    ) as WorkflowRunAdmissionAuthority;
    validateWorkflowAdmissionAuthority(input, authority);
    if (
      run.disposition !== "committed" ||
      run.state.runId !== row.run_id ||
      run.state.threadId !== input.threadId ||
      run.state.spaceId !== input.spaceId ||
      run.state.tenantId !== input.tenantId ||
      run.events.length !== 1 ||
      canonicalJson(reduceRunLifecycleEvent(null, run.events[0]!)) !==
        canonicalJson(run.state)
    )
      throw new Error("mismatched workflow receipt");
    if (
      ["runState", "threadState", "messages", "runEvents", "threadEvents"].some(
        (key) => Object.hasOwn(stored, key),
      )
    ) {
      if (
        !stored.messages ||
        stored.messages.length !== 1 ||
        canonicalJson(stored.runState) !== canonicalJson(run.state) ||
        canonicalJson(stored.runEvents) !== canonicalJson(run.events) ||
        stored.messages[0]!.content !==
          workflowRootInputContent(input.workflowInput) ||
        stored.messages[0]!.contentDigest !==
          workflowAdmissionDigest.sha256(stored.messages[0]!.content) ||
        stored.threadState.lastMessageSequence !==
          stored.messages[0]!.sequence ||
        stored.threadState.lastEventSequence !==
          stored.threadEvents[0]?.sequence
      )
        throw new Error("mismatched workflow input proof");
      resolveMessageRunEvidence(
        {
          tenantId: input.tenantId,
          spaceId: input.spaceId,
          threadId: input.threadId,
        },
        stored.messages[0]!,
        [
          {
            tenantId: row.tenant_id,
            spaceId: input.spaceId,
            threadId: input.threadId,
            runId: row.run_id,
            payload: stored,
          },
        ],
      );
    }
    const ref = run.workItems[0]?.payload.workflowInput as
      | { valueId: string; valueDigest: string }
      | undefined;
    if (!ref) throw new Error("missing workflow input reference");
    return {
      authority,
      run,
      inputRef: {
        tenantId: input.tenantId,
        runId: row.run_id,
        valueId: ref.valueId,
        valueDigest: ref.valueDigest,
      },
    };
  } catch (cause) {
    throw new RunStoreError("workflow_run_admission_receipt_invalid", {
      cause,
    });
  }
}

export function completeWorkflowAdmissionReplay(
  input: CommitWorkflowRunStartInput,
  decoded: ReturnType<typeof decodeWorkflowAdmissionReceipt>,
  value: WorkflowRunInputAuthority | null,
): CommitWorkflowRunStartResult {
  try {
    if (!value) throw new Error("missing workflow input");
    const { authority, run } = decoded;
    validateWorkflowAdmissionPreparation(input, authority, {
      commit: {
        tenantId: input.tenantId,
        idempotency: input.idempotency,
        expectedRevision: 0,
        events: run.events,
        workItems: run.workItems,
        outbox: run.outbox,
      },
      workflowInputValue: value,
    });
    return { authority, run: { ...run, disposition: "replayed" } };
  } catch (cause) {
    throw new RunStoreError("workflow_run_admission_receipt_invalid", {
      cause,
    });
  }
}
