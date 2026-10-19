import type { ConceptRecoveryContexts } from "./ConceptRecoveryCoordinator";

export type OtherProjectRecovery = Readonly<{
  projectId: string;
}>;

/** A host page chooses its project; global journals remain owned by the host. */
export function projectRecoveryProjection(
  projectId: string | null,
  contexts: ConceptRecoveryContexts,
): Readonly<{
  contexts: ConceptRecoveryContexts;
  otherProjects: readonly OtherProjectRecovery[];
}> {
  const otherProjects: OtherProjectRecovery[] = [];
  for (const lane of [
    "generation",
    "query",
    "historicalQuery",
    "selection",
  ] as const) {
    const intent = contexts[lane]?.intent;
    if (projectId && intent && intent.request.reference.projectId !== projectId)
      if (
        !otherProjects.some(
          (record) => record.projectId === intent.request.reference.projectId,
        )
      )
        otherProjects.push({ projectId: intent.request.reference.projectId });
  }
  function scoped<
    T extends {
      intent: {
        phase: "pending" | "uncertain" | "accepted" | "refused";
        request: { reference: { projectId: string }; threadId?: string };
      } | null;
      thread?: { threadId: string } | null;
    },
  >(context: T | null | undefined): T | null {
    const intent = context?.intent;
    if (
      !projectId ||
      !context ||
      !intent ||
      intent.request.reference.projectId === projectId
    )
      return context ?? null;
    // Unresolved lanes retain the original request's conversation. A terminal
    // lane instead carries Main's current selectedThread/readiness: preserve
    // that verified projection, never borrow the original request's thread.
    if (
      intent.phase === "pending" ||
      intent.phase === "uncertain" ||
      (intent.request.threadId !== undefined &&
        context.thread?.threadId === intent.request.threadId)
    )
      return null;
    return { ...context, intent: null };
  }
  return {
    contexts: {
      generation: scoped(contexts.generation),
      query: scoped(contexts.query),
      historicalQuery: scoped(contexts.historicalQuery),
      selection: scoped(contexts.selection),
    },
    otherProjects,
  };
}
