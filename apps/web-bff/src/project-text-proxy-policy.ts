import {
  parseCreativeProjectId,
  parseCreativeProjectRevision,
  parseSaveProjectOutlineCandidateRequest,
  parseSaveProjectScriptCandidateRequest,
  parseSelectProjectTextRevisionRequest,
  parseSetProjectTextArtifactLockedRequest,
} from "@crewon/contracts";

export type ProjectTextProxyQueryKind =
  | "text-artifacts"
  | "text-revisions"
  | "empty";
type ProjectTextProxyRoute = Readonly<{
  methods: readonly string[];
  query: ProjectTextProxyQueryKind;
}>;

/** Called only after the original project policy has validated the raw target and project ID. */
export function projectTextProxyRoute(
  parts: readonly string[],
): ProjectTextProxyRoute | null {
  if (parts[1] !== "text-artifacts") return null;
  if (parts.length === 2) return route(["GET"], "text-artifacts");
  if (parts[2] === "outline") {
    if (parts.length === 3) return route(["GET"]);
    if (parts.length === 4 && parts[3] === "candidates") return route(["POST"]);
    return null;
  }
  if (parts[2] === "scripts") {
    if (!opaque(parts[3])) return null;
    if (parts.length === 4) return route(["GET"]);
    if (parts.length === 5 && parts[4] === "candidates") return route(["POST"]);
    return null;
  }
  if (parts[2] !== "items" || !opaque(parts[3])) return null;
  if (parts.length === 4) return route(["GET"]);
  if (parts.length === 5 && (parts[4] === "selection" || parts[4] === "lock"))
    return route(["PUT"]);
  if (parts[4] === "revisions") {
    if (parts.length === 5) return route(["GET"], "text-revisions");
    if (parts.length === 6 && positiveRevision(parts[5])) return route(["GET"]);
  }
  return null;
}

/** New text writes are validated before forwarding; identity and owner fields are never accepted. */
export function assertProjectTextProxyBody(
  parts: readonly string[],
  body: unknown,
): void {
  if (parts[1] !== "text-artifacts") return;
  if (
    parts.length === 4 &&
    parts[2] === "outline" &&
    parts[3] === "candidates"
  ) {
    parseSaveProjectOutlineCandidateRequest(body);
    return;
  }
  if (
    parts.length === 5 &&
    parts[2] === "scripts" &&
    parts[4] === "candidates"
  ) {
    parseSaveProjectScriptCandidateRequest(body);
    return;
  }
  if (parts.length === 5 && parts[2] === "items" && parts[4] === "selection") {
    parseSelectProjectTextRevisionRequest(body);
    return;
  }
  if (parts.length === 5 && parts[2] === "items" && parts[4] === "lock") {
    parseSetProjectTextArtifactLockedRequest(body);
    return;
  }
  throw new Error("project_text_request_invalid");
}

function route(
  methods: readonly string[],
  query: ProjectTextProxyQueryKind = "empty",
): ProjectTextProxyRoute {
  return Object.freeze({ methods: Object.freeze(methods), query });
}
function opaque(input: string | undefined): boolean {
  if (input === undefined) return false;
  try {
    parseCreativeProjectId(decodeURIComponent(input));
    return true;
  } catch {
    return false;
  }
}
function positiveRevision(input: string | undefined): boolean {
  if (input === undefined) return false;
  try {
    parseCreativeProjectRevision(input);
    return true;
  } catch {
    return false;
  }
}
