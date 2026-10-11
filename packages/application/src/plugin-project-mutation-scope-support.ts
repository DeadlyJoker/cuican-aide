import { extensionCanonicalJson, creativeProjectDigest } from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type { CreativeProjectMutationCommand } from "./creative-project-commands.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { CreativeProjectMutationReceipt } from "./creative-project-store-port.ts";
import {
  qualifyPluginProjectMutationScope,
  type PluginProjectMutationScope,
} from "./plugin-project-read-scope.ts";

export function scopedPluginMetadataReceipt(
  scope: PluginProjectMutationScope,
  actor: ActorContext,
  command: CreativeProjectMutationCommand,
  receipt: CreativeProjectMutationReceipt,
  digester: ContentDigester,
) {
  const source = qualifyPluginProjectMutationScope(scope);
  for (const key of ["tenantId", "spaceId", "principalId", "actorId"] as const)
    if (actor[key] !== source.scope[key])
      throw new Error("plugin_project_mutation_actor_mismatch");
  const input = source.request.input as Readonly<Record<string, unknown>>;
  if (
    extensionCanonicalJson(command) !==
    extensionCanonicalJson({
      ...(input.request as object),
      projectId: input.projectId,
      idempotencyKey: input.idempotencyKey,
    })
  )
    throw new Error("plugin_project_mutation_command_mismatch");
  const digest = creativeProjectDigest(
    digester.sha256(
      extensionCanonicalJson({
        version: "crewon.plugin-project-mutation-receipt.v1",
        scope: source.scope,
        action: source.request.action,
        projectId: input.projectId,
        externalKey: receipt.idempotencyKey,
      }),
    ),
  );
  source.assertActive();
  return Object.freeze({
    idempotencyKey: `pm1_${digest.slice(7)}`,
    requestDigest: receipt.requestDigest,
  });
}
