import {
  parseGenerateProjectMediaRequest,
  parseGenerateProjectMediaResponse,
} from "./project-media-generations.ts";
import { parseProjectMediaGenerationRecoveryResponse } from "./project-media-generation-recovery.ts";
export const mediaGenerationCodec = Object.freeze({
  parseGenerateProjectMediaRequest,
  parseGenerateProjectMediaResponse,
  parseProjectMediaGenerationRecoveryResponse,
});
