/** Configured estimates for reported text tokens only; not a provider invoice. */
export type ModelTokenPrice = Readonly<{
  schemaVersion: "crewon.model-token-price.v0";
  currency: string;
  /** Integer millionths of one currency unit per million tokens. */
  rates: Readonly<{ input: string; cacheRead: string; output: string }>;
}>;
export type ModelTokenPricingSnapshot = Readonly<{
  revision: number;
  price: ModelTokenPrice;
}>;

export function validateModelTokenPrice(value: ModelTokenPrice): void {
  if (
    !exactKeys(value, ["schemaVersion", "currency", "rates"]) ||
    value.schemaVersion !== "crewon.model-token-price.v0" ||
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.currency) ||
    !exactKeys(value.rates, ["input", "cacheRead", "output"]) ||
    Object.values(value.rates).some(
      (rate) =>
        typeof rate !== "string" || !/^(0|[1-9][0-9]{0,17})$/.test(rate),
    )
  )
    throw new Error("model_token_price_invalid");
}
export function validateModelTokenPricingSnapshot(
  value: ModelTokenPricingSnapshot,
): void {
  if (
    !exactKeys(value, ["revision", "price"]) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  )
    throw new Error("model_token_pricing_snapshot_invalid");
  validateModelTokenPrice(value.price);
}
function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
export function copyModelTokenPricing(
  value: ModelTokenPricingSnapshot,
): ModelTokenPricingSnapshot {
  validateModelTokenPricingSnapshot(value);
  return {
    revision: value.revision,
    price: {
      schemaVersion: value.price.schemaVersion,
      currency: value.price.currency,
      rates: {
        input: value.price.rates.input,
        cacheRead: value.price.rates.cacheRead,
        output: value.price.rates.output,
      },
    },
  };
}

/** Exact integer arithmetic: microcurrency / million tokens = 10^-12 currency per token. */
export function estimateModelTokenCost(
  pricing: ModelTokenPricingSnapshot,
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    cachedInputTokensReported: boolean;
    outputTokens: number;
  },
) {
  validateModelTokenPricingSnapshot(pricing);
  if (
    [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens].some(
      (n) => !Number.isSafeInteger(n) || n < 0,
    ) ||
    usage.cachedInputTokens > usage.inputTokens ||
    typeof usage.cachedInputTokensReported !== "boolean" ||
    (!usage.cachedInputTokensReported && usage.cachedInputTokens !== 0)
  )
    throw new Error("model_token_cost_usage_invalid");
  const rates = pricing.price.rates;
  const input = BigInt(rates.input),
    cache = BigInt(rates.cacheRead),
    output = BigInt(rates.output) * BigInt(usage.outputTokens);
  let lower: bigint, upper: bigint;
  if (usage.cachedInputTokensReported) {
    lower = upper =
      input * BigInt(usage.inputTokens - usage.cachedInputTokens) +
      cache * BigInt(usage.cachedInputTokens) +
      output;
  } else {
    lower =
      (input < cache ? input : cache) * BigInt(usage.inputTokens) + output;
    upper =
      (input > cache ? input : cache) * BigInt(usage.inputTokens) + output;
  }
  return {
    currency: pricing.price.currency,
    lowerPicounits: lower.toString(),
    upperPicounits: upper.toString(),
    exactForConfiguredRates: lower === upper,
  };
}
