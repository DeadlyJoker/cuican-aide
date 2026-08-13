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
    /** Null lists the tenant catalog ordered by workflowId then workflowVersionId. */
    workflowId: string | null;
    after: WorkflowVersionListCursor | null;
    limit: number;
  }): Promise<readonly WorkflowVersionAsset[]>;
}
