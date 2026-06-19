import { capabilityAccents } from "../agent-config/agentConfigDefaults";
import type {
  KnowledgeData,
  KnowledgeEntry,
  KnowledgeSource,
  LibraryAccent,
} from "./crewonDomain";

// Keep backend knowledge cards visually aligned with curated demo data when
// the backend omits presentation fields.
const MEMORY_GLYPHS = ["◆", "★", "✓", "▣", "◐"];
const SOURCE_GLYPHS = ["▦", "▤", "◍", "◎", "▥"];

export function normalizeKnowledgeData(data: unknown): KnowledgeData {
  const value = data as
    | { memories?: unknown; sources?: unknown }
    | null
    | undefined;
  const memories = Array.isArray(value?.memories) ? value.memories : [];
  const sources = Array.isArray(value?.sources) ? value.sources : [];
  return {
    memories: memories
      .filter((entry) => Boolean(entry))
      .map((entry, index): KnowledgeEntry => {
        const memory = entry as Partial<KnowledgeEntry>;
        return {
          title:
            typeof memory.title === "string" && memory.title.trim()
              ? memory.title
              : `Memory ${index + 1}`,
          glyph:
            typeof memory.glyph === "string" && memory.glyph.trim()
              ? memory.glyph
              : MEMORY_GLYPHS[index % MEMORY_GLYPHS.length],
          accent: normalizeLibraryAccent(memory.accent, index),
          kind:
            typeof memory.kind === "string" && memory.kind.trim()
              ? memory.kind
              : "Workspace memory",
          preview: typeof memory.preview === "string" ? memory.preview : "",
          meta: typeof memory.meta === "string" ? memory.meta : "",
          path: typeof memory.path === "string" ? memory.path : undefined,
          threadId:
            typeof memory.threadId === "string" ? memory.threadId : undefined,
          pinned: Boolean(memory.pinned),
        };
      }),
    sources: sources
      .filter((source) => Boolean(source))
      .map((source, index): KnowledgeSource => {
        const knowledgeSource = source as Partial<KnowledgeSource>;
        return {
          name:
            typeof knowledgeSource.name === "string" &&
            knowledgeSource.name.trim()
              ? knowledgeSource.name
              : `Source ${index + 1}`,
          glyph:
            typeof knowledgeSource.glyph === "string" &&
            knowledgeSource.glyph.trim()
              ? knowledgeSource.glyph
              : SOURCE_GLYPHS[index % SOURCE_GLYPHS.length],
          accent: normalizeLibraryAccent(knowledgeSource.accent, index + 1),
          status: normalizeKnowledgeSourceStatus(knowledgeSource.status),
          meta:
            typeof knowledgeSource.meta === "string"
              ? knowledgeSource.meta
              : "",
          path:
            typeof knowledgeSource.path === "string"
              ? knowledgeSource.path
              : undefined,
          isDirectory: Boolean(knowledgeSource.isDirectory),
        };
      }),
  };
}

function normalizeLibraryAccent(
  accent: unknown,
  index: number,
): LibraryAccent {
  const accents = capabilityAccents();
  return typeof accent === "string" &&
    accents.includes(accent as LibraryAccent)
    ? (accent as LibraryAccent)
    : accents[index % accents.length];
}

function normalizeKnowledgeSourceStatus(
  status: unknown,
): KnowledgeSource["status"] {
  return status === "indexing" || status === "needs-auth" ? status : "indexed";
}
