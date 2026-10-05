import { parsePluginUiJsonValue, pluginUiFields } from "./plugin-ui-json.ts";
import { parseProjectTextId } from "./project-text-control-contract.ts";
import { parseProjectConversationStage } from "./plugin-project-conversations-contract.ts";
import {
  MAX_PROJECT_CONTEXT_RESPONSE_BYTES,
  type PublicProjectContextScope,
} from "./plugin-project-context-service.ts";

/** Validate a bounded data projection, never an authorization grant. */
export function parseProjectContextResponse(
  input: unknown,
): Readonly<{ scope: PublicProjectContextScope | null }> {
  const v = pluginUiFields(
    parsePluginUiJsonValue(input, {
      maxBytes: MAX_PROJECT_CONTEXT_RESPONSE_BYTES,
    }),
    ["scope"],
  );
  if (v.scope === null) return Object.freeze({ scope: null });
  const s = pluginUiFields(v.scope, [
    "projectId",
    "threadId",
    "runId",
    "bindingId",
    "bindingRevision",
    "stage",
    "sources",
    "allowedOperations",
    "contentDigest",
  ]);
  const stage = parseProjectConversationStage(s.stage),
    sources = pluginUiFields(s.sources, ["brief", "outline"]);
  const integer = (x: unknown) =>
    typeof x === "number" && Number.isSafeInteger(x) && x >= 1 ? x : fail();
  const digest = (x: unknown) =>
    typeof x === "string" && /^sha256:[a-f0-9]{64}$/u.test(x) ? x : fail();
  const b =
      sources.brief === null
        ? null
        : pluginUiFields(sources.brief, ["briefRevision", "contentDigest"]),
    o =
      sources.outline === null
        ? null
        : pluginUiFields(sources.outline, [
            "artifactId",
            "contentRevision",
            "contentDigest",
          ]);
  const brief =
      b === null
        ? null
        : Object.freeze({
            briefRevision: integer(b.briefRevision),
            contentDigest: digest(b.contentDigest),
          }),
    outline =
      o === null
        ? null
        : Object.freeze({
            artifactId: parseProjectTextId(o.artifactId),
            contentRevision: integer(o.contentRevision),
            contentDigest: digest(o.contentDigest),
          });
  const operations = [
    "project_context_read",
    "project_read",
    "outline_read",
    "script_read",
    "content_read",
    "text_history",
    ...(stage.kind === "discussion"
      ? []
      : [
          stage.kind === "brief"
            ? "brief_append"
            : stage.kind === "outline"
              ? "outline_save"
              : "script_save",
        ]),
  ];
  if (
    JSON.stringify(s.allowedOperations) !== JSON.stringify(operations) ||
    (stage.kind !== "discussion" &&
      brief?.briefRevision !== stage.briefRevision) ||
    (stage.kind === "script"
      ? stage.outline === null
        ? outline !== null
        : outline === null ||
          outline.artifactId !== stage.outline.artifactId ||
          outline.contentRevision !== stage.outline.contentRevision
      : outline !== null)
  )
    fail();
  return Object.freeze({
    scope: Object.freeze({
      projectId: parseProjectTextId(s.projectId),
      threadId: parseProjectTextId(s.threadId),
      runId: parseProjectTextId(s.runId),
      bindingId: parseProjectTextId(s.bindingId),
      bindingRevision: integer(s.bindingRevision),
      stage,
      sources: Object.freeze({ brief, outline }),
      allowedOperations: Object.freeze(operations),
      contentDigest: digest(s.contentDigest),
    }),
  });
}
function fail(): never {
  throw new Error("plugin_project_context_invalid");
}
export const projectContextCodec = Object.freeze({
  parseResponse: parseProjectContextResponse,
});
