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

const PIM_LAUNCH_TOKEN_STORAGE_KEY = "pim_launch_token";

/** In-memory fallback for environments without sessionStorage (tests, SSR). */
let _memoryStore: string | null = null;

function browserSessionStorage(): Storage | null {
  try {
    if (typeof window !== "undefined" && typeof sessionStorage !== "undefined") {
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
  if (storage) {
    return storage.getItem(PIM_LAUNCH_TOKEN_STORAGE_KEY) || null;
  }
  return _memoryStore;
}

function writeStoredToken(token: string): void {
  const storage = browserSessionStorage();
  if (storage) {
    storage.setItem(PIM_LAUNCH_TOKEN_STORAGE_KEY, token);
    return;
  }
  _memoryStore = token;
}

function removeStoredToken(): void {
  const storage = browserSessionStorage();
  if (storage) {
    storage.removeItem(PIM_LAUNCH_TOKEN_STORAGE_KEY);
    return;
  }
  _memoryStore = null;
}

/** One-shot, idempotent: called once on first script evaluation. */
function captureLaunchTokenFromUrl(): string | null {
  if (typeof window === "undefined") return null;

  try {
    const params = new URLSearchParams(window.location.search);
    const token =
      params.get("pim_launch_token") ||
      params.get("launch_token") ||
      "";

    if (!token) return readStoredToken();

    writeStoredToken(token);

    // Remove the token from the URL so it isn't bookmarked or shared.
    params.delete("pim_launch_token");
    params.delete("launch_token");
    const nextSearch = params.toString();
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash || ""}`;
    window.history.replaceState({}, document.title, nextUrl);

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
const _launchToken = captureLaunchTokenFromUrl();

/**
 * Return the active PIM launch token, if one was captured from the URL
 * or previously stored in sessionStorage.
 */
export function getPimLaunchToken(): string | null {
  const token = _launchToken || readStoredToken();
  return normalizeLaunchToken(token);
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
  writeStoredToken(normalized);
}

/** Discard the current PIM launch token. */
export function clearPimLaunchToken(): void {
  removeStoredToken();
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
