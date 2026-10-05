import type {
  ExtensionRunBinding,
  WorkflowSchemaValue,
  ProjectStageRunAdmission,
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

/** Only a trusted server price policy supplies quotes; no quote fields are accepted in task HTTP input. */
export interface ExtensionCreditQuotePort {
  quoteGeneration(
    input: ExtensionGenerationCreditQuoteRequest,
  ): Promise<ExtensionGenerationCreditQuote>;
  /** Explicit plain-message stage pricing; a legacy quote cannot silently price this different input binding. */
  quoteProjectConversationGeneration?(
    input: ProjectConversationGenerationCreditQuoteRequest,
  ): Promise<ExtensionGenerationCreditQuote>;
}
