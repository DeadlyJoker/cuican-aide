import type { ActorContext } from "@crewon/application";
import type { RunState } from "@crewon/domain";
import type {
  ProjectToolsAuthorizationInvocation,
  ProjectToolsServiceOwnerDependencies,
} from "./project-tools-service-owner.ts";
export function assertProjectToolOwnershipDeployment(
  input: Pick<
    ProjectToolsServiceOwnerDependencies,
    "projectOwnership" | "stageAdmission"
  >,
): void {
  if (
    input.projectOwnership !== undefined &&
    (input.projectOwnership !== "plugin-project-v1" ||
      input.stageAdmission == null)
  )
    throw new Error("plugin_project_tools_authority_denied");
}
/** External live dispatch/identity/PDP checks. SQL execution facts use the original borrowed connection separately. */
export function projectToolReadPolicyFence(
  input: Readonly<{
    actor: ActorContext;
    expectedRun: RunState;
    receiptId: string;
    authorization: ProjectToolsAuthorizationInvocation;
    dependencies: Pick<
      ProjectToolsServiceOwnerDependencies,
      "authorizeCurrent" | "authorization" | "runs"
    >;
    assertActive(): void;
    resolveActor(): Promise<ActorContext>;
  }>,
): () => Promise<void> {
  return async () => {
    input.assertActive();
    await input.dependencies.authorizeCurrent(input.authorization);
    await input.resolveActor();
    const run = await input.dependencies.runs.loadRunInSpace({
      tenantId: input.actor.tenantId,
      spaceId: input.actor.spaceId,
      runId: input.expectedRun.runId,
    });
    if (
      run === null ||
      run.cancelRequested ||
      (run.status !== "running" &&
        !(
          run.status === "reconciling" &&
          run.reconciliationReceiptId === input.receiptId
        )) ||
      (
        [
          "runId",
          "threadId",
          "tenantId",
          "spaceId",
          "createdByActorId",
          "authorityId",
          "runtimeGeneration",
          "agentVersionId",
          "policySnapshotId",
          "workspaceBindingId",
        ] as const
      ).some((key) => run[key] !== input.expectedRun[key])
    )
      throw new Error("plugin_project_tools_authority_denied");
    const decision = await input.dependencies.authorization.authorize({
      actor: input.actor,
      action: "creativeProject:read",
      resource: {
        kind: "creativeProject",
        tenantId: input.actor.tenantId,
        spaceId: input.actor.spaceId,
        projectId: input.authorization.projectId,
      },
    });
    if (decision.outcome !== "allow")
      throw new Error("plugin_project_tools_authority_denied");
    input.assertActive();
  };
}
