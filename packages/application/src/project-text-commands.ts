import type {
  ProjectOutlineContent,
  ProjectScriptContent,
} from "@crewon/domain";

type CandidateCommand = Readonly<{
  projectId: string;
  expectedArtifactRevision: number;
  briefRevision: number;
  idempotencyKey: string;
}>;
export type SaveProjectOutlineCandidateCommand = CandidateCommand &
  Readonly<{ content: ProjectOutlineContent }>;
export type SaveProjectScriptCandidateCommand = CandidateCommand &
  Readonly<{
    episodeId: string;
    outline: Readonly<{ artifactId: string; contentRevision: number }> | null;
    content: ProjectScriptContent;
  }>;
export type SelectProjectTextRevisionCommand = Readonly<{
  projectId: string;
  artifactId: string;
  expectedArtifactRevision: number;
  contentRevision: number;
  idempotencyKey: string;
}>;
export type SetProjectTextArtifactLockedCommand = Readonly<{
  projectId: string;
  artifactId: string;
  expectedArtifactRevision: number;
  locked: boolean;
  idempotencyKey: string;
}>;
export type ProjectTextMutationCommand =
  | SaveProjectOutlineCandidateCommand
  | SaveProjectScriptCandidateCommand
  | SelectProjectTextRevisionCommand
  | SetProjectTextArtifactLockedCommand;
