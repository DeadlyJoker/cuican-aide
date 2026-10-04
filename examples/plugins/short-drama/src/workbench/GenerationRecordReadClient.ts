import {
  createPluginProjectGenerationReadClient,
  type PluginProjectGenerationReadClient,
  type PluginUiServices,
} from "@crewon/plugin-sdk/ui";

/** Keep the original Host read in flight after the SDK stops waiting for it. */
export function createGenerationRecordReadClient(
  services: PluginUiServices,
): PluginProjectGenerationReadClient {
  // Preserve the public SDK's service validation before capturing its invocation.
  createPluginProjectGenerationReadClient(services);
  const invoke = Function.prototype.bind.call(
    Object.getOwnPropertyDescriptor(services, "invoke")!.value,
    services,
  ) as PluginUiServices["invoke"];
  let settled: Promise<void> = Promise.resolve();

  const getConceptGeneration: PluginProjectGenerationReadClient["getConceptGeneration"] =
    async (input, options) => {
      let physicalSettlement: Promise<void> | null = null;
      const sdk = createPluginProjectGenerationReadClient({
        invoke(action, parsedInput, invocationOptions) {
          const pending = settled.then(() => {
            const signal = invocationOptions.signal;
            if (signal?.aborted)
              throw (
                signal.reason ??
                new DOMException("The operation was aborted", "AbortError")
              );
            return invoke(action, parsedInput, invocationOptions);
          });
          settled = pending.then(
            () => undefined,
            () => undefined,
          );
          physicalSettlement = settled;
          return pending;
        },
      });
      try {
        return await sdk.getConceptGeneration(input, options);
      } finally {
        // SDK cancellation can win its race while the captured invocation stays open.
        if (physicalSettlement !== null) await physicalSettlement;
      }
    };

  return Object.freeze({ getConceptGeneration });
}
