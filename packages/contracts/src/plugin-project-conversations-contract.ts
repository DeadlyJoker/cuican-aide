import { parsePluginUiJsonValue, pluginUiFields } from "./plugin-ui-json.ts";
import {
  parseProjectTextId,
  parseProjectTextIdempotencyKey,
} from "./project-text-control-contract.ts";
import {
  PROJECT_CONVERSATIONS_METHOD_ACTIONS,
  MAX_PROJECT_CONVERSATIONS_BYTES,
  MAX_PROJECT_CONVERSATION_CONTENT_BYTES,
  type ProjectConversationStage,
  type PublicProjectConversationBinding,
  type ProjectConversationsUiAction,
  type ProjectConversationsUiActionRequest,
  type ProjectConversationsUiResponseMap,
  type ProjectConversationsCodec,
} from "./plugin-project-conversations-service.ts";
export class PluginProjectConversationsContractError extends Error {
  constructor() {
    super("plugin_project_conversations_invalid");
  }
}
const fail = (): never => {
  throw new PluginProjectConversationsContractError();
};
const integer = (v: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max
    ? v
    : fail();
const digest = (v: unknown): string =>
  typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v) ? v : fail();
const timestamp = (v: unknown): string =>
  typeof v === "string" &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v
    ? v
    : fail();
const state = (v: unknown): "active" | "revoked" =>
  v === "active" || v === "revoked" ? v : fail();
