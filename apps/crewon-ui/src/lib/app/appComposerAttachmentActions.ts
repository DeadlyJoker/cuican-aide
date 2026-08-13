import { stageLocalResourceAttachments } from "../shared/localResourceAttachments";
import type {
  LocalResourceAttachmentClient,
  LocalResourceSelectionKind,
} from "../shared/localResourceAttachments";
import type {
  PendingComposerMention,
  PendingComposerResourceKind,
} from "../shared/composerMentions";
import type { NoticeState } from "../shared/noticeState";

/** Mention path for a resource that lives on the agent platform. */
export function platformResourceMentionPath(resource: {
  id: number | string;
  type: string;
}): string {
  return `agent-platform://${resource.type}/${resource.id}`;
}

/**
 * Adds a platform resource to the pending mentions, ignoring duplicates so
 * selecting the same resource twice does not stack identical chips.
 */
export function withPlatformResourceMention(
  mentions: PendingComposerMention[],
  mention: {
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
      kind: mention.kind === "skill" ? "skill" : undefined,
      name: mention.name,
      path: mention.path,
      resourceKind: mention.kind,
    },
  ];
}

/**
 * Stages files dropped or picked in the composer as pending mentions.
 *
 * The composer only needs "add these files"; resolving the workspace directory,
 * talking to the server, and reporting failures are implementation concerns that
 * do not belong in the app shell's JSX.
 */
export async function addLocalComposerResources(params: {
  client: LocalResourceAttachmentClient | null;
  connected: boolean;
  cwd: string;
  files: File[];
  kind: LocalResourceSelectionKind;
  resolveBackendCwd: () => Promise<string | null>;
  setNotice: (notice: NoticeState) => void;
  onStaged: (mentions: PendingComposerMention[]) => void;
}): Promise<void> {
  if (!params.client || !params.connected) {
    params.setNotice({
      text: "CrewON Control 尚未提供本地文件添加能力",
      tone: "warning",
    });
    return;
  }
  try {
    const attachmentCwd =
      params.cwd.trim() || (await params.resolveBackendCwd());
    const mentions = await stageLocalResourceAttachments({
      client: params.client,
      cwd: attachmentCwd ?? "",
      files: params.files,
      kind: params.kind,
    });
    params.onStaged(mentions);
  } catch (error) {
    params.setNotice({
      text: error instanceof Error ? error.message : "添加本地文件失败",
      tone: "warning",
    });
  }
}
