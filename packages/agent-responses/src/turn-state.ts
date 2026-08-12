import { protocolError } from "./responses-errors.ts";

export const TURN_STATE_HEADER = "x-codex-turn-state";
export const MAX_TURN_STATE_BYTES = 4 * 1024;
export class ResponsesTurnStateAuthority {
  readonly #states = new Map<string, string>();

  seed(runId: string, value: string | null): void {
    if (value === null) return;
    const parsed = parseTurnStateHeader([value]);
    if (parsed === null) return;
    const current = this.#states.get(runId);
    if (current !== undefined && current !== parsed) {
      throw protocolError("responses_turn_state_conflict");
    }
    this.#states.set(runId, parsed);
  }

  get(runId: string): string | null {
    return this.#states.get(runId) ?? null;
  }

  async observe(
    runId: string,
    values: readonly string[],
    persist?: (value: string) => Promise<void>,
  ): Promise<string | null> {
    const value = parseTurnStateHeader(values);
    if (value === null) return null;
    let current = this.#states.get(runId);
    if (current !== undefined && current !== value) {
      throw protocolError("responses_turn_state_conflict");
    }
    if (current !== undefined) return null;
    await persist?.(value);
    current = this.#states.get(runId);
    if (current !== undefined && current !== value) {
      throw protocolError("responses_turn_state_conflict");
    }
    if (current !== undefined) return null;
    this.#states.set(runId, value);
    return value;
  }

  release(runId: string): void {
    this.#states.delete(runId);
  }
}

export function parseTurnStateHeader(values: readonly string[]): string | null {
  if (values.length === 0) return null;
  if (values.length !== 1) {
    throw protocolError("responses_turn_state_duplicate");
  }
  const value = values[0]!;
  if (
    value.length === 0 ||
    value.length > MAX_TURN_STATE_BYTES ||
    /[^\x20-\x2b\x2d-\x7e]/u.test(value)
  ) {
    throw protocolError("responses_turn_state_invalid");
  }
  return value;
}

export function fetchTurnStateHeaders(headers: Headers): readonly string[] {
  const value = headers.get(TURN_STATE_HEADER);
  return value === null ? [] : [value];
}
