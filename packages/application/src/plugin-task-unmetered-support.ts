import {
  assertPluginTaskFunding,
  createPluginTaskUnmeteredAdmission,
  parsePluginTaskUnmeteredAuthorization,
  type PluginTaskAdmission,
  type PluginTaskAdmissionPin,
  type PluginTaskUnmeteredAdmission,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type {
  CommitExtensionTurnOptions,
  CommitExtensionTurnResult,
  ExtensionMutationReceipt,
  ExtensionStore,
} from "./extension-store-port.ts";
import type {
  PluginTaskUnmeteredAuthorityPort,
  PluginTaskUnmeteredPreparedAuthority,
} from "./plugin-task-unmetered-authority-port.ts";
import { requirePluginTaskQuotes } from "./extension-plugin-task-support.ts";
import type { ExtensionCreditQuotePort } from "./extension-credit-quote-port.ts";

export function capturePluginTaskUnmeteredPort(
  input: PluginTaskUnmeteredAuthorityPort | undefined,
): PluginTaskUnmeteredAuthorityPort | undefined {
  if (input === undefined) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(
    input,
    "prepareGeneration",
  );
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "function"
  )
    throw new ApplicationError("conflict", "plugin_task_unmetered_unavailable");
  return Object.freeze({
    prepareGeneration: descriptor.value.bind(
      input,
    ) as PluginTaskUnmeteredAuthorityPort["prepareGeneration"],
  });
}

export function requirePluginTaskFinancialMode(
  store: ExtensionStore,
  quotes: ExtensionCreditQuotePort | undefined,
  unmetered: PluginTaskUnmeteredAuthorityPort | undefined,
): void {
  if (unmetered === undefined) {
    if (store.creditAdmissionVersion !== "crewon.extension-credit-admission.v0")
      throw new ApplicationError(
        "conflict",
        "extension_credit_admission_unavailable",
      );
    requirePluginTaskQuotes(quotes);
    return;
  }
  if (
    store.unmeteredAdmissionVersion !==
      "crewon.plugin-task-unmetered-admission.v1" ||
    typeof store.loadPluginTaskUnmeteredAdmission !== "function" ||
    typeof unmetered.prepareGeneration !== "function"
  )
    throw new ApplicationError("conflict", "plugin_task_unmetered_unavailable");
}
/** Captures data fields without executing accessors, including the trusted callbacks. */
export function capturePluginTaskUnmeteredAuthority(
  input: PluginTaskUnmeteredPreparedAuthority,
): PluginTaskUnmeteredPreparedAuthority {
  const names = ["authorization", "assertCurrent", "assertActive"] as const;
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== names.length ||
    Reflect.ownKeys(input).some(
      (key) =>
        typeof key !== "string" ||
        !names.includes(key as (typeof names)[number]),
    )
  )
    throw new ApplicationError(
      "conflict",
      "plugin_task_unmetered_authority_invalid",
    );
  const fields = Object.fromEntries(
    names.map((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      )
        throw new ApplicationError(
          "conflict",
          "plugin_task_unmetered_authority_invalid",
        );
      return [name, descriptor.value];
    }),
  );
  if (
    typeof fields.assertCurrent !== "function" ||
    typeof fields.assertActive !== "function"
  )
    throw new ApplicationError(
      "conflict",
      "plugin_task_unmetered_authority_invalid",
    );
  const authorization = parsePluginTaskUnmeteredAuthorization(
    fields.authorization,
  );
  return Object.freeze({
    authorization,
    assertCurrent: fields.assertCurrent.bind(input) as () => Promise<void>,
    assertActive: () => {
      if (
        Reflect.apply(fields.assertActive as () => void, input, []) !==
        undefined
      )
        throw new ApplicationError(
          "conflict",
          "plugin_task_unmetered_active_fence_invalid",
        );
    },
  });
}
export async function preparePluginTaskUnmeteredAuthority(
  port: PluginTaskUnmeteredAuthorityPort | undefined,
  actor: ActorContext,
  pin: PluginTaskAdmissionPin | null,
): Promise<PluginTaskUnmeteredPreparedAuthority | null> {
  if (port === undefined || pin === null) return null;
  const authority = capturePluginTaskUnmeteredAuthority(
    await port.prepareGeneration(Object.freeze({ actor, pin })),
  );
  authority.assertActive();
  await authority.assertCurrent();
  authority.assertActive();
  return authority;
}
export function pluginTaskFinancialOptions(
  authority: PluginTaskUnmeteredPreparedAuthority | null,
  options: CommitExtensionTurnOptions | undefined,
): CommitExtensionTurnOptions | undefined {
  return authority === null
    ? options
    : Object.freeze({ ...options, unmeteredAuthority: authority });
}
export function pluginTaskUnmeteredProof(
  authority: PluginTaskUnmeteredPreparedAuthority | null,
  task: PluginTaskAdmission | undefined,
  digester: ContentDigester,
): PluginTaskUnmeteredAdmission | undefined {
  if (authority === null) return undefined;
  if (task === undefined)
    throw new ApplicationError(
      "internal",
      "plugin_task_unmetered_task_required",
    );
  authority.assertActive();
  return createPluginTaskUnmeteredAdmission(
    { task, authorization: authority.authorization },
    digester,
  );
}
export function assertSavedPluginTaskFunding(
  saved: Pick<
    CommitExtensionTurnResult,
    "creditAdmission" | "unmeteredAdmission" | "binding"
  >,
  actor: ActorContext,
  receipt: ExtensionMutationReceipt,
  digester: ContentDigester,
): void {
  try {
    assertPluginTaskFunding(
      { ...saved, receipt, principalId: actor.principalId },
      digester,
    );
  } catch (error) {
    throw new ApplicationError(
      "internal",
      saved.creditAdmission === undefined &&
      saved.unmeteredAdmission === undefined
        ? "extension_credit_admission_missing"
        : "plugin_task_funding_invalid",
      { cause: error },
    );
  }
}
