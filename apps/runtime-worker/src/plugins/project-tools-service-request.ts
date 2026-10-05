import {
  parseAppendProjectBriefRequest,
  parseCreateCreativeProjectRequest,
  parseCreativeProjectId,
  parseCreativeProjectRevision,
  parseProjectTextId,
  parseSaveProjectOutlineCandidateRequest,
  parseSaveProjectScriptCandidateRequest,
  parseSelectProjectTextRevisionRequest,
  parseSetProjectTextArtifactLockedRequest,
} from "@crewon/contracts";
import {
  extensionCanonicalJson,
  creativeProjectTimestamp,
} from "@crewon/domain";
import {
  MAX_PROJECT_TOOLS_PAGE_SIZE,
  type PluginProjectToolsService,
  type ProjectToolsMethod,
} from "@crewon/contracts/project-tools";
export type ProjectToolsRequests = {
  [M in ProjectToolsMethod]: Parameters<
    PluginProjectToolsService[M]
  >[0]["request"];
};

/** Only two documented optional fields normalize to null; no actor or retry identity is accepted. */
export function parseProjectToolsRequest<M extends ProjectToolsMethod>(
  method: M,
  input: unknown,
): ProjectToolsRequests[M] {
  const canonical = extensionCanonicalJson(input);
  if (Buffer.byteLength(canonical, "utf8") > 60 * 1024) invalid();
  const value = JSON.parse(canonical) as unknown;
  let result: ProjectToolsRequests[ProjectToolsMethod];
  switch (method) {
    case "createProject":
      result = parseCreateCreativeProjectRequest(value);
      break;
    case "appendBrief": {
      const fields = record(value, [
        "projectId",
        "expectedProjectRevision",
        "text",
      ]);
      const { projectId, ...body } = fields;
      result = {
        projectId: parseCreativeProjectId(projectId),
        ...parseAppendProjectBriefRequest(body),
      };
      break;
    }
    case "listProjects": {
      const fields = record(value, ["state", "limit"], ["after"]);
      if (
        fields.state !== "all" &&
        fields.state !== "active" &&
        fields.state !== "archived"
      )
        invalid();
      const after =
        fields.after === undefined || fields.after === null
          ? null
          : record(fields.after, ["updatedAt", "projectId"]);
      result = {
        state: fields.state,
        limit: limit(fields.limit),
        after:
          after === null
            ? null
            : {
                updatedAt: creativeProjectTimestamp(after.updatedAt),
                projectId: parseCreativeProjectId(after.projectId),
              },
      };
      break;
    }
    case "readProject":
    case "readOutline": {
      const fields = record(value, ["projectId"]);
      result = { projectId: parseProjectTextId(fields.projectId) };
      break;
    }
    case "readScript": {
      const fields = record(value, ["projectId", "episodeId"]);
      result = {
        projectId: parseProjectTextId(fields.projectId),
        episodeId: parseProjectTextId(fields.episodeId),
      };
      break;
    }
    case "readContent": {
      const fields = record(value, ["projectId", "source", "offset"]);
      const source = fields.source as Record<string, unknown>;
      let checked;
      if (source?.kind === "brief") {
        const item = record(source, ["kind", "briefRevision"]);
        checked = {
          kind: "brief" as const,
          briefRevision: parseCreativeProjectRevision(item.briefRevision),
        };
      } else if (source?.kind === "text") {
        const item = record(source, ["kind", "artifactId", "contentRevision"]);
        checked = {
          kind: "text" as const,
          artifactId: parseProjectTextId(item.artifactId),
          contentRevision: parseCreativeProjectRevision(item.contentRevision),
        };
      } else invalid();
      result = {
        projectId: parseProjectTextId(fields.projectId),
        source: checked,
        offset: nonnegative(fields.offset),
      };
      break;
    }
    case "listRevisions": {
      const fields = record(value, [
        "projectId",
        "artifactId",
        "afterContentRevision",
        "limit",
      ]);
      result = {
        projectId: parseProjectTextId(fields.projectId),
        artifactId: parseProjectTextId(fields.artifactId),
        afterContentRevision: nonnegative(fields.afterContentRevision),
        limit: limit(fields.limit),
      };
      break;
    }
    case "saveOutlineCandidate": {
      const fields = record(value, [
        "projectId",
        "expectedArtifactRevision",
        "briefRevision",
        "content",
      ]);
      const { projectId, ...body } = fields;
      result = {
        projectId: parseProjectTextId(projectId),
        ...parseSaveProjectOutlineCandidateRequest(body),
      };
      break;
    }
    case "saveScriptCandidate": {
      const fields = record(
        value,
        [
          "projectId",
          "episodeId",
          "expectedArtifactRevision",
          "briefRevision",
          "content",
        ],
        ["outline"],
      );
      const { projectId, episodeId, ...body } = fields;
      result = {
        projectId: parseProjectTextId(projectId),
        episodeId: parseProjectTextId(episodeId),
        ...parseSaveProjectScriptCandidateRequest({
          ...body,
          outline: body.outline ?? null,
        }),
      };
      break;
    }
    case "selectRevision": {
      const fields = record(value, [
        "projectId",
        "artifactId",
        "expectedArtifactRevision",
        "contentRevision",
      ]);
      const { projectId, artifactId, ...body } = fields;
      result = {
        projectId: parseProjectTextId(projectId),
        artifactId: parseProjectTextId(artifactId),
        ...parseSelectProjectTextRevisionRequest(body),
      };
      break;
    }
    case "setLocked": {
      const fields = record(value, [
        "projectId",
        "artifactId",
        "expectedArtifactRevision",
        "locked",
      ]);
      const { projectId, artifactId, ...body } = fields;
      result = {
        projectId: parseProjectTextId(projectId),
        artifactId: parseProjectTextId(artifactId),
        ...parseSetProjectTextArtifactLockedRequest(body),
      };
      break;
    }
  }
  // Parsing must validate rather than alter creative text, titles or explicit values.
  const normalized = recordLike(value);
  if (method === "listProjects" && !Object.hasOwn(normalized, "after"))
    normalized.after = null;
  if (method === "saveScriptCandidate" && !Object.hasOwn(normalized, "outline"))
    normalized.outline = null;
  if (extensionCanonicalJson(normalized) !== extensionCanonicalJson(result))
    invalid();
  return Object.freeze(result) as ProjectToolsRequests[M];
}
function recordLike(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    invalid();
  return { ...input };
}
function record(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const fields = recordLike(input);
  if (
    Object.keys(fields).some(
      (key) => !required.includes(key) && !optional.includes(key),
    ) ||
    required.some((key) => !Object.hasOwn(fields, key))
  )
    invalid();
  return fields;
}
function nonnegative(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0)
    invalid();
  return input;
}
function limit(input: unknown): number {
  const value = nonnegative(input);
  if (value < 1 || value > MAX_PROJECT_TOOLS_PAGE_SIZE) invalid();
  return value;
}
function invalid(): never {
  throw new Error("plugin_project_tools_request_invalid");
}
