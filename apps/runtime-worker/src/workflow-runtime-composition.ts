import { parseAgentVersionAsset } from "@crewon/agent-version";
import {
  canonicalJson,
  type WorkflowDeploymentConfiguration,
  type ContentDigester,
} from "@crewon/application";
import type { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import type { RunRoute } from "@crewon/application";
import { ExperimentalWorkflowScheduler } from "./workflow-scheduler.ts";

export async function composeWorkflowScheduler(input: {
  store: PostgresDomainStore | SqliteRunStore;
  configuration: WorkflowDeploymentConfiguration | undefined;
  runtimeTenantId: string;
  route: RunRoute;
  digester: ContentDigester;
}): Promise<ExperimentalWorkflowScheduler | undefined> {
  if (input.configuration === undefined) return undefined;
  if (
    input.configuration.issuer.tenantId !== input.runtimeTenantId ||
    canonicalJson(input.configuration.route) !== canonicalJson(input.route)
  )
    throw new Error("workflow_runtime_deployment_mismatch");
  const capability = input.store.workflowDeployment(
    input.configuration,
    (asset) => parseAgentVersionAsset(asset, input.digester),
    input.digester,
  );
  await capability.migrate();
  return new ExperimentalWorkflowScheduler(input.store, capability.composition);
}
