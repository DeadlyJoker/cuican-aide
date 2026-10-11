import type {
  PluginProjectWorkspaceNamespace,
  PluginProjectWorkspaceOwner,
  PluginProjectWorkspaceOwnerScope,
} from "@crewon/domain";
import type { PluginProjectWorkspaceNativeObservation } from "./plugin-project-workspace-native-observation.ts";

/** Host-only original registration port. A plain namespace/response DTO is not an observation grant. */
export interface PluginProjectWorkspaceNativeRegistrationStore {
  recordFromNativeObservation(
    reference: PluginProjectWorkspaceNativeObservation,
    input: Readonly<{ createdAt: string }>,
  ): Promise<RecordPluginProjectWorkspaceNamespaceResult>;
}

/** Host-only namespace reads; contains no filesystem root and grants no execution. */
export interface PluginProjectWorkspaceReadStore {
  loadNamespace(
    input: Readonly<{ owner: PluginProjectWorkspaceOwner }>,
  ): Promise<PluginProjectWorkspaceNamespace | null>;
  listNamespaces(
    input: Readonly<{
      owner: PluginProjectWorkspaceOwnerScope;
      afterProjectId: string | null;
      limit: number;
    }>,
  ): Promise<
    Readonly<{
      namespaces: readonly PluginProjectWorkspaceNamespace[];
      nextProjectId: string | null;
    }>
  >;
}
/** The Host provisions the original workspace separately. This recipe never accepts ownership fields. */
export type RecordPluginProjectWorkspaceNamespaceInput = Readonly<{
  projectId: string;
  workspaceId: string;
  createdAt: string;
}>;
export type RecordPluginProjectWorkspaceNamespaceResult = Readonly<{
  disposition: "committed" | "replayed";
  namespace: PluginProjectWorkspaceNamespace;
}>;
