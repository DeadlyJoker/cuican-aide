// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://crewon.localhost","settings":{"fetch":{"disableSameOriginPolicy":true}}}
import { act } from "react";
import { expect, it } from "vitest";
import {
  clickFlowButton,
  editFlowField,
  flowUntil,
  mountBusinessExtensionFlow,
  selectFlowAgent,
  startBusinessExtensionFlowHost,
} from "./BusinessExtensionFlow.test-support";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const plugin = "crewon.comfyui-krea2";

it("saves, prepares, activates, generates and queries through production UI, Node hosts, SQLite and real SSE without duplicate external submission", async () => {
  const host = await startBusinessExtensionFlowHost();
  let ui = mountBusinessExtensionFlow(host.client);
  const button = (label: string) =>
    [...ui.container.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === label,
    )!;
  const open = async () => {
    await flowUntil(() => Boolean(button("Business plugins")), "catalog entry");
    await clickFlowButton(ui.container, "Business plugins");
    await flowUntil(
      () =>
        !ui.container.querySelector<HTMLInputElement>('input[type="url"]')
          ?.disabled,
      "configuration available",
    );
  };
  try {
    await ui.render();
    await open();
    await editFlowField(
      ui.container.querySelector<HTMLInputElement>('input[type="url"]')!,
      host.endpoint,
    );
    await clickFlowButton(ui.container, "Save configuration");
    await flowUntil(
      () => ui.container.textContent!.includes("Saved · revision 1"),
      "UI configuration saved",
    );
    const saved = (await host.client.getExtensionConfiguration(plugin, {}))
      .configuration!;
    expect(saved.parameters).toEqual({ baseUrl: host.endpoint });
    expect(saved.revision).toBe(1);
    const initialCatalog = await host.client.getActiveAgentVersionCatalog();
    const defaultAgent = initialCatalog.data[0]!.agentVersionId;
    await selectFlowAgent(ui.container, defaultAgent);
    await flowUntil(
      () =>
        ui.container.textContent!.includes("Complete deployment and refresh."),
      "unprepared Agent rejected",
    );
    expect(button("Enable plugin").disabled).toBe(true);
    expect(
      (await host.client.getExtensionActivation(plugin)).activation,
    ).toBeNull();
    expect(host.comfyRequests).toEqual([]);

    // Explicit Native preparation uses the exact configuration written by the UI.
    await ui.close();
    const agent = await host.prepareSavedPlugin(saved);
    ui = mountBusinessExtensionFlow(host.client);
    await ui.render();
    await open();
    await clickFlowButton(ui.container, "Refresh status");
    await flowUntil(
      () =>
        [...ui.container.querySelectorAll("option")].some(
          (option) => option.value === agent,
        ),
      "published Agent visible",
    );
    await selectFlowAgent(ui.container, agent);
    await flowUntil(
      () => !button("Enable plugin").disabled,
      "exact runtime is ready",
    );
    const ready = await host.client.getExtensionRuntime(plugin, {
      agentVersionId: agent,
      configurationRevision: saved.revision,
    });
    expect(ready.readiness.outcome).toBe("ready");
    await clickFlowButton(ui.container, "Enable plugin");
    await flowUntil(
      () => ui.container.textContent!.includes("Enabled"),
      "UI activation committed",
    );
    const activation = (await host.client.getExtensionActivation(plugin))
      .activation!;
    expect(activation.configurationRevision).toBe(saved.revision);
    expect(activation.configurationDigest).toBe(saved.contentDigest);
    expect(activation.target!.agentVersionId).toBe(agent);
    expect(Object.keys(activation.target!)).toHaveLength(8);
    await editFlowField(
      ui.container.querySelector<HTMLTextAreaElement>("textarea")!,
      "A local fixture ceramic teapot",
    );
    await flowUntil(
      () => !button("Generate image").disabled,
      "generation enabled",
    );
    await clickFlowButton(ui.container, "Generate image");
    await flowUntil(
      () =>
        ui.observed.thread?.turns.some(
          (turn) => turn.status === "completed",
        ) === true,
      "generation conversation settled",
    );
    await flowUntil(
      () =>
        ui.container.textContent!.includes(
          "Native operation accepted; query its existing operation.",
        ),
      "normal transcript displays Agent output",
    );
    const thread = ui.observed.thread!;
    const generateRunId = thread.turns[0]!.id;
    expect(ui.observed.opened).toEqual([thread.id]);
    expect(
      host.requests.some(
        (request) => request.path === `/api/v1/runs/${generateRunId}/events`,
      ),
    ).toBe(true);
    expect(host.disconnections).toHaveLength(1);
    expect(host.disconnections[0]!.path).toBe(
      `/api/v1/runs/${generateRunId}/events`,
    );
    expect(host.disconnections[0]!.cursor).toBeGreaterThan(0);
    expect(
      host.requests.some(
        (request) =>
          request.path === host.disconnections[0]!.path &&
          request.cursor === String(host.disconnections[0]!.cursor),
      ),
    ).toBe(true);
    expect(ui.observed.deltas).toContain(
      "Native operation accepted; query its existing operation.",
    );
    expect(
      ui.container.textContent!.split(
        "Native operation accepted; query its existing operation.",
      ),
    ).toHaveLength(2);
    expect(host.runBinding(generateRunId).target).toEqual(activation.target);
    expect(host.runBinding(generateRunId).configurationRevision).toBe(
      saved.revision,
    );
    expect(
      host.comfyRequests.filter((request) => request === "POST /prompt"),
    ).toHaveLength(1);
    expect(
      host.comfyRequests.filter((request) =>
        request.startsWith("GET /history/"),
      ),
    ).toHaveLength(0);
    expect(ui.container.querySelector('[role="dialog"]')).toBeNull();

    await open();
    await flowUntil(
      () => ui.container.textContent!.includes("External request submitted"),
      "recorded provider operation",
    );
    await clickFlowButton(ui.container, "Refresh status");
    await flowUntil(
      () => !button("Query source task result").disabled,
      "query available after refresh",
    );
    expect(
      host.comfyRequests.filter((request) => request === "POST /prompt"),
    ).toHaveLength(1);
    await clickFlowButton(ui.container, "Query source task result");
    await flowUntil(
      () =>
        ui.observed.thread?.turns.length === 2 &&
        ui.observed.thread.turns.every((turn) => turn.status === "completed"),
      "query conversation settled",
    );
    await flowUntil(
      () =>
        ui.container.textContent!.includes(
          "Native historical operation observed.",
        ),
      "query output in original conversation",
    );
    const queryRunId = ui.observed.thread!.turns.find(
      (turn) => turn.id !== generateRunId,
    )!.id;
    expect(ui.observed.thread!.id).toBe(thread.id);
    expect(host.runBinding(queryRunId).target).toEqual(activation.target);
    expect(
      host.comfyRequests.filter((request) => request === "POST /prompt"),
    ).toHaveLength(1);
    expect(
      host.comfyRequests.filter((request) =>
        request.startsWith("GET /history/"),
      ),
    ).toHaveLength(1);
    await open();
    await flowUntil(
      () => Boolean(ui.container.querySelector("a.business-extension-result")),
      "authoritative result link",
    );
    const result = ui.container.querySelector<HTMLAnchorElement>(
      "a.business-extension-result",
    )!;
    expect(result.textContent).toContain("native-fixture.png");
    expect(result.href).toBe(
      `${host.endpoint}view?filename=native-fixture.png&subfolder=&type=output`,
    );
    const modelCount = host.modelRequests.length;
    const requestCount = host.comfyRequests.length;
    await act(async () =>
      ui.container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Close business plugin"]',
        )!
        .click(),
    );
    await open();
    await flowUntil(
      () => Boolean(ui.container.querySelector("a.business-extension-result")),
      "result retained on reopen",
    );
    const resumeThread = ui.observed.thread;
    await ui.close();
    ui = mountBusinessExtensionFlow(
      host.client,
      resumeThread === null ? null : { ...resumeThread, turns: [] },
    );
    await ui.render();
    await clickFlowButton(ui.container, "Resume conversation");
    await flowUntil(
      () =>
        ui.container.textContent!.includes(
          "Native historical operation observed.",
        ),
      "fresh Runtime restores conversation",
    );
    await open();
    await flowUntil(
      () => Boolean(ui.container.querySelector("a.business-extension-result")),
      "fresh Runtime restores task result",
    );
    expect(ui.observed.thread!.turns).toHaveLength(2);
    expect(ui.observed.errors).toEqual([]);
    expect(host.modelRequests).toHaveLength(modelCount);
    expect(host.comfyRequests).toHaveLength(requestCount);
    expect(modelCount).toBe(4);
    host.recordEvidence({
      configuration: saved,
      target: activation.target,
      threadId: thread.id,
      generationRunId: generateRunId,
      queryRunId,
    });
    console.info(
      "Business UI actual-host evidence: saved revision 1; explicit seven-bundle preparation; full 8-field target; original conversation and real SSE; model POST=4, Comfy POST=1, history GET=1; refresh/reopen/fresh Runtime recovery add no external request",
    );
  } catch (error) {
    console.error(host.logTail());
    console.error(ui.container.textContent?.slice(-8_000));
    throw error;
  } finally {
    await ui.close();
    await host.close();
  }
}, 250_000);
