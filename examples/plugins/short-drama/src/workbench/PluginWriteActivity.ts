import type { PluginUiServices } from "@crewon/plugin-sdk/ui";

const writes = new Set([
  "crewon.creative-projects.v1.createProject",
  "crewon.creative-projects.v1.appendBrief",
  "crewon.creative-projects.v1.setProjectState",
  "crewon.creative-projects.v1.createConcept",
  "crewon.creative-projects.v1.appendConceptRevision",
  "crewon.project-generations.v1.generateConcept",
  "crewon.project-generation-queries.v1.queryConceptGeneration",
  "crewon.project-historical-queries.v1.queryConceptGeneration",
  "crewon.project-generation-selections.v1.selectConceptImage",
  "crewon.project-texts.v1.saveOutlineCandidate",
  "crewon.project-texts.v1.saveScriptCandidate",
  "crewon.project-texts.v1.selectRevision",
  "crewon.project-texts.v1.setLocked",
  "crewon.project-assets.v1.saveCandidate",
  "crewon.project-assets.v1.selectRevision",
  "crewon.project-assets.v1.setLocked",
  "crewon.project-assets.v1.saveReferenceCandidate",
  "crewon.project-assets.v1.selectReference",
  "crewon.project-asset-recovery.v1.acknowledge",
  "crewon.project-text-recovery.v1.acknowledge",
  "crewon.project-conversations.v1.createConversation",
  "crewon.project-conversation-association.v1.attach",
  "crewon.project-conversations.v1.refreshSource",
  "crewon.project-conversations.v1.setState",
  "crewon.project-conversations.v1.startStage",
  "crewon.project-text-plans.v1.start",
  "crewon.project-text-plans.v1.pause",
  "crewon.project-text-plans.v1.resume",
  "crewon.project-text-plans.v1.revoke",
  "crewon.project-text-plans.v1.reviseRemaining",
  "crewon.project-text-plans.v1.continue",
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
