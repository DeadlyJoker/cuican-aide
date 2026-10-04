import {
  extensionCanonicalJson,
  extensionDigest,
  type ExtensionContentDigester,
} from "./extension-configuration.ts";
import {
  pluginInstallationOpaqueId,
  pluginInstallationRecord,
  pluginInstallationRevision,
} from "./plugin-installation-validation.ts";
import {
  assertPluginTaskAdmission,
  parsePluginTaskAdmission,
  type PluginTaskAdmission,
} from "./plugin-task-admission.ts";
import type { ExtensionRunBinding } from "./extension-run-binding.ts";
import type {
  ExtensionCreditAdmission,
  ExtensionCreditCommandIdentity,
} from "./extension-credit-admission.ts";
import { assertExtensionCreditAdmission } from "./extension-credit-admission.ts";

export type PluginTaskUnmeteredAuthorization = Readonly<{
  authorityId: string;
  policyRevision: number;
}>;
/** Internal trusted-host evidence, independent of any credit amount or reservation. */
export type PluginTaskUnmeteredAdmission = Readonly<{
  schemaVersion: "crewon.plugin-task-unmetered-admission.v1";
  task: PluginTaskAdmission;
  authorization: PluginTaskUnmeteredAuthorization;
  admissionDigest: string;
}>;
export function parsePluginTaskUnmeteredAuthorization(
  input: unknown,
): PluginTaskUnmeteredAuthorization {
  const value = pluginInstallationRecord(input, [
    "authorityId",
    "policyRevision",
  ]);
  return Object.freeze({
    authorityId: pluginInstallationOpaqueId(value.authorityId),
    policyRevision: pluginInstallationRevision(value.policyRevision),
  });
}
export function createPluginTaskUnmeteredAdmission(
  input: Readonly<{
    task: PluginTaskAdmission;
    authorization: PluginTaskUnmeteredAuthorization;
  }>,
  digester: ExtensionContentDigester,
): PluginTaskUnmeteredAdmission {
  const body = Object.freeze({
    schemaVersion: "crewon.plugin-task-unmetered-admission.v1" as const,
    task: parsePluginTaskAdmission(input.task),
    authorization: parsePluginTaskUnmeteredAuthorization(input.authorization),
  });
  return Object.freeze({
    ...body,
    admissionDigest: extensionDigest(
      digester.sha256(extensionCanonicalJson(body)),
    ),
  });
}
export function parsePluginTaskUnmeteredAdmission(
  input: unknown,
  digester: ExtensionContentDigester,
): PluginTaskUnmeteredAdmission {
  const value = pluginInstallationRecord(input, [
    "schemaVersion",
    "task",
    "authorization",
    "admissionDigest",
  ]);
  if (value.schemaVersion !== "crewon.plugin-task-unmetered-admission.v1")
    throw new Error("plugin_task_unmetered_schema_unsupported");
  const parsed = createPluginTaskUnmeteredAdmission(
    {
      task: parsePluginTaskAdmission(value.task),
      authorization: parsePluginTaskUnmeteredAuthorization(value.authorization),
    },
    digester,
  );
  if (extensionDigest(value.admissionDigest) !== parsed.admissionDigest)
    throw new Error("plugin_task_unmetered_digest_mismatch");
  return parsed;
}
export function assertPluginTaskUnmeteredAdmission(
  input: Readonly<{
    admission: PluginTaskUnmeteredAdmission;
    binding: ExtensionRunBinding;
    receipt: ExtensionCreditCommandIdentity;
    task?: PluginTaskAdmission;
  }>,
  digester: ExtensionContentDigester,
): PluginTaskUnmeteredAdmission {
  const admission = parsePluginTaskUnmeteredAdmission(
    input.admission,
    digester,
  );
  assertPluginTaskAdmission(
    {
      admission: admission.task,
      binding: input.binding,
      receipt: input.receipt,
    },
    digester,
  );
  if (
    input.task !== undefined &&
    extensionCanonicalJson(parsePluginTaskAdmission(input.task)) !==
      extensionCanonicalJson(admission.task)
  )
    throw new Error("plugin_task_unmetered_task_mismatch");
  return admission;
}
/** Exactly one financial mode, with the same original task/binding/command owner. */
export function assertPluginTaskFunding(
  input: Readonly<{
    creditAdmission?: ExtensionCreditAdmission;
    unmeteredAdmission?: PluginTaskUnmeteredAdmission;
    binding: ExtensionRunBinding;
    receipt: ExtensionCreditCommandIdentity;
    principalId: string;
    task?: PluginTaskAdmission;
  }>,
  digester: ExtensionContentDigester,
): void {
  if (
    (input.creditAdmission === undefined) ===
    (input.unmeteredAdmission === undefined)
  )
    throw new Error("plugin_task_credit_admission_required");
  if (input.unmeteredAdmission !== undefined) {
    const proof = assertPluginTaskUnmeteredAdmission(
      {
        admission: input.unmeteredAdmission,
        binding: input.binding,
        receipt: input.receipt,
        ...(input.task === undefined ? {} : { task: input.task }),
      },
      digester,
    );
    if (proof.task.principalId !== input.principalId)
      throw new Error("plugin_task_unmetered_owner_mismatch");
  } else {
    const credit = assertExtensionCreditAdmission(
      {
        admission: input.creditAdmission!,
        binding: input.binding,
        receipt: input.receipt,
      },
      digester,
    );
    if (credit.reservation.scope.principalId !== input.principalId)
      throw new Error("plugin_task_credit_admission_required");
  }
}
