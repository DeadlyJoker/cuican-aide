import { extensionCanonicalJson } from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type {
  CreativeProjectCommitAuthority,
  CreativeProjectMutationKind,
} from "./creative-project-store-port.ts";
import type { ProjectTextMutationKind } from "./project-text-store-port.ts";
import type {
  CreativeProjectRunCommitTransactionAuthority,
  ProjectToolMutationOperation,
} from "./creative-project-run-commit-authority.ts";
import {
  creativeMutationCommand,
  creativeReceipt,
} from "./creative-project-application-support.ts";
import {
  parseProjectTextMutationCommand,
  projectTextMutationReceipt,
} from "./project-text-application-support.ts";

const kinds: Readonly<
  Record<
    ProjectToolMutationOperation,
    CreativeProjectMutationKind | ProjectTextMutationKind
  >
> = Object.freeze({
  project_create: "create-project",
  brief_append: "append-brief",
  outline_save: "save-outline",
  script_save: "save-script",
  text_select: "select-revision",
  text_lock: "set-lock",
});

/** Retry identity is derived from the actual original Tool, not supplied by the plugin/model. */
export function deriveProjectToolMutationIdempotencyKey(
  authority: CreativeProjectRunCommitTransactionAuthority,
  digester: ContentDigester,
): string {
  const digest = digester.sha256(
    extensionCanonicalJson({
      version: "crewon.creative-project-run-commit.v1",
      tenantId: authority.actor.tenantId,
      runId: authority.run.runId,
      receiptId: authority.receipt.receiptId,
      executionId: authority.receipt.executionId,
      actionDigest: authority.receipt.actionDigest,
      operationId: authority.operationId,
    }),
  );
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) denied();
  return `project-tool:${digest.slice(7)}`;
}

/** Shared with the transaction qualifier so recipes cannot change the original Tool arguments. */
export function projectToolRunMutationCommand(
  authority: CreativeProjectRunCommitTransactionAuthority,
  digester: ContentDigester,
) {
  const body: unknown = JSON.parse(authority.commandInput);
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.hasOwn(body, "idempotencyKey")
  )
    denied();
  const input = {
    ...body,
    idempotencyKey: deriveProjectToolMutationIdempotencyKey(
      authority,
      digester,
    ),
  };
  const kind = kinds[authority.operationId];
  if (kind === "save-script" && !Object.hasOwn(input, "outline"))
    Object.assign(input, { outline: null });
  if (kind === "create-project" || kind === "append-brief") {
    const command = creativeMutationCommand(kind, input);
    return Object.freeze({
      kind,
      command,
      receipt: creativeReceipt(authority.actor, kind, command, digester),
    });
  }
  if (
    kind !== "save-outline" &&
    kind !== "save-script" &&
    kind !== "select-revision" &&
    kind !== "set-lock"
  )
    denied();
  const command = parseProjectTextMutationCommand(kind, input);
  return Object.freeze({
    kind,
    command,
    receipt: projectTextMutationReceipt(
      authority.actor,
      kind,
      command,
      digester,
    ),
  });
}

/** This optional branch leaves all legacy human/UI command and receipt semantics unchanged. */
export function assertCreativeProjectRunMutationCommand(
  authority: CreativeProjectCommitAuthority | undefined,
  actor: ActorContext,
  kind: CreativeProjectMutationKind | ProjectTextMutationKind,
  command: unknown,
  digester: ContentDigester,
): void {
  if (authority?.runTransaction === undefined) return;
  const transaction = authority.runTransaction;
  const actual = projectToolRunMutationCommand(transaction, digester);
  if (
    extensionCanonicalJson(transaction.actor) !==
      extensionCanonicalJson(actor) ||
    actual.kind !== kind ||
    extensionCanonicalJson(actual.command) !== extensionCanonicalJson(command)
  )
    denied();
}
function denied(): never {
  throw new Error("creative_project_run_command_mismatch");
}

/** Only the new Run branch adds the external project-policy fence to its transaction callback. */
export function bindProjectRunCommitPolicy(
  authority: CreativeProjectCommitAuthority | undefined,
  assertPolicy: () => Promise<void>,
): CreativeProjectCommitAuthority | undefined {
  if (authority?.runTransaction === undefined) return authority;
  const tx = authority.runTransaction;
  return Object.freeze({
    ...authority,
    runTransaction: Object.freeze({
      ...tx,
      assertCurrent: async () => {
        await assertPolicy();
        await tx.assertCurrent();
      },
    }),
  });
}
