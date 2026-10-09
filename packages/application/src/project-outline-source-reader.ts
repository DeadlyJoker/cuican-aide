import {
  assertCreativeProjectScope,
  assertProjectTextRevisionIdentity,
  parseProjectOutlineSourceRevision,
  parseProjectTextArtifactRevision,
  type CreativeProject,
  type ProjectTextArtifact,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type {
  ProjectTextStore,
  ProjectTextReadScope,
} from "./project-text-store-port.ts";
import {
  projectTextInvalidStore,
  projectTextStored,
} from "./project-text-application-support.ts";

type OutlineReads = Pick<
  ProjectTextStore,
  "loadRevision" | "loadOutlineSourceRevision"
>;

/** Snapshot a declared optional method without invoking getters or later mutable replacements. */
export function captureProjectOutlineSourceReader(
  input: object,
): Pick<ProjectTextStore, "loadOutlineSourceRevision"> {
  for (
    let owner: object | null = input, depth = 0;
    owner !== null && depth < 16;
    owner = Object.getPrototypeOf(owner), depth++
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(
      owner,
      "loadOutlineSourceRevision",
    );
    if (descriptor === undefined) continue;
    if (
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "function"
    )
      projectTextInvalidStore();
    return Object.freeze({
      loadOutlineSourceRevision: descriptor.value.bind(input) as NonNullable<
        ProjectTextStore["loadOutlineSourceRevision"]
      >,
    });
  }
  return Object.freeze({});
}

export async function readProjectOutlineSourceRevision(
  input: Readonly<{
    store: OutlineReads;
    scope: ProjectTextReadScope;
    project: CreativeProject;
    artifact: ProjectTextArtifact;
    contentRevision: number;
    digester: ContentDigester;
  }>,
) {
  const request = {
    ...input.scope,
    artifactId: input.artifact.artifactId,
    contentRevision: input.contentRevision,
  };
  const raw =
    input.store.loadOutlineSourceRevision === undefined
      ? await input.store.loadRevision(request)
      : await input.store.loadOutlineSourceRevision(request);
  if (raw === null)
    throw new ApplicationError("notFound", "project_text_revision_not_found");
  return projectTextStored(() => {
    // An old store cannot accidentally broaden its strict v1 read contract.
    const parsed =
      input.store.loadOutlineSourceRevision === undefined
        ? parseProjectTextArtifactRevision(raw, input.digester)
        : raw;
    const revision = parseProjectOutlineSourceRevision(parsed, input.digester);
    assertCreativeProjectScope(input.project, revision);
    assertProjectTextRevisionIdentity(input.artifact, revision);
    if (revision.contentRevision !== input.contentRevision)
      projectTextInvalidStore();
    return revision;
  });
}
