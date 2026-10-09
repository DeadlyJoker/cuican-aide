import { captureProjectOutlineSourceReader } from "./project-outline-source-reader.ts";
import { compareCreativeIds } from "./creative-project-application-support.ts";
import {
  assertCreativeProjectScope,
  assertProjectTextRevisionIdentity,
  extensionCanonicalJson,
  parseProjectTextArtifact,
  parseProjectTextArtifactRevision,
  projectTextRecord,
  type CreativeProject,
  type ProjectTextArtifact,
  type ProjectTextArtifactRevision,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type { CreativeProjectAuthorizationPort } from "./creative-project-authorization-port.ts";
import type { ProjectTextApplicationDependencies } from "./project-text-application-service.ts";
import type {
  SaveProjectOutlineCandidateCommand,
  SaveProjectScriptCandidateCommand,
  SelectProjectTextRevisionCommand,
  SetProjectTextArtifactLockedCommand,
  ProjectTextMutationCommand,
} from "./project-text-commands.ts";
import type {
  ProjectTextMutationKind,
  ProjectTextMutationResult,
  ProjectTextStore,
} from "./project-text-store-port.ts";
import {
  projectTextInvalidStore,
  projectTextStored,
} from "./project-text-application-support.ts";

export function checkedProjectTextMutationResult(
  raw: unknown,
  actor: ActorContext,
  project: CreativeProject,
  kind: ProjectTextMutationKind,
  command: ProjectTextMutationCommand,
  digester: ContentDigester,
): ProjectTextMutationResult {
  return projectTextStored(() => {
    const value = projectTextRecord(raw, [
      "kind",
      "disposition",
      "artifact",
      "contentRevision",
    ]);
    if (
      value.kind !== kind ||
      !["committed", "replayed"].includes(value.disposition as string)
    )
      projectTextInvalidStore();
    const artifact = checkedProjectTextArtifact(value.artifact, project);
    if (
      artifact.revision !== command.expectedArtifactRevision + 1 ||
      artifact.updatedByActorId !== actor.actorId
    )
      projectTextInvalidStore();
    if (kind === "set-lock") {
      const lock = command as SetProjectTextArtifactLockedCommand;
      if (
        value.contentRevision !== null ||
        artifact.artifactId !== lock.artifactId ||
        artifact.locked !== lock.locked
      )
        projectTextInvalidStore();
      return Object.freeze({
        kind,
        disposition: value.disposition as "committed" | "replayed",
        artifact,
        contentRevision: null,
      });
    }
    const revision = checkedProjectTextRevision(
      value.contentRevision,
      project,
      artifact,
      undefined,
      digester,
    );
    if (kind === "select-revision") {
      const selected = command as SelectProjectTextRevisionCommand;
      if (
        artifact.artifactId !== selected.artifactId ||
        artifact.selectedContentRevision !== selected.contentRevision ||
        revision.contentRevision !== selected.contentRevision
      )
        projectTextInvalidStore();
    } else {
      const candidate = command as
        | SaveProjectOutlineCandidateCommand
        | SaveProjectScriptCandidateCommand;
      if (
        artifact.latestContentRevision !== revision.contentRevision ||
        revision.createdByActorId !== actor.actorId ||
        artifact.updatedAt !== revision.createdAt ||
        revision.brief.briefRevision !== candidate.briefRevision ||
        extensionCanonicalJson(revision.content) !==
          extensionCanonicalJson(candidate.content)
      )
        projectTextInvalidStore();
      if (kind === "save-outline" && revision.kind !== "outline")
        projectTextInvalidStore();
      if (kind === "save-script") {
        const script = candidate as SaveProjectScriptCandidateCommand;
        if (
          revision.kind !== "script" ||
          revision.episodeId !== script.episodeId ||
          (script.outline === null
            ? revision.outline !== null
            : revision.outline === null ||
              revision.outline.artifactId !== script.outline.artifactId ||
              revision.outline.contentRevision !==
                script.outline.contentRevision)
        )
          projectTextInvalidStore();
      }
    }
    return Object.freeze({
      kind,
      disposition: value.disposition as "committed" | "replayed",
      artifact,
      contentRevision: revision,
    });
  });
}

export function checkedProjectTextArtifact(
  raw: unknown,
  project: CreativeProject,
  artifactId?: string,
): ProjectTextArtifact {
  return projectTextStored(() => {
    const artifact = parseProjectTextArtifact(raw);
    assertCreativeProjectScope(project, artifact);
    if (
      artifact.ownerPrincipalId !== project.ownerPrincipalId ||
      (artifactId !== undefined && artifact.artifactId !== artifactId)
    )
      projectTextInvalidStore();
    return artifact;
  });
}
export function checkedProjectTextRevision(
  raw: unknown,
  project: CreativeProject,
  artifact: ProjectTextArtifact,
  contentRevision: number | undefined,
  digester: ContentDigester,
) {
  return projectTextStored(() => {
    const revision = parseProjectTextArtifactRevision(raw, digester);
    assertCreativeProjectScope(project, revision);
    assertProjectTextRevisionIdentity(artifact, revision);
    if (
      contentRevision !== undefined &&
      contentRevision !== revision.contentRevision
    )
      projectTextInvalidStore();
    return revision;
  });
}

export function requiredProjectTextRevision(
  input: ProjectTextArtifactRevision | null,
): ProjectTextArtifactRevision {
  if (input === null) projectTextInvalidStore();
  return input;
}
export function projectTextDataFields(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    projectTextInvalidStore();
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    projectTextInvalidStore();
  const values: Record<string, unknown> = {};
  for (const key of fields) {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (
      field === undefined ||
      !field.enumerable ||
      !Object.hasOwn(field, "value")
    )
      projectTextInvalidStore();
    values[key] = field.value;
  }
  return values;
}
function methods<T extends object>(input: T, names: readonly (keyof T)[]): T {
  const result: Partial<T> = {};
  for (const name of names) {
    let current: object | null = input;
    let value: unknown;
    for (
      let depth = 0;
      current !== null && depth < 32;
      depth++, current = Object.getPrototypeOf(current)
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor !== undefined) {
        if (!Object.hasOwn(descriptor, "value")) projectTextInvalidStore();
        value = descriptor.value;
        break;
      }
    }
    if (typeof value !== "function") projectTextInvalidStore();
    result[name] = value.bind(input) as T[keyof T];
  }
  return Object.freeze(result) as T;
}
export function captureProjectTextDependencies(
  input: ProjectTextApplicationDependencies,
): ProjectTextApplicationDependencies {
  const raw = projectTextDataFields(input, [
    "store",
    "projects",
    "authorization",
    "clock",
    "ids",
    "digester",
  ]);
  return Object.freeze({
    store: Object.freeze({
      ...captureProjectOutlineSourceReader(raw.store as ProjectTextStore),
      ...methods(raw.store as ProjectTextStore, [
        "loadOutline",
        "loadScript",
        "loadArtifact",
        "loadRevision",
        "listArtifacts",
        "listRevisions",
        "loadMutationReceipt",
        "commitCandidate",
        "commitSelection",
        "commitLock",
      ]),
    }),
    projects: methods(
      raw.projects as ProjectTextApplicationDependencies["projects"],
      ["loadProject", "loadBrief"],
    ),
    authorization: methods(
      raw.authorization as CreativeProjectAuthorizationPort,
      ["authorize"],
    ),
    clock: methods(raw.clock as ApplicationClock, ["now"]),
    ids: methods(raw.ids as ApplicationIdGenerator, ["nextId"]),
    digester: methods(raw.digester as ContentDigester, ["sha256"]),
  });
}

