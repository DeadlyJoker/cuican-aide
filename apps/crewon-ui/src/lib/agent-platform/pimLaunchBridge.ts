/**
 * PIM launch token bridge.
 *
 * When a user enters CrewON from a PIM showcase page, PIM appends a
 * `pim_launch_token` query parameter to the demo URL. This module:
 *
 * 1. Extracts the token from the URL before the app renders.
 * 2. Stores it in sessionStorage so it survives soft navigations.
 * 3. Cleans the URL so the token is not bookmarked or shared.
 * 4. Exposes helpers so the auth and fetch layers can attach it to
 *    every API request.
 *
 * The token IS the authentication — there is no separate login step.
 */

import { notifyAgentPlatformSessionChanged } from "./agentPlatformSessionEvents";

const PIM_LAUNCH_TOKEN_STORAGE_KEY = "pim_launch_token";

/** Current module session wins over stale or unavailable browser persistence. */
let activeToken: string | null = null;
const tokenChangedListeners = new Set<() => void>();

function browserSessionStorage(): Storage | null {
  try {
    if (
      typeof window !== "undefined" &&
      typeof sessionStorage !== "undefined"
    ) {
      // Accessing sessionStorage may throw in sandboxed iframes.
      void sessionStorage.length;
      return sessionStorage;
    }
  } catch {
    // sessionStorage not available — fall back to in-memory store.
  }
  return null;
}

function readStoredToken(): string | null {
  const storage = browserSessionStorage();
  try {
    if (storage) {
      return normalizeLaunchToken(
        storage.getItem(PIM_LAUNCH_TOKEN_STORAGE_KEY),
      );
    }
  } catch {
    // A method may fail even when reading sessionStorage.length succeeded.
  }
  return activeToken;
}

function writeStoredToken(token: string): void {
  activeToken = token;
  const storage = browserSessionStorage();
  try {
    storage?.setItem(PIM_LAUNCH_TOKEN_STORAGE_KEY, token);
  } catch {
    // Keep the current token when persistence is denied or full.
  }
}

function removeStoredToken(): void {
  activeToken = null;
  const storage = browserSessionStorage();
  try {
    storage?.removeItem(PIM_LAUNCH_TOKEN_STORAGE_KEY);
  } catch {
    // A stale persisted token must not reactivate this cleared module session.
  }
}

/** One-shot, idempotent: called once on first script evaluation. */
function captureLaunchTokenFromUrl(): string | null {
  if (typeof window === "undefined") return null;

  try {
    const params = new URLSearchParams(window.location.search);
    const rawToken =
      params.get("pim_launch_token") || params.get("launch_token") || "";

    if (!rawToken) return readStoredToken();

    const token = normalizeLaunchToken(rawToken);
    if (token === null) removeStoredToken();
    else writeStoredToken(token);

    // Remove the token from the URL so it isn't bookmarked or shared.
    params.delete("pim_launch_token");
    params.delete("launch_token");
    const nextSearch = params.toString();
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash || ""}`;
    try {
      window.history.replaceState({}, document.title, nextUrl);
    } catch {
      // URL cleanup failure does not change the captured session.
    }

    return token;
  } catch {
    return null;
  }
}

/** Normalize a raw token value: strip Bearer prefix and surrounding whitespace. */
function normalizeLaunchToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let token = raw.trim();
  if (token.toLowerCase().startsWith("bearer ")) {
    token = token.slice(7).trim();
  }
  return token || null;
}

// Capture once at module load — before React mounts.
activeToken = captureLaunchTokenFromUrl();

/**
 * Return the active PIM launch token, if one was captured from the URL
 * or previously stored in sessionStorage.
 */
export function getPimLaunchToken(): string | null {
  return activeToken;
}

/** Internal synchronous invalidation, independent of the public UI event. */
export function onPimLaunchTokenChanged(listener: () => void): () => void {
  tokenChangedListeners.add(listener);
  return () => {
    tokenChangedListeners.delete(listener);
  };
}

function notifyTokenChanged(notifySessionChanged: boolean): void {
  for (const listener of [...tokenChangedListeners]) {
    try {
      listener();
    } catch {
      // One consumer cannot prevent other session owners from withdrawing.
    }
  }
  if (notifySessionChanged) notifyAgentPlatformSessionChanged();
}

/**
 * Whether the current session was launched from a PIM showcase page.
 */
export function isPimLaunchSession(): boolean {
  return getPimLaunchToken() !== null;
}

/**
 * Persist a refreshed launch token.
 *
 * Called when the backend refresh endpoint returns a new token for an
 * expiring session.
 */
export function setPimLaunchToken(token: string): void {
  const normalized = normalizeLaunchToken(token);
  if (!normalized) return;
  const previous = getPimLaunchToken();
  writeStoredToken(normalized);
  if (previous !== normalized) notifyTokenChanged(true);
}

/** Discard the current PIM launch token. */
export function clearPimLaunchToken(
  options: Readonly<{ notifySessionChanged?: boolean }> = {},
): void {
  const previous = getPimLaunchToken();
  removeStoredToken();
  if (previous !== null)
    notifyTokenChanged(options.notifySessionChanged !== false);
}

/**
 * Attach the PIM launch token to a Headers object if one is active.
 *
 * Returns the same Headers instance (mutated) for chaining convenience.
 */
export function attachPimLaunchToken(headers: Headers): Headers {
  const token = getPimLaunchToken();
  if (token && !headers.has("X-PIM-Launch-Token")) {
    headers.set("X-PIM-Launch-Token", token);
  }
  return headers;
}
