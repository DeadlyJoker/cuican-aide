import {
  extensionCanonicalJson,
  parseInstalledPluginPackage,
  parsePluginSelection,
  projectTextRecord,
  validateCreativeProjectActor,
  creativeProjectOpaqueId,
  projectTextOpaqueId,
  type InstalledPluginPackage,
  type PluginSelection,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { CreativeProjectCommitAuthority } from "./creative-project-store-port.ts";
import {
  parseProjectToolInstallationPin,
  type ProjectToolInstallationPin,
} from "./creative-project-run-commit-authority.ts";
import {
  parseProjectTextMutationCommand,
  projectTextMutationReceipt,
} from "./project-text-application-support.ts";
import type { ProjectTextMutationKind } from "./project-text-store-port.ts";

/** An installation tuple only; it supplies neither a Run nor UI task provenance. */
export type ProjectTextUiInstallationPin = ProjectToolInstallationPin;
export type ProjectTextUiMutationAction =
  | "crewon.project-texts.v1.saveOutlineCandidate"
  | "crewon.project-texts.v1.saveScriptCandidate"
  | "crewon.project-texts.v1.selectRevision"
  | "crewon.project-texts.v1.setLocked";
export type ProjectTextUiCommitTransactionAuthority = Readonly<{
  version: "crewon.project-text-plugin-commit.v1";
  actor: ActorContext;
  installation: ProjectTextUiInstallationPin;
  actionId: ProjectTextUiMutationAction;
  /** Detached original invocation input, captured by the host's private issuer. */
  input: unknown;
  selection: PluginSelection;
  package: InstalledPluginPackage;
  /** Actual UI contribution, required when this invocation participates in the cold journal. */
  contributionId?: string;
  /** A journal locator, never a permission or a caller-issued commit receipt. */
  intentRef?: Readonly<{ intentId: string; requestDigest: string }>;
  /** Live invocation/profile/policy checks only; never borrow the committing pool. */
  assertCurrent(): Promise<void>;
}>;

const kinds: Readonly<
  Record<ProjectTextUiMutationAction, ProjectTextMutationKind>
> = Object.freeze({
  "crewon.project-texts.v1.saveOutlineCandidate": "save-outline",
  "crewon.project-texts.v1.saveScriptCandidate": "save-script",
  "crewon.project-texts.v1.selectRevision": "select-revision",
  "crewon.project-texts.v1.setLocked": "set-lock",
});

export function captureProjectTextUiCommitTransaction(
  input: unknown,
): ProjectTextUiCommitTransactionAuthority {
  const fields = authorityFields(input, [
    "version",
    "actor",
    "installation",
    "actionId",
    "input",
    "selection",
    "package",
    "assertCurrent",
    "contributionId",
    "intentRef",
  ]);
  if (
    fields.version !== "crewon.project-text-plugin-commit.v1" ||
    typeof fields.assertCurrent !== "function" ||
    typeof fields.actionId !== "string" ||
    !Object.hasOwn(kinds, fields.actionId)
  )
    denied();
  const actor = validateCreativeProjectActor(clone(fields.actor));
  const installation = parseProjectToolInstallationPin(fields.installation);
  const selection = parsePluginSelection(clone(fields.selection));
  const pkg = parseInstalledPluginPackage(clone(fields.package));
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
  const contributionId =
    fields.contributionId === undefined
      ? undefined
      : creativeProjectOpaqueId(fields.contributionId);
  let intentRef: ProjectTextUiCommitTransactionAuthority["intentRef"];
  if (fields.intentRef !== undefined) {
    if (contributionId === undefined) denied();
    const ref = projectTextRecord(fields.intentRef, [
      "intentId",
      "requestDigest",
    ]);
    if (
      typeof ref.requestDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(ref.requestDigest)
    )
      denied();
    intentRef = Object.freeze({
      intentId: projectTextOpaqueId(ref.intentId),
      requestDigest: ref.requestDigest,
    });
  }
  return Object.freeze({
    version: "crewon.project-text-plugin-commit.v1",
    actor,
    installation,
    actionId: fields.actionId as ProjectTextUiMutationAction,
    input: clone(fields.input),
    selection,
    package: pkg,
    ...(contributionId === undefined ? {} : { contributionId }),
    ...(intentRef === undefined ? {} : { intentRef }),
    assertCurrent: async () => {
      const result: unknown = await current();
      if (result !== undefined) denied();
    },
  });
}

/** Exact manual UI command, shared by Application and the transaction's receipt qualifier. */
export function projectTextUiMutationCommand(
  transaction: ProjectTextUiCommitTransactionAuthority,
  digester: ContentDigester,
) {
  const kind = kinds[transaction.actionId];
  if (kind === undefined) denied();
  const fields = ["projectId", "request", "idempotencyKey"];
  if (kind === "save-script") fields.push("episodeId");
  if (kind === "select-revision" || kind === "set-lock")
    fields.push("artifactId");
  const input = projectTextRecord(transaction.input, fields);
  const requestFields = ["expectedArtifactRevision"];
  if (kind === "save-outline" || kind === "save-script")
    requestFields.push("briefRevision", "content");
  if (kind === "save-script") requestFields.push("outline");
  if (kind === "select-revision") requestFields.push("contentRevision");
  if (kind === "set-lock") requestFields.push("locked");
  const request = projectTextRecord(input.request, requestFields);
  const command = parseProjectTextMutationCommand(kind, {
    ...request,
    projectId: input.projectId,
    idempotencyKey: input.idempotencyKey,
    ...(kind === "save-script" ? { episodeId: input.episodeId } : {}),
    ...(kind === "select-revision" || kind === "set-lock"
      ? { artifactId: input.artifactId }
      : {}),
  });
  return Object.freeze({
    kind,
    command,
    receipt: projectTextMutationReceipt(
      transaction.actor,
      kind,
      command,
      digester,
    ),
  });
}

export function assertProjectTextUiMutationCommand(
  authority: CreativeProjectCommitAuthority | undefined,
  actor: ActorContext,
  kind: ProjectTextMutationKind,
  command: unknown,
  digester: ContentDigester,
): void {
  const transaction = authority?.textUiTransaction;
  if (transaction === undefined) return;
  const expected = projectTextUiMutationCommand(transaction, digester);
  if (
    extensionCanonicalJson(actor) !==
      extensionCanonicalJson(transaction.actor) ||
    kind !== expected.kind ||
    extensionCanonicalJson(command) !== extensionCanonicalJson(expected.command)
  )
    denied();
}

/** Add actual project PDP revalidation to the transaction-safe host callback. */
export function bindProjectTextUiCommitPolicy(
  authority: CreativeProjectCommitAuthority | undefined,
  assertPolicy: () => Promise<void>,
): CreativeProjectCommitAuthority | undefined {
  if (authority === undefined || authority.textUiTransaction === undefined)
    return authority;
  const transaction = authority.textUiTransaction;
  return Object.freeze({
    ...authority,
    textUiTransaction: Object.freeze({
      ...transaction,
      assertCurrent: async () => {
        await assertPolicy();
        await transaction.assertCurrent();
      },
    }),
  });
}
function clone(input: unknown): unknown {
  const result: unknown = JSON.parse(extensionCanonicalJson(input));
  return freeze(result);
}
function freeze(input: unknown): unknown {
  if (input !== null && typeof input === "object") {
    for (const child of Object.values(input)) freeze(child);
    Object.freeze(input);
  }
  return input;
}
function denied(): never {
  throw new Error("project_text_ui_commit_authority_invalid");
}

function authorityFields(
  input: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    denied();
  const fields: Record<string, unknown> = Object.create(null);
  const keys = Reflect.ownKeys(input);
  if (
    keys.length < 8 ||
    keys.length > allowed.length ||
    allowed.slice(0, 8).some((key) => !Object.hasOwn(input, key))
  )
    denied();
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.includes(key)) denied();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      !descriptor.enumerable
    )
      denied();
    fields[key] = descriptor.value;
  }
  return fields;
}
