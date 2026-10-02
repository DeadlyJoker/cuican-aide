import {
  assertPluginQueryTaskAdmission,
  extensionCanonicalJson,
  extensionDigest,
  parsePluginQueryTaskAdmission,
  type PluginTaskAdmissionPin,
  type ExtensionRunBinding,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { CreateExtensionTaskCommand } from "./extension-task-application-service.ts";
import type {
  ExtensionStore,
  ExtensionMutationReceipt,
} from "./extension-store-port.ts";
import type { PluginQuerySource } from "./plugin-query-source.ts";
import { ApplicationError } from "./application-error.ts";
export function pluginQueryTaskReceipt(
  actor: ActorContext,
  command: CreateExtensionTaskCommand,
  pin: PluginTaskAdmissionPin,
  source: PluginQuerySource,
  digester: ContentDigester,
): ExtensionMutationReceipt {
  return Object.freeze({
    actorId: actor.actorId,
    idempotencyKey: `plugin-query:${extensionDigest(digester.sha256(extensionCanonicalJson([actor.tenantId, actor.spaceId, pin.profileId, actor.principalId, actor.actorId, pin.pluginId, command.idempotencyKey]))).slice(7)}`,
    requestDigest: extensionDigest(
      digester.sha256(
        extensionCanonicalJson({
          schemaVersion: "crewon.plugin-query-task-command.v1",
          actor,
          pin,
          command,
          source,
        }),
      ),
    ),
  });
}
export async function assertSavedPluginQueryTask(
  input: Readonly<{
    store: ExtensionStore;
    pin: PluginTaskAdmissionPin;
    source: PluginQuerySource;
    binding: ExtensionRunBinding;
    receipt: ExtensionMutationReceipt;
    digester: ContentDigester;
  }>,
): Promise<void> {
  const raw = await input.store.loadPluginQueryTaskAdmission!({
    ...input.binding,
  });
  if (raw === null)
    throw new ApplicationError("internal", "plugin_query_admission_missing");
  const saved = assertPluginQueryTaskAdmission(
    {
      admission: raw,
      binding: input.binding,
      sourceBinding: input.source.binding,
      receipt: input.receipt,
    },
    input.digester,
  );
  const expected = parsePluginQueryTaskAdmission({
    schemaVersion: "crewon.plugin-query-task-admission.v1",
    ...input.pin,
    runId: input.binding.runId,
    threadId: input.binding.threadId,
    extensionBindingDigest: input.binding.bindingDigest,
    requestDigest: input.receipt.requestDigest,
    idempotencyKey: input.receipt.idempotencyKey,
    source: input.source.admission,
    operationId: input.source.operationId,
  });
  if (extensionCanonicalJson(saved) !== extensionCanonicalJson(expected))
    throw new ApplicationError("internal", "plugin_query_admission_mismatch");
}
