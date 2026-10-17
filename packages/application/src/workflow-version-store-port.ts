export type WorkflowVersionAsset = Readonly<{
  schemaVersion: "crewon.workflow-version-asset.v0";
  tenantId: string;
  workflowId: string;
  workflowVersionId: string;
  contentDigest: string;
  definitionJson: string;
  createdAt: string;
}>;

export type WorkflowVersionListCursor = Readonly<{
  workflowId: string;
  workflowVersionId: string;
}>;

export type WorkflowVersionCatalogQuery = Readonly<{
  tenantId: string;
  after: WorkflowVersionListCursor | null;
  limit: number;
}>;
export type WorkflowVersionCatalogEntry = Readonly<{
  workflowId: string;
  workflowVersionId: string;
  contentDigest: string;
  name: string;
  description: string;
  createdAt: string;
}>;
/** Bounded tenant metadata catalog; definitions retain their original immutable authority. */
export interface WorkflowVersionCatalogStore {
  listWorkflowVersionCatalog(
    input: WorkflowVersionCatalogQuery,
  ): Promise<readonly WorkflowVersionCatalogEntry[]>;
}

export interface WorkflowVersionStore {
  registerWorkflowVersion(asset: WorkflowVersionAsset): Promise<{
    disposition: "registered" | "existing";
    asset: WorkflowVersionAsset;
  }>;
  loadWorkflowVersion(input: {
    tenantId: string;
    workflowVersionId: string;
  }): Promise<WorkflowVersionAsset | null>;
  listWorkflowVersions(input: {
    tenantId: string;
    workflowId: string;
    after: WorkflowVersionListCursor | null;
    limit: number;
  }): Promise<readonly WorkflowVersionAsset[]>;
}
