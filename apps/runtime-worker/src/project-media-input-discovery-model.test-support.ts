import assert from "node:assert/strict";
import type { ModelTransportPort, ModelRequest } from "@crewon/agent-kernel";
import type {
  ProjectAssetToolHead,
  ProjectAssetToolsResponses,
} from "@crewon/contracts/project-asset-tools";
import type {
  MediaInputToolResponses,
  MediaInputToolRequests,
} from "@crewon/contracts/project-media-input-tools";

type Call = { callId: string; operation: string; input: unknown };
/** This named model derives every business identity and reference revision solely from actual tool results. */
export function mediaInputDiscoveryModel(): ModelTransportPort {
  return {
    adapterName: "named-media-input-discovery-model",
    adapterVersion: "1",
    modelId: "fixture-discovery",
    async *stream(request) {
      const next = nextDiscoveryCall(request);
      if (next)
        yield {
          type: "tool.call",
          kind: "function",
          callId: next.callId,
          name: `crewon_short_drama__${next.operation}`,
          input: JSON.stringify(next.input),
        };
      else {
        yield { type: "output.delta", delta: "已读取剧本和已采用素材，" };
        yield {
          type: "output.delta",
          delta: "生成输入已保存，可继续手动调整。",
        };
      }
      yield { type: "completed", checkpoint: null };
    },
  };
}
function nextDiscoveryCall(request: ModelRequest): Call | null {
  const results = new Map(
    request.input.items
      .filter((i) => i.type === "tool_result")
      .map((i) => [i.callId, JSON.parse(JSON.parse(i.output).resultJson)]),
  );
  const call = (callId: string, operation: string, input: unknown): Call => ({
    callId,
    operation,
    input,
  });
  const media = (method: string, body: unknown) =>
    call(method, "media_input", { method, requestJson: JSON.stringify(body) });
  if (!results.has("getContext")) return media("getContext", {});
  const scope = results.get(
    "getContext",
  ) as MediaInputToolResponses["getContext"];
  const projectId = scope.projectId;
  if (!results.has("project"))
    return call("project", "project_read", { projectId });
  if (!results.has("outline"))
    return call("outline", "outline_read", { projectId });
  if (scope.script && !results.has("script"))
    return call("script", "script_read", {
      projectId,
      episodeId: scope.script.episodeId,
    });
  const chunks = (
    prefix: string,
    operation: string,
    input: unknown,
  ): Call | string => {
    let text = "",
      offset = 0,
      contentDigest: string | undefined;
    for (let n = 0; n < 32; n++) {
      const id = `${prefix}-${offset}`;
      if (!results.has(id))
        return call(id, operation, { ...(input as object), offset });
      const value = results.get(id) as {
        contentDigest: string;
        offset: number;
        text: string;
        nextOffset: number | null;
      };
      assert.equal(value.offset, offset);
      if (contentDigest !== undefined)
        assert.equal(value.contentDigest, contentDigest);
      contentDigest = value.contentDigest;
      text += value.text;
      if (value.nextOffset === null) return text;
      assert.ok(value.nextOffset > offset);
      offset = value.nextOffset;
    }
    throw Error("named_discovery_chunk_limit");
  };
  const brief = chunks("brief", "content_read", {
    projectId,
    source: { kind: "brief", briefRevision: scope.briefRevision },
  });
  if (typeof brief !== "string") return brief;
  if (scope.script) {
    const script = chunks("script-text", "content_read", {
      projectId,
      source: {
        kind: "text",
        artifactId: scope.script.artifactId,
        contentRevision: scope.script.contentRevision,
      },
    });
    if (typeof script !== "string") return script;
    if (!results.has("text-history"))
      return call("text-history", "text_history", {
        projectId,
        artifactId: scope.script.artifactId,
        afterContentRevision: 0,
        limit: 4,
      });
  }
  const kinds =
    scope.workflowId === "krea2-reference-four-view"
      ? (["character"] as const)
      : (["character", "scene"] as const);
  const heads: ProjectAssetToolHead[] = [];
  for (const kind of kinds) {
    let afterAssetId: string | null = null;
    for (let n = 0; n < 16; n++) {
      const id = `list-${kind}-${n}`;
      if (!results.has(id))
        return call(id, "asset_list", {
          projectId,
          kind,
          afterAssetId,
          limit: 1,
        });
      const page = results.get(id) as ProjectAssetToolsResponses["listAssets"];
      heads.push(...page.assets);
      if (page.nextAssetId === null) break;
      afterAssetId = page.nextAssetId;
      assert.ok(n < 15);
    }
  }
  const selected: ProjectAssetToolHead[] = [];
  const names: string[] = [];
  for (const h of heads) {
    const id = `asset-${h.assetId}`;
    if (!results.has(id))
      return call(id, "asset_read", { projectId, assetId: h.assetId });
    const { view } = results.get(id) as ProjectAssetToolsResponses["getAsset"];
    if (
      !view ||
      view.referenceState !== "current" ||
      view.dependencyState !== "current"
    )
      continue;
    assert.ok(
      view.asset.selectedContentRevision &&
        view.asset.selectedReferenceRevision,
    );
    const body = chunks(`asset-text-${h.assetId}`, "asset_content_read", {
      projectId,
      assetId: h.assetId,
      contentRevision: view.asset.selectedContentRevision,
    });
    if (typeof body !== "string") return body;
    const content = JSON.parse(body) as { name: string };
    names.push(content.name);
    selected.push(view.asset);
  }
  assert.ok(selected.length);
  if (!results.has("asset-history"))
    return call("asset-history", "asset_history", {
      projectId,
      assetId: selected[0]!.assetId,
      afterContentRevision: 0,
      limit: 4,
    });
  if (!results.has("getOptions")) return media("getOptions", { projectId });
  if (!results.has("saveInput")) {
    const characters = selected.filter((h) => h.kind === "character"),
      scene = selected.find((h) => h.kind === "scene"),
      first = characters[0]!;
    assert.ok(first);
    const reference = (h: ProjectAssetToolHead) => ({
      projectId,
      assetId: h.assetId,
      kind: h.kind as "character" | "scene",
      expectedAssetRevision: h.revision,
      contentRevision: h.selectedContentRevision!,
      referenceRevision: h.selectedReferenceRevision!,
    });
    const four = scope.workflowId === "krea2-reference-four-view";
    if (!four) assert.ok(scene && characters[1]);
    const save: MediaInputToolRequests["saveInput"] = {
      projectId,
      mediaInputId: null,
      expectedInputRevision: 0,
      item: four
        ? { kind: "character-reference", assetId: first.assetId }
        : {
            kind: "storyboard-frame-exploration",
            episodeId: scope.script!.episodeId,
          },
      briefRevision: scope.briefRevision,
      script: scope.script
        ? {
            artifactId: scope.script.artifactId,
            contentRevision: scope.script.contentRevision,
          }
        : null,
      workflowId: scope.workflowId,
      configurationRevision: scope.configurationRevision,
      prompt: `${brief.slice(0, 80)}。依据已采用设定：${names.join("、")}，保持角色与场景一致。`,
      references: four
        ? { character: reference(first) }
        : {
            scene: reference(scene!),
            characterOne: reference(first),
            characterTwo: reference(characters[1]!),
          },
    };
    return media("saveInput", save);
  }
  const saved = results.get(
    "saveInput",
  ) as MediaInputToolResponses["saveInput"];
  const query = {
    projectId,
    mediaInputId: saved.input.mediaInputId,
    inputRevision: 1,
  };
  if (!results.has("getInput")) return media("getInput", query);
  if (!results.has("readPrompt"))
    return media("readPrompt", { ...query, offset: 0 });
  if (!results.has("listInputs"))
    return media("listInputs", {
      projectId,
      afterMediaInputId: null,
      limit: 4,
    });
  return null;
}

/** Only the requested operation is injected; ids still come from the real getContext result. */
export function mediaInputReadProbe(
  operation: string,
  request: (scope: MediaInputToolResponses["getContext"]) => unknown,
): ModelTransportPort {
  return {
    adapterName: "named-media-input-read-probe",
    adapterVersion: "1",
    modelId: "fixture-read-probe",
    async *stream(r) {
      const context = r.input.items.find(
        (i) => i.type === "tool_result" && i.callId === "getContext",
      );
      if (!context || context.type !== "tool_result")
        yield {
          type: "tool.call",
          kind: "function",
          callId: "getContext",
          name: "crewon_short_drama__media_input",
          input: JSON.stringify({ method: "getContext", requestJson: "{}" }),
        };
      else if (
        !r.input.items.some(
          (i) => i.type === "tool_result" && i.callId === "probe",
        )
      )
        yield {
          type: "tool.call",
          kind: "function",
          callId: "probe",
          name: `crewon_short_drama__${operation}`,
          input: JSON.stringify(
            request(JSON.parse(JSON.parse(context.output).resultJson)),
          ),
        };
      else yield { type: "output.delta", delta: "read completed" };
      yield { type: "completed", checkpoint: null };
    },
  };
}
