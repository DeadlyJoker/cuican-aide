import { randomBytes } from "node:crypto";
import type { ApplicationIdGenerator } from "@crewon/application";

type Randomness = Readonly<{
  randomBytes(size: number): Uint8Array;
}>;

/** Persisted task identities use an alphanumeric prefix without discarding random entropy.
 * UI invocation references have their own protocol and continue using their original generator. */
export function createPluginTaskApplicationIds(
  randomness: Randomness = { randomBytes },
): ApplicationIdGenerator {
  return Object.freeze({
    nextId: () => {
      const bytes = randomness.randomBytes(32);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32)
        throw new Error("plugin_task_application_id_entropy_invalid");
      return `plugin-${Buffer.from(bytes).toString("base64url")}`;
    },
  });
}
