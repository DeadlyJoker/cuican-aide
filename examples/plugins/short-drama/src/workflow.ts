import portrait from "./templates/krea2-portrait.api.json" with { type: "json" };
import character from "./templates/krea2-character-three-view.api.json" with { type: "json" };
import {
  renderComfyApiGraph,
  validateComfyApiGraph,
  type ComfyApiGraph,
  type ComfyApiGraphOptions,
} from "../build-support/comfyui-api-workflow-validation.mjs";

export type KreaPreset = "krea2-portrait" | "krea2-character-three-view";

const portraitOptions: ComfyApiGraphOptions = Object.freeze({
  outputNodeId: "29",
  prompt: Object.freeze({ nodeId: "51", input: "text" }),
  outputPrefix: Object.freeze({ nodeId: "29", input: "filename_prefix" }),
});
const characterOptions: ComfyApiGraphOptions = Object.freeze({
  outputNodeId: "29",
  prompt: Object.freeze({ nodeId: "121", input: "prompt" }),
  outputPrefix: Object.freeze({ nodeId: "29", input: "filename_prefix" }),
});
const templates: Readonly<
  Record<
    KreaPreset,
    Readonly<{
      graph: ComfyApiGraph;
      options: ComfyApiGraphOptions;
    }>
  >
> = Object.freeze({
  "krea2-portrait": Object.freeze({
    graph: validateComfyApiGraph(portrait, portraitOptions),
    options: portraitOptions,
  }),
  "krea2-character-three-view": Object.freeze({
    graph: validateComfyApiGraph(character, characterOptions),
    options: characterOptions,
  }),
});

/** No default or inference from a prompt: this is the original Run's saved configuration. */
export function parseKreaPreset(input: unknown): KreaPreset {
  if (input !== "krea2-portrait" && input !== "krea2-character-three-view")
    throw new Error("krea_plugin_configuration_invalid");
  return input;
}

/** Full reviewed graphs stay fixed, including T04's original random-seed sentinel. */
export function krea2Workflow(
  prompt: string,
  operationId: string,
  preset: KreaPreset,
): ComfyApiGraph {
  if (
    typeof prompt !== "string" ||
    !prompt.trim() ||
    prompt.length > 2_000 ||
    /[\ud800-\udfff]/u.test(prompt) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(prompt)
  )
    throw new Error("comfy_prompt_invalid");
  if (!/^[a-f0-9-]{36}$/u.test(operationId))
    throw new Error("comfy_operation_id_invalid");
  const template = templates[parseKreaPreset(preset)];
  return renderComfyApiGraph(template.graph, template.options, {
    prompt,
    outputPrefix: `crewon-${operationId}`,
  });
}
