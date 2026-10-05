import {
  extensionCanonicalJson,
  parseInstalledPluginPackage,
  parsePluginSelection,
  parsePluginTaskAdmissionPin,
  parseProjectConversationInstallation,
  validateCreativeProjectActor,
} from "@crewon/domain";
import type { ProjectConversationCommitAuthority } from "./project-conversation-store-port.ts";
import { ApplicationError } from "./application-error.ts";

/** Detached host evidence and captured callbacks, never a public request field. */
export function captureProjectConversationAuthority(
  input: unknown,
): ProjectConversationCommitAuthority {
  const keys = [
    "version",
    "actor",
    "installation",
    "selection",
    "package",
    "pin",
    "assertCurrent",
    "assertTransactionCurrent",
    "assertActive",
  ];
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    denied();
  const d = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(input).length !== keys.length ||
    keys.some((k) => !d[k]?.enumerable || !Object.hasOwn(d[k]!, "value"))
  )
    denied();
  const get = (k: string): unknown => d[k]!.value,
    actor = validateCreativeProjectActor(get("actor")),
    installation = parseProjectConversationInstallation(get("installation")),
    pin = parsePluginTaskAdmissionPin(get("pin")),
    selection = parsePluginSelection(get("selection")),
    pkg = parseInstalledPluginPackage(get("package"));
  if (
    get("version") !== "crewon.project-conversation-commit.v1" ||
    pin.action !== "project.execute" ||
    pin.contributionId !== "workbench" ||
    ["tenantId", "spaceId", "principalId", "actorId"].some(
      (k) => actor[k as keyof typeof actor] !== pin[k as keyof typeof pin],
    ) ||
    Object.keys(installation).some(
      (k) =>
        installation[k as keyof typeof installation] !==
        pin[k as keyof typeof pin],
    ) ||
    selection.state !== "enabled" ||
    selection.revision !== installation.selectionRevision ||
    selection.selectedPackageDigest !== installation.packageDigest ||
    pkg.packageDigest !== installation.packageDigest ||
    pkg.version !== installation.version ||
    ["tenantId", "spaceId", "profileId", "pluginId", "publisherId"].some(
      (k) =>
        selection[k as keyof typeof selection] !==
          installation[k as keyof typeof installation] ||
        pkg[k as keyof typeof pkg] !==
          installation[k as keyof typeof installation],
    )
  )
    denied();
  const current = get("assertCurrent"),
    transaction = get("assertTransactionCurrent"),
    active = get("assertActive");
  if (
    typeof current !== "function" ||
    typeof transaction !== "function" ||
    typeof active !== "function"
  )
    denied();
  return Object.freeze({
    version: "crewon.project-conversation-commit.v1",
    actor,
    installation,
    pin,
    selection,
    package: pkg,
    assertCurrent: async () => {
      if ((await current.call(input)) !== undefined) denied();
    },
    assertTransactionCurrent: async () => {
      if ((await transaction.call(input)) !== undefined) denied();
    },
    assertActive: () => {
      if (active.call(input) !== undefined) denied();
    },
  });
}
export function assertProjectConversationActor(
  input: unknown,
  authority: ProjectConversationCommitAuthority,
): void {
  if (
    extensionCanonicalJson(validateCreativeProjectActor(input)) !==
    extensionCanonicalJson(authority.actor)
  )
    denied();
  authority.assertActive();
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "project_conversation_authority_required",
  );
}
