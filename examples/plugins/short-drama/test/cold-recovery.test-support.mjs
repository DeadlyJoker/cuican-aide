import { deferred } from "./persistent-ui.test-support.mjs";
import { selectionService } from "./selection-submit.test-support.mjs";

/** Public protocol/DOM fixture with independently delayed source reads; no durable storage claim. */
export function coldRecoveryService() {
  const base = selectionService(),
    gates = new Map(),
    gatedReads = [];
  const services = {
    async invoke(action, input, options) {
      if (
        action === "crewon.creative-projects.v1.getConceptAsset" &&
        gates.has(input.assetId)
      ) {
        const gate = gates.get(input.assetId);
        gatedReads.push({ assetId: input.assetId, signal: options?.signal });
        await gate.promise;
      }
      return base.services.invoke(action, input, options);
    },
  };
  return {
    ...base,
    services,
    gatedReads,
    contexts() {
      const data = base.props().data;
      return {
        generation: structuredClone(data.projectGenerationContext),
        query: structuredClone(data.projectGenerationQueryContext),
        selection: structuredClone(data.projectGenerationSelectionContext),
      };
    },
    gateSource(assetId) {
      const gate = deferred();
      gates.set(assetId, gate);
      return {
        resolve() {
          gates.delete(assetId);
          gate.resolve();
        },
        reject() {
          gates.delete(assetId);
          gate.reject(new Error("original_source_read_unavailable"));
        },
      };
    },
    setGenerationIntent(value) {
      base.setIntent(value);
    },
  };
}
