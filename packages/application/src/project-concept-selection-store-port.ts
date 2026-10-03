import type {
  CurrentConceptSelection,
  OperationResultLink,
  ProjectGenerationReference,
  ProjectConceptSelectionPublication,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type {
  CreativeProjectCommitAuthority,
  CreativeProjectMutationReceipt,
  CreativeProjectOwnerScope,
} from "./creative-project-store-port.ts";
export type CommitProjectConceptSelectionInput = Readonly<{
  actor: ActorContext;
  reference: ProjectGenerationReference;
  operationId: string;
  expectedOperationRevision: number;
  resultIndex: number;
  expectedSelectionRevision: number;
  receipt: CreativeProjectMutationReceipt;
  at: string;
}>;
export type ProjectConceptSelectionCommandSource =
  | Readonly<{ kind: "authenticated-project-command" }>
  | Readonly<{
      kind: "installed-plugin-ui";
      publication: ProjectConceptSelectionPublication;
    }>;
export type ProjectConceptSelectionCommitOptions = Readonly<{
  authority: CreativeProjectCommitAuthority;
  source: ProjectConceptSelectionCommandSource;
}>;
export type CommitProjectConceptSelectionResult = Readonly<{
  disposition: "committed" | "replayed";
  pointer: CurrentConceptSelection;
  resultLink: OperationResultLink;
}>;
export type CurrentConceptSelectionReadResult = Readonly<{
  selectionRevision: number;
  current: Readonly<{
    pointer: CurrentConceptSelection;
    resultLink: OperationResultLink;
  }> | null;
}>;
export interface ProjectConceptSelectionStore {
  readonly projectConceptSelectionVersion:
    | "crewon.project-concept-selection.v1"
    | undefined;
  readonly projectConceptSelectionReadVersion:
    | "crewon.project-concept-selection-read.v1"
    | undefined;
  loadConceptSelectionReceipt(
    input: Readonly<{
      actor: ActorContext;
      receipt: CreativeProjectMutationReceipt;
    }>,
  ): Promise<CommitProjectConceptSelectionResult | null>;
  commitConceptImageSelection(
    input: CommitProjectConceptSelectionInput,
    options: ProjectConceptSelectionCommitOptions,
  ): Promise<CommitProjectConceptSelectionResult>;
  loadCurrentConceptSelection(
    input: Readonly<{
      owner: CreativeProjectOwnerScope;
      projectId: string;
      assetId: string;
    }>,
  ): Promise<CurrentConceptSelectionReadResult>;
}
