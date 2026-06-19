import type { FsGetMetadataResponse } from "@crewon-protocol/v2/FsGetMetadataResponse";
import type { FsReadFileResponse } from "@crewon-protocol/v2/FsReadFileResponse";

import type { CapabilityPanelItem } from "../capability/capabilityPanelTypes";
import type { LibraryPanel, LibraryPanelAction } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import { knowledgeFilePanel } from "./libraryActionPresentation";
import { pathBaseName } from "../shared/pathUtils";
import { decodeBase64Text } from "../server-request/serverRequestPresentation";

type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

export type LibraryFileActionParams = {
  action: LibraryPanelAction;
  getMetadata: (
    path: string,
  ) => Promise<FsGetMetadataResponse | null | undefined>;
  locale: Locale;
  openCapabilityItem: (item: CapabilityPanelItem) => void;
  readFile: (path: string) => Promise<FsReadFileResponse | null | undefined>;
  setCapabilityDockOpen: (open: boolean) => void;
  setLibraryPanel: LibraryPanelSetter;
};

export async function handleLibraryFileAction({
  action,
  getMetadata,
  locale,
  openCapabilityItem,
  readFile,
  setCapabilityDockOpen,
  setLibraryPanel,
}: LibraryFileActionParams): Promise<boolean> {
  if (action.id === "open-path") {
    if (!action.pathToOpen) {
      return true;
    }
    setCapabilityDockOpen(true);
    openCapabilityItem({
      label: pathBaseName(action.pathToOpen),
      path: action.pathToOpen,
      kind: action.pathKind ?? "file",
    });
    return true;
  }

  if (action.id === "open-knowledge-file") {
    if (!action.knowledgePath) {
      return true;
    }
    const knowledgePath = action.knowledgePath;
    const title = action.knowledgeTitle ?? pathBaseName(knowledgePath);
    if (action.knowledgeKind === "directory") {
      setCapabilityDockOpen(true);
      openCapabilityItem({
        label: title,
        path: knowledgePath,
        kind: "directory",
      });
      return true;
    }

    const [file, metadata] = await Promise.all([
      readFile(knowledgePath),
      getMetadata(knowledgePath),
    ]);
    const text = file ? decodeBase64Text(file.dataBase64) : "";
    setLibraryPanel((currentPanel) =>
      knowledgeFilePanel(currentPanel, {
        metadata,
        path: knowledgePath,
        text,
        title,
        locale,
      }),
    );
    return true;
  }

  return false;
}
