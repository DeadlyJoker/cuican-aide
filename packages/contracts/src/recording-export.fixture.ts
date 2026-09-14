/** SYNTHETIC C01 fixture: no browser, model or upstream integration was exercised. */
import {
  sealRecordingExport,
  type RecordingExport,
  type RecordingExportBody,
  type RecordingStep,
} from "./recording-export.ts";

export const SYNTHETIC_RECORDING_EVIDENCE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="white"/><rect x="32" y="24" width="160" height="32" fill="none" stroke="black"/></svg>';

const page = {
  origin: "https://teaching.example",
  routeTemplate: "https://teaching.example/orders?date={runtime}",
  // Synthetic route digest: this cannot be used to reconstruct or navigate a URL.
  routeDigest: `sha256:${"0".repeat(64)}` as const,
};
const baseStep = {
  page,
  target: null,
  input: null,
  note: null,
  evidenceIds: ["synthetic-evidence-1"],
  outcome: "observed",
  reason: null,
  relatedStepId: null,
} satisfies Partial<RecordingStep>;

/** Synthetic variable candidate is input.classification === 'parameter-candidate'. */
export async function createSyntheticRecordingExport(): Promise<RecordingExport> {
  const bytes = new TextEncoder().encode(SYNTHETIC_RECORDING_EVIDENCE_SVG);
  const hashed = await crypto.subtle.digest("SHA-256", bytes);
  const contentDigest =
    `sha256:${Array.from(new Uint8Array(hashed), (byte) => byte.toString(16).padStart(2, "0")).join("")}` as const;
  const body: RecordingExportBody = {
    schemaVersion: 1,
    recordingId: "synthetic-recording-1",
    revision: 12,
    scope: { ownerId: "synthetic-owner", workspaceId: null },
    authorization: {
      source: "desktop-user-start",
      authorizedAt: "2026-09-14T00:00:00.000Z",
      allowedOrigins: [page.origin],
    },
    startedAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:12.000Z",
    status: "completed",
    steps: [
      {
        ...baseStep,
        stepId: "synthetic-step-1",
        sequence: 1,
        kind: "navigate",
        occurredAt: "2026-09-14T00:00:01.000Z",
      },
      {
        ...baseStep,
        stepId: "synthetic-step-3",
        sequence: 3,
        kind: "input",
        occurredAt: "2026-09-14T00:00:03.000Z",
        target: {
          tag: "input",
          selector: "main:nth-of-type(1)>input:nth-of-type(1)",
          description: "text input",
          role: "textbox",
          accessibleName: "Region",
        },
        input: { classification: "parameter-candidate", value: "North" },
        note: "Synthetic example: candidate region parameter",
      },
      {
        ...baseStep,
        stepId: "synthetic-step-4",
        sequence: 4,
        kind: "select",
        occurredAt: "2026-09-14T00:00:04.000Z",
        target: {
          tag: "select",
          selector: "main:nth-of-type(1)>select:nth-of-type(1)",
          description: "select control",
          role: "combobox",
          accessibleName: "Period",
        },
        input: { classification: "ordinary", value: "current" },
      },
      {
        ...baseStep,
        stepId: "synthetic-step-5",
        sequence: 5,
        kind: "click",
        occurredAt: "2026-09-14T00:00:05.000Z",
        target: {
          tag: "button",
          selector: "main:nth-of-type(1)>button:nth-of-type(1)",
          description: "button",
          role: "button",
          accessibleName: "Download",
        },
      },
      {
        ...baseStep,
        stepId: "synthetic-step-6",
        sequence: 6,
        kind: "download",
        occurredAt: "2026-09-14T00:00:06.000Z",
        outcome: "unknown",
        relatedStepId: "synthetic-step-5",
        reason: "Synthetic download start; no completion event observed",
      },
      {
        ...baseStep,
        stepId: "synthetic-step-7",
        sequence: 7,
        kind: "unsupported",
        occurredAt: "2026-09-14T00:00:07.000Z",
        reason: "frame-content-unavailable",
      },
    ],
    evidence: [
      {
        evidenceId: "synthetic-evidence-1",
        kind: "redacted-layout",
        mediaType: "image/svg+xml",
        byteLength: bytes.byteLength,
        contentDigest,
      },
    ],
    edits: [
      {
        revision: 9,
        stepId: "synthetic-step-3",
        operation: "annotate",
        at: "2026-09-14T00:00:09.000Z",
      },
      {
        revision: 10,
        stepId: "synthetic-step-2",
        operation: "delete",
        at: "2026-09-14T00:00:10.000Z",
      },
    ],
  };
  return sealRecordingExport(body);
}
