import {
  parseProjectContextResponse,
  type PublicProjectContextScope,
} from "@crewon/contracts/project-context";
import type {
  PluginTaskAdmission,
  ProjectStageRunAdmission,
} from "@crewon/domain";
import type { ActorContext } from "@crewon/application";
import type {
  ProjectToolsDispatchInvocation,
  ProjectToolsServiceOwnerDependencies,
} from "./project-tools-service-owner.ts";
type Invocation = ProjectToolsDispatchInvocation & {
  pending: Set<Promise<unknown>>;
};
export function readProjectContextScope<T extends Invocation>(
  input: Readonly<{ command: unknown }>,
  host: {
    invocations: WeakMap<object, T>;
    check(invocation: T): { receipt: { receiptId: string } };
    ownerSignal: AbortSignal;
    dependencies: ProjectToolsServiceOwnerDependencies;
    actor(actorId: string, signal: AbortSignal): Promise<ActorContext>;
    admission: PluginTaskAdmission;
    stage: ProjectStageRunAdmission | null;
    pending: Set<Promise<unknown>>;
  },
): Promise<Readonly<{ scope: PublicProjectContextScope | null }>> {
  try {
    const d = Object.getOwnPropertyDescriptors(input ?? {});
    if (
      input === null ||
      typeof input !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).length !== 1 ||
      !d.command?.enumerable ||
      !("value" in d.command) ||
      d.command.value === null ||
      typeof d.command.value !== "object"
    )
      denied();
    const invocation = host.invocations.get(d.command.value);
    if (
      invocation === undefined ||
      invocation.method === "cancel" ||
      invocation.pending.size >= 64
    )
      denied();
    host.check(invocation);
    const task = (async () => {
      const operation = {
        ...invocation,
        signal: AbortSignal.any([invocation.signal, host.ownerSignal]),
        operationId: "project_context_read",
        projectId: host.stage?.projectId ?? null,
      };
      await host.dependencies.authorizeCurrent(operation);
      host.check(invocation);
      await host.actor(host.admission.actorId, operation.signal);
      const run = await host.dependencies.runs.loadRunInSpace({
        tenantId: host.admission.tenantId,
        spaceId: host.admission.spaceId,
        runId: host.admission.runId,
      });
      if (
        run === null ||
        run.cancelRequested ||
        run.createdByActorId !== host.admission.actorId ||
        run.threadId !== host.admission.threadId ||
        (run.status !== "running" &&
          !(
            run.status === "reconciling" &&
            run.reconciliationReceiptId ===
              host.check(invocation).receipt.receiptId
          ))
      )
        denied();
      if (host.stage !== null) {
        const actor = await host.actor(run.createdByActorId, operation.signal);
        if (
          (
            await host.dependencies.authorization.authorize({
              actor,
              action: "creativeProject:read",
              resource: {
                kind: "creativeProject",
                tenantId: actor.tenantId,
                spaceId: actor.spaceId,
                projectId: host.stage.projectId,
              },
            })
          ).outcome !== "allow"
        )
          denied();
      }
      await host.dependencies.authorizeCurrent(operation);
      host.check(invocation);
      const s = host.stage;
      return parseProjectContextResponse({
        scope:
          s === null
            ? null
            : {
                projectId: s.projectId,
                threadId: s.threadId,
                runId: s.runId,
                bindingId: s.bindingId,
                bindingRevision: s.bindingRevision,
                stage: s.stage,
                sources: s.sources,
                allowedOperations: s.allowedOperations,
                contentDigest: s.contentDigest,
              },
      });
    })();
    invocation.pending.add(task);
    host.pending.add(task);
    void task
      .finally(() => {
        invocation.pending.delete(task);
        host.pending.delete(task);
      })
      .catch(() => {});
    return task;
  } catch (error) {
    return Promise.reject(error);
  }
}
function denied(): never {
  throw new Error("plugin_project_tools_authority_denied");
}
