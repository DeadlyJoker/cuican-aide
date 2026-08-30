import { stageLocalResourceAttachments } from "../shared/localResourceAttachments";
import { inlineLocalResourceAttachments } from "../shared/localResourceAttachments";
import type {
  LocalResourceAttachmentClient,
  LocalResourceSelectionKind,
} from "../shared/localResourceAttachments";
import type { PendingComposerMention } from "../shared/composerMentions";
import type { NoticeState } from "../shared/noticeState";
export {
  platformResourceMentionPath,
  withPlatformResourceMention,
} from "../shared/composerResourceMentions";

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
  useInlineContent?: boolean;
  resolveBackendCwd: () => Promise<string | null>;
  setNotice: (notice: NoticeState) => void;
  onStaged: (mentions: PendingComposerMention[]) => void;
}): Promise<void> {
  try {
    if (params.useInlineContent || !params.client || !params.connected) {
      params.onStaged(
        await inlineLocalResourceAttachments({
          files: params.files,
          kind: params.kind,
        }),
      );
      return;
    }
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
