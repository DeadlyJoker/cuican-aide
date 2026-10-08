/** Portable v2 read protocol. Large documents are paged; original SDK/v1 limits and write authorities are unchanged. */
export const CREWON_PROJECT_OUTLINES_SERVICE = "crewon.project-outlines";
export const CREWON_PROJECT_OUTLINES_API_VERSION = "2";
export const MAX_PROJECT_OUTLINE_UI_RESPONSE_BYTES = 60 * 1024;
export const PROJECT_OUTLINE_UI_METHOD_ACTIONS = Object.freeze({
  getOutline: "crewon.project-outlines.v2.getOutline",
  getSection: "crewon.project-outlines.v2.getSection",
  listRevisions: "crewon.project-outlines.v2.listRevisions",
} as const);
export type ProjectOutlineUiAction =
  (typeof PROJECT_OUTLINE_UI_METHOD_ACTIONS)[keyof typeof PROJECT_OUTLINE_UI_METHOD_ACTIONS];
export const PROJECT_OUTLINE_SECTIONS = Object.freeze([
  "overview",
  "adaptation",
  "keep",
  "cut",
  "merge",
  "risks",
  "characters",
  "scenes",
  "props",
  "beats",
  "episodes",
  "gates",
  "problems",
] as const);
export type ProjectOutlineSection = (typeof PROJECT_OUTLINE_SECTIONS)[number];
export type ProjectOutlineJson =
  | null
  | boolean
  | number
  | string
  | readonly ProjectOutlineJson[]
  | Readonly<{ [key: string]: ProjectOutlineJson }>;
