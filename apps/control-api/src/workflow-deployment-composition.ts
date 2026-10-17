import { parseAgentVersionAsset } from "@crewon/agent-version";
import {
  canonicalJson,
  captureWorkflowDeploymentConfiguration,
  type ActorContext,
  type WorkflowDeploymentConfiguration,
} from "@crewon/application";
import type { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import { NodeSha256ContentDigester } from "./standalone-adapters.ts";
import { WorkflowRecoveryContext } from "./workflow-recovery-context.ts";

export type PreparedWorkflowControl = {
  admission:
    | ReturnType<PostgresDomainStore["workflowDeployment"]>["admission"]
    | ReturnType<SqliteRunStore["workflowDeployment"]>["admission"];
  composition:
    | ReturnType<PostgresDomainStore["workflowDeployment"]>["composition"]
    | ReturnType<SqliteRunStore["workflowDeployment"]>["composition"];
  migrate(): void | Promise<void>;
  recovery: WorkflowRecoveryContext;
};

/** SQLite policy and migrations are synchronous on the owning connection. */
export function prepareSqliteWorkflowControl(input: {
  store: SqliteRunStore;
  configuration: WorkflowDeploymentConfiguration;
  actor: ActorContext;
  defaultAgentVersionId: string;
}): PreparedWorkflowControl {
  const digester = new NodeSha256ContentDigester();
  const configuration = captureWorkflowDeploymentConfiguration(
    input.configuration,
  );
  if (
    canonicalJson(configuration.issuer) !== canonicalJson(input.actor) ||
    configuration.route.agentVersionId !== input.defaultAgentVersionId
  )
    throw new Error("workflow_control_deployment_mismatch");
  const capability = input.store.workflowDeployment(
    configuration,
    (asset) => parseAgentVersionAsset(asset, digester),
    digester,
  );
  return Object.freeze({
    ...capability,
    recovery: new WorkflowRecoveryContext({
      configuration,
      namespace: `sqlite:${capability.identity}`,
    }),
  });
}
export async function prepareWorkflowControl(input: {
  store: PostgresDomainStore;
  configuration: WorkflowDeploymentConfiguration | undefined;
  actor: ActorContext;
  defaultAgentVersionId: string;
  namespace: string;
}): Promise<PreparedWorkflowControl | undefined> {
  const digester = new NodeSha256ContentDigester();
  if (input.configuration === undefined) {
    // The public definition API already exists independently of execution opt-in.
    await input.store.workflowVersionStore(digester).migrate();
    return undefined;
  }
  const configuration = captureWorkflowDeploymentConfiguration(
    input.configuration,
  );
  const recovery = new WorkflowRecoveryContext({
    configuration,
    namespace: input.namespace,
  });
  if (
    canonicalJson(configuration.issuer) !== canonicalJson(input.actor) ||
    configuration.route.agentVersionId !== input.defaultAgentVersionId
  )
    throw new Error("workflow_control_deployment_mismatch");
  const capability = input.store.workflowDeployment(
    configuration,
    (asset) => parseAgentVersionAsset(asset, digester),
    digester,
  );
  await capability.migrate();
  return Object.freeze({
    ...capability,
    recovery,
  });
}
