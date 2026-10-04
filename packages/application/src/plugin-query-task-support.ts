import {
  assertPluginQueryTaskAdmission,
  extensionCanonicalJson,
  extensionDigest,
  parseExtensionRunBinding,
  parsePluginTaskAdmission,
  parsePluginQueryTaskAdmission,
  parseProjectQueryReference,
  type PluginQueryTaskAdmission,
  type PluginTaskAdmissionPin,
  type ExtensionRunBinding,
  type ProjectQueryReference,
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
import {
  checkedPluginTaskPin,
  pluginTaskActor,
} from "./extension-plugin-task-support.ts";
import { projectQueryTaskReceipt } from "./project-query-task-receipt.ts";

export type PluginQueryReceiptResolution = Readonly<{
  receipt: ExtensionMutationReceipt;
  receiptPin: PluginTaskAdmissionPin;
  historicalAdmission: PluginQueryTaskAdmission | null;
}>;

/** Capture the optional actual receipt reader without evaluating accessors or retaining replaceable methods. */
export function capturePluginQueryReceiptLookup(
  store: Pick<ExtensionStore, "loadPluginQueryTaskAdmissionByReceipt">,
): Pick<ExtensionStore, "loadPluginQueryTaskAdmissionByReceipt"> {
  for (
    let receiver: object | null = store, depth = 0;
    receiver !== null && depth < 32;
    receiver = Object.getPrototypeOf(receiver), depth++
  ) {
    const field = Object.getOwnPropertyDescriptor(
      receiver,
      "loadPluginQueryTaskAdmissionByReceipt",
    );
    if (field === undefined) continue;
    if (
      !Object.hasOwn(field, "value") ||
      (field.value !== undefined && typeof field.value !== "function")
    )
      throw new ApplicationError(
        "internal",
        "plugin_query_receipt_port_invalid",
      );
    return Object.freeze(
      field.value === undefined
        ? {}
        : {
            loadPluginQueryTaskAdmissionByReceipt: field.value.bind(
              store,
            ) as NonNullable<
              ExtensionStore["loadPluginQueryTaskAdmissionByReceipt"]
            >,
          },
    );
  }
  return Object.freeze({});
}

/** Preserve the original full-pin query digest. Historical issuance never grants current permission. */
export async function resolvePluginQueryTaskReceipt(
  input: Readonly<{
    store: Pick<ExtensionStore, "loadPluginQueryTaskAdmissionByReceipt">;
    actor: ActorContext;
    command: CreateExtensionTaskCommand;
    pin: PluginTaskAdmissionPin;
    source: PluginQuerySource;
    project?: Readonly<{
      reference: ProjectQueryReference;
      generationLinkDigest: string;
    }>;
    digester: ContentDigester;
  }>,
): Promise<PluginQueryReceiptResolution> {
  const pin = checkedPluginTaskPin(input.pin);
  const actor = pluginTaskActor(input.actor, pin);
  const digester = Object.freeze({
    sha256: input.digester.sha256.bind(input.digester),
  });
  const command = JSON.parse(
    extensionCanonicalJson(input.command),
  ) as CreateExtensionTaskCommand;
  const source = Object.freeze({
    admission: parsePluginTaskAdmission(input.source.admission),
    binding: parseExtensionRunBinding(input.source.binding, digester),
    operationId: input.source.operationId,
  });
  const project =
    input.project === undefined
      ? undefined
      : Object.freeze({
          reference: parseProjectQueryReference(input.project.reference),
          generationLinkDigest: extensionDigest(
            input.project.generationLinkDigest,
          ),
        });
  const receiptFor = (receiptPin: PluginTaskAdmissionPin) => {
    const base = pluginQueryTaskReceipt(
      actor,
      command,
      receiptPin,
      source,
      digester,
    );
    return project === undefined
      ? base
      : projectQueryTaskReceipt(base, project, digester);
  };
  const receipt = receiptFor(pin);
  const store = capturePluginQueryReceiptLookup(input.store);
  const lookup = store.loadPluginQueryTaskAdmissionByReceipt;
  if (lookup === undefined)
    return { receipt, receiptPin: pin, historicalAdmission: null };
  const saved = await lookup.call(store, {
    tenantId: pin.tenantId,
    spaceId: pin.spaceId,
    profileId: pin.profileId,
    pluginId: pin.pluginId,
    principalId: pin.principalId,
    actorId: pin.actorId,
    idempotencyKey: receipt.idempotencyKey,
  });
  if (saved === null)
    return { receipt, receiptPin: pin, historicalAdmission: null };
  let previous: PluginQueryTaskAdmission;
  try {
    previous = parsePluginQueryTaskAdmission(saved);
  } catch (cause) {
    throw new ApplicationError("internal", "plugin_query_admission_invalid", {
      cause,
    });
  }
  const receiptPin = checkedPluginTaskPin({
    ...pin,
    authorityEpoch: previous.authorityEpoch,
  });
  const historical = receiptFor(receiptPin);
  if (
    extensionCanonicalJson(queryAdmissionPin(previous)) !==
      extensionCanonicalJson(receiptPin) ||
    previous.threadId !== command.threadId ||
    previous.operationId !== source.operationId ||
    extensionCanonicalJson(previous.source) !==
      extensionCanonicalJson(source.admission) ||
    command.intent.kind !== "query" ||
    command.intent.sourceRunId !== source.binding.runId ||
    command.intent.operationId !== source.operationId ||
    previous.idempotencyKey !== historical.idempotencyKey ||
    previous.requestDigest !== historical.requestDigest
  )
    throw new ApplicationError("conflict", "extension_idempotency_conflict");
  return { receipt: historical, receiptPin, historicalAdmission: previous };
}

export function queryAdmissionPin(
  admission: PluginQueryTaskAdmission,
): PluginTaskAdmissionPin {
  const {
    schemaVersion: _schema,
    runId: _run,
    threadId: _thread,
    extensionBindingDigest: _binding,
    requestDigest: _request,
    idempotencyKey: _key,
    source: _source,
    operationId: _operation,
    ...pin
  } = parsePluginQueryTaskAdmission(admission);
  return checkedPluginTaskPin(pin);
}

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
    store: Pick<ExtensionStore, "loadPluginQueryTaskAdmission">;
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
