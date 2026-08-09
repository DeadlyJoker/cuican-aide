import { createHash } from "node:crypto";

import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ApplicationIdKind,
  ContentDigester,
  RunExecutionPolicyPort,
} from "@crewon/application";
import type { RunRoute } from "@crewon/application";
import { v7 as uuidv7 } from "uuid";

export class SystemApplicationClock implements ApplicationClock {
  now(): string {
    return new Date().toISOString();
  }
}

export class UuidV7ApplicationIdGenerator implements ApplicationIdGenerator {
  nextId(_kind: ApplicationIdKind): string {
    return uuidv7();
  }
}

export class NodeSha256ContentDigester implements ContentDigester {
  sha256(value: string): string {
    return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
  }
}

export class PinnedRunExecutionPolicy implements RunExecutionPolicyPort {
  readonly #route: RunRoute;

  constructor(route: RunRoute) {
    this.#route = structuredClone(route);
  }

  async evaluate(
    input: Parameters<RunExecutionPolicyPort["evaluate"]>[0],
  ): Promise<Awaited<ReturnType<RunExecutionPolicyPort["evaluate"]>>> {
    if (
      input.run.authorityId !== this.#route.authorityId ||
      input.run.runtimeGeneration !== this.#route.runtimeGeneration ||
      input.run.agentVersionId !== this.#route.agentVersionId ||
      input.run.policySnapshotId !== this.#route.policySnapshotId ||
      input.run.workspaceBindingId !== this.#route.workspaceBindingId ||
      input.workItem.tenantId !== input.run.tenantId ||
      input.workItem.runId !== input.run.runId
    ) {
      return { outcome: "deny", reasonCode: "pinned_route_mismatch" };
    }
    return { outcome: "allow" };
  }
}
