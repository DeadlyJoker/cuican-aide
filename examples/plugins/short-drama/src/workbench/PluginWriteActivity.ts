import type { PluginUiServices } from "@crewon/plugin-sdk/ui";

const writes = new Set([
  "crewon.creative-projects.v1.createProject",
  "crewon.creative-projects.v1.appendBrief",
  "crewon.creative-projects.v1.setProjectState",
  "crewon.creative-projects.v1.createConcept",
  "crewon.creative-projects.v1.appendConceptRevision",
  "crewon.project-generations.v1.generateConcept",
  "crewon.project-generation-queries.v1.queryConceptGeneration",
  "crewon.project-generation-selections.v1.selectConceptImage",
  "crewon.project-texts.v1.saveOutlineCandidate",
  "crewon.project-texts.v1.saveScriptCandidate",
  "crewon.project-texts.v1.selectRevision",
  "crewon.project-texts.v1.setLocked",
  "crewon.project-text-recovery.v1.acknowledge",
]);

/** SDK cancellation ends UI waiting; the original Host invocation may still be open. */
export class PluginWriteActivity {
  readonly services: PluginUiServices;
  #pending = 0;
  #changed: (() => void) | null;
  constructor(services: PluginUiServices, changed: () => void) {
    this.#changed = changed;
    const invoke = services.invoke.bind(services);
    this.services = Object.freeze({
      invoke: async (action, input, options) => {
        if (!writes.has(action)) return invoke(action, input, options);
        ++this.#pending;
        try {
          this.#notify();
          return await invoke(action, input, options);
        } finally {
          --this.#pending;
          this.#notify();
        }
      },
    });
  }
  get pending() {
    return this.#pending > 0;
  }
  #notify() {
    try {
      this.#changed?.();
    } catch {
      // A UI subscriber cannot replace the original Host outcome.
    }
  }
  dispose() {
    this.#changed = null;
  }
}
