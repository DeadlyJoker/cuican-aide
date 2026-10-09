/** Portable Worker protocol. JSON hints never grant Run, installation or UI authority. */
export const CREWON_PROJECT_OUTLINE_TOOLS_SERVICE =
  "crewon.project-outline-tools";
export const CREWON_PROJECT_OUTLINE_TOOLS_API_VERSION = "1";
export const PROJECT_OUTLINE_CHANGE_OPERATION = "outline_change";
export const MAX_PROJECT_OUTLINE_TOOL_INPUT_BYTES = 60 * 1024;
export const MAX_PROJECT_OUTLINE_TOOL_OUTPUT_BYTES = 2048;
export type ProjectOutlineToolJson =
  | null
  | boolean
  | number
  | string
  | readonly ProjectOutlineToolJson[]
  | Readonly<{ [key: string]: ProjectOutlineToolJson }>;
export type ProjectOutlineToolRequest = Readonly<{
  projectId: string;
  expectedFoundationRevision: number;
  expectedArtifactRevision: number;
  briefRevision: number;
  base: Readonly<{ contentRevision: number; contentDigest: string }> | null;
  change: Readonly<Record<string, ProjectOutlineToolJson>>;
}>;
export type ProjectOutlineToolResult = Readonly<{
  kind: "save-outline";
  disposition: "committed" | "replayed";
  projectId: string;
  artifactId: string;
  artifactRevision: number;
  contentRevision: number;
  contentDigest: string;
}>;
export type PluginProjectOutlineToolsService = Readonly<{
  saveCandidate(
    input: Readonly<{
      /** Must be the genuine execution object forwarded unchanged by the installed Node runtime. */
      command: unknown;
      request: ProjectOutlineToolRequest;
    }>,
  ): Promise<ProjectOutlineToolResult>;
}>;

export function parseProjectOutlineToolRequest(
  raw: unknown,
): ProjectOutlineToolRequest {
  const value = fields(copy(raw, MAX_PROJECT_OUTLINE_TOOL_INPUT_BYTES), [
    "projectId",
    "expectedFoundationRevision",
    "expectedArtifactRevision",
    "briefRevision",
    "base",
    "change",
  ]);
  id(value.projectId);
  revision(value.expectedFoundationRevision, 1);
  revision(value.expectedArtifactRevision, 0);
  revision(value.briefRevision, 1);
  if (value.base !== null) {
    const base = fields(value.base, ["contentRevision", "contentDigest"]);
    revision(base.contentRevision, 1);
    digest(base.contentDigest);
  }
  const change = record(value.change);
  if (new TextEncoder().encode(JSON.stringify(change)).byteLength > 48 * 1024)
    invalid();
  switch (change.kind) {
    case "initialize":
      fields(change, ["kind", "document"]);
      if (value.base !== null) invalid();
      record(change.document);
      break;
    case "overview":
    case "adaptation":
      fields(change, ["kind", "value"]);
      if (value.base === null) invalid();
      record(change.value);
      break;
    case "upsert":
      fields(change, ["kind", "collection", "items", "removeIds"]);
      if (
        value.base === null ||
        !["characters", "scenes", "props", "beats", "episodes"].includes(
          change.collection as string,
        )
      )
        invalid();
      if (
        !Array.isArray(change.items) ||
        change.items.length > 10 ||
        !Array.isArray(change.removeIds) ||
        change.removeIds.length > 10
      )
        invalid();
      change.items.forEach(record);
      change.removeIds.forEach(id);
      break;
    default:
      invalid();
  }
  return value as ProjectOutlineToolRequest;
}
export function parseProjectOutlineToolResult(
  request: ProjectOutlineToolRequest,
  raw: unknown,
): ProjectOutlineToolResult {
  const checked = parseProjectOutlineToolRequest(request);
  const value = fields(copy(raw, MAX_PROJECT_OUTLINE_TOOL_OUTPUT_BYTES), [
    "kind",
    "disposition",
    "projectId",
    "artifactId",
    "artifactRevision",
    "contentRevision",
    "contentDigest",
  ]);
  if (
    value.kind !== "save-outline" ||
    !["committed", "replayed"].includes(value.disposition as string) ||
    value.projectId !== checked.projectId ||
    value.artifactRevision !== checked.expectedArtifactRevision + 1
  )
    invalid();
  id(value.artifactId);
  revision(value.contentRevision, 1);
  digest(value.contentDigest);
  return value as ProjectOutlineToolResult;
}
export function createProjectOutlineToolsClient(
  service: PluginProjectOutlineToolsService,
) {
  if (typeof service.saveCandidate !== "function") invalid();
  const invoke = service.saveCandidate.bind(service);
  return Object.freeze({
    async saveCandidate(
      input: Readonly<{ command: unknown; request: ProjectOutlineToolRequest }>,
    ) {
      const request = parseProjectOutlineToolRequest(input.request);
      return parseProjectOutlineToolResult(
        request,
        await invoke({ command: input.command, request }),
      );
    },
  });
}
function record(raw: unknown): Record<string, ProjectOutlineToolJson> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) invalid();
  return raw as Record<string, ProjectOutlineToolJson>;
}
function fields(raw: unknown, keys: readonly string[]) {
  const value = record(raw);
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
  return value;
}
function id(value: unknown): void {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 160 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    invalid();
}
function revision(value: unknown, minimum: number): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    invalid();
}
function digest(value: unknown): void {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value))
    invalid();
}
function invalid(): never {
  throw new Error("project_outline_tool_contract_invalid");
}

/** Data-only immutable copy, before any serialization; accessors/hooks are never evaluated. */
function copy(raw: unknown, maximum: number): ProjectOutlineToolJson {
  let nodes = 0,
    bytes = 0;
  const ancestors = new Set<object>();
  const charge = (n: number) => {
    if ((bytes += n) > maximum) invalid();
  };
  function visit(value: unknown, depth: number): ProjectOutlineToolJson {
    if (++nodes > 8192 || depth > 16) invalid();
    if (value === null || typeof value === "boolean") {
      charge(value === null || value === true ? 4 : 5);
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) invalid();
      charge(JSON.stringify(value).length);
      return value;
    }
    if (typeof value === "string") {
      if (
        value.length > maximum ||
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
          value,
        )
      )
        invalid();
      charge(new TextEncoder().encode(JSON.stringify(value)).byteLength);
      return value;
    }
    if (typeof value !== "object" || ancestors.has(value)) invalid();
    ancestors.add(value);
    try {
      const keys = Reflect.ownKeys(value);
      if (keys.length > 8192) invalid();
      const item = (key: string) => {
        const d = Object.getOwnPropertyDescriptor(value, key);
        if (!d?.enumerable || !Object.hasOwn(d, "value")) invalid();
        return visit(d.value, depth + 1);
      };
      if (Array.isArray(value)) {
        if (
          Object.getPrototypeOf(value) !== Array.prototype ||
          keys.length !== value.length + 1
        )
          invalid();
        charge(2 + Math.max(0, value.length - 1));
        return Object.freeze(
          Array.from({ length: value.length }, (_, i) => item(String(i))),
        );
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        invalid();
      charge(2 + Math.max(0, keys.length - 1));
      return Object.freeze(
        Object.fromEntries(
          keys.map((key) => {
            if (typeof key !== "string") invalid();
            charge(
              new TextEncoder().encode(JSON.stringify(key)).byteLength + 1,
            );
            return [key, item(key)];
          }),
        ),
      );
    } finally {
      ancestors.delete(value);
    }
  }
  return visit(raw, 0);
}
