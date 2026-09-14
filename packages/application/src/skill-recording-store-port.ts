import type { RecordingExport } from "@crewon/contracts/recording";
import type { SkillRecordingSource } from "@crewon/domain";
import type { SkillScope } from "./demonstrated-skill-store-port.ts";
export type SkillEvidenceUpload = Readonly<{
  evidenceId: string;
  mediaType: "image/png" | "image/svg+xml";
  dataBase64: string;
}>;
/** Separate from model context. Scope comes from the authenticated importer, never C01 source claims. */
export interface SkillRecordingStore {
  saveImportedRecording(
    scope: SkillScope,
    recording: RecordingExport,
    evidence: readonly SkillEvidenceUpload[],
  ): Promise<void>;
  readImportedRecording(
    scope: SkillScope,
    source: SkillRecordingSource,
  ): Promise<RecordingExport | null>;
  readRecordingEvidence(
    scope: SkillScope,
    source: SkillRecordingSource,
    evidenceId: string,
  ): Promise<SkillEvidenceUpload | null>;
}
