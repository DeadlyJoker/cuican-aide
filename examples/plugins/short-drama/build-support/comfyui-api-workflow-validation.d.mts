export type ComfyJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ComfyJsonValue[]
  | { readonly [key: string]: ComfyJsonValue };

export type ComfyApiNode = Readonly<{
  class_type: string;
  inputs: Readonly<Record<string, ComfyJsonValue>>;
  _meta?: Readonly<Record<string, ComfyJsonValue>>;
}>;

export type ComfyApiGraph = Readonly<Record<string, ComfyApiNode>>;

export type ComfyApiGraphOptions = Readonly<{
  outputNodeId: string;
  prompt: Readonly<{ nodeId: string; input: string }>;
  outputPrefix: Readonly<{ nodeId: string; input: string }>;
  objectInfo?: Readonly<
    Record<string, Readonly<{ output: readonly unknown[] }>>
  >;
}>;

export function validateComfyApiGraph(
  graph: unknown,
  options: ComfyApiGraphOptions,
): ComfyApiGraph;

export function renderComfyApiGraph(
  graph: unknown,
  options: ComfyApiGraphOptions,
  values: Readonly<{ prompt: string; outputPrefix: string }>,
): ComfyApiGraph;
