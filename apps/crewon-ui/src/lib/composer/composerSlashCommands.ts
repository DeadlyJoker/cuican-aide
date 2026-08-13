import type { PendingComposerMention } from "../shared/composerMentions";
import {
  upsertPendingComposerMention,
} from "../shared/composerMentions";

export type ComposerSlashCommandKind = "app" | "mcp" | "skill" | "tool";

export type ComposerSlashCommand = {
  id: string;
  kind: ComposerSlashCommandKind;
  label: string;
  meta: string;
  description: string;
  token: string;
  mention?: PendingComposerMention;
  selection?: "mention" | "promptToken";
  execution?: {
    kind: "localMcpTool";
    serverName: string;
    toolName: string;
  };
};

/**
 * Adds the mention for a chosen slash command to the pending list.
 *
 * Apps carry a token that has to be reconciled with any text already typed, so
 * they go through the token-aware upsert. Other resources are identified by path
 * alone and are simply appended once.
 */
export function mentionsWithSlashCommand(
  mentions: PendingComposerMention[],
  command: ComposerSlashCommand,
): PendingComposerMention[] {
  const mention = command.mention;
  if (!mention || command.kind === "tool") {
    return mentions;
  }
  if (command.kind === "app") {
    return upsertPendingComposerMention(
      mentions,
      {
        kind: mention.kind,
        path: mention.path,
        token: command.token,
      },
      mention.name,
    );
  }
  if (mentions.some((current) => current.path === mention.path)) {
    return mentions;
  }
  return [
    ...mentions,
    {
      kind: mention.kind,
      name: mention.name,
      path: mention.path,
      resourceKind: command.kind,
    },
  ];
}
