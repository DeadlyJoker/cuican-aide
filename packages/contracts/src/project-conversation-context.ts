import { pluginUiFields } from "./plugin-ui-json.ts";
import { parseProjectTextId } from "./project-text-control-contract.ts";
import { parsePublicProjectConversationBinding } from "./plugin-project-conversations-contract.ts";
import type { PublicProjectConversationBinding } from "./plugin-project-conversations-service.ts";

export const MAX_PROJECT_CONVERSATION_CONTEXT_BYTES = 256 * 1024;
export type ProjectConversationContext = Readonly<{
  binding: PublicProjectConversationBinding;
  projectRevision: number;
  briefRevision: number;
  outline: Readonly<{
    artifactId: string;
    contentRevision: number;
    episodes: readonly Readonly<{ episodeId: string; title: string }>[];
  }> | null;
}>;
export type ProjectConversationContextResponse = Readonly<{
  context: ProjectConversationContext | null;
}>;
export function parseProjectConversationContextResponse(
  threadId: string,
  input: unknown,
): ProjectConversationContextResponse {
  const thread = parseProjectTextId(threadId);
  const value = pluginUiFields(input, ["context"]);
  if (value.context === null) return Object.freeze({ context: null });
  const c = pluginUiFields(value.context, [
    "binding",
    "projectRevision",
    "briefRevision",
    "outline",
  ]);
  const binding = parsePublicProjectConversationBinding(c.binding);
  if (binding.threadId !== thread || binding.state !== "active") invalid();
  const outline =
    c.outline === null
      ? null
      : pluginUiFields(c.outline, [
          "artifactId",
          "contentRevision",
          "episodes",
        ]);
  const seen = new Set<string>();
  if (
    outline !== null &&
    (!Array.isArray(outline.episodes) ||
      Object.getPrototypeOf(outline.episodes) !== Array.prototype ||
      outline.episodes.length > 240 ||
      Reflect.ownKeys(outline.episodes).length !== outline.episodes.length + 1)
  )
    invalid();
  const parsed = Object.freeze({
    context: Object.freeze({
      binding,
      projectRevision: revision(c.projectRevision, 1),
      briefRevision: revision(c.briefRevision, 0),
      outline:
        outline === null
          ? null
          : Object.freeze({
              artifactId: parseProjectTextId(outline.artifactId),
              contentRevision: revision(outline.contentRevision, 1),
              episodes: Object.freeze(
                Array.from(
                  { length: (outline.episodes as unknown[]).length },
                  (_, index) => {
                    const descriptor = Object.getOwnPropertyDescriptor(
                      outline.episodes,
                      String(index),
                    );
                    if (
                      !descriptor?.enumerable ||
                      !Object.hasOwn(descriptor, "value")
                    )
                      invalid();
                    const item: unknown = descriptor!.value;
                    const e = pluginUiFields(item, ["episodeId", "title"]);
                    const episodeId = parseProjectTextId(e.episodeId);
                    if (
                      seen.has(episodeId) ||
                      typeof e.title !== "string" ||
                      e.title.length > 640 ||
                      !e.title.trim() ||
                      new TextEncoder().encode(e.title).length > 640 ||
                      /[\u0000-\u001f\u007f]/u.test(e.title)
                    )
                      invalid();
                    seen.add(episodeId);
                    return Object.freeze({
                      episodeId,
                      title: e.title as string,
                    });
                  },
                ),
              ),
            }),
    }),
  });
  if (
    new TextEncoder().encode(JSON.stringify(parsed)).length >
    MAX_PROJECT_CONVERSATION_CONTEXT_BYTES
  )
    invalid();
  return parsed;
}
function revision(value: unknown, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    invalid();
  return value as number;
}
function invalid(): never {
  throw new Error("project_conversation_context_invalid");
}
