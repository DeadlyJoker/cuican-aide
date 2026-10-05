import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { CreativeProjectCommitOptions } from "./creative-project-store-port.ts";
import type { ProjectTextMutationCommand } from "./project-text-commands.ts";
import type { ProjectTextMutationKind } from "./project-text-store-port.ts";
import { creativeActor } from "./creative-project-application-support.ts";
import {
  assertCreativeProjectRunMutationCommand,
  bindProjectRunCommitPolicy,
} from "./creative-project-run-command.ts";
import {
  assertProjectTextUiMutationCommand,
  bindProjectTextUiCommitPolicy,
} from "./project-text-ui-commit-authority.ts";
import {
  captureProjectTextCommitAuthority,
  parseProjectTextMutationCommand,
  projectTextMutationReceipt,
} from "./project-text-application-support.ts";

/** Capture one of the distinct caller authorities before asynchronous reads or commits. */
export function prepareProjectTextMutationAuthority(
  actorInput: ActorContext,
  kind: ProjectTextMutationKind,
  input: ProjectTextMutationCommand,
  options: CreativeProjectCommitOptions | undefined,
  digester: ContentDigester,
  assertPolicy: (actor: ActorContext, projectId: string) => Promise<void>,
) {
  let authority = captureProjectTextCommitAuthority(options);
  const actor = creativeActor(actorInput);
  const command = parseProjectTextMutationCommand(kind, input);
  assertCreativeProjectRunMutationCommand(
    authority,
    actor,
    kind,
    command,
    digester,
  );
  assertProjectTextUiMutationCommand(authority, actor, kind, command, digester);
  const currentPolicy = () => assertPolicy(actor, command.projectId);
  authority = bindProjectTextUiCommitPolicy(authority, currentPolicy);
  authority = bindProjectRunCommitPolicy(authority, currentPolicy);
  return Object.freeze({
    actor,
    command,
    authority,
    receipt: projectTextMutationReceipt(actor, kind, command, digester),
  });
}
