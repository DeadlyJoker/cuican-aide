import type { Turn } from "@crewon-protocol/v2/Turn";

export type OfficeMessageSubmitMention = {
  memberId: string;
};

export type OfficeMessageProcessingPhase =
  | "reserved"
  | "dispatching"
  | "recovering";

export type OfficeMessageSubmitDelivery =
  | {
      type: "processing";
      phase: OfficeMessageProcessingPhase;
      retryAfterMs: number;
    }
  | {
      type: "runStarted";
      runId: string;
      threadId: string;
      turn: Turn;
    }
  | {
      type: "interactionStarted";
      interactionId: string;
      threadId: string;
      turn: Turn;
    }
  | {
      type: "steered";
      runId: string;
      threadId: string;
      turnId: string;
    }
  | {
      type: "queued";
      afterRunId: string;
      position: number;
    }
  | {
      type: "answered";
      interactionId: string;
      threadId: string;
      turnId: string;
    }
  | {
      type: "failed";
      code: string;
      message: string;
      retryable: boolean;
    };

export type PendingOfficeMessageDelivery = Extract<
  OfficeMessageSubmitDelivery,
  { type: "processing" | "queued" }
>;

export type OfficeMessageSendResult = {
  delivery: OfficeMessageSubmitDelivery | null;
  disposition: "clearOutbox" | "retainOutbox";
};
