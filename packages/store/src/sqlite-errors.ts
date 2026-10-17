import { RunStoreError } from "@crewon/application";
import {
  ThreadGoalError,
  RunLifecycleError,
  ThreadLifecycleError,
} from "@crewon/domain";

export function normalizeSqliteError(error: unknown): Error {
  if (error instanceof ThreadGoalError) {
    return new RunStoreError(error.code, { cause: error });
  }
  if (
    error instanceof RunStoreError ||
    error instanceof RunLifecycleError ||
    error instanceof ThreadLifecycleError
  ) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    message === "run_output_replay_requires_stream_append" ||
    message === "outbox_message_conflict"
  ) {
    return new RunStoreError(message, { cause: error });
  }
  if (/busy|locked/i.test(message)) {
    return new RunStoreError("sqlite_busy", { cause: error });
  }
  if (/constraint/i.test(message)) {
    return new RunStoreError("sqlite_constraint", { cause: error });
  }
  return new RunStoreError("sqlite_error", { cause: error });
}
