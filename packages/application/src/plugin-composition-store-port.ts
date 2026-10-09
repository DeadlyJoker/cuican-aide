import type {
  PluginCompositionLock,
  PluginCompositionScope,
} from "@crewon/contracts/plugins";
import type { PluginProfileScope } from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";

export class PluginCompositionStoreError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "PluginCompositionStoreError";
    this.code = code;
  }
}
export type CommitPluginCompositionInput = Readonly<{
  /** Trusted host scope; the lock's self-declared scope is not authority. */
  scope: PluginCompositionScope;
  actor: ActorContext;
  lock: PluginCompositionLock;
  expectedRevision: number | null;
}>;
export type PluginCompositionCommitResult = Readonly<{
  disposition: "committed" | "replayed";
  lock: PluginCompositionLock;
}>;
/** Internal metadata persistence, not an activation or permission grant. */
export interface PluginCompositionStore {
  /** Explicit; never part of ordinary constructor/startup and disallowed on an owned profile view. */
  migrate(): Promise<void>;
  loadCurrent(
    input: Readonly<{ scope: PluginProfileScope }>,
  ): Promise<PluginCompositionLock | null>;
  loadLock(
    input: Readonly<{ scope: PluginProfileScope; lockDigest: string }>,
  ): Promise<PluginCompositionLock | null>;
  /** CAS head update with the entire enabled selection vector checked in the profile writer transaction. */
  commit(
    input: CommitPluginCompositionInput,
  ): Promise<PluginCompositionCommitResult>;
}
