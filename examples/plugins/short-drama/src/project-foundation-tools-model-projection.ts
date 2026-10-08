import type {
  ProjectFoundationToolsRequest,
  ProjectFoundationToolsResponseMap,
} from "@crewon/plugin-sdk/project-foundation-tools";
import { canonical, sha256 } from "./catalog.js";
import { foundationCreationSkill } from "./project-foundation-creation-skill.js";

/** This is a model projection, not the full host DTO. Even the whole escaped output is bounded. */
export const MAX_FOUNDATION_MODEL_OUTPUT_BYTES = 9999;

export function projectFoundationModelOutput(
  expected: ProjectFoundationToolsRequest,
  result: unknown,
): string {
  if (expected.operation === "foundation_read") {
    const foundation = (
        result as ProjectFoundationToolsResponseMap["getFoundation"]
      ).foundation,
      { parameters, ...metadata } = foundation,
      content = canonical(parameters),
      scalars = Array.from(content),
      startOffset = expected.request.parametersStartOffset ?? 0,
      limit = expected.request.parametersLimit ?? 1024;
    if (startOffset > scalars.length)
      throw new Error("short_drama_foundation_parameters_page_range_invalid");
    const endOffset = Math.min(startOffset + limit, scalars.length);
    return checkedOutput({
      foundation: metadata,
      parametersPage: {
        digest: sha256(content),
        startOffset,
        endOffset,
        content: scalars.slice(startOffset, endOffset).join(""),
        nextOffset: endOffset < scalars.length ? endOffset : null,
        characterLength: scalars.length,
      },
      projection: {
        kind: "foundation-parameters-page",
        completeParameters: startOffset === 0 && endOffset === scalars.length,
      },
    });
  }
  if (expected.operation === "foundation_chapters") {
    const page =
      result as ProjectFoundationToolsResponseMap["listSourceChapters"];
    let count = page.chapters.length;
    while (true) {
      const chapters = page.chapters.slice(0, count),
        reduced = count < page.chapters.length,
        value = {
          chapters,
          nextStartOffset: reduced
            ? chapters.at(-1)!.startOffset
            : page.nextStartOffset,
          projection: {
            kind: "bounded-chapter-page",
            requestedLimit: expected.request.limit,
            returnedCount: count,
            nativeReturnedCount: page.chapters.length,
          },
        },
        output = encodeOutput(value);
      if (Buffer.byteLength(output) <= MAX_FOUNDATION_MODEL_OUTPUT_BYTES)
        return output;
      if (count <= 1) throw new Error("short_drama_foundation_output_limit");
      count--;
    }
  }
  return checkedOutput(
    expected.operation === "foundation_scope"
      ? { ...(result as object), guidance: foundationCreationSkill() }
      : result,
  );
}

function encodeOutput(value: unknown): string {
  return JSON.stringify({ resultJsonParts: [JSON.stringify(value)] });
}
function checkedOutput(value: unknown): string {
  const output = encodeOutput(value);
  if (Buffer.byteLength(output) > MAX_FOUNDATION_MODEL_OUTPUT_BYTES)
    throw new Error("short_drama_foundation_output_limit");
  return output;
}
