import type { ControlApiClient } from "@crewon/control-client";
import type { CreateKnowledgeRequest, KnowledgeView } from "@crewon/contracts";

export const CONTROL_KNOWLEDGE_PAGE_SIZE = 100;
export const CONTROL_KNOWLEDGE_MAX_PAGES = 5;
export const CONTROL_KNOWLEDGE_MAX_ITEMS = 500;

export type ControlKnowledgeCollection = {
  data: KnowledgeView[];
  truncated: boolean;
};

export type CreateControlKnowledgeInput = CreateKnowledgeRequest & {
  idempotencyKey: string;
};

export class ControlKnowledgeLibraryError extends Error {
  readonly operation: "list" | "read" | "create";

  constructor(operation: "list" | "read" | "create", options?: ErrorOptions) {
    super(`Control Knowledge ${operation} failed`, options);
    this.name = "ControlKnowledgeLibraryError";
    this.operation = operation;
  }
}

export async function listControlKnowledge(
  client: ControlApiClient,
): Promise<ControlKnowledgeCollection> {
  try {
    const data: KnowledgeView[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    for (let page = 0; page < CONTROL_KNOWLEDGE_MAX_PAGES; page += 1) {
      const response = await client.listKnowledge(
        cursor === null
          ? { limit: CONTROL_KNOWLEDGE_PAGE_SIZE }
          : { cursor, limit: CONTROL_KNOWLEDGE_PAGE_SIZE },
      );
      data.push(
        ...response.data.slice(
          0,
          Math.max(0, CONTROL_KNOWLEDGE_MAX_ITEMS - data.length),
        ),
      );

      if (response.nextCursor === null) {
        return { data, truncated: false };
      }
      if (
        data.length >= CONTROL_KNOWLEDGE_MAX_ITEMS ||
        seenCursors.has(response.nextCursor)
      ) {
        return { data, truncated: true };
      }
      seenCursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }

    return { data, truncated: true };
  } catch (error) {
    throw new ControlKnowledgeLibraryError("list", { cause: error });
  }
}

export async function readControlKnowledge(
  client: ControlApiClient,
  knowledgeId: string,
): Promise<KnowledgeView> {
  try {
    const response = await client.getKnowledge(requireValue(knowledgeId));
    return response.knowledge;
  } catch (error) {
    throw new ControlKnowledgeLibraryError("read", { cause: error });
  }
}

export async function createControlKnowledge(
  client: ControlApiClient,
  input: CreateControlKnowledgeInput,
): Promise<KnowledgeView> {
  try {
    const response = await client.createKnowledge(
      {
        kind: input.kind,
        sourceId: requireValue(input.sourceId),
        title: requireValue(input.title),
        content: requireValue(input.content),
      },
      requireValue(input.idempotencyKey),
    );
    return response.knowledge;
  } catch (error) {
    throw new ControlKnowledgeLibraryError("create", { cause: error });
  }
}

function requireValue(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("A required Knowledge value is empty");
  return normalized;
}
