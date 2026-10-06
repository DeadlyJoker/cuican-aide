/** Compatibility entrypoint; Control API and Native Worker use the same provider decoder. */
export {
  createComfyUiProjectGenerationImageResultVerifier,
  decodeComfyUiImages,
  type VerifiedComfyUiImage,
  type ComfyUiResultIdentity,
} from "@crewon/artifacts";
