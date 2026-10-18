import type { AutonomousTaskEdgeLink } from "./task-lineage-policy.ts";

export const AUTONOMOUS_TASK_EDGE_LIST_MAX_LIMIT = 32;

export type AutonomousTaskEdge = AutonomousTaskEdgeLink &
  Readonly<{ createdAt: number }>;

export type AutonomousTaskEdgeScope = Readonly<{
  tenantId: string;
  spaceId: string;
}>;

export interface AutonomousTaskEdgeStore {
  /** Explicit migration; constructing the store must not change a database. */
  migrate(): Promise<void>;
  link(
    input: AutonomousTaskEdgeScope & AutonomousTaskEdgeLink,
  ): Promise<
    Readonly<{ disposition: "created" | "replayed"; edge: AutonomousTaskEdge }>
  >;
  listChildren(
    input: AutonomousTaskEdgeScope & {
      parentTaskId: string;
      limit?: number;
    },
  ): Promise<readonly AutonomousTaskEdge[]>;
  listDescendants(
    input: AutonomousTaskEdgeScope & {
      rootTaskId: string;
      maxDepth?: number;
      limit?: number;
    },
  ): Promise<readonly AutonomousTaskEdge[]>;
}
