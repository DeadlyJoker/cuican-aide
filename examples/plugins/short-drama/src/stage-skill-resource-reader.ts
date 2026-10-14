import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import {
  SHUOHAO_RESOURCE_FILES,
  SHUOHAO_SKILLS_REVISION,
  type ShortDramaStageSkill,
} from "./stage-skill-resources.js";

export type StageSkillResourceRequest = {
  path: string;
  startOffset: number;
  limit: number;
};

/** Read-only resource adapter for a future host-authorized stage read. The
 * caller must derive activeSkill from an actual host scope; this is not a
 * project tool, command runner, ambient file reader, or authority issuer.
 */
export function createStageSkillResourceReader(resourceDirectory: URL) {
  if (
    resourceDirectory.protocol !== "file:" ||
    !resourceDirectory.pathname.endsWith("/") ||
    resourceDirectory.search ||
    resourceDirectory.hash
  )
    throw new Error("short_drama_skill_resource_directory_invalid");

  return async (
    activeSkill: ShortDramaStageSkill,
    request: StageSkillResourceRequest,
  ) => {
    if (
      !request ||
      Object.keys(request).length !== 3 ||
      !Object.hasOwn(request, "path") ||
      !Object.hasOwn(request, "startOffset") ||
      !Object.hasOwn(request, "limit") ||
      !Number.isSafeInteger(request.startOffset) ||
      request.startOffset < 0 ||
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 1024
    )
      throw new Error("short_drama_skill_resource_request_invalid");

    const resource = SHUOHAO_RESOURCE_FILES.find(
      (file) => file.skill === activeSkill && file.path === request.path,
    );
    if (!resource) throw new Error("short_drama_skill_resource_scope_denied");
    const path = new URL(resource.path, resourceDirectory);
    if (!(await lstat(path)).isFile())
      throw new Error("short_drama_skill_resource_not_regular");
    const bytes = await readFile(path);
    if (
      bytes.byteLength !== resource.byteLength ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
        resource.sha256
    )
      throw new Error("short_drama_skill_resource_integrity_mismatch");

    const content = Array.from(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (request.startOffset > content.length)
      throw new Error("short_drama_skill_resource_page_range_invalid");
    const endOffset = Math.min(
      request.startOffset + request.limit,
      content.length,
    );
    return {
      skill: activeSkill,
      revision: SHUOHAO_SKILLS_REVISION,
      path: resource.path,
      sha256: resource.sha256,
      startOffset: request.startOffset,
      endOffset,
      characterLength: content.length,
      content: content.slice(request.startOffset, endOffset).join(""),
      nextOffset: endOffset < content.length ? endOffset : null,
      qualityChecks: "not-run" as const,
    };
  };
}
