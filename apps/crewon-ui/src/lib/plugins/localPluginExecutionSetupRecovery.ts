import type {
  DesktopLocalPluginExecutionPreview,
  DesktopLocalPluginExecutionSetupAccess,
  DesktopLocalPluginExecutionSetupClient,
} from "../desktop/desktopLocalPluginExecutionSetupProtocol";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";

export type LocalPluginExecutionSetupTicket = Readonly<{
  preview: DesktopLocalPluginExecutionPreview;
}>;
type Entry = {
  ownerKey: string;
  shell: symbol | null;
  startedInShell: symbol | null;
  ticket: LocalPluginExecutionSetupTicket | null;
  release: (() => void) | null;
};
// Exactly one public ticket per genuine preload client. Main's receipt remains the fact source.
const entries = new WeakMap<DesktopLocalPluginExecutionSetupClient, Entry>();
function entry(access: DesktopLocalPluginExecutionSetupAccess): Entry {
  let current = entries.get(access.client);
  if (current && current.ownerKey !== access.ownerKey) {
    clearLocalPluginExecutionSetupTicket({
      client: access.client,
      ownerKey: current.ownerKey,
    });
    current = undefined;
  }
  if (!current) {
    current = {
      ownerKey: access.ownerKey,
      shell: null,
      startedInShell: null,
      ticket: null,
      release: null,
    };
    entries.set(access.client, current);
  }
  return current;
}
export function registerLocalPluginExecutionSetupShell(
  access: DesktopLocalPluginExecutionSetupAccess,
  shell: symbol,
): string | null {
  const current = entry(access);
  const restore = current.ticket !== null && current.startedInShell !== shell;
  current.shell = shell;
  return restore ? current.ticket!.preview.pluginId : null;
}
export function localPluginExecutionSetupTicket(
  access: DesktopLocalPluginExecutionSetupAccess,
): LocalPluginExecutionSetupTicket | null {
  return entry(access).ticket;
}
export function currentLocalPluginExecutionSetupPluginId(
  access: DesktopLocalPluginExecutionSetupAccess,
): string | null {
  return localPluginExecutionSetupTicket(access)?.preview.pluginId ?? null;
}
export function retainLocalPluginExecutionSetupTicket(
  access: DesktopLocalPluginExecutionSetupAccess,
  preview: DesktopLocalPluginExecutionPreview,
): LocalPluginExecutionSetupTicket | null {
  clearLocalPluginExecutionSetupTicket(access);
  const current = entry(access);
  const ticket = Object.freeze({ preview });
  current.ticket = ticket;
  current.startedInShell = current.shell;
  const withdraw = () => clearLocalPluginExecutionSetupTicket(access, ticket);
  try {
    const release = access.client.subscribeOwnerChanged(withdraw);
    if (typeof release !== "function")
      throw new Error("invalid_execution_owner_listener");
    if (current.ticket !== ticket) {
      release();
      return null;
    }
    window.addEventListener(AGENT_PLATFORM_SESSION_CHANGED_EVENT, withdraw);
    current.release = () => {
      try {
        release();
      } finally {
        window.removeEventListener(
          AGENT_PLATFORM_SESSION_CHANGED_EVENT,
          withdraw,
        );
      }
    };
  } catch {
    clearLocalPluginExecutionSetupTicket(access, ticket);
    return null;
  }
  return ticket;
}
export function clearLocalPluginExecutionSetupTicket(
  access: DesktopLocalPluginExecutionSetupAccess,
  expected?: LocalPluginExecutionSetupTicket,
): void {
  const current = entries.get(access.client);
  if (
    !current ||
    current.ownerKey !== access.ownerKey ||
    (expected && current.ticket !== expected)
  )
    return;
  const release = current.release;
  current.release = null;
  current.ticket = null;
  current.startedInShell = null;
  try {
    release?.();
  } catch {
    /* A listener cannot preserve a withdrawn ticket. */
  }
}
