import { creativeControlQuery } from "./creative-project-control-support.ts";
import { ProjectAssetStagesContractError } from "./project-asset-stages-contract.ts";
import {
  assetContractCopy as copy,
  assetContractRecord as record,
  assetContractId as id,
  assetContractRevision as revision,
} from "./project-asset-contract-support.ts";

export const MAX_PROJECT_ASSET_SCRIPT_SOURCE_BYTES = 4096;
export type ProjectAssetScriptSourceRequest = Readonly<{
  projectId: string;
  threadId: string;
  expectedBindingRevision: number;
  briefRevision: number;
  episodeId: string;
}>;
export type ProjectAssetScriptSourceResponse = Readonly<{
  projectId: string;
  threadId: string;
  bindingRevision: number;
  briefRevision: number;
  episodeId: string;
  script: Readonly<{
    artifactId: string;
    episodeId: string;
    contentRevision: number;
  }> | null;
}>;
function checked<T>(work: () => T): T {
  try {
    return work();
  } catch {
    throw new ProjectAssetStagesContractError();
  }
}
export function parseProjectAssetScriptSourceRequest(
  input: unknown,
): ProjectAssetScriptSourceRequest {
  return checked(() => {
    const v = record(copy(input, MAX_PROJECT_ASSET_SCRIPT_SOURCE_BYTES), [
      "projectId",
      "threadId",
      "expectedBindingRevision",
      "briefRevision",
      "episodeId",
    ]);
    return Object.freeze({
      projectId: id(v.projectId),
      threadId: id(v.threadId),
      expectedBindingRevision: revision(v.expectedBindingRevision),
      briefRevision: revision(v.briefRevision),
      episodeId: id(v.episodeId),
    });
  });
}
export function parseProjectAssetScriptSourceResponse(
  requestInput: ProjectAssetScriptSourceRequest,
  input: unknown,
): ProjectAssetScriptSourceResponse {
  return checked(() => {
    const r = parseProjectAssetScriptSourceRequest(requestInput),
      v = record(copy(input, MAX_PROJECT_ASSET_SCRIPT_SOURCE_BYTES), [
        "projectId",
        "threadId",
        "bindingRevision",
        "briefRevision",
        "episodeId",
        "script",
      ]);
    if (
      v.projectId !== r.projectId ||
      v.threadId !== r.threadId ||
      v.bindingRevision !== r.expectedBindingRevision ||
      v.briefRevision !== r.briefRevision ||
      v.episodeId !== r.episodeId
    )
      throw new Error();
    const s =
      v.script === null
        ? null
        : record(v.script, ["artifactId", "episodeId", "contentRevision"]);
    if (s !== null && s.episodeId !== r.episodeId) throw new Error();
    return Object.freeze({
      projectId: r.projectId,
      threadId: r.threadId,
      bindingRevision: r.expectedBindingRevision,
      briefRevision: r.briefRevision,
      episodeId: r.episodeId,
      script:
        s === null
          ? null
          : Object.freeze({
              artifactId: id(s.artifactId),
              episodeId: id(s.episodeId),
              contentRevision: revision(s.contentRevision),
            }),
    });
  });
}
export function projectAssetScriptSourcePath(
  input: ProjectAssetScriptSourceRequest,
): string {
  const r = parseProjectAssetScriptSourceRequest(input);
  const query = new URLSearchParams({
    projectId: r.projectId,
    expectedBindingRevision: String(r.expectedBindingRevision),
    briefRevision: String(r.briefRevision),
    episodeId: r.episodeId,
  });
  return `/api/v1/threads/${encodeURIComponent(r.threadId)}/project-asset-stage/script-source?${query}`;
}
export function parseProjectAssetScriptSourceQuery(
  threadId: string,
  input: unknown,
): ProjectAssetScriptSourceRequest {
  return checked(() => {
    const v = record(
      copy(
        creativeControlQuery(input, [
          "projectId",
          "expectedBindingRevision",
          "briefRevision",
          "episodeId",
        ]),
        MAX_PROJECT_ASSET_SCRIPT_SOURCE_BYTES,
      ),
      ["projectId", "expectedBindingRevision", "briefRevision", "episodeId"],
    );
    const number = (v: unknown) => {
      if (typeof v !== "string" || !/^[1-9][0-9]{0,15}$/u.test(v))
        throw new Error();
      return Number(v);
    };
    return parseProjectAssetScriptSourceRequest({
      ...v,
      threadId,
      expectedBindingRevision: number(v.expectedBindingRevision),
      briefRevision: number(v.briefRevision),
    });
  });
}
