import type { ProjectFoundationSourceUpload } from "@crewon/plugin-sdk/project-foundation-ui";
/** Host-owned raw transport only. Ordinary services.invoke never receives file bytes or base64. */
export interface ProjectSourceUploadUiPort {
  cancelUpload?(): Promise<void>;
  uploadFile(
    input: Readonly<{
      file: File;
      signal: AbortSignal;
      progress(
        value: Readonly<{
          phase: "uploading" | "preparing";
          sentBytes: number;
          totalBytes: number;
        }>,
      ): void;
    }>,
  ): Promise<ProjectFoundationSourceUpload>;
}
