import { appMentionSlug } from "./text";

export type AppMentionInfo = {
  kind?: PendingComposerMentionKind;
  path: string;
  token: string;
};

export type PendingComposerMentionKind = "mention" | "skill";

export type PendingComposerMention = {
  kind?: PendingComposerMentionKind;
  name: string;
  path: string;
  token?: string;
};

export function appMentionInfo(appId: string, appName: string): AppMentionInfo {
  const path = `app://${appId}`;
  return {
    path,
    token: `$${appMentionSlug(appName)}`,
  };
}

export function appendAppMentionToken(
  currentValue: string,
  token: string,
): string {
  if (currentValue.includes(token)) {
    return currentValue;
  }
  return currentValue.trim() ? `${token} ${currentValue}` : `${token} `;
}

export function upsertPendingComposerMention(
  mentions: PendingComposerMention[],
  mention: AppMentionInfo,
  appName: string,
): PendingComposerMention[] {
  return mentions.some((currentMention) => currentMention.path === mention.path)
    ? mentions
    : [
        ...mentions,
        {
          ...(mention.kind ? { kind: mention.kind } : {}),
          name: appName,
          path: mention.path,
          token: mention.token,
        },
      ];
}
