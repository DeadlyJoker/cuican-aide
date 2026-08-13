import { type Dispatch, type SetStateAction, useEffect, useRef } from "react";

import type { ConnectionState } from "../../lib/shared/connectionState";

export type OfficeCatalogStatus = "loading" | "ready" | "unavailable";
type TimeoutId = ReturnType<typeof globalThis.setTimeout>;

const OFFICE_CATALOG_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000];

export function officeCatalogReconnectDelayMs(attempt: number): number {
  const normalizedAttempt = Math.max(0, Math.floor(attempt));
  return OFFICE_CATALOG_RECONNECT_DELAYS_MS[
    Math.min(normalizedAttempt, OFFICE_CATALOG_RECONNECT_DELAYS_MS.length - 1)
  ];
}

export function scheduleOfficeCatalogReconnect({
  active,
  attempt,
  clearTimeout,
  connectionState,
  onReconnect,
  setTimeout,
  status,
}: {
  active: boolean;
  attempt: number;
  clearTimeout: (timeoutId: TimeoutId) => void;
  connectionState: ConnectionState;
  onReconnect: (nextAttempt: number) => void;
  setTimeout: (handler: () => void, timeout: number) => TimeoutId;
  status: OfficeCatalogStatus;
}): (() => void) | undefined {
  if (!active || connectionState !== "connected" || status !== "unavailable") {
    return undefined;
  }

  const timeoutId = setTimeout(() => {
    onReconnect(attempt + 1);
  }, officeCatalogReconnectDelayMs(attempt));

  return () => clearTimeout(timeoutId);
}

export function useCommandOfficeCatalogAutoReconnect({
  active,
  connectionState,
  refreshNonce,
  status,
  workspaceCwd,
}: {
  active: boolean;
  connectionState: ConnectionState;
  refreshNonce: Dispatch<SetStateAction<number>>;
  status: OfficeCatalogStatus;
  workspaceCwd: string;
}) {
  const attemptRef = useRef(0);

  useEffect(() => {
    attemptRef.current = 0;
  }, [workspaceCwd]);

  useEffect(() => {
    if (status === "ready") {
      attemptRef.current = 0;
      return undefined;
    }

    return scheduleOfficeCatalogReconnect({
      active,
      attempt: attemptRef.current,
      clearTimeout: (timeoutId) => window.clearTimeout(timeoutId),
      connectionState,
      onReconnect: (nextAttempt) => {
        attemptRef.current = nextAttempt;
        refreshNonce((current) => current + 1);
      },
      setTimeout: (handler, timeout) => window.setTimeout(handler, timeout),
      status,
    });
  }, [active, connectionState, refreshNonce, status, workspaceCwd]);
}
