import type { CreativeProjectListCursor } from "./creative-project-store-port.ts";

export type CreateCreativeProjectCommand = Readonly<{
  title: string;
  briefText: string;
  idempotencyKey: string;
}>;
export type RenameCreativeProjectCommand = Readonly<{
  projectId: string;
  title: string;
  expectedProjectRevision: number;
  idempotencyKey: string;
}>;
export type SetCreativeProjectStateCommand = Readonly<{
  projectId: string;
  state: "active" | "archived";
  expectedProjectRevision: number;
  idempotencyKey: string;
}>;
export type AppendProjectBriefCommand = Readonly<{
  projectId: string;
  text: string;
  expectedProjectRevision: number;
  idempotencyKey: string;
}>;
export type CreateConceptAssetCommand = Readonly<{
  projectId: string;
  briefRevision: number;
  name: string;
  prompt: string;
  expectedProjectRevision: number;
  idempotencyKey: string;
}>;
export type AppendConceptAssetRevisionCommand = Readonly<{
  projectId: string;
  assetId: string;
  briefRevision: number;
  prompt: string;
  expectedProjectRevision: number;
  expectedAssetMetadataRevision: number;
  idempotencyKey: string;
}>;
export type ListCreativeProjectsQuery = Readonly<{
  state: "active" | "archived" | "all";
  after: CreativeProjectListCursor | null;
  limit: number;
}>;
export type CreativeProjectMutationCommand =
  | CreateCreativeProjectCommand
  | RenameCreativeProjectCommand
  | SetCreativeProjectStateCommand
  | AppendProjectBriefCommand
  | CreateConceptAssetCommand
  | AppendConceptAssetRevisionCommand;
