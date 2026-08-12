import type { ModelDispatchEvidenceStore } from "./model-dispatch-evidence-store-port.ts";
import type { WorkflowNodeContinuationStore } from "./workflow-node-continuation-store-port.ts";
import type { WorkflowRunAdmissionStore } from "./workflow-run-admission-store-port.ts";
import type { WorkflowRunCompositionStore } from "./workflow-run-composition-port.ts";

/**
 * Single, non-splittable Workflow runtime transaction authority.
 *
 * Production dispatchers and certification accept only this combined Store;
 * composition and continuation methods must therefore share one physical
 * transaction authority and cannot be injected as separate instances.
 */
export interface WorkflowRuntimeStore
  extends WorkflowRunAdmissionStore,
    WorkflowRunCompositionStore,
    WorkflowNodeContinuationStore,
    ModelDispatchEvidenceStore {}
