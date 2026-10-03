import { parsePluginTaskAdmissionPin } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { projectTaskFixture } from "./project-generation-task.test-support.ts";
import {
  taskActor,
  taskDigester,
  taskPin,
} from "./extension-plugin-task.test-support.ts";
import type { ExtensionTaskApplicationDependencies } from "./extension-task-application-service.ts";

/** Application-only memory doubles: no SQL, physical Host, provider or pricing authority proof. */
export function readinessFixture() {
  const f = projectTaskFixture();
  const sourcePin = parsePluginTaskAdmissionPin({
    ...taskPin,
    pluginId: "example.business",
    packageDigest: taskDigester.sha256("business-context"),
    action: "crewon.project-generation-contexts.v1.getReadiness",
  });
  const publication = {
    source: {
      pluginId: sourcePin.pluginId,
      packageDigest: sourcePin.packageDigest,
      contributionId: sourcePin.contributionId,
    },
    target: {
      pluginId: taskPin.pluginId,
      packageDigest: taskPin.packageDigest,
      contributionId: taskPin.contributionId,
      action: taskPin.action,
    },
  };
  const state = {
    live: true,
    current: 0,
    active: 0,
    transaction: 0,
    evaluates: 0,
    onCurrent: null as null | (() => void | Promise<void>),
    onEvaluate: null as null | (() => void | Promise<void>),
  };
  const active = () => {
    state.active++;
    if (!state.live)
      throw new ApplicationError("authorization", "fixture_context_withdrawn");
  };
  const authority = {
    async assertCurrent() {
      if (this !== authority) throw new Error("receiver_lost");
      state.current++;
      active();
      await state.onCurrent?.();
      active();
    },
    async assertTransactionCurrent() {
      if (this !== authority) throw new Error("receiver_lost");
      state.transaction++;
      active();
    },
    assertActive() {
      if (this !== authority) throw new Error("receiver_lost");
      active();
    },
  };
  const input = {
    actor: taskActor,
    reference: f.reference,
    publication,
    sourcePin,
    executionPin: taskPin,
    authority,
  };
  const extensions = {
    ...f.extensions,
    projectGenerationPublicationVersion:
      "crewon.project-generation-publication.v1" as const,
  };
  const host = {
    ...f.base.dependencies.host,
    taskAdmissionMode: () => "installed" as const,
    async evaluate(
      ...args: Parameters<
        ExtensionTaskApplicationDependencies["host"]["evaluate"]
      >
    ) {
      state.evaluates++;
      await state.onEvaluate?.();
      return f.base.dependencies.host.evaluate(...args);
    },
  };
  const create = (patch: Partial<ExtensionTaskApplicationDependencies> = {}) =>
    f.create({ extensions, host, ...patch });
  return {
    f,
    state,
    input,
    authority,
    extensions,
    host,
    create,
    read: () => create().getPublishedProjectGenerationReadiness(input),
  };
}

export function readinessDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