export type ProjectOutlineItem = Readonly<Record<string, ProjectOutlineJson>>;
export type ProjectOutlineArtifact = Readonly<{
  projectId: string;
  artifactId: string;
  kind: "outline";
  episodeId: null;
  revision: number;
  latestContentRevision: number;
  selectedContentRevision: number | null;
  locked: boolean;
  createdAt: string;
  updatedAt: string;
}>;
export type ProjectOutlineRevisionSummary = Readonly<{
  projectId: string;
  artifactId: string;
  contentRevision: number;
  contentDigest: string;
  brief: Readonly<{ briefRevision: number; contentDigest: string }>;
  format: "legacy-v1" | "structured-v2";
  title: string;
  createdAt: string;
  counts: Readonly<{
    episodes: number;
    characters: number;
    scenes: number;
    props: number;
    beats: number;
  }>;
  quality: Readonly<{
    passed: boolean;
    problemCount: number;
    failedGateCount: number;
  }> | null;
}>;
export type ProjectOutlineView = Readonly<{
  artifact: ProjectOutlineArtifact;
  latestRevision: ProjectOutlineRevisionSummary;
  selectedRevision: ProjectOutlineRevisionSummary | null;
  staleReasons: readonly ("brief-changed" | "foundation-changed")[];
}>;
export type ProjectOutlineSectionQuery = Readonly<{
  projectId: string;
  artifactId: string;
  contentRevision: number;
  contentDigest: string;
  section: ProjectOutlineSection;
  afterIndex: number;
  limit: number;
}>;
export type ProjectOutlineSectionResponse = Readonly<{
  revision: ProjectOutlineRevisionSummary;
  section: ProjectOutlineSection;
  startIndex: number;
  totalItems: number;
  items: readonly ProjectOutlineItem[];
  nextIndex: number | null;
}>;
export type ProjectOutlineUiInputMap = Readonly<{
  "crewon.project-outlines.v2.getOutline": Readonly<{ projectId: string }>;
  "crewon.project-outlines.v2.getSection": ProjectOutlineSectionQuery;
  "crewon.project-outlines.v2.listRevisions": Readonly<{
    projectId: string;
    artifactId: string;
    afterContentRevision: number;
    limit: number;
  }>;
}>;
export type ProjectOutlineUiResponseMap = Readonly<{
  "crewon.project-outlines.v2.getOutline": Readonly<{
    view: ProjectOutlineView | null;
  }>;
  "crewon.project-outlines.v2.getSection": ProjectOutlineSectionResponse;
  "crewon.project-outlines.v2.listRevisions": Readonly<{
    revisions: readonly ProjectOutlineRevisionSummary[];
    nextContentRevision: number | null;
  }>;
}>;
export type ProjectOutlineUiRequest = {
  [A in ProjectOutlineUiAction]: Readonly<{
    action: A;
    input: ProjectOutlineUiInputMap[A];
  }>;
}[ProjectOutlineUiAction];
export function isProjectOutlineUiAction(
  value: unknown,
): value is ProjectOutlineUiAction {
  return (
    typeof value === "string" &&
    Object.values(PROJECT_OUTLINE_UI_METHOD_ACTIONS).some(
      (action) => action === value,
    )
  );
}
export function isProjectOutlineUiNamespaceAction(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (value === CREWON_PROJECT_OUTLINES_SERVICE ||
      value.startsWith(CREWON_PROJECT_OUTLINES_SERVICE + "."))
  );
}
export class ProjectOutlineUiContractError extends Error {
  constructor() {
    super("project_outline_ui_contract_invalid");
    this.name = "ProjectOutlineUiContractError";
  }
}
export function parseProjectOutlineUiRequest(
  raw: unknown,
): ProjectOutlineUiRequest {
  const value = fields(json(raw, 24 * 1024), ["action", "input"]);
  if (!isProjectOutlineUiAction(value.action)) invalid();
  const action = value.action;
  const keys =
    action === PROJECT_OUTLINE_UI_METHOD_ACTIONS.getOutline
      ? ["projectId"]
      : action === PROJECT_OUTLINE_UI_METHOD_ACTIONS.getSection
        ? [
            "projectId",
            "artifactId",
            "contentRevision",
            "contentDigest",
            "section",
            "afterIndex",
            "limit",
          ]
        : ["projectId", "artifactId", "afterContentRevision", "limit"];
  const input = fields(value.input, keys);
  id(input.projectId);
  if (action !== PROJECT_OUTLINE_UI_METHOD_ACTIONS.getOutline) {
    id(input.artifactId);
    integer(input.limit, 1, 10);
  }
  if (action === PROJECT_OUTLINE_UI_METHOD_ACTIONS.getSection) {
    integer(input.contentRevision, 1);
    digest(input.contentDigest);
    integer(input.afterIndex, 0, 8192);
    if (
      !PROJECT_OUTLINE_SECTIONS.includes(input.section as ProjectOutlineSection)
    )
      invalid();
  } else if (action === PROJECT_OUTLINE_UI_METHOD_ACTIONS.listRevisions)
    integer(input.afterContentRevision, 0);
  return Object.freeze({ action, input }) as ProjectOutlineUiRequest;
}
export function parseProjectOutlineUiResponse<A extends ProjectOutlineUiAction>(
  request: Readonly<{ action: A; input: ProjectOutlineUiInputMap[A] }>,
  raw: unknown,
): ProjectOutlineUiResponseMap[A] {
  const checked = parseProjectOutlineUiRequest(request);
  const value = json(raw, MAX_PROJECT_OUTLINE_UI_RESPONSE_BYTES);
  const query = checked.input;
  if (checked.action === PROJECT_OUTLINE_UI_METHOD_ACTIONS.getOutline) {
    const response = fields(value, ["view"]);
    if (response.view !== null) {
      const view = fields(response.view, [
        "artifact",
        "latestRevision",
        "selectedRevision",
        "staleReasons",
      ]);
      const artifact = fields(view.artifact, [
        "projectId",
        "artifactId",
        "kind",
        "episodeId",
        "revision",
        "latestContentRevision",
        "selectedContentRevision",
        "locked",
        "createdAt",
        "updatedAt",
      ]);
      if (
        artifact.projectId !== query.projectId ||
        artifact.kind !== "outline" ||
        artifact.episodeId !== null ||
        typeof artifact.locked !== "boolean"
      )
        invalid();
      id(artifact.artifactId);
      integer(artifact.revision, 1);
      integer(artifact.latestContentRevision, 1);
      timestamp(artifact.createdAt);
      timestamp(artifact.updatedAt);
      const latest = summary(
        view.latestRevision,
        query.projectId,
        artifact.artifactId as string,
      );
      if (latest.contentRevision !== artifact.latestContentRevision) invalid();
      if (view.selectedRevision === null) {
        if (artifact.selectedContentRevision !== null) invalid();
      } else {
        const selected = summary(
          view.selectedRevision,
          query.projectId,
          artifact.artifactId as string,
        );
        if (
          selected.contentRevision !== artifact.selectedContentRevision ||
          selected.contentRevision > latest.contentRevision
        )
          invalid();
      }
      if (
        !Array.isArray(view.staleReasons) ||
        view.staleReasons.length > 2 ||
        new Set(view.staleReasons).size !== view.staleReasons.length ||
        view.staleReasons.some(
          (reason) =>
            reason !== "brief-changed" && reason !== "foundation-changed",
        )
      )
        invalid();
    }
  } else if (checked.action === PROJECT_OUTLINE_UI_METHOD_ACTIONS.getSection) {
    const input = checked.input,
      response = fields(value, [
        "revision",
        "section",
        "startIndex",
        "totalItems",
        "items",
        "nextIndex",
      ]);
    const revision = summary(
      response.revision,
      input.projectId,
      input.artifactId,
    );
    if (
      revision.contentRevision !== input.contentRevision ||
      revision.contentDigest !== input.contentDigest ||
      response.section !== input.section ||
      response.startIndex !== input.afterIndex
    )
      invalid();
    integer(response.totalItems, 0, 8192);
    if (
      !Array.isArray(response.items) ||
      response.items.length > input.limit ||
      response.items.some(
        (item) =>
          item === null || typeof item !== "object" || Array.isArray(item),
      )
    )
      invalid();
    const end = input.afterIndex + response.items.length;
    if (
      input.afterIndex > (response.totalItems as number) ||
      end > (response.totalItems as number) ||
      (end < (response.totalItems as number)
        ? response.nextIndex !== end || response.items.length === 0
        : response.nextIndex !== null)
    )
      invalid();
  } else {
    const input = checked.input,
      response = fields(value, ["revisions", "nextContentRevision"]);
    if (
      !Array.isArray(response.revisions) ||
      response.revisions.length > input.limit
    )
      invalid();
    let previous = input.afterContentRevision;
    for (const item of response.revisions) {
      const revision = summary(item, input.projectId, input.artifactId);
      if (revision.contentRevision <= previous) invalid();
      previous = revision.contentRevision;
    }
    if (
      response.nextContentRevision !== null &&
      (response.revisions.length === 0 ||
        response.nextContentRevision !== previous)
    )
      invalid();
  }
  return value as ProjectOutlineUiResponseMap[A];
}
function summary(
  raw: unknown,
  projectId: string,
  artifactId: string,
): ProjectOutlineRevisionSummary {
  const value = fields(raw, [
    "projectId",
    "artifactId",
    "contentRevision",
    "contentDigest",
    "brief",
    "format",
    "title",
    "createdAt",
    "counts",
    "quality",
  ]);
  if (
    value.projectId !== projectId ||
    value.artifactId !== artifactId ||
    !["legacy-v1", "structured-v2"].includes(value.format as string) ||
    typeof value.title !== "string" ||
    new TextEncoder().encode(value.title).byteLength > 640
  )
    invalid();
  integer(value.contentRevision, 1);
  digest(value.contentDigest);
  timestamp(value.createdAt);
  const brief = fields(value.brief, ["briefRevision", "contentDigest"]);
  integer(brief.briefRevision, 1);
  digest(brief.contentDigest);
  const counts = fields(value.counts, [
    "episodes",
    "characters",
    "scenes",
    "props",
    "beats",
  ]);
  for (const count of Object.values(counts)) integer(count, 0, 240);
  if (value.format === "legacy-v1") {
    if (value.quality !== null) invalid();
  } else {
    const quality = fields(value.quality, [
      "passed",
      "problemCount",
      "failedGateCount",
    ]);
    if (typeof quality.passed !== "boolean") invalid();
    integer(quality.problemCount, 0, 8192);
    integer(quality.failedGateCount, 0, 14);
    if (quality.passed !== (quality.problemCount === 0)) invalid();
  }
  return value as ProjectOutlineRevisionSummary;
}
function fields(
  raw: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(raw, key))
  )
    invalid();
  return raw as Record<string, unknown>;
}
function id(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 160 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    invalid();
}
function digest(value: unknown) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value))
    invalid();
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    invalid();
}
function timestamp(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    invalid();
}
function invalid(): never {
  throw new ProjectOutlineUiContractError();
}
function json(input: unknown, maxBytes: number): ProjectOutlineJson {
  let nodes = 0,
    bytes = 0;
  const charge = (amount: number) => {
    if ((bytes += amount) > maxBytes) invalid();
  };
  const ancestors = new Set<object>();
  function copy(value: unknown, depth: number): ProjectOutlineJson {
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
        value.length > maxBytes ||
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
      const item = (key: string): ProjectOutlineJson => {
        const field = Object.getOwnPropertyDescriptor(value, key);
        if (!field?.enumerable || !Object.hasOwn(field, "value")) invalid();
        return copy(field.value, depth + 1);
      };
      if (Array.isArray(value)) {
        if (
          Object.getPrototypeOf(value) !== Array.prototype ||
          keys.length !== value.length + 1
        )
          invalid();
        charge(2 + Math.max(0, value.length - 1));
        return Object.freeze(
          Array.from({ length: value.length }, (_, index) =>
            item(String(index)),
          ),
        );
      }
      if (
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      )
        invalid();
      charge(2 + Math.max(0, keys.length - 1));
      return Object.freeze(
        Object.fromEntries(
          keys.map((key) => {
            if (typeof key !== "string" || key.length > maxBytes) invalid();
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
  const value = copy(input, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxBytes)
    invalid();
  return value;
}
export type PluginProjectOutlineUiClient = Readonly<{
  getOutline(
    input: ProjectOutlineUiInputMap["crewon.project-outlines.v2.getOutline"],
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<
    ProjectOutlineUiResponseMap["crewon.project-outlines.v2.getOutline"]
  >;
  getSection(
    input: ProjectOutlineSectionQuery,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ProjectOutlineSectionResponse>;
  listRevisions(
    input: ProjectOutlineUiInputMap["crewon.project-outlines.v2.listRevisions"],
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<
    ProjectOutlineUiResponseMap["crewon.project-outlines.v2.listRevisions"]
  >;
}>;
export function createPluginProjectOutlineUiClient(
  host: Readonly<{
    invoke(
      action: string,
      input: ProjectOutlineJson,
      options: Readonly<{ signal?: AbortSignal }>,
    ): Promise<unknown>;
  }>,
): PluginProjectOutlineUiClient {
  const invoke = host.invoke.bind(host);
  const call = async <A extends ProjectOutlineUiAction>(
    action: A,
    input: ProjectOutlineUiInputMap[A],
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => {
    const request = parseProjectOutlineUiRequest({ action, input });
    return parseProjectOutlineUiResponse(
      { action, input },
      await invoke(action, request.input, options ?? {}),
    );
  };
  return Object.freeze({
    getOutline: (input, options) =>
      call(PROJECT_OUTLINE_UI_METHOD_ACTIONS.getOutline, input, options),
    getSection: (input, options) =>
      call(PROJECT_OUTLINE_UI_METHOD_ACTIONS.getSection, input, options),
    listRevisions: (input, options) =>
      call(PROJECT_OUTLINE_UI_METHOD_ACTIONS.listRevisions, input, options),
  });
}
