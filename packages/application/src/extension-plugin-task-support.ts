import {
  assertPluginTaskAdmission,
  extensionCanonicalJson,
  extensionDigest,
  extensionOpaqueId,
  parsePluginTaskAdmissionPin,
  parsePluginTaskAdmission,
  parseProjectGenerationReference,
  pluginInstallationOpaqueId,
  type PluginTaskAdmission,
  type PluginTaskAdmissionPin,
  type ExtensionRunBinding,
  type ProjectGenerationReference,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { ExtensionCreditQuotePort } from "./extension-credit-quote-port.ts";
import type { CreateExtensionTaskCommand } from "./extension-task-application-service.ts";
import type {
  CommitExtensionTurnInput,
  CommitExtensionTurnOptions,
  ExtensionMutationReceipt,
  ExtensionStore,
} from "./extension-store-port.ts";
import { extensionCommand } from "./extension-application-support.ts";
import { projectGenerationTaskReceipt } from "./project-generation-task-receipt.ts";

/** Trusted host callback, never a plugin or HTTP-supplied identity/permission claim. */
export interface PluginTaskCommitAuthorityPort {
  assertCurrent(
    input: Readonly<{
      actor: ActorContext;
      pin: PluginTaskAdmissionPin;
    }>,
  ): Promise<void>;
  /** Optional negative fence. Must be synchronous and safe while the original Store transaction is held. */
  assertActive?(
    input: Readonly<{ actor: ActorContext; pin: PluginTaskAdmissionPin }>,
  ): void;
}

export function capturePluginTaskCommitAuthority(
  input: PluginTaskCommitAuthorityPort | undefined,
): PluginTaskCommitAuthorityPort | null {
  if (input === undefined) return null;
  const current = pluginTaskAuthorityMethod(input, "assertCurrent");
  const active = pluginTaskAuthorityMethod(input, "assertActive");
  if (
    typeof current !== "function" ||
    (active !== undefined && typeof active !== "function")
  )
    throw new ApplicationError("conflict", "plugin_task_authority_unavailable");
  return Object.freeze({
    async assertCurrent(
      provided: Parameters<PluginTaskCommitAuthorityPort["assertCurrent"]>[0],
    ) {
      if ((await current.call(input, provided)) !== undefined)
        throw new ApplicationError(
          "conflict",
          "plugin_task_authority_unavailable",
        );
    },
    ...(active === undefined
      ? {}
      : {
          assertActive(
            provided: Parameters<
              NonNullable<PluginTaskCommitAuthorityPort["assertActive"]>
            >[0],
          ) {
            const result: unknown = active.call(input, provided);
            if (result instanceof Promise) void result.catch(() => {});
            if (result !== undefined)
              throw new ApplicationError(
                "conflict",
                "plugin_task_authority_unavailable",
              );
          },
        }),
  });
}
function pluginTaskAuthorityMethod(input: object, name: string): unknown {
  let owner: object | null = input;
  while (owner !== null && owner !== Object.prototype) {
    const field = Object.getOwnPropertyDescriptor(owner, name);
    if (field !== undefined) {
      if (!("value" in field))
        throw new ApplicationError(
          "conflict",
          "plugin_task_authority_unavailable",
        );
      return field.value;
    }
    owner = Object.getPrototypeOf(owner);
  }
  return undefined;
}

export function checkedPluginTaskPin(input: unknown): PluginTaskAdmissionPin {
  try {
    return parsePluginTaskAdmissionPin(input);
  } catch (error) {
    throw new ApplicationError("validation", "plugin_task_admission_invalid", {
      cause: error,
    });
  }
}
export function pluginTaskActor(
  input: ActorContext,
  pin: PluginTaskAdmissionPin,
): ActorContext {
  const value = extensionCommand(input, [
    "principalId",
    "actorId",
    "tenantId",
    "spaceId",
  ]);
  let actor: ActorContext;
  try {
    actor = Object.freeze({
      principalId: pluginInstallationOpaqueId(value.principalId),
      actorId: extensionOpaqueId(value.actorId),
      tenantId: extensionOpaqueId(value.tenantId),
      spaceId: extensionOpaqueId(value.spaceId),
    });
  } catch (error) {
    throw new ApplicationError("validation", "actor_context_invalid", {
      cause: error,
    });
  }
  if (
    ["principalId", "actorId", "tenantId", "spaceId"].some(
      (key) =>
        actor[key as keyof ActorContext] !==
        pin[key as keyof PluginTaskAdmissionPin],
    )
  )
    throw new ApplicationError(
      "authorization",
      "plugin_task_admission_owner_mismatch",
    );
  return actor;
}
export function requirePluginTaskStore(
  store: ExtensionStore,
  mode: "metered" | "unmetered" = "metered",
): void {
  if (
    store.pluginAdmissionVersion !== "crewon.plugin-task-admission.v1" ||
    typeof store.loadPluginTaskAdmission !== "function"
  )
    throw new ApplicationError("conflict", "plugin_task_admission_unavailable");
  if (
    mode === "metered" &&
    store.creditAdmissionVersion !== "crewon.extension-credit-admission.v0"
  )
    throw new ApplicationError(
      "conflict",
      "extension_credit_admission_unavailable",
    );
  if (
    mode === "unmetered" &&
    (store.unmeteredAdmissionVersion !==
      "crewon.plugin-task-unmetered-admission.v1" ||
      typeof store.loadPluginTaskUnmeteredAdmission !== "function")
  )
    throw new ApplicationError("conflict", "plugin_task_unmetered_unavailable");
}
export function requirePluginTaskQuotes(
  quotes: ExtensionCreditQuotePort | undefined,
): void {
  if (typeof quotes?.quoteGeneration !== "function")
    throw new ApplicationError(
      "conflict",
      "extension_credit_quote_unavailable",
    );
}

/** Shared lookup key for the original task receipt; this does not validate its command digest. */
export function pluginTaskReceiptKey(
  input: Readonly<{
    actor: ActorContext;
    profileId: string;
    pluginId: string;
    idempotencyKey: string;
  }>,
  digester: ContentDigester,
): string {
  const { actor, profileId, pluginId, idempotencyKey } = input;
  return `plugin-task:${extensionDigest(digester.sha256(extensionCanonicalJson([actor.tenantId, actor.spaceId, profileId, actor.principalId, actor.actorId, pluginId, idempotencyKey]))).slice(7)}`;
}

export function pluginTaskReceipt(
  actor: ActorContext,
  command: CreateExtensionTaskCommand,
  pin: PluginTaskAdmissionPin,
  digester: ContentDigester,
): ExtensionMutationReceipt {
  return Object.freeze({
    actorId: actor.actorId,
    idempotencyKey: pluginTaskReceiptKey(
      {
        actor,
        profileId: pin.profileId,
        pluginId: pin.pluginId,
        idempotencyKey: command.idempotencyKey,
      },
      digester,
    ),
    requestDigest: extensionDigest(
      digester.sha256(
        extensionCanonicalJson({
          schemaVersion: "crewon.plugin-task-command.v1",
          actor,
          pin,
          command,
        }),
      ),
    ),
  });
}
/** Replay keeps the original full-pin v1 digest and audit epoch, including the
 * existing project-generation wrapper when a captured reference is supplied.
 * The current invocation remains independently authorized with its fresh pin. */
export async function resolvePluginTaskReceipt(
  input: Readonly<{
    store: Pick<ExtensionStore, "loadPluginTaskAdmissionByReceipt">;
    actor: ActorContext;
    command: CreateExtensionTaskCommand;
    pin: PluginTaskAdmissionPin;
    digester: ContentDigester;
    projectGeneration?: ProjectGenerationReference;
    projectConversationReceipt?: (
      base: ExtensionMutationReceipt,
    ) => ExtensionMutationReceipt;
  }>,
): Promise<
  Readonly<{
    receipt: ExtensionMutationReceipt;
    receiptPin: PluginTaskAdmissionPin;
  }>
> {
  const pin = checkedPluginTaskPin(input.pin);
  const actor = pluginTaskActor(input.actor, pin);
  const command = JSON.parse(
    extensionCanonicalJson(input.command),
  ) as CreateExtensionTaskCommand;
  const reference =
    input.projectGeneration === undefined
      ? undefined
      : parseProjectGenerationReference(input.projectGeneration);
  const digester = Object.freeze({
    sha256: input.digester.sha256.bind(input.digester),
  });
  const makeReceipt = (receiptPin: PluginTaskAdmissionPin) => {
    const base = pluginTaskReceipt(actor, command, receiptPin, digester);
    const receipt =
      reference === undefined
        ? base
        : projectGenerationTaskReceipt(base, reference, digester);
    return input.projectConversationReceipt?.(receipt) ?? receipt;
  };
  const receipt = makeReceipt(pin);
  const store = input.store;
  const lookup = store.loadPluginTaskAdmissionByReceipt;
  if (lookup === undefined) return { receipt, receiptPin: pin };
  const saved = await lookup.call(store, {
    tenantId: pin.tenantId,
    spaceId: pin.spaceId,
    profileId: pin.profileId,
    pluginId: pin.pluginId,
    principalId: pin.principalId,
    actorId: pin.actorId,
    idempotencyKey: receipt.idempotencyKey,
  });
  if (saved === null) return { receipt, receiptPin: pin };
  let previous: PluginTaskAdmission;
  try {
    previous = parsePluginTaskAdmission(saved);
  } catch (cause) {
    throw new ApplicationError("internal", "plugin_task_admission_invalid", {
      cause,
    });
  }
  const {
    schemaVersion: _schema,
    runId: _run,
    threadId: _thread,
    extensionBindingDigest: _binding,
    requestDigest: _request,
    idempotencyKey: _key,
    ...previousPin
  } = previous;
  // Selection revision and every business/identity field remain exact. Only
  // the historical issuance epoch is restored while verifying original data.
  const receiptPin = checkedPluginTaskPin({
    ...pin,
    authorityEpoch: previous.authorityEpoch,
  });
  const historical = makeReceipt(receiptPin);
  if (
    extensionCanonicalJson(previousPin) !==
      extensionCanonicalJson(receiptPin) ||
    previous.threadId !== command.threadId ||
    previous.idempotencyKey !== historical.idempotencyKey ||
    previous.requestDigest !== historical.requestDigest
  )
    throw new ApplicationError("conflict", "extension_idempotency_conflict");
  return { receipt: historical, receiptPin };
}

export function pluginTaskAdmission(
  pin: PluginTaskAdmissionPin,
  binding: ExtensionRunBinding,
  receipt: ExtensionMutationReceipt,
  digester: ContentDigester,
): PluginTaskAdmission {
  return assertPluginTaskAdmission(
    {
      admission: {
        schemaVersion: "crewon.plugin-task-admission.v1",
        ...pin,
        runId: binding.runId,
        threadId: binding.threadId,
        extensionBindingDigest: binding.bindingDigest,
        requestDigest: receipt.requestDigest,
        idempotencyKey: receipt.idempotencyKey,
      },
      binding,
      receipt,
    },
    digester,
  );
}
export async function assertSavedPluginTask(
  input: Readonly<{
    store: Pick<ExtensionStore, "loadPluginTaskAdmission">;
    pin: PluginTaskAdmissionPin;
    binding: ExtensionRunBinding;
    threadId: string;
    committedBinding?: ExtensionRunBinding;
    receipt: ExtensionMutationReceipt;
    digester: ContentDigester;
  }>,
): Promise<void> {
  try {
    if (
      input.binding.threadId !== input.threadId ||
      (input.committedBinding !== undefined &&
        extensionCanonicalJson(input.binding) !==
          extensionCanonicalJson(input.committedBinding))
    )
      throw new Error("plugin_task_admission_result_mismatch");
    const raw = await input.store.loadPluginTaskAdmission!({
      tenantId: input.binding.tenantId,
      spaceId: input.binding.spaceId,
      runId: input.binding.runId,
    });
    if (raw === null) throw new Error("plugin_task_admission_missing");
    const saved = assertPluginTaskAdmission(
      { admission: raw, binding: input.binding, receipt: input.receipt },
      input.digester,
    );
    if (saved.principalId !== input.pin.principalId)
      throw new ApplicationError(
        "authorization",
        "plugin_task_admission_owner_mismatch",
      );
    const expected = pluginTaskAdmission(
      input.pin,
      input.binding,
      input.receipt,
      input.digester,
    );
    if (extensionCanonicalJson(saved) !== extensionCanonicalJson(expected))
      throw new Error("plugin_task_admission_pin_mismatch");
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError("internal", "plugin_task_admission_invalid", {
      cause: error,
    });
  }
}
export async function commitPluginTask(
  store: ExtensionStore,
  input: CommitExtensionTurnInput,
  options?: CommitExtensionTurnOptions,
) {
  try {
    return await store.commitExtensionTurn(input, options);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "plugin_task_admission_conflict"
    )
      throw new ApplicationError("conflict", "plugin_task_admission_conflict", {
        cause: error,
      });
    throw error;
  }
}
