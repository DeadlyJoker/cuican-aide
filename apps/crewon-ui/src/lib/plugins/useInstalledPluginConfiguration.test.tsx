// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  PluginSelectionView,
  SaveExtensionConfigurationRequest,
} from "@crewon/contracts";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";
import { notifyInstalledPluginSelectionChanged } from "./installedPluginChanges";
import {
  useInstalledPluginConfiguration,
  type InstalledPluginConfigurationState,
} from "./useInstalledPluginConfiguration";
import {
  CONFIG_PLUGIN_ID,
  ConfigurationFetchFixture,
  configurationDeferred,
  configurationHttpError,
  configurationSelection,
  configurationValue,
  settleConfiguration,
} from "./pluginConfiguration.test-support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("installed configuration with the actual Control client and named HTTP fixtures", () => {
  let root: Root;
  let container: HTMLDivElement;
  let fixture: ConfigurationFetchFixture;
  let latest: InstalledPluginConfigurationState;
  let initialSelection: PluginSelectionView;
  beforeEach(() => {
    fixture = new ConfigurationFetchFixture();
    initialSelection = fixture.selection;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await settleConfiguration();
    });
    container.remove();
  });
  function Harness({
    f,
    selection,
  }: {
    f: ConfigurationFetchFixture;
    selection: PluginSelectionView;
  }) {
    latest = useInstalledPluginConfiguration({
      client: f.client,
      selection,
      locale: "zh",
    });
    return <output>{latest.status}</output>;
  }
  async function render(f = fixture, selection = initialSelection) {
    await act(async () => {
      root.render(<Harness f={f} selection={selection} />);
      await settleConfiguration();
    });
    await settle();
  }
  async function settle() {
    await act(async () => {
      await settleConfiguration();
      await settleConfiguration();
    });
  }
  async function edit(value: string) {
    const draft = latest.draft;
    if (!draft || draft.type !== "object") throw new Error("draft_not_loaded");
    await act(async () => {
      latest.setDraft({
        ...draft,
        fields: {
          ...draft.fields,
          organization: { included: true, value: { type: "string", value } },
        },
      });
    });
  }
  function organization() {
    const draft = latest.draft;
    return draft?.type === "object" ? draft.fields.organization?.value : null;
  }
  async function save() {
    await act(async () => {
      await latest.save();
      await settleConfiguration();
    });
    await settle();
  }
  async function retry() {
    await act(async () => {
      await latest.retry();
      await settleConfiguration();
    });
    await settle();
  }

  it("reads the real selected disabled version, explicitly saves CAS0 and verifies latest without Agent/readiness/task requests", async () => {
    await render();
    expect(latest.status).toBe("available");
    expect(latest.package?.version).toBe("1.0.0");
    expect(latest.configuration).toBeNull();
    expect(fixture.saves).toHaveLength(0);
    await edit("真实草稿");
    await save();
    expect(fixture.saves).toHaveLength(1);
    expect(fixture.saves[0]!.body).toEqual({
      pluginVersion: "1.0.0",
      expectedRevision: 0,
      parameters: { organization: "真实草稿" },
      credentialBindings: [],
    });
    expect(fixture.saves[0]!.headers.get("authorization")).toBe(
      "Bearer named-configuration-actor-token",
    );
    expect(fixture.saves[0]!.headers.get("x-csrf-token")).toBe(
      "named-configuration-csrf-token",
    );
    expect(fixture.saves[0]!.headers.get("idempotency-key")).toMatch(
      /^plugin-configuration-/,
    );
    expect(latest.configuration?.revision).toBe(1);
    expect(latest.dirty).toBe(false);
    expect(latest.feedback).toContain("尚未发布或启用");
    expect(
      fixture.requests.every(
        (request) =>
          request.path === "/api/v1/extensions" ||
          request.path ===
            `/api/v1/extensions/${CONFIG_PLUGIN_ID}/configuration` ||
          request.path.startsWith("/api/v1/plugins/packages/") ||
          request.path.startsWith("/api/v1/plugins/selections/"),
      ),
    ).toBe(true);
  });

  it("keeps the latest space-scoped revision when selected version B differs from saved A", async () => {
    fixture.selection = configurationSelection(2, 4);
    fixture.configuration = configurationValue(9, "1.0.0", {
      organization: "old-version-value",
    });
    await render(fixture, fixture.selection);
    expect(latest.package?.version).toBe("2.0.0");
    expect(latest.configuration?.pluginVersion).toBe("1.0.0");
    expect(organization()).toEqual({ type: "string", value: "" });
    await edit("new version");
    await save();
    expect(fixture.saves[0]!.body).toMatchObject({
      pluginVersion: "2.0.0",
      expectedRevision: 9,
    });
    expect(latest.configuration?.revision).toBe(10);
  });

  it("preserves an unknown PUT's immutable key/body and retries directly before any schema reads", async () => {
    fixture.onSave = () => configurationHttpError(500);
    await render();
    await edit("uncertain first body");
    await save();
    expect(latest.retryable).toBe(true);
    expect(latest.saveDisabled).toBe(true);
    const first = fixture.saves[0]!;
    await edit("must not replace uncertain body");
    await save();
    expect(fixture.saves).toHaveLength(1);
    expect(organization()).toEqual({
      type: "string",
      value: "uncertain first body",
    });
    const previousCount = fixture.requests.length;
    fixture.onRead = (request) =>
      request.path === "/api/v1/extensions"
        ? configurationHttpError(403)
        : undefined;
    fixture.onSave = (request) => fixture.saveResponse(request, "replayed");
    await retry();
    expect(fixture.requests[previousCount]!.method).toBe("PUT");
    expect(
      fixture.requests
        .slice(previousCount)
        .some((request) => request.path === "/api/v1/extensions"),
    ).toBe(false);
    expect(fixture.saves[1]!.body).toEqual(first.body);
    expect(fixture.saves[1]!.headers.get("idempotency-key")).toBe(
      first.headers.get("idempotency-key"),
    );
    expect(latest.retryable).toBe(false);
    expect(latest.configuration?.revision).toBe(1);
  });

  it("keeps uncertain transport and malformed success outcomes retryable; explicit abandon rereads before editing", async () => {
    fixture.onSave = () => {
      throw new TypeError("named network disconnect");
    };
    await render();
    await edit("my draft");
    await save();
    expect(latest.retryable).toBe(true);
    fixture.onSave = () => Response.json({ not: "a save receipt" });
    await retry();
    expect(latest.retryable).toBe(true);
    fixture.configuration = configurationValue(2, "1.0.0", {
      organization: "current-after-uncertain",
    });
    await act(async () => {
      latest.abandonRetry();
      await settleConfiguration();
    });
    await settle();
    expect(latest.retryable).toBe(false);
    expect(latest.configuration?.revision).toBe(2);
    expect(organization()).toEqual({ type: "string", value: "my draft" });
    await edit("confirmed new edit");
    fixture.onSave = (request) => fixture.saveResponse(request);
    await save();
    expect(fixture.saves[2]!.headers.get("idempotency-key")).not.toBe(
      fixture.saves[0]!.headers.get("idempotency-key"),
    );
    expect(fixture.saves[2]!.body).toMatchObject({ expectedRevision: 2 });
  });

  it("on 409 rereads latest revision but preserves the user draft and conflict message", async () => {
    fixture.configuration = configurationValue(1);
    fixture.onSave = () => {
      fixture.configuration = configurationValue(3, "1.0.0", {
        organization: "other author",
      });
      return configurationHttpError(409);
    };
    await render();
    await edit("my revision draft");
    await save();
    expect(latest.configuration?.revision).toBe(3);
    expect(latest.error).toContain("修订冲突");
    expect(latest.retryable).toBe(false);
    expect(organization()).toEqual({
      type: "string",
      value: "my revision draft",
    });
    fixture.onSave = (request) => fixture.saveResponse(request);
    await save();
    expect(fixture.saves[1]!.body).toMatchObject({
      expectedRevision: 3,
      parameters: { organization: "my revision draft" },
    });
    expect(fixture.saves[1]!.headers.get("idempotency-key")).not.toBe(
      fixture.saves[0]!.headers.get("idempotency-key"),
    );
  });

  it("refuses a new save if latest configuration changed during editing, without sending a stale PUT", async () => {
    fixture.configuration = configurationValue(1);
    await render();
    await edit("draft not overwritten");
    fixture.configuration = configurationValue(2, "1.0.0", {
      organization: "new current",
    });
    await save();
    expect(fixture.saves).toHaveLength(0);
    expect(latest.configuration?.revision).toBe(2);
    expect(latest.error).toContain("配置已变化");
    expect(organization()).toEqual({
      type: "string",
      value: "draft not overwritten",
    });
  });

  it("does not project a replayed old receipt as current when the authoritative GET reports a newer revision", async () => {
    await render();
    await edit("old accepted body");
    fixture.onSave = (request) => {
      const response = fixture.saveResponse(request, "replayed");
      fixture.configuration = configurationValue(5, "1.0.0", {
        organization: "actual-current",
      });
      return response;
    };
    await save();
    expect(latest.configuration?.revision).toBe(5);
    expect(latest.feedback).toBeNull();
    expect(latest.error).toContain("更新修订");
    expect(latest.dirty).toBe(true);
    expect(organization()).toEqual({
      type: "string",
      value: "old accepted body",
    });
  });

  it("checks exact selection before saving and after a received save before projecting it", async () => {
    await render();
    await edit("old package draft");
    fixture.selection = configurationSelection(2, 2);
    await save();
    expect(fixture.saves).toHaveLength(0);
    expect(latest.status).toBe("unavailable");
    expect(latest.error).toContain("选择已变化");
    await render(fixture, fixture.selection);
    await edit("new package draft");
    fixture.onSave = (request) => {
      const response = fixture.saveResponse(request);
      fixture.selection = configurationSelection(1, 3);
      return response;
    };
    await save();
    expect(fixture.saves).toHaveLength(1);
    expect(latest.status).toBe("unavailable");
    expect(latest.configuration).toBeNull();
    expect(latest.feedback).toBeNull();
    expect(latest.retryable).toBe(false);
  });

  it("does not erase saved credential references or invent replacement bindings", async () => {
    fixture.configuration = {
      ...configurationValue(1),
      credentialBindings: [
        {
          slotId: "api_key",
          credentialBindingId: "authoritative-opaque-reference",
        },
      ],
    };
    await render();
    await edit("parameter-only edit");
    expect(latest.credentialsUnsupported).toBe(true);
    expect(latest.saveDisabled).toBe(true);
    await save();
    expect(fixture.saves).toHaveLength(0);
    expect(latest.configuration?.credentialBindings).toEqual(
      fixture.configuration.credentialBindings,
    );
  });

  it("keeps missing metadata service visible as unavailable, with no save or fallback schema", async () => {
    fixture.onRead = (request) =>
      request.path === "/api/v1/extensions"
        ? configurationHttpError(404)
        : undefined;
    await render();
    expect(latest.status).toBe("unavailable");
    expect(latest.schema).toBeNull();
    expect(latest.error).toContain("服务不可用");
    await save();
    expect(fixture.saves).toHaveLength(0);
  });

  it("discards late reads after client replacement and selected version changes", async () => {
    const deferred = configurationDeferred<Response>();
    fixture.onRead = (request) =>
      request.path === "/api/v1/extensions" ? deferred.promise : undefined;
    await render();
    expect(latest.status).toBe("loading");
    const second = new ConfigurationFetchFixture();
    second.selection = configurationSelection(2, 2);
    await render(second, second.selection);
    expect(latest.package?.version).toBe("2.0.0");
    await act(async () => {
      deferred.resolve(Response.json({ extensions: [] }));
      await settleConfiguration();
    });
    await settle();
    expect(latest.status).toBe("available");
    expect(latest.package?.version).toBe("2.0.0");
  });

  it.each(["session", "selection", "client", "unmount"] as const)(
    "withdraws a pending mutation on %s without accepting its late receipt",
    async (kind) => {
      const deferred = configurationDeferred<Response>();
      fixture.onSave = () => deferred.promise;
      await render();
      await edit("pending old actor");
      let pending!: Promise<void>;
      await act(async () => {
        pending = latest.save();
        await settleConfiguration();
      });
      expect(fixture.saves).toHaveLength(1);
      if (kind === "session")
        await act(async () => {
          window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT));
        });
      if (kind === "selection") {
        fixture.selection = configurationSelection(2, 2);
        await act(async () => {
          notifyInstalledPluginSelectionChanged();
          await settleConfiguration();
        });
        await render(fixture, fixture.selection);
      }
      if (kind === "client") await render(new ConfigurationFetchFixture());
      if (kind === "unmount")
        await act(async () => {
          root.render(null);
        });
      const readCount = fixture.requests.length;
      await act(async () => {
        deferred.resolve(
          Response.json({
            disposition: "created",
            configuration: configurationValue(1, "1.0.0", {
              organization: "pending old actor",
            }),
          }),
        );
        await pending;
        await settleConfiguration();
      });
      await settle();
      expect(fixture.requests.length).toBe(readCount);
      if (kind === "session") {
        expect(latest.status).toBe("unavailable");
        expect(latest.configuration).toBeNull();
        expect(latest.retryable).toBe(false);
      }
      if (kind === "selection") expect(latest.package?.version).toBe("2.0.0");
      if (kind === "client") expect(latest.configuration).toBeNull();
    },
  );

  it("revokes an initial pending read on the account event and does not reopen its directory", async () => {
    const deferred = configurationDeferred<Response>();
    fixture.onRead = (request) =>
      request.path === "/api/v1/extensions" ? deferred.promise : undefined;
    await render();
    await act(async () => {
      window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT));
      deferred.resolve(Response.json({ extensions: [] }));
      await settleConfiguration();
    });
    await settle();
    expect(latest.status).toBe("unavailable");
    expect(latest.package).toBeNull();
    expect(latest.error).toContain("账号已变化");
  });

  it("keeps A's edited draft and exact uncertain receipt retry when a scoped selection notification belongs to plugin B", async () => {
    await render();
    await edit("A's preserved draft");
    await act(async () => {
      notifyInstalledPluginSelectionChanged({
        pluginId: "fixture.other-plugin",
      });
      await settleConfiguration();
    });
    expect(latest.status).toBe("available");
    expect(organization()).toEqual({
      type: "string",
      value: "A's preserved draft",
    });
    fixture.onSave = () => configurationHttpError(500);
    await save();
    const first = fixture.saves[0]!;
    expect(latest.retryable).toBe(true);
    await act(async () => {
      notifyInstalledPluginSelectionChanged({
        pluginId: "fixture.other-plugin",
      });
      await settleConfiguration();
    });
    expect(latest.retryable).toBe(true);
    expect(organization()).toEqual({
      type: "string",
      value: "A's preserved draft",
    });
    fixture.onSave = (request) => fixture.saveResponse(request, "replayed");
    await retry();
    expect(fixture.saves[1]!.body).toEqual(first.body);
    expect(fixture.saves[1]!.headers.get("idempotency-key")).toBe(
      first.headers.get("idempotency-key"),
    );
    expect(latest.configuration?.revision).toBe(1);
  });

  it("fences the old draft and command when the same plugin's actual selected version changes", async () => {
    await render();
    await edit("A old version draft");
    fixture.onSave = () => configurationHttpError(500);
    await save();
    expect(latest.retryable).toBe(true);
    fixture.selection = configurationSelection(2, 2);
    await act(async () => {
      notifyInstalledPluginSelectionChanged({
        pluginId: CONFIG_PLUGIN_ID,
        selection: fixture.selection,
      });
      await settleConfiguration();
    });
    await render(fixture, fixture.selection);
    expect(latest.package?.version).toBe("2.0.0");
    expect(latest.retryable).toBe(false);
    expect(organization()).toEqual({ type: "string", value: "" });
    await retry();
    expect(fixture.saves).toHaveLength(1);
  });

  it("preserves the draft and uncertain original command when installing a new version leaves the actual selection unchanged", async () => {
    await render();
    await edit("selected A stays selected");
    fixture.onSave = () => configurationHttpError(500);
    await save();
    const first = fixture.saves[0]!;
    const requests = fixture.requests.length;
    await act(async () => {
      notifyInstalledPluginSelectionChanged({
        pluginId: CONFIG_PLUGIN_ID,
        selection: { ...fixture.selection },
      });
      await settleConfiguration();
    });
    expect(fixture.requests.length).toBe(requests);
    expect(latest.retryable).toBe(true);
    expect(organization()).toEqual({
      type: "string",
      value: "selected A stays selected",
    });
    fixture.onSave = (request) => fixture.saveResponse(request, "replayed");
    await retry();
    expect(fixture.saves[1]!.body).toEqual(first.body);
    expect(fixture.saves[1]!.headers.get("idempotency-key")).toBe(
      first.headers.get("idempotency-key"),
    );
    expect(latest.configuration?.revision).toBe(1);
  });

  it("does not create a new command while a save is physically pending", async () => {
    const deferred = configurationDeferred<Response>();
    fixture.onSave = () => deferred.promise;
    await render();
    await edit("one frozen command");
    let pending!: Promise<void>;
    await act(async () => {
      pending = latest.save();
      await settleConfiguration();
    });
    await edit("not while pending");
    await save();
    expect(fixture.saves).toHaveLength(1);
    const body = fixture.saves[0]!.body as SaveExtensionConfigurationRequest;
    expect(body.parameters).toEqual({ organization: "one frozen command" });
    await act(async () => {
      deferred.resolve(fixture.saveResponse(fixture.saves[0]!));
      await pending;
    });
    expect(latest.dirty).toBe(false);
  });

  it("reports a bounded recursive draft copy refusal and preserves the prior edit instead of throwing from the field handler", async () => {
    fixture.schema = {
      type: "object",
      additionalProperties: false,
      required: ["organization", "rows"],
      properties: {
        organization: { type: "string", maxLength: 128, enum: null },
        rows: {
          type: "array",
          maxItems: 1024,
          items: {
            type: "object",
            additionalProperties: false,
            required: [],
            properties: {
              a: { type: "boolean" },
              b: { type: "boolean" },
              c: { type: "boolean" },
              d: { type: "boolean" },
              e: { type: "boolean" },
              f: { type: "boolean" },
              g: { type: "boolean" },
              h: { type: "boolean" },
            },
          },
        },
      },
    };
    await render();
    await edit("keep this draft");
    const before = latest.draft;
    if (!before || before.type !== "object") throw new Error("expected_object");
    const row = {
      type: "object" as const,
      fields: Object.fromEntries(
        ["a", "b", "c", "d", "e", "f", "g", "h"].map((name) => [
          name,
          {
            included: false,
            value: { type: "boolean" as const, value: false },
          },
        ]),
      ),
    };
    await act(async () => {
      latest.setDraft({
        ...before,
        fields: {
          ...before.fields,
          rows: {
            included: true,
            value: {
              type: "array",
              items: Array.from({ length: 1024 }, () => row),
            },
          },
        },
      });
    });
    expect(latest.draft).toBe(before);
    expect(latest.error).toContain("原草稿已保留");
    expect(fixture.saves).toHaveLength(0);
  });

  it("edits and saves a small valid configuration with many absent optional fields using lazy draft nodes", async () => {
    fixture.schema = {
      type: "object",
      additionalProperties: false,
      required: ["organization", "rows"],
      properties: {
        organization: { type: "string", maxLength: 128, enum: null },
        rows: {
          type: "array",
          maxItems: 64,
          items: {
            type: "object",
            additionalProperties: false,
            required: [],
            properties: Object.fromEntries(
              Array.from({ length: 64 }, (_, index) => [
                `field${index}`,
                { type: "boolean" },
              ]),
            ),
          },
        },
      },
    };
    fixture.configuration = configurationValue(1, "1.0.0", {
      organization: "old",
      rows: Array.from({ length: 64 }, () => ({})),
    });
    await render();
    expect(latest.status).toBe("available");
    const draft = latest.draft;
    if (draft?.type !== "object" || draft.fields.rows?.value?.type !== "array")
      throw new Error("expected_rows");
    const row = draft.fields.rows.value.items[0];
    expect(row?.type === "object" && row.fields.field0!.value).toBeNull();
    await edit("valid edited value");
    expect(latest.error).toBeNull();
    expect(latest.validation?.valid).toBe(true);
    await save();
    expect(fixture.saves[0]!.body).toEqual({
      pluginVersion: "1.0.0",
      expectedRevision: 1,
      parameters: {
        organization: "valid edited value",
        rows: Array.from({ length: 64 }, () => ({})),
      },
      credentialBindings: [],
    });
    expect(latest.configuration?.revision).toBe(2);
    expect(latest.error).toBeNull();
  });

  it("accepts and saves valid parameter values with more than 4096 nodes within the real 8192-node/16KiB protocol limits", async () => {
    fixture.schema = {
      type: "object",
      additionalProperties: false,
      required: ["organization", "rows"],
      properties: {
        organization: { type: "string", maxLength: 128, enum: null },
        rows: {
          type: "array",
          maxItems: 5,
          items: {
            type: "array",
            maxItems: 1024,
            items: { type: "integer", minimum: null, maximum: null },
          },
        },
      },
    };
    const rows = Array.from({ length: 5 }, () =>
      Array.from({ length: 1024 }, () => 0),
    );
    fixture.configuration = configurationValue(1, "1.0.0", {
      organization: "old",
      rows,
    });
    await render();
    expect(latest.status).toBe("available");
    await edit("over 4096 nodes");
    expect(latest.validation?.valid).toBe(true);
    await save();
    expect(fixture.saves[0]!.body).toMatchObject({
      expectedRevision: 1,
      parameters: { organization: "over 4096 nodes", rows },
    });
    expect(latest.configuration?.revision).toBe(2);
    expect(latest.error).toBeNull();
  });
});
