import type {
  DesktopLocalPluginSourceConfirmation,
  DesktopLocalPluginSourceConfirmed,
  DesktopLocalPluginSourceImportAccess,
  DesktopLocalPluginSourceImportClient,
  DesktopLocalPluginSourceImportStatus,
} from "../desktop/desktopLocalPluginSourceImportProtocol";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";

type Binding = DesktopLocalPluginSourceImportAccess;
type Identity = Pick<
  DesktopLocalPluginSourceConfirmation,
  "previewId" | "pluginId" | "publisherId" | "version" | "packageDigest"
>;
export type LocalPluginSourceImportTicket = Readonly<{ identity: Identity }>;
type Entry = {
  ownerKey: string;
  shell: symbol | null;
  startedInShell: symbol | null;
  restoreSettings: boolean;
  ticket: LocalPluginSourceImportTicket | null;
  release: (() => void) | null;
};

// One ticket per actual preload client. No paths, credentials, durable history or
// runtime access survive a shell remount; Main owns and verifies the actual result.
const entries = new WeakMap<DesktopLocalPluginSourceImportClient, Entry>();
const identityKeys = [
  "pluginId",
  "publisherId",
  "version",
  "packageDigest",
] as const;

function entry(binding: Binding): Entry {
  let current = entries.get(binding.client);
  if (current && current.ownerKey !== binding.ownerKey) {
    clearLocalPluginSourceImportTicket({
      client: binding.client,
      ownerKey: current.ownerKey,
    });
    current = undefined;
  }
  if (!current) {
    current = {
      ownerKey: binding.ownerKey,
      shell: null,
      startedInShell: null,
      restoreSettings: false,
      ticket: null,
      release: null,
    };
    entries.set(binding.client, current);
  }
  return current;
}

export function registerLocalPluginSourceImportShell(
  binding: Binding,
  shell: symbol,
): boolean {
  const current = entry(binding);
  const restore =
    current.ticket !== null &&
    current.restoreSettings &&
    current.startedInShell !== shell;
  current.shell = shell;
  if (restore) current.restoreSettings = false;
  return restore;
}

export function retainLocalPluginSourceImportTicket(
  binding: Binding,
  command: DesktopLocalPluginSourceConfirmation,
): LocalPluginSourceImportTicket | null {
  if (
    typeof binding.client.readStatus !== "function" ||
    typeof binding.client.subscribeStatusChanged !== "function"
  )
    return null;
  clearLocalPluginSourceImportTicket(binding);
  const current = entry(binding);
  const ticket = Object.freeze({
    identity: Object.freeze({
      previewId: command.previewId,
      pluginId: command.pluginId,
      publisherId: command.publisherId,
      version: command.version,
      packageDigest: command.packageDigest,
    }),
  });
  current.ticket = ticket;
  current.startedInShell = current.shell;
  current.restoreSettings = true;
  const withdraw = () => clearLocalPluginSourceImportTicket(binding, ticket);
  // These listeners outlive the settings component, including a signed-out
  // AuthGate remount. Neither listener holds any old runtime capability open.
  try {
    const unsubscribe = binding.client.subscribeOwnerChanged(withdraw);
    if (typeof unsubscribe !== "function")
      throw new Error("invalid_owner_listener");
    if (current.ticket !== ticket) {
      unsubscribe();
      return null;
    }
    window.addEventListener(AGENT_PLATFORM_SESSION_CHANGED_EVENT, withdraw);
    current.release = () => {
      try {
        unsubscribe();
      } finally {
        window.removeEventListener(
          AGENT_PLATFORM_SESSION_CHANGED_EVENT,
          withdraw,
        );
      }
    };
  } catch {
    clearLocalPluginSourceImportTicket(binding, ticket);
    return null;
  }
  return ticket;
}

export function localPluginSourceImportTicket(
  binding: Binding,
): LocalPluginSourceImportTicket | null {
  return entry(binding).ticket;
}

export function clearLocalPluginSourceImportTicket(
  binding: Binding,
  expected?: LocalPluginSourceImportTicket,
): void {
  const current = entries.get(binding.client);
  if (
    !current ||
    current.ownerKey !== binding.ownerKey ||
    (expected && current.ticket !== expected)
  )
    return;
  const release = current.release;
  current.release = null;
  current.ticket = null;
  current.startedInShell = null;
  current.restoreSettings = false;
  release?.();
}

export function validateLocalPluginSourceImportResult(
  result: DesktopLocalPluginSourceConfirmed,
  identity: Identity,
): void {
  if (
    !result ||
    typeof result !== "object" ||
    typeof result.sourceId !== "string" ||
    !result.sourceId ||
    result.sourceId.length > 256 ||
    identityKeys.some((key) => result[key] !== identity[key]) ||
    (result.runtimeStatus !== "ready" &&
      result.runtimeStatus !== "restartRequired") ||
    result.restartRequired !== (result.runtimeStatus === "restartRequired")
  )
    throw new Error("invalid_confirmation");
}

export function validateLocalPluginSourceImportStatus(
  status: DesktopLocalPluginSourceImportStatus,
  ticket: LocalPluginSourceImportTicket,
): void {
  if (
    !status ||
    typeof status !== "object" ||
    status.previewId !== ticket.identity.previewId ||
    identityKeys.some((key) => status[key] !== ticket.identity[key])
  )
    throw new Error("invalid_import_status");
  switch (status.state) {
    case "pending":
      return;
    case "committed":
      validateLocalPluginSourceImportResult(status.result, ticket.identity);
      return;
    case "failed":
      if (status.code === "desktop_plugin_source_import_failed") return;
      break;
  }
  throw new Error("invalid_import_status");
}
