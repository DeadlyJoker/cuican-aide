import { ApplicationError } from "./application-error.ts";
import {
  qualifyPluginProjectReadScope,
  type PluginProjectReadScope,
} from "./plugin-project-read-scope.ts";
import type { ProjectTextApplicationDependencies } from "./project-text-application-service.ts";
import type { ProjectStructuredOutlineApplicationDependencies } from "./project-structured-outline-application-service.ts";
import type { CreativeProjectReadStore } from "./creative-project-store-port.ts";
import type { ProjectStructuredOutlineStore } from "./project-structured-outline-store-port.ts";
import type { ProjectFoundationStore } from "./project-foundation-store-port.ts";

function optionalBinder<T>(port: object) {
  let current: object | null = port;
  for (
    let depth = 0;
    current && depth < 32;
    depth++, current = Object.getPrototypeOf(current)
  ) {
    const field = Object.getOwnPropertyDescriptor(current, "bindProjectReads");
    if (!field) continue;
    if (!Object.hasOwn(field, "value")) denied();
    if (field.value === undefined) return undefined;
    if (typeof field.value !== "function") denied();
    return field.value.bind(port) as (scope: PluginProjectReadScope) => T;
  }
  return undefined;
}
async function protectedTarget(
  input: { projects: ProjectTextApplicationDependencies["projects"] },
  scope: PluginProjectReadScope,
) {
  const source = qualifyPluginProjectReadScope(scope);
  if (
    !source.creativeRunMutationAuthority &&
    !source.outlineRunMutationAuthority &&
    !source.outlineRunReadAuthority
  )
    denied();
  const projectId =
    "projectId" in source.request.input
      ? source.request.input.projectId
      : undefined;
  if (typeof projectId !== "string") denied();
  await source.assertCurrent();
  source.assertActive();
  const project = await input.projects.loadProject({
    owner: {
      tenantId: source.scope.tenantId,
      spaceId: source.scope.spaceId,
      principalId: source.scope.principalId,
    },
    projectId,
  });
  await source.assertCurrent();
  source.assertActive();
  // Ordinary projects stay on the original route. Protected/absent records require exact positive ownership.
  return project === null;
}
/** Captured once from the original manager. No receipts or writers are borrowed from a read facade. */
export function captureTextRunStoreView(
  input: ProjectTextApplicationDependencies,
  captured: ProjectTextApplicationDependencies,
) {
  const projects = optionalBinder<CreativeProjectReadStore>(input.projects);
  const reads = optionalBinder<ProjectStructuredOutlineStore>(input.store);
  return async (scope: PluginProjectReadScope) => {
    if (!(await protectedTarget(captured, scope))) return null;
    if (!projects || !reads) denied();
    return {
      ...captured,
      projects: projects(scope),
      store: Object.freeze({
        ...reads(scope),
        loadMutationReceipt: captured.store.loadMutationReceipt,
        commitCandidate: captured.store.commitCandidate,
        commitSelection: captured.store.commitSelection,
        commitLock: captured.store.commitLock,
      }),
    };
  };
}
export function captureOutlineRunStoreView(
  input: ProjectStructuredOutlineApplicationDependencies,
  captured: ProjectStructuredOutlineApplicationDependencies,
) {
  const projects = optionalBinder<CreativeProjectReadStore>(input.projects);
  const reads = optionalBinder<ProjectStructuredOutlineStore>(input.store);
  const foundations = optionalBinder<ProjectFoundationStore>(input.foundations);
  return async (scope: PluginProjectReadScope) => {
    if (!(await protectedTarget(captured, scope))) return null;
    if (!projects || !reads || !foundations) denied();
    return {
      ...captured,
      projects: projects(scope),
      foundations: foundations(scope),
      store: Object.freeze({
        ...reads(scope),
        loadStructuredMutationReceipt:
          captured.store.loadStructuredMutationReceipt,
        commitStructuredOutlineCandidate:
          captured.store.commitStructuredOutlineCandidate,
        commitStructuredOutlineSelection:
          captured.store.commitStructuredOutlineSelection,
      }),
    };
  };
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_text_run_store_binding_unavailable",
  );
}
