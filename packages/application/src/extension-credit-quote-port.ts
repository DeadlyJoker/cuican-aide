import type {
  ExtensionRunBinding,
  WorkflowSchemaValue,
  ProjectStageRunAdmission,
  ProjectAssetStageRunAdmission,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";

export type ExtensionGenerationCreditQuote = Readonly<{
  poolId: string;
  priceRevision: number;
  quotedCredits: string;
}>;
export type ExtensionGenerationCreditQuoteRequest = Readonly<{
  actor: ActorContext;
  binding: ExtensionRunBinding;
  input: WorkflowSchemaValue;
  commandRequestDigest: string;
}>;
export type ProjectConversationGenerationCreditQuoteRequest =
  ExtensionGenerationCreditQuoteRequest &
    Readonly<{ projectStageAdmission: ProjectStageRunAdmission }>;
export type ProjectAssetStageGenerationCreditQuoteRequest =
  ExtensionGenerationCreditQuoteRequest &
    Readonly<{ projectAssetStageAdmission: ProjectAssetStageRunAdmission }>;

/** Only a trusted server price policy supplies quotes; no quote fields are accepted in task HTTP input. */
export interface ExtensionCreditQuotePort {
  quoteGeneration(
    input: ExtensionGenerationCreditQuoteRequest,
  ): Promise<ExtensionGenerationCreditQuote>;
  /** Explicit plain-message stage pricing; a legacy quote cannot silently price this different input binding. */
  quoteProjectConversationGeneration?(
    input: ProjectConversationGenerationCreditQuoteRequest,
  ): Promise<ExtensionGenerationCreditQuote>;
  /** Independent plain-message asset stage; absent support must fail closed. */
  quoteProjectAssetStageGeneration?(
    input: ProjectAssetStageGenerationCreditQuoteRequest,
  ): Promise<ExtensionGenerationCreditQuote>;
}
