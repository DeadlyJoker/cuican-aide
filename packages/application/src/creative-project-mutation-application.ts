import { scopedPluginMetadataReceipt } from "./plugin-project-mutation-scope-support.ts";
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
  OwnedCreativeProjectCreationStore,
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
  store: CreativeProjectStore & Partial<OwnedCreativeProjectCreationStore>;
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
    let authority = captureCreativeProjectCommitAuthority(options, {
      allowTextUiTransaction: false,
      allowCreationScope: kind === "create-project",
      allowMutationScope: kind !== "create-project",
    });
    const creationScope = options?.creationScope;
    const mutationScope = options?.mutationScope;
    if (
      creationScope !== undefined &&
      (typeof dependencies.store.loadOwnedCreationReceipt !== "function" ||
        typeof dependencies.store.commitOwnedProjectCreation !== "function")
    )
      throw new Error("plugin_project_owned_creation_unavailable");
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
    if (
      (creationScope !== undefined || mutationScope !== undefined) &&
      authority?.transaction !== undefined
    ) {
      const sourceAuthority = authority;
      const transaction = sourceAuthority.transaction!;
      authority = Object.freeze({
        ...sourceAuthority,
        assertCurrent: async () => {
          await assertCreativeProjectCommitCurrent(sourceAuthority);
          await dependencies.authorize(actor, action, projectId);
        },
        transaction: Object.freeze({
          ...transaction,
          assertCurrent: async () => {
            await transaction.assertCurrent();
            await dependencies.authorize(actor, action, projectId);
          },
        }),
      });
    }
    const commitOptions =
      authority === undefined &&
      creationScope === undefined &&
      mutationScope === undefined
        ? undefined
        : Object.freeze({
            authority,
            ...(creationScope === undefined ? {} : { creationScope }),
            ...(mutationScope === undefined ? {} : { mutationScope }),
          });
    const externalReceipt = creativeReceipt(
      actor,
      kind,
      command,
      dependencies.digester,
    );
    const receipt =
      mutationScope === undefined
        ? externalReceipt
        : scopedPluginMetadataReceipt(
            mutationScope,
            actor,
            command,
            externalReceipt,
            dependencies.digester,
          );
    await dependencies.authorize(actor, action, projectId);
    if (authority !== undefined)
      await assertCreativeProjectCommitCurrent(authority);
    const previous =
      creationScope === undefined
        ? await dependencies.store.loadMutationReceipt(
            { actor, kind, receipt },
            commitOptions,
          )
        : await dependencies.store.loadOwnedCreationReceipt!(
            { actor, receipt, creationScope },
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
