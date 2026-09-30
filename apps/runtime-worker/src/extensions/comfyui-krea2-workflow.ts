/** Reviewed graph from the supplied T01 workflow; only prompt and host-owned output prefix vary. */
export function krea2Workflow(prompt: string, operationId: string) {
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
  return {
    "29": {
      class_type: "SaveImage",
      inputs: { filename_prefix: `crewon-${operationId}`, images: ["54", 0] },
    },
    "49": {
      class_type: "ResolutionSelector",
      inputs: {
        aspect_ratio: "9:16 (Portrait Widescreen)",
        megapixels: 1,
        multiple: 8,
      },
    },
    "51": {
      class_type: "CLIPTextEncode",
      inputs: { text: prompt, clip: ["56", 0] },
    },
    "52": {
      class_type: "EmptyLatentImage",
      inputs: { width: ["49", 0], height: ["49", 1], batch_size: 1 },
    },
    "53": {
      class_type: "KSampler",
      inputs: {
        seed: 769068639772876,
        steps: 8,
        cfg: 1,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1,
        model: ["55", 0],
        positive: ["51", 0],
        negative: ["58", 0],
        latent_image: ["52", 0],
      },
    },
    "54": {
      class_type: "VAEDecode",
      inputs: { samples: ["53", 0], vae: ["57", 0] },
    },
    "55": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "krea2/darkBeastINT8Convrot2_krea211INT8Convrot.safetensors",
        weight_dtype: "default",
      },
    },
    "56": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: "qwen3vl_4b_uncensored_int8_convrot.safetensors",
        type: "krea2",
        device: "default",
      },
    },
    "57": {
      class_type: "VAELoader",
      inputs: { vae_name: "qwen_image_vae.safetensors" },
    },
    "58": {
      class_type: "ConditioningZeroOut",
      inputs: { conditioning: ["51", 0] },
    },
    // The original LoRA node is unconnected; do not silently change the user's model graph.
    "87": {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        lora_name: "krea2/krea2_darkbrush.safetensors",
        strength_model: 1,
        model: ["55", 0],
      },
    },
  };
}
