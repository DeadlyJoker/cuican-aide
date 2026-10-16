import type { PoolClient } from "pg";
import {
  WorkflowDeploymentPolicy,
  ApplicationError,
  type WorkflowDeploymentConfiguration,
  type WorkflowAgentVersionDecoder,
  type WorkflowDeploymentReader,
  type WorkflowHumanGateAuthority,
} from "@crewon/application";
import type { RunState, WorkflowContentDigester } from "@crewon/domain";
import type {
  ExperimentalPostgresWorkflowRunAdmissionStore,
  PostgresWorkflowRouteResolver,
  PostgresWorkflowAdmissionPolicy,
} from "./postgres-workflow-run-admission.ts";
import type {
  ExperimentalPostgresWorkflowRunCompositionStore,
  PostgresWorkflowCompositionOptions,
} from "./postgres-workflow-run-composition.ts";

/** One shared policy used by both host compositions, with the actual transaction client. */
export function createPostgresWorkflowDeployment(input: {
  configuration: WorkflowDeploymentConfiguration;
  decodeAgentVersion: WorkflowAgentVersionDecoder;
  digester: WorkflowContentDigester;
  reader(client: PoolClient): WorkflowDeploymentReader;
  migrateDefinition(): Promise<void>;
  loadRoot(
    client: PoolClient,
    authority: Pick<WorkflowHumanGateAuthority, "tenantId" | "runId">,
  ): Promise<RunState | null>;
  admission(
    resolve: PostgresWorkflowRouteResolver,
    policy: PostgresWorkflowAdmissionPolicy,
  ): ExperimentalPostgresWorkflowRunAdmissionStore;
  composition(
    options: PostgresWorkflowCompositionOptions,
  ): ExperimentalPostgresWorkflowRunCompositionStore;
}) {
  const policy = new WorkflowDeploymentPolicy(
    input.configuration,
    input.decodeAgentVersion,
    input.digester,
  );
  const reader = async (client: PoolClient) => {
    // Activation never locks a Run/Thread, so this release fence cannot form an aggregate lock cycle.
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtext($1))", [
      `agent-version-release:${policy.configuration.issuer.tenantId}`,
    ]);
    return input.reader(client);
  };
  const admission = input.admission(
    async (context) =>
      policy.resolveAdmissionRoute(context, await reader(context.client)),
    {
      authorizeCreatedRun: async ({ client, run }) => {
        await policy.authorizeScheduler(run, await reader(client));
      },
    },
  );
  const composition = input.composition({
    maximumParallelNodes: policy.configuration.maximumParallelNodes,
    authorize: async ({ client, run }) =>
      policy.authorizeScheduler(run, await reader(client)),
    resolveChildRoute: async ({ client, parent, node }) =>
      policy.resolveChildRoute(parent, node, await reader(client)),
    humanGates: {
      authorize: async ({ client, actor, authority }) => {
        const run = await input.loadRoot(client, authority);
        if (!run)
          return {
            outcome: "deny",
            reasonCode: "workflow_gate_authorization_denied",
          };
        try {
          return await policy.authorizeGate(
            { run, actor, authority },
            await reader(client),
          );
        } catch (error) {
          if (
            error instanceof ApplicationError &&
            error.category === "authorization"
          )
            return { outcome: "deny", reasonCode: error.code };
          throw error;
        }
      },
    },
  });
  return Object.freeze({
    admission,
    composition,
    migrate: async () => {
      await input.migrateDefinition();
      await admission.migrate();
      await composition.migrate();
    },
  });
}
