import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { CreativeProjectAuthorizationAction } from "./creative-project-authorization-port.ts";
import type { CreativeProjectMutationCommand } from "./creative-project-commands.ts";
import type {
  CreativeProjectCommitOptions,
  CreativeProjectMutationKind,
  CreativeProjectMutationReceipt,
  CreativeProjectMutationResult,
  CreativeProjectStore,
} from "./creative-project-store-port.ts";
import {
  assertCreativeProjectCommitCurrent,
  captureCreativeProjectCommitAuthority,
} from "./creative-project-commit-authority.ts";
import {
  assertCreativeCommittedRecords,
  checkedCreativeMutationResult,
  creativeActor,
  creativeMutationCommand,
  creativeProjectUseCase,
  creativeReceipt,
  type CreativeProjectPreparedRecords,
} from "./creative-project-application-support.ts";
import {
  assertCreativeProjectRunMutationCommand,
  bindProjectRunCommitPolicy,
} from "./creative-project-run-command.ts";

type PreparedCreativeMutation = Readonly<{
  records: CreativeProjectPreparedRecords;
  commit(): Promise<CreativeProjectMutationResult>;
}>;

type CreativeMutationDependencies = Readonly<{
  store: CreativeProjectStore;
  digester: ContentDigester;
  authorize(
    actor: ActorContext,
    action: CreativeProjectAuthorizationAction,
    projectId: string | null,
  ): Promise<void>;
  prepare(
    actor: ActorContext,
    kind: CreativeProjectMutationKind,
    command: CreativeProjectMutationCommand,
    receipt: CreativeProjectMutationReceipt,
    options?: CreativeProjectCommitOptions,
  ): Promise<PreparedCreativeMutation>;
}>;

/** Mutation orchestration shared by direct metadata and qualified Run callers. */
export function executeCreativeProjectMutation(
  dependencies: CreativeMutationDependencies,
  actorInput: ActorContext,
  kind: CreativeProjectMutationKind,
  input: CreativeProjectMutationCommand,
  options?: CreativeProjectCommitOptions,
): Promise<CreativeProjectMutationResult> {
  return creativeProjectUseCase(async () => {
    let authority = captureCreativeProjectCommitAuthority(options);
    const actor = creativeActor(actorInput);
    const command = creativeMutationCommand(kind, input);
    assertCreativeProjectRunMutationCommand(
      authority,
      actor,
      kind,
      command,
      dependencies.digester,
    );
    const projectId = "projectId" in command ? command.projectId : null;
    const action =
      kind === "create-project"
        ? "creativeProject:create"
        : "creativeProject:write";
    authority = bindProjectRunCommitPolicy(authority, () =>
      dependencies.authorize(actor, action, projectId),
    );
    const commitOptions =
      authority === undefined ? undefined : Object.freeze({ authority });
    const receipt = creativeReceipt(
      actor,
      kind,
      command,
      dependencies.digester,
    );
    await dependencies.authorize(actor, action, projectId);
    if (authority !== undefined)
      await assertCreativeProjectCommitCurrent(authority);
    const previous = await dependencies.store.loadMutationReceipt(
      { actor, kind, receipt },
      commitOptions,
    );
    if (authority !== undefined)
      await assertCreativeProjectCommitCurrent(authority);
    if (previous !== null) {
      const result = checkedCreativeMutationResult(
        previous,
        actor,
        kind,
        command,
        dependencies.digester,
      );
      await dependencies.authorize(actor, action, projectId);
      if (authority !== undefined)
        await assertCreativeProjectCommitCurrent(authority);
      return Object.freeze({ ...result, disposition: "replayed" as const });
    }
    const prepared = await dependencies.prepare(
      actor,
      kind,
      command,
      receipt,
      commitOptions,
    );
    await dependencies.authorize(actor, action, projectId);
    if (authority !== undefined)
      await assertCreativeProjectCommitCurrent(authority);
    const raw = await prepared.commit();
    const result = checkedCreativeMutationResult(
      raw,
      actor,
      kind,
      command,
      dependencies.digester,
    );
    if (result.disposition === "committed")
      assertCreativeCommittedRecords(result, prepared.records);
    else {
      await dependencies.authorize(actor, action, projectId);
      await assertCreativeProjectCommitCurrent(authority);
    }
    return result;
  });
}
