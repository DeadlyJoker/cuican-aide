import type { ExtensionRunBinding, WorkflowSchemaValue } from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";

export type ExtensionGenerationCreditQuote = Readonly<{
  poolId: string;
  priceRevision: number;
  quotedCredits: string;
}>;

/** Only a trusted server price policy supplies quotes; no quote fields are accepted in task HTTP input. */
export interface ExtensionCreditQuotePort {
  quoteGeneration(
    input: Readonly<{
      actor: ActorContext;
      binding: ExtensionRunBinding;
      input: WorkflowSchemaValue;
      commandRequestDigest: string;
    }>,
  ): Promise<ExtensionGenerationCreditQuote>;
}
