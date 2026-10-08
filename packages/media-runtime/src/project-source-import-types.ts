import type { ProjectSourceFormat } from "@crewon/domain";

export type ParseProjectSourceFileInput = Readonly<{
  fileName: string;
  format: ProjectSourceFormat;
  bytes: Uint8Array;
}>;

/** Prepared normalized data only. Scope and audit identity belong to the application. */
export type ParsedProjectSourceFile = Readonly<{
  fileName: string;
  format: ProjectSourceFormat;
  byteLength: number;
  characterLength: number;
  digest: string;
  fileDigest: string;
  chunks: readonly Readonly<{
    index: number;
    startOffset: number;
    content: string;
    digest: string;
  }>[];
  chapters: readonly Readonly<{
    chapterId: string;
    title: string;
    startOffset: number;
    endOffset: number;
  }>[];
}>;

export type ProjectSourceHeading = Readonly<{
  title: string;
  startOffset: number;
}>;
