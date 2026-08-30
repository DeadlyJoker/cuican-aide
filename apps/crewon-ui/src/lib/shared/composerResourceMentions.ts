import type {
  PendingComposerMention,
  PendingComposerResourceKind,
} from "./composerMentions";

/** Mention path for a resource that lives on the agent platform. */
export function platformResourceMentionPath(resource: {
  execution?: "local" | "remote";
  id: number | string;
  type: string;
}): string {
  if (resource.execution === "local") {
    return `crewon://${resource.type}/${resource.id}`;
  }
  return `agent-platform://${resource.type}/${resource.id}`;
}

/** Adds a selected resource once so one composer never shows duplicate chips. */
export function withPlatformResourceMention(
  mentions: PendingComposerMention[],
  mention: {
    content?: string;
    kind: PendingComposerResourceKind;
    name: string;
    path: string;
  },
): PendingComposerMention[] {
  if (mentions.some((current) => current.path === mention.path)) {
    return mentions;
  }
  return [
    ...mentions,
    {
      ...(mention.content ? { content: mention.content } : {}),
      kind: mention.kind === "skill" ? "skill" : undefined,
      name: mention.name,
      path: mention.path,
      resourceKind: mention.kind,
    },
  ];
}
