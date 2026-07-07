import type { LibraryPanel, LibraryPanelAction } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import {
  isLibraryDraftAction,
  libraryActionFailurePanel,
  libraryActionProgressPanel,
  libraryDemoBackendDeferredPanel,
  libraryDraftActionPanel,
} from "./libraryActionPresentation";

type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;
export type LibraryPanelActionHandler = () => boolean | Promise<boolean>;

export type LibraryConnectionGateParams = {
  action: LibraryPanelAction;
  isConnected: boolean;
  isDemo: boolean;
  locale: Locale;
  setLibraryPanel: LibraryPanelSetter;
};

export function handleLibraryConnectionGate({
  action,
  isConnected,
  isDemo,
  locale,
  setLibraryPanel,
}: LibraryConnectionGateParams): boolean {
  if (isConnected || (isDemo && isLibraryDraftAction(action.id))) {
    return false;
  }

  if (
    isDemo &&
    (action.id === "reload-tools" || action.id === "install-plugin")
  ) {
    const deferredActionId = action.id;
    setLibraryPanel((currentPanel) =>
      libraryDemoBackendDeferredPanel(currentPanel, deferredActionId, locale),
    );
  }

  return true;
}

export function handleLibraryDraftPlaceholder({
  action,
  locale,
  setLibraryPanel,
}: {
  action: LibraryPanelAction;
  locale: Locale;
  setLibraryPanel: LibraryPanelSetter;
}): boolean {
  if (!isLibraryDraftAction(action.id)) {
    return false;
  }

  const draftActionId = action.id;
  setLibraryPanel((currentPanel) =>
    libraryDraftActionPanel(currentPanel, draftActionId, locale),
  );
  return true;
}

export function showLibraryActionProgress({
  action,
  locale,
  setLibraryPanel,
}: {
  action: LibraryPanelAction;
  locale: Locale;
  setLibraryPanel: LibraryPanelSetter;
}): void {
  setLibraryPanel((currentPanel) =>
    libraryActionProgressPanel(currentPanel, action.id, locale),
  );
}

export async function handleLibraryPanelActionDispatch({
  action,
  connectedHandlers,
  deferredHandlers,
  immediateHandlers,
  isConnected,
  isDemo,
  locale,
  setLibraryPanel,
}: {
  action: LibraryPanelAction;
  connectedHandlers: LibraryPanelActionHandler[];
  deferredHandlers: LibraryPanelActionHandler[];
  immediateHandlers: LibraryPanelActionHandler[];
  isConnected: boolean;
  isDemo: boolean;
  locale: Locale;
  setLibraryPanel: LibraryPanelSetter;
}): Promise<boolean> {
  if (
    handleLibraryConnectionGate({
      action,
      isConnected,
      isDemo,
      locale,
      setLibraryPanel,
    })
  ) {
    return true;
  }

  if (await runLibraryActionHandlers(immediateHandlers)) {
    return true;
  }

  if (isConnected && await runLibraryActionHandlers(connectedHandlers)) {
    return true;
  }

  if (handleLibraryDraftPlaceholder({ action, locale, setLibraryPanel })) {
    return true;
  }

  showLibraryActionProgress({ action, locale, setLibraryPanel });

  try {
    return await runLibraryActionHandlers(deferredHandlers);
  } catch (error) {
    setLibraryPanel((currentPanel) =>
      libraryActionFailurePanel(currentPanel, error, action.id, locale),
    );
    return true;
  }
}

async function runLibraryActionHandlers(
  handlers: LibraryPanelActionHandler[],
): Promise<boolean> {
  for (const handler of handlers) {
    if (await handler()) {
      return true;
    }
  }
  return false;
}
