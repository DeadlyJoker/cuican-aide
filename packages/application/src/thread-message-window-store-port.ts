import type { ThreadState } from "@crewon/domain";
import type {
  MessageRecord,
  ThreadScopedLocator,
} from "./thread-store-port.ts";

export type ThreadMessageWindowPosition = Readonly<{
  direction: "older" | "newer";
  messageSequence: number;
  threadRevision: number;
}>;

export type ThreadMessageWindowQuery = ThreadScopedLocator &
  Readonly<{
    /** null reads the newest standard-view messages. Positions are exclusive. */
    position: ThreadMessageWindowPosition | null;
    limit: number;
    /** Transcript reads resolve immutable message/Run evidence in the same snapshot. */
    view?: "messages" | "transcript";
  }>;

export type ThreadMessageWindow = Readonly<{
  thread: ThreadState;
  /** Always ascending; a page may start or end within one logical turn. */
  messages: readonly MessageRecord[];
  hasOlder: boolean;
  hasNewer: boolean;
  runBindings?: readonly ThreadMessageRunBinding[];
}>;

export type ThreadMessageRunBinding = Readonly<{
  messageId: string;
  runId: string | null;
  source: "turnStartReceipt" | "messageCompletedEvent" | "unassociated";
}>;

export interface ThreadMessageWindowStore {
  /** Scope, revision, message visibility and navigation share one short snapshot. */
  readWindow(query: ThreadMessageWindowQuery): Promise<ThreadMessageWindow>;
}
