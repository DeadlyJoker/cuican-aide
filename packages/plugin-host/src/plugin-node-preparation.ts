import type { PluginPackageDescriptor } from "@crewon/contracts/plugins";
import type { PluginIdentity } from "@crewon/plugin-sdk/node";

export type PluginNodeDependencyIdentity = Readonly<{
  service: string;
  apiVersion: string;
  /** Null identifies a service supplied directly by the host. */
  provider: PluginIdentity | null;
}>;

export type PluginNodeCommitCandidate = Readonly<{
  descriptor: PluginPackageDescriptor;
  packageDigest: string;
  identity: PluginIdentity;
  previousIdentity: PluginIdentity | null;
  dependencyIdentities: readonly PluginNodeDependencyIdentity[];
}>;

export type PluginNodePreparedCommit = Readonly<{
  /**
   * Synchronous host authority, including any durable selection fence. This is
   * a publication check, not an atomic transaction with an external database.
   */
  authorizeCommit(candidate: PluginNodeCommitCandidate): "allow" | "deny";
}>;

/** Only a host-created handle can publish its captured candidate. */
export type PluginNodePreparedActivation = Readonly<{
  identity: PluginIdentity;
  dependencyIdentities: readonly PluginNodeDependencyIdentity[];
  /** Single use; publication invokes no plugin cleanup or asynchronous work. */
  commit(input: PluginNodePreparedCommit): PluginIdentity;
  /** Idempotent; waits for this candidate's cleanup and preserves failures. */
  abort(): Promise<void>;
}>;
