/** Explicit write protocol. The existing outlines API2 remains read only. */
export const CREWON_PROJECT_OUTLINE_EDITS_SERVICE =
  "crewon.project-outline-edits";
export const CREWON_PROJECT_OUTLINE_EDITS_API_VERSION = "1";
export const PROJECT_OUTLINE_EDIT_ACTIONS = Object.freeze({
  saveCandidate: "crewon.project-outline-edits.v1.saveCandidate",
  selectRevision: "crewon.project-outline-edits.v1.selectRevision",
} as const);
export type ProjectOutlineEditAction =
  (typeof PROJECT_OUTLINE_EDIT_ACTIONS)[keyof typeof PROJECT_OUTLINE_EDIT_ACTIONS];
export type ProjectOutlineJson =
  | null
  | boolean
  | number
  | string
  | readonly ProjectOutlineJson[]
  | Readonly<{ [key: string]: ProjectOutlineJson }>;
type Common = Readonly<{
  projectId: string;
  expectedArtifactRevision: number;
  idempotencyKey: string;
}>;
export type ProjectOutlineEditInputMap = Readonly<{
  "crewon.project-outline-edits.v1.saveCandidate": Common &
    Readonly<{
      briefRevision: number;
      base: Readonly<{ contentRevision: number; contentDigest: string }> | null;
      change: Readonly<Record<string, ProjectOutlineJson>>;
    }>;
  "crewon.project-outline-edits.v1.selectRevision": Common &
    Readonly<{ artifactId: string; contentRevision: number }>;
}>;
export type ProjectOutlineEditRequest = {
  [A in ProjectOutlineEditAction]: Readonly<{
    action: A;
    input: ProjectOutlineEditInputMap[A];
  }>;
}[ProjectOutlineEditAction];
export type ProjectOutlineEditResult = Readonly<{
  kind: "save-outline" | "select-revision";
  disposition: "committed" | "replayed";
  projectId: string;
  artifactId: string;
  artifactRevision: number;
  contentRevision: number;
  contentDigest: string;
}>;
export function isProjectOutlineEditAction(
  value: unknown,
): value is ProjectOutlineEditAction {
  return (
    typeof value === "string" &&
    Object.values(PROJECT_OUTLINE_EDIT_ACTIONS).some(
      (action) => action === value,
    )
  );
}
export function isProjectOutlineEditNamespaceAction(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (value === CREWON_PROJECT_OUTLINE_EDITS_SERVICE ||
      value.startsWith(CREWON_PROJECT_OUTLINE_EDITS_SERVICE + "."))
  );
}
export class ProjectOutlineEditContractError extends Error {
  constructor() {
    super("project_outline_edit_contract_invalid");
    this.name = "ProjectOutlineEditContractError";
  }
}
export function parseProjectOutlineEditRequest(
  raw: unknown,
): ProjectOutlineEditRequest {
  const value = fields(json(raw, 64 * 1024), ["action", "input"]);
  if (!isProjectOutlineEditAction(value.action)) invalid();
  const save = value.action === PROJECT_OUTLINE_EDIT_ACTIONS.saveCandidate;
  const input = fields(value.input, [
    "projectId",
    "expectedArtifactRevision",
    "idempotencyKey",
    ...(save
      ? ["briefRevision", "base", "change"]
      : ["artifactId", "contentRevision"]),
  ]);
  id(input.projectId);
  id(input.idempotencyKey);
  if ((input.idempotencyKey as string).includes(",")) invalid();
  integer(input.expectedArtifactRevision, save ? 0 : 1);
  if (save) {
    integer(input.briefRevision, 1);
    if (input.base !== null) {
      const base = fields(input.base, ["contentRevision", "contentDigest"]);
      integer(base.contentRevision, 1);
      digest(base.contentDigest);
    }
    if (
      input.change === null ||
      typeof input.change !== "object" ||
      Array.isArray(input.change)
    )
      invalid();
    if (
      new TextEncoder().encode(JSON.stringify(input.change)).byteLength >
      48 * 1024
    )
      invalid();
  } else {
    id(input.artifactId);
    integer(input.contentRevision, 1);
  }
  return Object.freeze({
    action: value.action,
    input,
  }) as ProjectOutlineEditRequest;
}
export function parseProjectOutlineEditResult(
  request: ProjectOutlineEditRequest,
  raw: unknown,
): ProjectOutlineEditResult {
  const checked = parseProjectOutlineEditRequest(request);
  const value = fields(json(raw, 2 * 1024), [
    "kind",
    "disposition",
    "projectId",
    "artifactId",
    "artifactRevision",
    "contentRevision",
    "contentDigest",
  ]);
  const save = checked.action === PROJECT_OUTLINE_EDIT_ACTIONS.saveCandidate;
  if (
    value.kind !== (save ? "save-outline" : "select-revision") ||
    !["committed", "replayed"].includes(value.disposition as string) ||
    value.projectId !== checked.input.projectId ||
    value.artifactRevision !== checked.input.expectedArtifactRevision + 1
  )
    invalid();
  id(value.artifactId);
  integer(value.contentRevision, 1);
  digest(value.contentDigest);
  if (
    !save &&
    (value.artifactId !== checked.input.artifactId ||
      value.contentRevision !== checked.input.contentRevision)
  )
    invalid();
  return value as ProjectOutlineEditResult;
}
export type PluginProjectOutlineEditsService = Readonly<{
  service: typeof CREWON_PROJECT_OUTLINE_EDITS_SERVICE;
  apiVersion: typeof CREWON_PROJECT_OUTLINE_EDITS_API_VERSION;
  invoke(
    action: ProjectOutlineEditAction,
    input: ProjectOutlineEditInputMap[ProjectOutlineEditAction],
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<unknown>;
}>;
export function createProjectOutlineEditsClient(
  service: PluginProjectOutlineEditsService,
) {
  if (
    service.service !== CREWON_PROJECT_OUTLINE_EDITS_SERVICE ||
    service.apiVersion !== CREWON_PROJECT_OUTLINE_EDITS_API_VERSION ||
    typeof service.invoke !== "function"
  )
    invalid();
  const invoke = service.invoke.bind(service);
  async function call<A extends ProjectOutlineEditAction>(
    action: A,
    input: ProjectOutlineEditInputMap[A],
    options?: Readonly<{ signal?: AbortSignal }>,
  ) {
    const request = parseProjectOutlineEditRequest({ action, input });
    return parseProjectOutlineEditResult(
      request,
      await invoke(request.action, request.input, options ?? {}),
    );
  }
  return Object.freeze({
    saveCandidate: (
      input: ProjectOutlineEditInputMap["crewon.project-outline-edits.v1.saveCandidate"],
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => call(PROJECT_OUTLINE_EDIT_ACTIONS.saveCandidate, input, options),
    selectRevision: (
      input: ProjectOutlineEditInputMap["crewon.project-outline-edits.v1.selectRevision"],
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => call(PROJECT_OUTLINE_EDIT_ACTIONS.selectRevision, input, options),
  });
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
  throw new ProjectOutlineEditContractError();
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
