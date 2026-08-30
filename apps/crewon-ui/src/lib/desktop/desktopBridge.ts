export const DESKTOP_BRIDGE_VERSION = 1 as const;

export type DesktopRectangle = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type DesktopHttpRequest = Readonly<{
  url: string;
  method: string;
  headers: readonly (readonly [string, string])[];
  body: Uint8Array | null;
}>;

export type DesktopHttpResponse = Readonly<{
  url: string;
  status: number;
  statusText: string;
  headers: readonly (readonly [string, string])[];
  body: Uint8Array;
}>;

export type DesktopUpdateInfo = Readonly<{
  version: string;
  notes?: string;
}>;

export type DesktopUpdateProgress =
  | Readonly<{ event: "Started"; data: { contentLength?: number } }>
  | Readonly<{ event: "Progress"; data: { chunkLength: number } }>
  | Readonly<{ event: "Finished" }>;

/**
 * Narrow, versioned host surface exposed by the isolated Electron preload.
 * Renderer code never receives Node, Electron, filesystem, or raw IPC access.
 */
export interface CrewonDesktopBridge {
  readonly version: typeof DESKTOP_BRIDGE_VERSION;
  readonly runtime: {
    bootstrap(): Promise<unknown>;
    reloadProvider(): Promise<void>;
  };
  readonly http: {
    fetch(request: DesktopHttpRequest): Promise<DesktopHttpResponse>;
  };
  readonly sandbox: {
    listDirectory(path?: string): Promise<unknown>;
    readFile(path: string): Promise<unknown>;
    readDiff(): Promise<unknown>;
    runCommand(request: unknown): Promise<unknown>;
  };
  readonly workspace: {
    status(): Promise<unknown>;
    selectAndRegister(request: unknown): Promise<unknown>;
    clear(request: unknown): Promise<unknown>;
    pickDirectory(title?: string): Promise<string | null>;
  };
  readonly providers: {
    catalog(): Promise<unknown>;
    activate(providerId: string): Promise<unknown>;
    delete(providerId: string): Promise<unknown>;
    upsert(request: unknown): Promise<unknown>;
  };
  readonly window: {
    close(): Promise<void>;
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    isMaximized(): Promise<boolean>;
    isFullscreen(): Promise<boolean>;
    onBoundsChanged(listener: () => void): () => void;
  };
  readonly browser: {
    create(id: string, url: string, bounds: DesktopRectangle): Promise<void>;
    updateBounds(id: string, bounds: DesktopRectangle): Promise<void>;
    setVisible(id: string, visible: boolean): Promise<void>;
    destroy(id: string): Promise<void>;
  };
  readonly updater: {
    check(): Promise<DesktopUpdateInfo | null>;
    download(): Promise<void>;
    relaunch(): Promise<void>;
    onProgress(listener: (event: DesktopUpdateProgress) => void): () => void;
  };
  readonly external: {
    open(url: string): Promise<void>;
  };
}

declare global {
  interface Window {
    readonly crewonDesktop?: CrewonDesktopBridge;
  }
}

export function getDesktopBridge(): CrewonDesktopBridge | null {
  const bridge =
    typeof window === "undefined" ? undefined : window.crewonDesktop;
  return bridge?.version === DESKTOP_BRIDGE_VERSION ? bridge : null;
}

export function requireDesktopBridge(): CrewonDesktopBridge {
  const bridge = getDesktopBridge();
  if (bridge === null) {
    throw new Error("desktop_bridge_unavailable");
  }
  return bridge;
}