function checked<T>(read: () => T): T {
  try {
    return read();
  } catch {
    throw new PluginProjectConversationsContractError();
  }
}
export function parseProjectConversationStage(
  input: unknown,
): ProjectConversationStage {
  return checked(() => {
    const v = pluginUiFields(
      parsePluginUiJsonValue(input),
      Object.keys(input as object),
    );
    if (v.kind === "discussion") {
      pluginUiFields(v, ["kind"]);
      return Object.freeze({ kind: "discussion" });
    }
    if (v.kind === "brief" || v.kind === "outline") {
      pluginUiFields(v, ["kind", "briefRevision"]);
      return Object.freeze({
        kind: v.kind,
        briefRevision: integer(v.briefRevision),
      });
    }
    if (v.kind !== "script") return fail();
    pluginUiFields(v, ["kind", "episodeId", "briefRevision", "outline"]);
    const o =
      v.outline === null
        ? null
        : pluginUiFields(v.outline, ["artifactId", "contentRevision"]);
    return Object.freeze({
      kind: "script",
      episodeId: parseProjectTextId(v.episodeId),
      briefRevision: integer(v.briefRevision),
      outline:
        o === null
          ? null
          : Object.freeze({
              artifactId: parseProjectTextId(o.artifactId),
              contentRevision: integer(o.contentRevision),
            }),
    });
  });
}
export function parseProjectConversationsActionRequest(
  input: unknown,
): ProjectConversationsUiActionRequest {
  return checked(() => {
    const v = pluginUiFields(
      parsePluginUiJsonValue(input, {
        maxBytes: MAX_PROJECT_CONVERSATIONS_BYTES,
      }),
      ["action", "input"],
    );
    if (
      !Object.values(PROJECT_CONVERSATIONS_METHOD_ACTIONS).includes(
        v.action as ProjectConversationsUiAction,
      )
    )
      fail();
    const action = v.action as ProjectConversationsUiAction,
      method = action.slice("crewon.project-conversations.v1.".length);
    const fields =
      method === "getBinding"
        ? ["threadId"]
        : method === "listConversations"
          ? ["projectId", "afterThreadId", "limit"]
          : method === "createConversation"
            ? ["projectId", "workspaceId", "title", "idempotencyKey"]
            : method === "openConversation"
              ? ["projectId", "threadId"]
              : method === "refreshSource"
                ? [
                    "projectId",
                    "threadId",
                    "expectedBindingRevision",
                    "idempotencyKey",
                  ]
                : method === "setState"
                  ? [
                      "projectId",
                      "threadId",
                      "expectedBindingRevision",
                      "state",
                      "idempotencyKey",
                    ]
                  : [
                      "projectId",
                      "threadId",
                      "expectedThreadRevision",
                      "expectedBindingRevision",
                      "content",
                      "idempotencyKey",
                      "stage",
                    ];
    const b = pluginUiFields(v.input, fields),
      out: Record<string, unknown> = {};
    for (const k of fields) {
      const x = b[k];
      switch (k) {
        case "limit":
          out[k] = integer(x, 1, 16);
          break;
        case "expectedThreadRevision":
        case "expectedBindingRevision":
          out[k] = integer(x);
          break;
        case "idempotencyKey":
          out[k] = parseProjectTextIdempotencyKey(x);
          break;
        case "workspaceId":
        case "afterThreadId":
          out[k] = x === null ? null : parseProjectTextId(x);
          break;
        case "title":
          if (x === null) {
            out[k] = null;
            break;
          }
          if (
            typeof x !== "string" ||
            x.trim() !== x ||
            !x.length ||
            [...x].length > 160 ||
            x.length > 320
          )
            fail();
          out[k] = x;
          break;
        case "content":
          if (
            typeof x !== "string" ||
            !x.trim() ||
            new TextEncoder().encode(x).length >
              MAX_PROJECT_CONVERSATION_CONTENT_BYTES ||
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(x)
          )
            fail();
          out[k] = x;
          break;
        case "state":
          out[k] = state(x);
          break;
        case "stage":
          out[k] = parseProjectConversationStage(x);
          break;
        default:
          out[k] = parseProjectTextId(x);
      }
    }
    return Object.freeze({
      action,
      input: Object.freeze(out),
    }) as ProjectConversationsUiActionRequest;
  });
}
export function parsePublicProjectConversationBinding(
  input: unknown,
): PublicProjectConversationBinding {
  return checked(() => {
    const v = pluginUiFields(
        parsePluginUiJsonValue(input, {
          maxBytes: MAX_PROJECT_CONVERSATIONS_BYTES,
        }),
        [
          "bindingId",
          "projectId",
          "threadId",
          "workspaceId",
          "revision",
          "state",
          "source",
          "createdAt",
          "updatedAt",
        ],
      ),
      s = pluginUiFields(v.source, [
        "pluginId",
        "publisherId",
        "version",
        "packageDigest",
        "selectionRevision",
      ]);
    const namespace = (x: unknown) =>
      typeof x === "string" &&
      /^[a-z][a-z0-9._-]{0,127}$/u.test(x) &&
      x.length <= 128
        ? x
        : fail();
    if (
      typeof s.version !== "string" ||
      s.version.length > 128 ||
      !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
        s.version,
      )
    )
      fail();
    const createdAt = timestamp(v.createdAt),
      updatedAt = timestamp(v.updatedAt);
    if (Date.parse(updatedAt) < Date.parse(createdAt)) fail();
    return Object.freeze({
      bindingId: parseProjectTextId(v.bindingId),
      projectId: parseProjectTextId(v.projectId),
      threadId: parseProjectTextId(v.threadId),
      workspaceId:
        v.workspaceId === null ? null : parseProjectTextId(v.workspaceId),
      revision: integer(v.revision),
      state: state(v.state),
      source: Object.freeze({
        pluginId: namespace(s.pluginId),
        publisherId: namespace(s.publisherId),
        version: s.version as string,
        packageDigest: digest(s.packageDigest),
        selectionRevision: integer(s.selectionRevision),
      }),
      createdAt,
      updatedAt,
    });
  });
}
export function parseProjectConversationsActionResponse(
  requestInput: ProjectConversationsUiActionRequest,
  input: unknown,
): ProjectConversationsUiResponseMap[ProjectConversationsUiAction] {
  return checked(() => {
    const request = parseProjectConversationsActionRequest(requestInput),
      v = parsePluginUiJsonValue(input, {
        maxBytes: MAX_PROJECT_CONVERSATIONS_BYTES,
      }),
      b = request.input;
    if (request.action === PROJECT_CONVERSATIONS_METHOD_ACTIONS.startStage) {
      const out = pluginUiFields(v, [
        "disposition",
        "threadId",
        "threadRevision",
        "runId",
        "runRevision",
        "bindingRevision",
        "stageAdmissionDigest",
      ]);
      if (out.disposition !== "committed" && out.disposition !== "replayed")
        fail();
      if (
        out.threadId !== request.input.threadId ||
        out.bindingRevision !== request.input.expectedBindingRevision
      )
        fail();
      return Object.freeze({
        disposition: out.disposition as "committed" | "replayed",
        threadId: parseProjectTextId(out.threadId),
        threadRevision:
          out.threadRevision === request.input.expectedThreadRevision + 1
            ? integer(out.threadRevision)
            : fail(),
        runId: parseProjectTextId(out.runId),
        runRevision: integer(out.runRevision),
        bindingRevision: integer(out.bindingRevision),
        stageAdmissionDigest: digest(out.stageAdmissionDigest),
      });
    }
    if (
      request.action === PROJECT_CONVERSATIONS_METHOD_ACTIONS.listConversations
    ) {
      const out = pluginUiFields(v, ["bindings", "nextThreadId"]);
      if (
        !Array.isArray(out.bindings) ||
        out.bindings.length > request.input.limit
      )
        fail();
      const bindings = (out.bindings as unknown[]).map(
        parsePublicProjectConversationBinding,
      );
      if (
        bindings.some((x) => x.projectId !== request.input.projectId) ||
        new Set(bindings.map((x) => x.threadId)).size !== bindings.length ||
        bindings.some((x, index) => {
          const previous =
            index === 0
              ? request.input.afterThreadId
              : bindings[index - 1]!.threadId;
          return previous !== null && compareUtf8(x.threadId, previous) <= 0;
        })
      )
        fail();
      const nextThreadId =
        out.nextThreadId === null ? null : parseProjectTextId(out.nextThreadId);
      if (nextThreadId !== null && nextThreadId !== bindings.at(-1)?.threadId)
        fail();
      return Object.freeze({ bindings: Object.freeze(bindings), nextThreadId });
    }
    const read =
        request.action === PROJECT_CONVERSATIONS_METHOD_ACTIONS.getBinding ||
        request.action ===
          PROJECT_CONVERSATIONS_METHOD_ACTIONS.openConversation,
      out = pluginUiFields(v, read ? ["binding"] : ["disposition", "binding"]);
    if (out.binding === null) {
      if (request.action !== PROJECT_CONVERSATIONS_METHOD_ACTIONS.getBinding)
        fail();
      return Object.freeze({ binding: null });
    }
    const binding = parsePublicProjectConversationBinding(out.binding);
    if (
      ("projectId" in b && binding.projectId !== b.projectId) ||
      ("threadId" in b && binding.threadId !== b.threadId)
    )
      fail();
    if (read) return Object.freeze({ binding });
    if (out.disposition !== "committed" && out.disposition !== "replayed")
      fail();
    if (
      "expectedBindingRevision" in b &&
      binding.revision !== b.expectedBindingRevision + 1
    )
      fail();
    if (
      request.action ===
        PROJECT_CONVERSATIONS_METHOD_ACTIONS.createConversation &&
      (binding.revision !== 1 ||
        binding.workspaceId !== request.input.workspaceId)
    )
      fail();
    if (
      request.action === PROJECT_CONVERSATIONS_METHOD_ACTIONS.setState &&
      binding.state !== request.input.state
    )
      fail();
    return Object.freeze({
      disposition: out.disposition as "committed" | "replayed",
      binding,
    });
  });
}
export const projectConversationsCodec: ProjectConversationsCodec =
  Object.freeze({
    parseRequest: parseProjectConversationsActionRequest,
    parseResponse: parseProjectConversationsActionResponse,
  });

function compareUtf8(a: string, b: string): number {
  const x = new TextEncoder().encode(a),
    y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++)
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}
