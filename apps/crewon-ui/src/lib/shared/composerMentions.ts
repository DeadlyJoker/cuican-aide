import { appMentionSlug } from "./text";

export type AppMentionInfo = {
  path: string;
  token: string;
};

export type PendingComposerMention = {
  name: string;
  path: string;
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
          name: appName,
          path: mention.path,
        },
      ];
}
