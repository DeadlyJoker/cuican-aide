import type {
  ProjectCreationParameters,
  ProjectOrigin,
  ProjectProposal,
} from "@crewon/domain";

import type { ProjectSourceUploadReference } from "./project-source-preparation-port.ts";
export type { ProjectSourceUploadReference } from "./project-source-preparation-port.ts";
export type CreateProjectFoundationCommand = Readonly<{
  title: string;
  briefText: string;
  origin: ProjectOrigin;
  parameters: ProjectCreationParameters;
  creativeStartMode: "confirm-plan" | "direct-script" | null;
  sourceUpload: ProjectSourceUploadReference | null;
  idempotencyKey: string;
}>;
type MutationCommand = Readonly<{
  projectId: string;
  expectedFoundationRevision: number;
  idempotencyKey: string;
}>;
export type UpdateProjectFoundationParametersCommand = MutationCommand &
  Readonly<{ parameters: ProjectCreationParameters }>;
export type AppendProjectFoundationSourceCommand = MutationCommand &
  Readonly<{ sourceUpload: ProjectSourceUploadReference }>;
export type SaveProjectProposalCommand = MutationCommand &
  Readonly<{
    expectedProposalRevision: number;
    kind: ProjectProposal["kind"];
    text: string;
  }>;
export type ConfirmProjectProposalCommand = MutationCommand &
  Readonly<{ proposalRevision: number; proposalDigest: string }>;
export type ChooseProjectFoundationStartModeCommand = MutationCommand &
  Readonly<{ creativeStartMode: "confirm-plan" | "direct-script" }>;
export type ProjectFoundationMutationCommand =
  | CreateProjectFoundationCommand
  | UpdateProjectFoundationParametersCommand
  | AppendProjectFoundationSourceCommand
  | SaveProjectProposalCommand
  | ConfirmProjectProposalCommand
  | ChooseProjectFoundationStartModeCommand;
export type ProjectFoundationQuery = Readonly<{ projectId: string }>;
export type ProjectSourceQuery = ProjectFoundationQuery &
  Readonly<{ sourceRevision: number }>;
export type ProjectSourcePageQuery = ProjectSourceQuery &
  Readonly<{ sourceDigest: string; startOffset: number; limit: number }>;
export type ProjectSourceChaptersQuery = ProjectSourceQuery &
  Readonly<{
    sourceDigest: string;
    afterStartOffset: number | null;
    limit: number;
  }>;
export type ProjectProposalQuery = ProjectFoundationQuery &
  Readonly<{ proposalRevision: number }>;
export type ProjectProposalsQuery = ProjectFoundationQuery &
  Readonly<{ afterProposalRevision: number; limit: number }>;
