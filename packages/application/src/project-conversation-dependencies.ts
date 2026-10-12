import { captureProjectOutlineSourceReader } from "./project-outline-source-reader.ts";
import type { ProjectConversationApplicationDependencies } from "./project-conversation-application-service.ts";
import { uiRecord } from "./plugin-ui-application-support.ts";
import { ApplicationError } from "./application-error.ts";
export function captureProjectConversationDependencies(
  input: ProjectConversationApplicationDependencies,
): ProjectConversationApplicationDependencies {
  const d = uiRecord(input, [
    "conversations",
    "threads",
    "threadStore",
    "projects",
    "texts",
    "tasks",
    "authorization",
    "clock",
    "ids",
    "digester",
  ]) as unknown as ProjectConversationApplicationDependencies;
  if (
    Object.getOwnPropertyDescriptor(d.conversations, "version")?.value !==
    "crewon.project-conversation-binding.v1"
  )
    fail();
  const binding = optionalMethod(d.projects, "bindProjectReads");
  const textBinding = optionalMethod(d.texts, "bindProjectReads");
  return Object.freeze({
    conversations: Object.freeze({
      version: "crewon.project-conversation-binding.v1",
      migrate: method(d.conversations, "migrate"),
      hasThreadBinding: method(d.conversations, "hasThreadBinding"),
      loadBinding: method(d.conversations, "loadBinding"),
      listBindings: method(d.conversations, "listBindings"),
      loadMutationReceipt: method(d.conversations, "loadMutationReceipt"),
      commitBinding: method(d.conversations, "commitBinding"),
      readRequiredStageDigest: method(
        d.conversations,
        "readRequiredStageDigest",
      ),
      loadStageAdmission: method(d.conversations, "loadStageAdmission"),
    }),
    threads: Object.freeze({
      prepareCreateThread: method(d.threads, "prepareCreateThread"),
    }),
    threadStore: Object.freeze({
      loadThreadInSpace: method(d.threadStore, "loadThreadInSpace"),
    }),
    projects: Object.freeze({
      ...(binding === undefined ? {} : { bindProjectReads: binding }),
      loadProject: method(d.projects, "loadProject"),
      loadBrief: method(d.projects, "loadBrief"),
    }),
    texts: Object.freeze({
      ...(textBinding === undefined ? {} : { bindProjectReads: textBinding }),
      ...captureProjectOutlineSourceReader(d.texts),
      loadOutline: method(d.texts, "loadOutline"),
      loadRevision: method(d.texts, "loadRevision"),
    }),
    tasks: Object.freeze({
      createProjectConversationTurnFromHost: method(
        d.tasks,
        "createProjectConversationTurnFromHost",
      ),
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
function optionalMethod<T extends object, K extends keyof T>(
  input: T,
  key: K,
): T[K] | undefined {
  if (input === null || typeof input !== "object") fail();
  for (
    let owner: object | null = input, depth = 0;
    owner !== null && depth < 16;
    owner = Object.getPrototypeOf(owner), depth++
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor === undefined) continue;
    if (
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "function"
    )
      fail();
    return descriptor.value.bind(input) as T[K];
  }
  return undefined;
}
function fail(): never {
  throw new ApplicationError("internal", "project_conversation_config_invalid");
}
