/** Independent Node read-only scope service; data is a hint, never execution authority. */
export const CREWON_PROJECT_CONTEXT_SERVICE = "crewon.project-context";
export const CREWON_PROJECT_CONTEXT_API_VERSION = "1";
export const MAX_PROJECT_CONTEXT_RESPONSE_BYTES = 8192;
export type ProjectContextStage =
  | Readonly<{ kind: "discussion" }>
  | Readonly<{ kind: "brief" | "outline"; briefRevision: number }>
  | Readonly<{
      kind: "script";
      episodeId: string;
      briefRevision: number;
      outline: Readonly<{ artifactId: string; contentRevision: number }> | null;
    }>;
export type PublicProjectContextScope = Readonly<{
  projectId: string;
  threadId: string;
  runId: string;
  bindingId: string;
  bindingRevision: number;
  stage: ProjectContextStage;
  sources: Readonly<{
    brief: Readonly<{ briefRevision: number; contentDigest: string }> | null;
    outline: Readonly<{
      artifactId: string;
      contentRevision: number;
      contentDigest: string;
    }> | null;
  }>;
  allowedOperations: readonly string[];
  contentDigest: string;
}>;
export interface PluginProjectContextService {
  readScope(
    input: Readonly<{ command: unknown }>,
  ): Promise<Readonly<{ scope: PublicProjectContextScope | null }>>;
}
