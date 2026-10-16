import { parseAgentVersionAsset } from "@crewon/agent-version";
import {
  canonicalJson,
  type ActorContext,
  type WorkflowDeploymentConfiguration,
} from "@crewon/application";
import type { PostgresDomainStore } from "@crewon/store";
import { NodeSha256ContentDigester } from "./standalone-adapters.ts";

export type PreparedWorkflowControl = ReturnType<
  PostgresDomainStore["workflowDeployment"]
>;
export async function prepareWorkflowControl(input: {
  store: PostgresDomainStore;
  configuration: WorkflowDeploymentConfiguration | undefined;
  actor: ActorContext;
  defaultAgentVersionId: string;
}): Promise<PreparedWorkflowControl | undefined> {
  const digester = new NodeSha256ContentDigester();
  if (input.configuration === undefined) {
    // The public definition API already exists independently of execution opt-in.
    await input.store.workflowVersionStore(digester).migrate();
    return undefined;
  }
  if (
    canonicalJson(input.configuration.issuer) !== canonicalJson(input.actor) ||
    input.configuration.route.agentVersionId !== input.defaultAgentVersionId
  )
    throw new Error("workflow_control_deployment_mismatch");
  const capability = input.store.workflowDeployment(
    input.configuration,
    (asset) => parseAgentVersionAsset(asset, digester),
    digester,
  );
  await capability.migrate();
  return capability;
}
