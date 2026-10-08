import {
  ProjectStructuredOutlineApplicationService,
  type CreativeProjectAuthorizationPort,
  type CreativeProjectStore,
  type ProjectTextStore,
  type ProjectStructuredOutlineStore,
} from "@crewon/application";
import type { ProjectFoundationStoreOwner } from "./project-foundation-composition.ts";
import {
  NodeSha256ContentDigester,
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
} from "./standalone-adapters.ts";

/** Reuse only already-configured original stores; constructing the reader neither migrates nor grants a new write protocol. */
export function prepareProjectStructuredOutlines(
  owner: ProjectFoundationStoreOwner,
  input: Readonly<{
    foundationConfigured: boolean;
    texts: ProjectTextStore;
    projects: CreativeProjectStore;
    authorization: CreativeProjectAuthorizationPort;
  }>,
): ProjectStructuredOutlineApplicationService | undefined {
  if (!input.foundationConfigured) return undefined;
  if (owner.projectFoundationStore === undefined)
    throw new Error("project_foundation_composition_required");
  const texts = input.texts;
  const methods = [
    "loadStructuredRevision",
    "listStructuredRevisions",
    "loadStructuredMutationReceipt",
    "commitStructuredOutlineCandidate",
    "commitStructuredOutlineSelection",
  ] as const;
  // Legacy custom Store adapters remain usable for v1 and never advertise a capability they do not implement.
  if (!methods.every((key) => hasDataMethod(texts, key))) return undefined;
  return new ProjectStructuredOutlineApplicationService({
    store: texts as ProjectStructuredOutlineStore,
    projects: input.projects,
    foundations: owner.projectFoundationStore(),
    authorization: input.authorization,
    clock: new SystemApplicationClock(),
    ids: new UuidV7ApplicationIdGenerator(),
    digester: new NodeSha256ContentDigester(),
  });
}
function hasDataMethod(input: object, key: string): boolean {
  let current: object | null = input;
  for (
    let depth = 0;
    current !== null && depth < 8;
    depth++, current = Object.getPrototypeOf(current)
  ) {
    const field = Object.getOwnPropertyDescriptor(current, key);
    if (field !== undefined)
      return Object.hasOwn(field, "value") && typeof field.value === "function";
  }
  return false;
}
