import type { FuzzyFileSearchResponse } from "@crewon/app-server-protocol/FuzzyFileSearchResponse";
import type { FsGetMetadataResponse } from "@crewon/app-server-protocol/v2/FsGetMetadataResponse";
import type { FsReadFileResponse } from "@crewon/app-server-protocol/v2/FsReadFileResponse";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { TurnStartResponse } from "@crewon/app-server-protocol/v2/TurnStartResponse";

import type {
  CapabilityPanel,
  CapabilityPanelItem,
} from "../capability/capabilityPanelTypes";
import { fileMetadataText } from "../capability/capabilityPanelText";
import type {
  ArtifactItem,
  LibraryPanel,
  OfficeConfig,
  OfficeMessage,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import type { Locale, ToolId } from "../i18n";
import {
  officeArtifactDirectoryPanel,
  officeArtifactDisconnectedPanel,
  officeArtifactDraftBody,
  officeArtifactDraftPanel,
  officeArtifactErrorPanel,
  officeArtifactLoadedPanel,
  officeArtifactLocatingPanel,
  officeArtifactSavedPanel,
  officeArtifactSystemMessage,
  officeArtifactTurnPrompt,
  officeSavedArtifact,
  officeWorkspaceWithArtifactMessage,
} from "./officeArtifactPanel";
import { sha256Base64 } from "./officeArtifactContentHash";
import { joinPath, pathDirName, resolveSearchPath } from "../shared/pathUtils";
import { decodeBase64Text } from "../server-request/serverRequestPresentation";
import { slugifySkillName } from "../shared/text";
import { upsertTurnInThread } from "../thread/threadModel";
import type { OfficeThreadResolution } from "./officeThreadActions";

type StateSetter<T> = (updater: (current: T) => T) => void;
type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

export type OfficeArtifactClient = {
  createDirectory(path: string, recursive?: boolean): Promise<unknown>;
  fuzzyFileSearch(
    query: string,
    roots: string[],
    cancellationToken?: string | null,
  ): Promise<FuzzyFileSearchResponse | null | undefined>;
  getMetadata(path: string): Promise<FsGetMetadataResponse | null | undefined>;
  readFile(path: string): Promise<FsReadFileResponse | null | undefined>;
  startTurn(
    threadId: string,
    text: string,
  ): Promise<TurnStartResponse | null | undefined>;
  writeTextFile(path: string, text: string): Promise<unknown>;
};

export type OfficeArtifactActionParams = {
  artifact: ArtifactItem;
  busyToolId: ToolId | null;
  client: OfficeArtifactClient | null;
  ensureOfficeThread: (
    panel: LibraryPanel,
    workspace: OfficeWorkspace,
  ) => Promise<OfficeThreadResolution | null>;
  handleDirectoryItem: (item: CapabilityPanelItem) => Promise<void>;
  isConnected: boolean;
  libraryPanel: LibraryPanel | null;
  locale: Locale;
  nowIso: () => string;
  resolveBackendCwd: () => Promise<string>;
  setBusyToolId: (toolId: ToolId | null) => void;
  setCapabilityDockOpen: (open: boolean) => void;
  setCapabilityPanel: (panel: CapabilityPanel) => void;
  setLibraryPanel: LibraryPanelSetter;
  setThreads: StateSetter<Thread[]>;
  uniqueId: () => string;
  upsertOfficeArtifact: (
    root: string,
    panel: LibraryPanel,
    workspace: OfficeWorkspace,
    threadId: string,
    artifact: ArtifactItem,
    message: OfficeMessage,
  ) => Promise<OfficeConfig | null>;
};

export async function handleOfficeArtifactAction({
  artifact,
  busyToolId,
  client,
  ensureOfficeThread,
  handleDirectoryItem,
  isConnected,
  libraryPanel,
  locale,
  nowIso,
  resolveBackendCwd,
  setBusyToolId,
  setCapabilityDockOpen,
  setCapabilityPanel,
  setLibraryPanel,
  setThreads,
  uniqueId,
  upsertOfficeArtifact,
}: OfficeArtifactActionParams): Promise<boolean> {
  if (!isConnected) {
    setCapabilityPanel(officeArtifactDisconnectedPanel(artifact, locale));
    return true;
  }

  if (busyToolId) {
    return false;
  }

  setBusyToolId("files");
  setCapabilityDockOpen(true);
  setCapabilityPanel(officeArtifactLocatingPanel(artifact, locale));

  try {
    const root = await resolveBackendCwd();
    if (!root) {
      throw new Error(
        locale === "zh"
          ? "未找到工作区路径"
          : "No workspace path found",
      );
    }

    const explicitArtifactPath = artifact.path?.trim();
    const artifactUrl = artifact.url?.trim();
    const explicitArtifactLocation = explicitArtifactPath
      ? {
          label: explicitArtifactPath,
          path: resolveSearchPath(root, explicitArtifactPath),
        }
      : artifactUrl
        ? {
            label: artifactUrl,
            path: artifactUrl,
          }
        : null;
    if (explicitArtifactLocation) {
      await loadOfficeArtifactFile({
        artifact,
        artifactPath: explicitArtifactLocation.path,
        client,
        items: [
          {
            label: `  ${explicitArtifactLocation.label}`,
            path: explicitArtifactLocation.path,
            kind: "file",
          },
        ],
        locale,
        setCapabilityPanel,
      });
      return true;
    }

    const response = await client?.fuzzyFileSearch(
      artifact.title,
      [root],
      uniqueId(),
    );
    const matches = response?.files ?? [];
    const exactMatch =
      matches.find((item) => item.file_name === artifact.title) ?? null;
    const fileMatch =
      exactMatch ??
      matches.find((item) => item.match_type === "file") ??
      matches[0] ??
      null;

    if (!fileMatch) {
      await createOfficeArtifactDraft({
        artifact,
        client,
        ensureOfficeThread,
        libraryPanel,
        locale,
        nowIso,
        root,
        setCapabilityPanel,
        setLibraryPanel,
        setThreads,
        upsertOfficeArtifact,
      });
      return true;
    }

    const artifactPath = resolveSearchPath(fileMatch.root, fileMatch.path);
    const topMatches = matches.slice(0, 8).map(
      (item) =>
        ({
          label: `${item.match_type === "directory" ? ">" : " "} ${item.path}`,
          path: resolveSearchPath(item.root, item.path),
          kind: item.match_type,
        }) satisfies CapabilityPanelItem,
    );

    if (fileMatch.match_type === "directory") {
      setCapabilityPanel(
        officeArtifactDirectoryPanel({
          artifact,
          artifactPath,
          items: topMatches,
          locale,
        }),
      );
      await handleDirectoryItem({
        label: artifact.title,
        path: artifactPath,
        kind: "directory",
      });
      return true;
    }

    await loadOfficeArtifactFile({
      artifact,
      artifactPath,
      client,
      items: topMatches,
      locale,
      setCapabilityPanel,
    });
  } catch (error) {
    setCapabilityPanel(officeArtifactErrorPanel({ artifact, error, locale }));
  } finally {
    setBusyToolId(null);
  }
  return true;
}

async function loadOfficeArtifactFile(params: {
  artifact: ArtifactItem;
  artifactPath: string;
  client: OfficeArtifactClient | null;
  items: CapabilityPanelItem[];
  locale: Locale;
  setCapabilityPanel: (panel: CapabilityPanel) => void;
}) {
  const { artifact, artifactPath, client, items, locale, setCapabilityPanel } =
    params;
  const [file, metadata] = await Promise.all([
    client?.readFile(artifactPath),
    client?.getMetadata(artifactPath),
  ]);
  const fileText = file ? decodeBase64Text(file.dataBase64) : "";
  const currentContentSha256 = file ? await sha256Base64(file.dataBase64) : null;
  setCapabilityPanel(
    officeArtifactLoadedPanel({
      artifact,
      artifactPath,
      currentContentSha256,
      fileText,
      items,
      locale,
      metadataText: fileMetadataText(metadata ?? null, locale),
      searchRoot: pathDirName(artifactPath),
    }),
  );
}

async function createOfficeArtifactDraft(params: {
  artifact: ArtifactItem;
  client: OfficeArtifactClient | null;
  ensureOfficeThread: (
    panel: LibraryPanel,
    workspace: OfficeWorkspace,
  ) => Promise<OfficeThreadResolution | null>;
  libraryPanel: LibraryPanel | null;
  locale: Locale;
  nowIso: () => string;
  root: string;
  setCapabilityPanel: (panel: CapabilityPanel) => void;
  setLibraryPanel: LibraryPanelSetter;
  setThreads: StateSetter<Thread[]>;
  upsertOfficeArtifact: (
    root: string,
    panel: LibraryPanel,
    workspace: OfficeWorkspace,
    threadId: string,
    artifact: ArtifactItem,
    message: OfficeMessage,
  ) => Promise<OfficeConfig | null>;
}) {
  const {
    artifact,
    client,
    ensureOfficeThread,
    libraryPanel,
    locale,
    nowIso,
    root,
    setCapabilityPanel,
    setLibraryPanel,
    setThreads,
    upsertOfficeArtifact,
  } = params;
  const artifactDir = joinPath(
    joinPath(joinPath(root, ".crewon"), "offices"),
    "artifacts",
  );
  const artifactPath = joinPath(
    artifactDir,
    `${slugifySkillName(artifact.title || "office-artifact")}.md`,
  );
  const artifactBody = officeArtifactDraftBody({
    artifact,
    createdAtIso: nowIso(),
    locale,
    officeGoal: libraryPanel?.workspace?.goal,
  });

  await client?.createDirectory(artifactDir, true);
  await client?.writeTextFile(artifactPath, artifactBody);
  const metadata = await client?.getMetadata(artifactPath);
  if (libraryPanel?.workspace) {
    const savedArtifact = officeSavedArtifact(artifact, artifactPath, locale);
    const systemMessage = officeArtifactSystemMessage({
      artifact,
      artifactPath,
      locale,
    });
    const nextWorkspace = officeWorkspaceWithArtifactMessage(
      libraryPanel.workspace,
      systemMessage,
    );
    const thread = await ensureOfficeThread(
      libraryPanel,
      libraryPanel.workspace,
    );
    if (thread) {
      const savedConfig = await upsertOfficeArtifact(
        root,
        libraryPanel,
        thread.config.workspace,
        thread.threadId,
        savedArtifact,
        systemMessage,
      );
      const turn = await client?.startTurn(
        thread.threadId,
        officeArtifactTurnPrompt({
          artifact,
          body: artifactBody,
          locale,
          officeTitle: libraryPanel.title,
        }),
      );
      if (turn) {
        setThreads((current) =>
          upsertTurnInThread(current, thread.threadId, turn.turn),
        );
      }
      setLibraryPanel((currentPanel) =>
        officeArtifactSavedPanel(currentPanel, {
          workspace: savedConfig?.workspace ?? nextWorkspace,
          threadId: thread.threadId,
        }),
      );
    }
  }

  setCapabilityPanel(
    officeArtifactDraftPanel({
      artifact,
      artifactBody,
      artifactDir,
      artifactPath,
      locale,
      metadataText: fileMetadataText(metadata ?? null, locale),
    }),
  );
}
