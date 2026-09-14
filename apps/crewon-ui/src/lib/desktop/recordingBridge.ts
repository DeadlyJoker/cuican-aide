import type { RecordingExport } from "@crewon/contracts/recording";
import type { DesktopRectangle } from "./desktopBridge.ts";

export type RecordingSkillImportRequest = {
  requestId: string;
  recording: RecordingExport;
  evidence: Array<{
    evidenceId: string;
    mediaType: string;
    dataBase64: string;
  }>;
};
export type RecordingSkillImportResult = {
  ok: boolean;
  message: string;
  skillId?: string;
};
export type RecordingSkillImportListener = (
  request: RecordingSkillImportRequest,
) => Promise<RecordingSkillImportResult>;
export type RecordingState = {
  skillImportAvailable: boolean;
  captureReady?: boolean;
  recording: RecordingExport | null;
  pageOrigin: string | null;
  error: string | null;
  recordings: Array<{
    recordingId: string;
    status: RecordingExport["status"];
    startedAt: string;
  }>;
};
export interface RecordingBridge {
  open(): Promise<void>;
  handoff(): Promise<RecordingSkillImportResult>;
  state(): Promise<RecordingState>;
  start(url: string): Promise<RecordingState>;
  navigate(url: string): Promise<RecordingState>;
  control(request: {
    command: "pause" | "resume" | "finish";
    recordingId: string;
    expectedRevision: number;
  }): Promise<RecordingState>;
  edit(request: {
    stepId: string;
    operation: "delete" | "annotate";
    note: string | null;
    expectedRevision: number;
  }): Promise<RecordingState>;
  select(recordingId: string): Promise<RecordingState>;
  remove(recordingId: string): Promise<RecordingState>;
  export(): Promise<{ cancelled: boolean }>;
  evidence(evidenceId: string): Promise<string>;
  bounds(bounds: DesktopRectangle): Promise<void>;
}
export type RecordingSourceEvent = {
  kind: "click" | "input" | "select" | "unsupported";
  target: {
    tag: string;
    selector: string;
    description: string;
    role: string | null;
    accessibleName: string | null;
  } | null;
  input:
    | { classification: "ordinary" | "parameter-candidate"; value: string }
    | { classification: "runtime-required" }
    | null;
  reason: string | null;
  screenshotSafe: boolean;
  layout: {
    width: number;
    height: number;
    x: number;
    y: number;
    targetWidth: number;
    targetHeight: number;
  } | null;
};
