import {
  parseInstalledPluginPackage,
  parsePluginSelection,
  parsePluginTaskAdmissionPin,
} from "@crewon/domain";
import type {
  ProjectSourceUploadCommitAuthority,
  ProjectSourceUploadExecutionAuthority,
  ProjectSourceUploadExecutionOptions,
  ProjectSourceUploadPluginCommitTransactionAuthority,
} from "./project-source-upload-port.ts";

/** writePart is exclusively a raw transport action, absent from the public JSON codec. */
export const PROJECT_SOURCE_UPLOAD_PLUGIN_ACTIONS = Object.freeze({
  "projectSourceUpload:begin": "crewon.project-source-uploads.v1.begin",
  "projectSourceUpload:write": "crewon.project-source-uploads.v1.writePart",
  "projectSourceUpload:status": "crewon.project-source-uploads.v1.status",
  "projectSourceUpload:prepare": "crewon.project-source-uploads.v1.prepare",
  "projectSourceUpload:cancel": "crewon.project-source-uploads.v1.cancel",
});

export function captureProjectSourceUploadPluginCommitTransaction(
  input: unknown,
): ProjectSourceUploadPluginCommitTransactionAuthority {
  const value = fields(input, [
    "version",
    "pin",
    "selection",
    "package",
    "assertCurrent",
  ]);
  if (
    value.version !== "crewon.project-source-upload-plugin-commit.v1" ||
    typeof value.assertCurrent !== "function"
  )
    invalid();
  let pin: ProjectSourceUploadPluginCommitTransactionAuthority["pin"];
  let selection: ProjectSourceUploadPluginCommitTransactionAuthority["selection"];
  let pkg: ProjectSourceUploadPluginCommitTransactionAuthority["package"];
  try {
    pin = parsePluginTaskAdmissionPin(value.pin);
    selection = parsePluginSelection(value.selection);
    pkg = parseInstalledPluginPackage(value.package);
  } catch {
    invalid();
  }
  if (
    !Object.values(PROJECT_SOURCE_UPLOAD_PLUGIN_ACTIONS).includes(
      pin.action as never,
    ) ||
    selection.state !== "enabled" ||
    selection.revision !== pin.selectionRevision ||
    selection.selectedPackageDigest !== pin.packageDigest ||
    pkg.packageDigest !== pin.packageDigest ||
    pkg.version !== pin.version ||
    (
      ["tenantId", "spaceId", "profileId", "pluginId", "publisherId"] as const
    ).some((key) => selection[key] !== pin[key] || pkg[key] !== pin[key])
  )
    invalid();
  const current = value.assertCurrent.bind(input);
  return Object.freeze({
    version: "crewon.project-source-upload-plugin-commit.v1",
    pin,
    selection,
    package: pkg,
    assertCurrent: async () => {
      if ((await current()) !== undefined) invalid();
    },
  });
}

/** The actual business permission must match the independent captured pin. No installed-row read is implied. */
export function qualifyProjectSourceUploadPluginCommit(
  authority: ProjectSourceUploadCommitAuthority,
): ProjectSourceUploadPluginCommitTransactionAuthority | undefined {
  if (authority.transaction === undefined) return undefined;
  const transaction = captureProjectSourceUploadPluginCommitTransaction(
    authority.transaction,
  );
  const { actor, action } = authority.permission;
  if (
    !Object.hasOwn(PROJECT_SOURCE_UPLOAD_PLUGIN_ACTIONS, action) ||
    transaction.pin.action !==
      PROJECT_SOURCE_UPLOAD_PLUGIN_ACTIONS[
        action as keyof typeof PROJECT_SOURCE_UPLOAD_PLUGIN_ACTIONS
      ] ||
    (["tenantId", "spaceId", "principalId", "actorId"] as const).some(
      (key) => transaction.pin[key] !== actor[key],
    )
  )
    throw new Error("project_source_upload_plugin_commit_pin_mismatch");
  return transaction;
}

export function captureProjectSourceUploadExecutionAuthority(
  options: ProjectSourceUploadExecutionOptions | undefined,
  allowedExtraFields: readonly string[] = [],
): ProjectSourceUploadExecutionAuthority | undefined {
  if (options === undefined) return undefined;
  const outer = fields(options, ["authority", ...allowedExtraFields], []);
  if (outer.authority === undefined) return undefined;
  const input = outer.authority;
  const value = fields(
    input,
    ["assertCurrent", "assertActive", "transaction"],
    ["assertCurrent", "assertActive"],
  );
  if (
    typeof value.assertCurrent !== "function" ||
    typeof value.assertActive !== "function"
  )
    invalid();
  return Object.freeze({
    assertCurrent: value.assertCurrent.bind(input),
    assertActive: value.assertActive.bind(input),
    ...(value.transaction === undefined
      ? {}
      : {
          transaction: captureProjectSourceUploadPluginCommitTransaction(
            value.transaction,
          ),
        }),
  });
}

/** Inside SQL use only the external transaction fence, never the full installation-loading fence. */
export async function assertProjectSourceUploadTransactionCurrent(
  authority: ProjectSourceUploadCommitAuthority,
): Promise<void> {
  if (
    authority.transaction !== undefined &&
    (await authority.transaction.assertCurrent()) !== undefined
  )
    invalid();
}

function fields(
  input: unknown,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    invalid();
  const keys = Reflect.ownKeys(input);
  if (
    keys.length > allowed.length ||
    required.some((key) => !Object.hasOwn(input, key))
  )
    invalid();
  const value: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      invalid();
    value[key] = descriptor.value;
  }
  return value;
}
function invalid(): never {
  throw new Error("project_source_upload_plugin_commit_authority_invalid");
}