export function checkedProjectTextArtifactPage(
  raw: unknown,
  project: CreativeProject,
  afterArtifactId: string | null,
  limit: number,
) {
  return projectTextStored(() => {
    const page = projectTextRecord(raw, ["artifacts", "nextArtifactId"]);
    if (!Array.isArray(page.artifacts) || page.artifacts.length > limit)
      projectTextInvalidStore();
    const artifacts = page.artifacts.map((record) =>
      checkedProjectTextArtifact(record, project),
    );
    let previous = afterArtifactId;
    for (const artifact of artifacts) {
      if (
        previous !== null &&
        compareCreativeIds(previous, artifact.artifactId) >= 0
      )
        projectTextInvalidStore();
      previous = artifact.artifactId;
    }
    if (
      page.nextArtifactId !== null &&
      (artifacts.length !== limit ||
        page.nextArtifactId !== artifacts.at(-1)?.artifactId)
    )
      projectTextInvalidStore();
    return Object.freeze({
      artifacts: Object.freeze(artifacts),
      nextArtifactId: page.nextArtifactId as string | null,
    });
  });
}
export function checkedProjectTextRevisionPage(
  raw: unknown,
  project: CreativeProject,
  artifact: ProjectTextArtifact,
  afterContentRevision: number,
  limit: number,
  digester: ContentDigester,
) {
  return projectTextStored(() => {
    // A page has separately bounded immutable records, rather than one 64KiB JSON copy.
    const descriptors = projectTextDataFields(raw, [
      "revisions",
      "nextContentRevision",
    ]);
    const records = descriptors.revisions;
    if (!Array.isArray(records) || records.length > limit)
      projectTextInvalidStore();
    const copy = Object.getOwnPropertyDescriptors(records);
    if (Reflect.ownKeys(records).length !== records.length + 1)
      projectTextInvalidStore();
    const revisions = Array.from({ length: records.length }, (_, index) => {
      const field = copy[String(index)];
      if (field === undefined || !Object.hasOwn(field, "value"))
        projectTextInvalidStore();
      return checkedProjectTextRevision(
        field.value,
        project,
        artifact,
        undefined,
        digester,
      );
    });
    let previous = afterContentRevision;
    for (const revision of revisions) {
      if (revision.contentRevision <= previous) projectTextInvalidStore();
      previous = revision.contentRevision;
    }
    const next = descriptors.nextContentRevision;
    if (
      next !== null &&
      (revisions.length !== limit || next !== revisions.at(-1)?.contentRevision)
    )
      projectTextInvalidStore();
    return Object.freeze({
      revisions: Object.freeze(revisions),
      nextContentRevision: next as number | null,
    });
  });
}
