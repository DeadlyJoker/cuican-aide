import {
  parseProjectOutlineEditRequest,
  type ProjectOutlineEditRequest,
} from "@crewon/contracts/project-outline-edits";
import {
  extensionCanonicalJson,
  parseInstalledPluginPackage,
  parsePluginSelection,
  validateCreativeProjectActor,
  type InstalledPluginPackage,
  type PluginSelection,
} from "@crewon/domain";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import {
  parseProjectToolInstallationPin,
  type ProjectToolInstallationPin,
} from "./creative-project-run-commit-authority.ts";
import {
  parseProjectStructuredOutlineCommand,
  projectStructuredOutlineCommandReceipt,
  type ProjectStructuredOutlineMutationKind,
} from "./project-structured-outline-commands.ts";
import type { CreativeProjectCommitAuthority } from "./creative-project-store-port.ts";

/** Different command and receipt protocol; no v1 text, Run, plan or installation tuple alone can issue it. */
export type ProjectOutlineUiCommitTransactionAuthority = Readonly<{
  version: "crewon.project-outline-plugin-commit.v2";
  actor: ActorContext;
  installation: ProjectToolInstallationPin;
  actionId: ProjectOutlineEditRequest["action"];
  input: unknown;
  selection: PluginSelection;
  package: InstalledPluginPackage;
  assertCurrent(): Promise<void>;
}>;
export function captureProjectOutlineUiCommitTransaction(
  input: unknown,
): ProjectOutlineUiCommitTransactionAuthority {
  const fields = extensionRecord(input, [
    "version",
    "actor",
    "installation",
    "actionId",
    "input",
    "selection",
    "package",
    "assertCurrent",
  ]);
  if (
    fields.version !== "crewon.project-outline-plugin-commit.v2" ||
    typeof fields.assertCurrent !== "function"
  )
    denied();
  const actor = validateCreativeProjectActor(copyExtensionJson(fields.actor)),
    installation = parseProjectToolInstallationPin(fields.installation),
    selection = parsePluginSelection(copyExtensionJson(fields.selection)),
    pkg = parseInstalledPluginPackage(copyExtensionJson(fields.package)),
    request = parseProjectOutlineEditRequest({
      action: fields.actionId,
      input: fields.input,
    });
  if (
    installation.tenantId !== actor.tenantId ||
    installation.spaceId !== actor.spaceId ||
    selection.state !== "enabled" ||
    selection.revision !== installation.selectionRevision ||
    selection.selectedPackageDigest !== installation.packageDigest ||
    pkg.packageDigest !== installation.packageDigest ||
    pkg.version !== installation.version ||
    (
      ["tenantId", "spaceId", "profileId", "pluginId", "publisherId"] as const
    ).some(
      (key) =>
        selection[key] !== installation[key] || pkg[key] !== installation[key],
    )
  )
    denied();
  const current = fields.assertCurrent.bind(input);
  return Object.freeze({
    version: "crewon.project-outline-plugin-commit.v2",
    actor,
    installation,
    actionId: request.action,
    input: request.input,
    selection,
    package: pkg,
    assertCurrent: async () => {
      if ((await current()) !== undefined) denied();
    },
  });
}
export function projectOutlineUiMutationCommand(
  transaction: ProjectOutlineUiCommitTransactionAuthority,
  digester: ContentDigester,
) {
  const request = parseProjectOutlineEditRequest({
    action: transaction.actionId,
    input: transaction.input,
  });
  const kind = request.action.endsWith(".saveCandidate")
    ? "save-outline"
    : "select-revision";
  const command = parseProjectStructuredOutlineCommand(kind, request.input);
  return Object.freeze({
    kind,
    command,
    receipt: projectStructuredOutlineCommandReceipt(
      transaction.actor,
      kind,
      command,
      digester,
    ),
  });
}
export function assertProjectOutlineUiMutationCommand(
  authority: CreativeProjectCommitAuthority | undefined,
  actor: ActorContext,
  kind: ProjectStructuredOutlineMutationKind,
  command: unknown,
  digester: ContentDigester,
): void {
  const transaction = authority?.outlineUiTransaction;
  if (!transaction) return;
  const expected = projectOutlineUiMutationCommand(transaction, digester);
  if (
    extensionCanonicalJson(actor) !==
      extensionCanonicalJson(transaction.actor) ||
    kind !== expected.kind ||
    extensionCanonicalJson(command) !== extensionCanonicalJson(expected.command)
  )
    denied();
}
function denied(): never {
  throw new Error("project_outline_ui_commit_authority_invalid");
}
function copyExtensionJson(input: unknown): unknown {
  return parsePluginUiJsonValue(input);
}
function extensionRecord(
  input: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    denied();
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== allowed.length ||
    allowed.some((key) => !Object.hasOwn(input, key))
  )
    denied();
  const fields: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.includes(key)) denied();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      denied();
    fields[key] = descriptor.value;
  }
  return fields;
}
