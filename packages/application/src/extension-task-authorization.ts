import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import type { ExtensionRunBinding } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import {
  authorizeExtension,
  extensionScopeFor,
} from "./extension-application-support.ts";
export async function authorizeExtensionTaskThread(
  authorization: AuthorizationPort,
  actor: ActorContext,
  threadId: string,
) {
  for (const request of [
    {
      actor,
      action: "thread:message:append" as const,
      resource: {
        kind: "thread" as const,
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        threadId,
      },
    },
    {
      actor,
      action: "run:create" as const,
      resource: {
        kind: "run" as const,
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        threadId,
        runId: null,
      },
    },
  ])
    if ((await authorization.authorize(request)).outcome !== "allow")
      throw new ApplicationError("authorization", "authorization_denied");
}

export async function authorizeExtensionTaskQuerySource(
  authorization: AuthorizationPort,
  actor: ActorContext,
  pluginId: string,
  source: ExtensionRunBinding,
) {
  await authorizeExtension(
    authorization,
    actor,
    "extension:query",
    extensionScopeFor(actor, pluginId),
  );
  const decision = await authorization.authorize({
    actor,
    action: "run:read",
    resource: {
      kind: "run",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      threadId: source.threadId,
      runId: source.runId,
    },
  });
  if (decision.outcome !== "allow")
    throw new ApplicationError("authorization", "authorization_denied");
}
