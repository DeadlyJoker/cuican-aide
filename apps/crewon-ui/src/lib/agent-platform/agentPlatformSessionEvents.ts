export const AGENT_PLATFORM_SESSION_CHANGED_EVENT =
  "crewon-agent-platform-session-changed";

/** Session invalidation carries no token, user snapshot, or authority. */
export function notifyAgentPlatformSessionChanged(): void {
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function" &&
    typeof Event !== "undefined"
  ) {
    window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT));
  }
}
