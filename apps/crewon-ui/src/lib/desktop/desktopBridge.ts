import type {
  DesktopHttpReadResult,
  DESKTOP_HTTP_VERSION,
} from "./desktopHttpProtocol.ts";
import type { DesktopPluginUiAssets } from "./desktopPluginUiProtocol.ts";
export const DESKTOP_BRIDGE_VERSION = 1 as const;

/**
 * A cloud Agent profile entry that the renderer sends to the main process so
 * the runtime worker can target the agent's invocation URL with the correct
 * model identifier.
 */
export type CloudAgentProfileEntry = Readonly<{
  agentVersionId: string;
  instructions: string;
  invocationUrl: string;
  modelId: string;
  agentId: number;
}>;

export type AgentPlatformCredentialCatalog = Readonly<{
  bindings: readonly Readonly<{
    origin: string;
    credentialAvailable: boolean;
  }>[];
}>;

export type AgentPlatformCredentialUpsertRequest = Readonly<{
  origin: string;
  apiKey: string;
}>;

export type DesktopRectangle = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type DesktopHttpRequest = Readonly<{
  requestId: string;
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
  /** Additive capability: older desktop preloads remain valid and cannot load installed UI assets. */
  readonly pluginUiAssets?: DesktopPluginUiAssets;
  readonly agentPlatformCredentials: {
    catalog(): Promise<AgentPlatformCredentialCatalog>;
    upsert(
      request: AgentPlatformCredentialUpsertRequest,
    ): Promise<AgentPlatformCredentialCatalog>;
    delete(origin: string): Promise<AgentPlatformCredentialCatalog>;
  };
  readonly runtime: {
    bootstrap(): Promise<unknown>;
    reloadProvider(): Promise<void>;
    /**
     * Pushes cloud Agent profiles into the runtime supervisor so the runtime
     * worker can forward inference requests to each agent's invocation URL.
     * Triggers a runtime restart so the new profiles take effect.
     */
    updateCloudAgentProfiles(
      profiles: readonly CloudAgentProfileEntry[],
    ): Promise<void>;
  };
  readonly http: {
    readonly version: typeof DESKTOP_HTTP_VERSION;
    fetch(request: DesktopHttpRequest): Promise<DesktopHttpResponse>;
    read(requestId: string): Promise<DesktopHttpReadResult>;
    abort(requestId: string): Promise<void>;
  };
  readonly sandbox: {
    listDirectory(path?: string): Promise<unknown>;
    readFile(path: string): Promise<unknown>;
    readGitSummary(): Promise<unknown>;
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
    /** Asks the provider's /models endpoint which models it advertises. */
    modelCatalog(request: unknown): Promise<unknown>;
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
