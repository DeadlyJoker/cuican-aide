import type { WebContents } from "electron";

/** Host-only C05 adapter. Never expose WebContents, lease or AbortSignal over renderer IPC. */
export type RecordingExecutionSession = {
  sessionId: string;
  webContents: WebContents;
  generation: number;
  mode: "recording" | "paused" | "interrupted" | "idle" | "executing";
};
export type RecordingExecutionLease = {
  leaseId: string;
  sessionId: string;
  generation: number;
  signal: AbortSignal;
};
export interface RecordingExecutionAccess {
  getExecutionSession(sessionId?: string): RecordingExecutionSession | null;
  acquireExecution(request: {
    sessionId: string;
    ownerId: string;
    expectedGeneration: number;
  }): RecordingExecutionLease;
  releaseExecution(leaseId: string): void;
  revokeExecution(reason: string): void;
  subscribeExecutionRevoked(listener: (reason: string) => void): () => void;
}
