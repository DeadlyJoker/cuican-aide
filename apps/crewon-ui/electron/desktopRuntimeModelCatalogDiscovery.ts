import { createHash } from "node:crypto";
import type { ActiveProvider } from "./providerCredentials.ts";
import type { ProviderModelCatalogOutcome } from "./providerModelCatalog.ts";
import { desktopRuntimeModelDiscovery } from "./desktopRuntimeModelDiscovery.ts";

export const DESKTOP_RUNTIME_MODEL_CATALOG_REUSE_MS = 5 * 60_000;

export type DesktopModelDiscoveryContext = Readonly<{
  entry: string;
  source: boolean;
  environment: NodeJS.ProcessEnv;
  credentialSource: Readonly<{
    kind: string;
    environmentVariable: string | null;
  }> | null;
}>;

/** One Main lifetime, one recent successful discovery. This is never an execution grant. */
export class DesktopRuntimeModelCatalogDiscovery {
  readonly #discover: (
    provider: ActiveProvider,
  ) => Promise<ProviderModelCatalogOutcome>;
  readonly #context: (provider: ActiveProvider) => DesktopModelDiscoveryContext;
  readonly #now: () => number;
  #generation = 0;
  #retained: Readonly<{
    key: string;
    recordedAt: number;
    outcome: ProviderModelCatalogOutcome;
  }> | null = null;

  constructor(
    input: Readonly<{
      discover(provider: ActiveProvider): Promise<ProviderModelCatalogOutcome>;
      context(provider: ActiveProvider): DesktopModelDiscoveryContext;
      now?: () => number;
    }>,
  ) {
    this.#discover = input.discover;
    this.#context = input.context;
    this.#now = input.now ?? (() => performance.now());
  }

  async discover(provider: ActiveProvider): Promise<readonly string[] | null> {
    const captured = Object.freeze({ ...provider });
    const key = discoveryKey(captured, this.#context(captured));
    const age = this.#retained ? this.#now() - this.#retained.recordedAt : -1;
    if (
      this.#retained?.key === key &&
      age >= 0 &&
      age < DESKTOP_RUNTIME_MODEL_CATALOG_REUSE_MS
    )
      return desktopRuntimeModelDiscovery(this.#retained.outcome);
    // A changed identity, expired result or later failed probe cannot fall back to this slot.
    this.#retained = null;
    const generation = ++this.#generation;
    const outcome = await this.#discover(captured);
    if (
      outcome.status === "ok" &&
      generation === this.#generation &&
      discoveryKey(captured, this.#context(captured)) === key
    )
      this.#retained = Object.freeze({
        key,
        recordedAt: this.#now(),
        outcome: Object.freeze({
          status: "ok",
          models: Object.freeze([...outcome.models]),
        }),
      });
    return desktopRuntimeModelDiscovery(outcome);
  }
}

function discoveryKey(
  provider: ActiveProvider,
  context: DesktopModelDiscoveryContext,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        provider,
        entry: context.entry,
        source: context.source,
        credentialSource: context.credentialSource,
        environment: Object.entries(context.environment).sort(
          ([left], [right]) => left.localeCompare(right),
        ),
      }),
    )
    .digest("hex");
}
