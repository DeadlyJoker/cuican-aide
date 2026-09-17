import type { TestContext } from "node:test";
import type { WorkflowSchedulerAuthorization } from "@crewon/application";
import {
  sqliteAdmissionFixture,
  type admissionVersion,
} from "./workflow-run-admission.test-support.ts";
import { ManualLeaseClock } from "./run-store-conformance.test-support.ts";
import { gateCompositionOptions } from "./workflow-human-gate.test-support.ts";
import type { SqliteWorkflowCompositionOptions } from "./sqlite-workflow-run-composition.ts";

export async function schedulerFixture(
  t: TestContext,
  asset?: ReturnType<typeof admissionVersion>,
) {
  const clock = new ManualLeaseClock(Date.now());
  const f = await sqliteAdmissionFixture(t, undefined, { clock, asset });
  let authorize: WorkflowSchedulerAuthorization = ({ run, workItem }) =>
    run.authorityId === "authority-1" &&
    run.runtimeGeneration === "ts-v0" &&
    run.policySnapshotId === "policy-1" &&
    workItem.runId === run.runId
      ? { outcome: "allow" }
      : { outcome: "deny", reasonCode: "fixture-policy-denied" };
  const options: SqliteWorkflowCompositionOptions = {
    ...gateCompositionOptions,
    scheduler: { authorize: (input) => authorize(input) },
  };
  const composition = f.store.experimentalWorkflowRunCompositionStore(options);
  const started = await f.start();
  const root = {
    tenantId: started.run.state.tenantId,
    runId: started.run.state.runId,
  };
  return {
    ...f,
    clock,
    options,
    composition,
    started,
    root,
    binding: started.run.state.workflowVersionBinding!,
    authorize: (next: WorkflowSchedulerAuthorization) => {
      authorize = next;
    },
  };
}
