import {
  ApplicationError,
  DeliveryApplicationService,
  type AuthorizationPort,
  type DeliveryStorePort,
  type RunApplicationService,
  type ThreadApplicationService,
} from "@crewon/application";
import { SpreadsheetEngine } from "@crewon/artifacts";

export function composeDeliveries(config: {
  store: DeliveryStorePort;
  threads: ThreadApplicationService;
  runs: RunApplicationService;
  authorization: AuthorizationPort;
}) {
  return new DeliveryApplicationService({
    store: config.store,
    engine: new SpreadsheetEngine(),
    access: {
      async check(actor, threadId, access) {
        const thread = await config.threads.getThread(actor, threadId);
        if (thread.createdByActorId !== actor.actorId)
          throw new ApplicationError(
            "authorization",
            "delivery_owner_forbidden",
          );
        if (access === "write") {
          if (thread.status !== "active")
            throw new ApplicationError(
              "conflict",
              "delivery_thread_not_active",
            );
          const decision = await config.authorization.authorize({
            actor,
            action: "thread:workspace:write",
            resource: {
              kind: "thread",
              tenantId: actor.tenantId,
              spaceId: actor.spaceId,
              threadId,
            },
          });
          if (decision.outcome !== "allow")
            throw new ApplicationError("authorization", decision.reasonCode);
        }
      },
      async checkRun(actor, threadId, runId) {
        const run = await config.runs.getRun(actor, runId);
        if (
          run.threadId !== threadId ||
          run.createdByActorId !== actor.actorId ||
          run.tenantId !== actor.tenantId ||
          run.spaceId !== actor.spaceId
        )
          throw new ApplicationError("authorization", "delivery_run_forbidden");
      },
    },
  });
}
