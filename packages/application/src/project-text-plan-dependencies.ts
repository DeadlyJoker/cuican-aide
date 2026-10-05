import type { ProjectTextPlanApplicationDependencies } from "./project-text-plan-application-service.ts";
import { ApplicationError } from "./application-error.ts";
import { uiRecord } from "./plugin-ui-application-support.ts";
export function captureProjectTextPlanDependencies(
  input: ProjectTextPlanApplicationDependencies,
): ProjectTextPlanApplicationDependencies {
  const d = uiRecord(input, [
    "plans",
    "conversations",
    "projects",
    "texts",
    "extensions",
    "authorization",
    "clock",
    "ids",
    "digester",
  ]) as unknown as ProjectTextPlanApplicationDependencies;
  if (
    Object.getOwnPropertyDescriptor(d.plans, "version")?.value !==
    "crewon.project-text-plan.v1"
  )
    fail();
  return Object.freeze({
    plans: Object.freeze({
      version: "crewon.project-text-plan.v1",
      migrate: method(d.plans, "migrate"),
      loadPlan: method(d.plans, "loadPlan"),
      loadRevision: method(d.plans, "loadRevision"),
      loadStep: method(d.plans, "loadStep"),
      listSteps: method(d.plans, "listSteps"),
      listPlans: method(d.plans, "listPlans"),
      loadMutationReceipt: method(d.plans, "loadMutationReceipt"),
      commitControl: method(d.plans, "commitControl"),
      commitObservation: method(d.plans, "commitObservation"),
      commitSystemPause: method(d.plans, "commitSystemPause"),
      scanRecoverable: method(d.plans, "scanRecoverable"),
      readRequiredPlanDigest: method(d.plans, "readRequiredPlanDigest"),
      loadRunAdmission: method(d.plans, "loadRunAdmission"),
    }),
    conversations: Object.freeze({
      loadBinding: method(d.conversations, "loadBinding"),
    }),
    projects: Object.freeze({
      loadProject: method(d.projects, "loadProject"),
      loadBrief: method(d.projects, "loadBrief"),
    }),
    texts: Object.freeze({
      loadOutline: method(d.texts, "loadOutline"),
      loadScript: method(d.texts, "loadScript"),
      loadRevision: method(d.texts, "loadRevision"),
    }),
    extensions: Object.freeze({
      loadLatestExtensionConfiguration: method(
        d.extensions,
        "loadLatestExtensionConfiguration",
      ),
      loadExtensionActivation: method(d.extensions, "loadExtensionActivation"),
    }),
    authorization: Object.freeze({
      authorize: method(d.authorization, "authorize"),
    }),
    clock: Object.freeze({ now: method(d.clock, "now") }),
    ids: Object.freeze({ nextId: method(d.ids, "nextId") }),
    digester: Object.freeze({ sha256: method(d.digester, "sha256") }),
  });
}
function method<T extends object, K extends keyof T>(input: T, key: K): T[K] {
  if (input === null || typeof input !== "object") fail();
  for (
    let owner: object | null = input, depth = 0;
    owner !== null && depth < 16;
    owner = Object.getPrototypeOf(owner), depth++
  ) {
    const d = Object.getOwnPropertyDescriptor(owner, key);
    if (d === undefined) continue;
    if (!Object.hasOwn(d, "value") || typeof d.value !== "function") break;
    return d.value.bind(input) as T[K];
  }
  return fail();
}
function fail(): never {
  throw new ApplicationError("internal", "project_text_plan_config_invalid");
}

export function captureProjectTextPlanCoordinatorDependencies(
  input: import("./project-text-plan-coordinator.ts").ProjectTextPlanCoordinatorDependencies,
): import("./project-text-plan-coordinator.ts").ProjectTextPlanCoordinatorDependencies {
  const d = uiRecord(input, [
    "plans",
    "continuation",
    "projects",
    "texts",
    "conversations",
    "threads",
    "runs",
    "tasks",
    "textCommands",
    "clock",
    "digester",
  ]) as unknown as typeof input;
  if (
    Object.getOwnPropertyDescriptor(d.plans, "version")?.value !==
    "crewon.project-text-plan.v1"
  )
    fail();
  return Object.freeze({
    plans: Object.freeze({
      version: "crewon.project-text-plan.v1",
      migrate: method(d.plans, "migrate"),
      loadPlan: method(d.plans, "loadPlan"),
      loadRevision: method(d.plans, "loadRevision"),
      loadStep: method(d.plans, "loadStep"),
      listSteps: method(d.plans, "listSteps"),
      listPlans: method(d.plans, "listPlans"),
      loadMutationReceipt: method(d.plans, "loadMutationReceipt"),
      commitControl: method(d.plans, "commitControl"),
      commitObservation: method(d.plans, "commitObservation"),
      commitSystemPause: method(d.plans, "commitSystemPause"),
      scanRecoverable: method(d.plans, "scanRecoverable"),
      readRequiredPlanDigest: method(d.plans, "readRequiredPlanDigest"),
      loadRunAdmission: method(d.plans, "loadRunAdmission"),
    }),
    continuation: Object.freeze({ run: method(d.continuation, "run") }),
    projects: Object.freeze({
      loadProject: method(d.projects, "loadProject"),
      loadBrief: method(d.projects, "loadBrief"),
    }),
    texts: Object.freeze({
      loadOutline: method(d.texts, "loadOutline"),
      loadScript: method(d.texts, "loadScript"),
      loadRevision: method(d.texts, "loadRevision"),
    }),
    conversations: Object.freeze({
      loadBinding: method(d.conversations, "loadBinding"),
      loadStageAdmission: method(d.conversations, "loadStageAdmission"),
    }),
    threads: Object.freeze({
      loadThreadInSpace: method(d.threads, "loadThreadInSpace"),
    }),
    runs: Object.freeze({
      loadRunInSpace: method(d.runs, "loadRunInSpace"),
      listRunEvents: method(d.runs, "listRunEvents"),
    }),
    tasks: Object.freeze({
      createProjectTextPlanTurnFromHost: method(
        d.tasks,
        "createProjectTextPlanTurnFromHost",
      ),
    }),
    textCommands: Object.freeze({
      selectRevision: method(d.textCommands, "selectRevision"),
    }),
    clock: Object.freeze({ now: method(d.clock, "now") }),
    digester: Object.freeze({ sha256: method(d.digester, "sha256") }),
  });
}
