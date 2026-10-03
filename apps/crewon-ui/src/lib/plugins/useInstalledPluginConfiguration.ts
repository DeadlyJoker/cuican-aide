import { useEffect, useRef, useState } from "react";
import {
  ControlApiClientError,
  type ControlApiClient,
  type PluginControlClient,
} from "@crewon/control-client";
import {
  parseSaveExtensionConfigurationRequest,
  type GetExtensionConfigurationResponse,
  type PluginPackageView,
  type PluginSelectionView,
  type SaveExtensionConfigurationRequest,
} from "@crewon/contracts";
import {
  parseWorkflowObjectSchema,
  type WorkflowObjectSchema,
} from "@crewon/domain/workflow-schema";
import type { Locale } from "../i18n";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";
import {
  INSTALLED_PLUGIN_SELECTION_CHANGED,
  installedPluginSelectionChange,
} from "./installedPluginChanges";
import {
  copyPluginConfigurationDraft,
  createPluginConfigurationDraft,
  validatePluginConfigurationDraft,
  type PluginConfigurationDraft,
  type PluginConfigurationDraftValidation,
} from "./pluginConfigurationSchema";

export type InstalledPluginConfigurationClient = Pick<
  ControlApiClient,
  "listExtensions" | "getExtensionConfiguration" | "saveExtensionConfiguration"
> &
  Readonly<{
    plugins: Pick<PluginControlClient, "getSelection" | "getPackage">;
  }>;
type Configuration = GetExtensionConfigurationResponse["configuration"];
type Snapshot = Readonly<{
  package: PluginPackageView;
  schema: WorkflowObjectSchema;
  configuration: Configuration;
  credentialsUnsupported: boolean;
}>;
type State = Readonly<{
  status: "loading" | "available" | "unavailable";
  package: PluginPackageView | null;
  schema: WorkflowObjectSchema | null;
  configuration: Configuration;
  draft: PluginConfigurationDraft | null;
  dirty: boolean;
  busy: boolean;
  retryable: boolean;
  error: string | null;
  feedback: string | null;
  credentialsUnsupported: boolean;
}>;
export type InstalledPluginConfigurationState = State &
  Readonly<{
    validation: PluginConfigurationDraftValidation | null;
    saveDisabled: boolean;
    setDraft(draft: PluginConfigurationDraft): void;
    save(): Promise<void>;
    retry(): Promise<void>;
    refresh(): void;
    abandonRetry(): void;
  }>;
type Owner = Readonly<{
  client: InstalledPluginConfigurationClient;
  key: string;
  controller: AbortController;
}>;
type Intent = Readonly<{
  body: SaveExtensionConfigurationRequest;
  key: string;
}>;
const REQUEST_TIMEOUT_MS = 15_000;
const EMPTY: State = Object.freeze({
  status: "loading",
  package: null,
  schema: null,
  configuration: null,
  draft: null,
  dirty: false,
  busy: false,
  retryable: false,
  error: null,
  feedback: null,
  credentialsUnsupported: false,
});

/** Configuration is persisted by Control; an installation or a save never implies runtime readiness. */
export function useInstalledPluginConfiguration({
  client,
  selection,
  locale,
}: Readonly<{
  client: InstalledPluginConfigurationClient;
  selection: PluginSelectionView;
  locale: Locale;
}>): InstalledPluginConfigurationState {
  const key = selectionKey(selection);
  const expected = Object.freeze({ ...selection });
  const requested = useRef({ client, key });
  requested.current = { client, key };
  const owner = useRef<Owner>({
    client,
    key,
    controller: new AbortController(),
  });
  const intent = useRef<Intent | null>(null);
  const running = useRef(false);
  const [state, setState] = useState<State>(EMPTY);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [refreshCount, setRefreshCount] = useState(0);
  const [scopeCount, setScopeCount] = useState(0);
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const alive = (current: Owner) =>
    owner.current === current &&
    requested.current.client === current.client &&
    requested.current.key === current.key &&
    !current.controller.signal.aborted;
  const text = (zh: string, en: string) =>
    localeRef.current === "zh" ? zh : en;

  useEffect(() => {
    const current: Owner = { client, key, controller: new AbortController() };
    owner.current = current;
    intent.current = null;
    running.current = false;
    setState(EMPTY);
    const invalidateSession = () => {
      current.controller.abort();
      intent.current = null;
      setState({
        ...EMPTY,
        status: "unavailable",
        error: text(
          "账号已变化，请重新打开业务配置。",
          "Your account changed. Reopen configuration.",
        ),
      });
    };
    const invalidateSelection = (event: Event) => {
      const hint = installedPluginSelectionChange(event);
      if (hint !== null && hint.pluginId !== expected.pluginId) return;
      if (hint?.selection && selectionKey(hint.selection) === current.key)
        return;
      current.controller.abort();
      intent.current = null;
      setState(EMPTY);
      setScopeCount((value) => value + 1);
    };
    window.addEventListener(
      AGENT_PLATFORM_SESSION_CHANGED_EVENT,
      invalidateSession,
    );
    window.addEventListener(
      INSTALLED_PLUGIN_SELECTION_CHANGED,
      invalidateSelection,
    );
    return () => {
      current.controller.abort();
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        invalidateSession,
      );
      window.removeEventListener(
        INSTALLED_PLUGIN_SELECTION_CHANGED,
        invalidateSelection,
      );
    };
  }, [client, key, scopeCount]);

  useEffect(() => {
    const current = owner.current;
    if (!alive(current)) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      current.controller.signal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ]);
    setState((old) => ({ ...old, status: "loading" }));
    void readSnapshot(client, expected, signal).then(
      (snapshot) => {
        if (!alive(current) || controller.signal.aborted) return;
        setState((old) => snapshotState(old, snapshot, old.dirty));
      },
      (cause) => {
        if (!alive(current) || controller.signal.aborted) return;
        setState((old) => ({
          ...old,
          status: "unavailable",
          error: configurationError(cause, localeRef.current),
        }));
      },
    );
    return () => controller.abort();
  }, [client, key, scopeCount, refreshCount]);

  const setDraft = (draft: PluginConfigurationDraft) => {
    const current = owner.current;
    const old = stateRef.current;
    if (
      !alive(current) ||
      running.current ||
      intent.current ||
      !old.schema ||
      old.status !== "available"
    )
      return;
    try {
      const copied = copyPluginConfigurationDraft(old.schema, draft);
      setState((state) => ({
        ...state,
        draft: copied,
        dirty: true,
        error: null,
        feedback: null,
      }));
    } catch {
      setState((state) => ({
        ...state,
        error: text(
          "草稿超出编辑范围或结构无效，原草稿已保留。",
          "The edit exceeds the draft limit or has an invalid structure. The original draft is preserved.",
        ),
      }));
    }
  };

  const run = async (retry: boolean) => {
    const current = owner.current;
    const before = stateRef.current;
    if (
      !alive(current) ||
      running.current ||
      (retry
        ? !intent.current
        : intent.current !== null ||
          before.status !== "available" ||
          before.credentialsUnsupported ||
          !before.schema ||
          !before.draft)
    )
      return;
    running.current = true;
    setState((old) => ({ ...old, busy: true, error: null, feedback: null }));
    const signal = AbortSignal.any([
      current.controller.signal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ]);
    try {
      let command = intent.current;
      if (!command) {
        // A new mutation must still refer to this exact selected package and latest space-scoped revision.
        const snapshot = await readSnapshot(client, expected, signal);
        if (!alive(current)) return;
        if (!sameJson(snapshot.package, before.package))
          throw new Error("configuration_selection_changed");
        if (snapshot.credentialsUnsupported) {
          setState((old) => ({
            ...snapshotState(old, snapshot, true),
            error: text(
              "暂不支持凭据绑定配置；现有绑定已保留。",
              "Credential configuration is unsupported; existing bindings are preserved.",
            ),
          }));
          return;
        }
        if (
          !sameJson(snapshot.configuration, before.configuration) ||
          !sameJson(snapshot.schema, before.schema)
        ) {
          setState((old) => ({
            ...snapshotState(old, snapshot, true),
            error: text(
              "配置已变化，草稿已保留。请核对最新修订后再保存。",
              "Configuration changed. Your draft is preserved; review the latest revision before saving.",
            ),
          }));
          return;
        }
        const validation = validatePluginConfigurationDraft(
          snapshot.schema,
          before.draft!,
        );
        if (!validation.valid) return;
        const body = freezeRequest(
          parseSaveExtensionConfigurationRequest({
            pluginVersion: snapshot.package.version,
            expectedRevision: snapshot.configuration?.revision ?? 0,
            parameters: validation.parameters,
            credentialBindings: [],
          }),
        );
        command = Object.freeze({
          body,
          key: `plugin-configuration-${crypto.randomUUID()}`,
        });
        intent.current = command;
      }
      // An uncertain receipt retry goes directly to the same PUT, even if metadata reads are unavailable.
      const response = await client.saveExtensionConfiguration(
        expected.pluginId,
        command.body,
        command.key,
        { signal },
      );
      if (!alive(current)) return;
      const latest = await client.getExtensionConfiguration(
        expected.pluginId,
        {},
        { signal },
      );
      if (!alive(current)) return;
      await readSelectionPackage(client, expected, signal);
      if (!alive(current)) return;
      if (
        !latest.configuration ||
        latest.configuration.revision < response.configuration.revision
      )
        throw new Error("configuration_current_unconfirmed");
      intent.current = null;
      const matches =
        latest.configuration.revision === response.configuration.revision &&
        sameJson(latest.configuration, response.configuration);
      setState((old) => ({
        ...old,
        configuration: latest.configuration,
        credentialsUnsupported:
          latest.configuration!.credentialBindings.length > 0 ||
          old.credentialsUnsupported,
        dirty: !matches,
        retryable: false,
        feedback: matches
          ? text(
              "业务配置已保存；尚未发布或启用运行。",
              "Configuration saved; runtime has not been published or activated.",
            )
          : null,
        error: matches
          ? null
          : text(
              "保存回执已确认，但当前已有更新修订。草稿已保留，请核对。",
              "The save receipt is confirmed, but a newer revision is current. Your draft is preserved; review it.",
            ),
      }));
    } catch (cause) {
      if (!alive(current)) return;
      const known =
        cause instanceof ControlApiClientError &&
        [400, 401, 403, 404, 409, 422].includes(cause.status);
      const selectionChanged =
        cause instanceof Error &&
        cause.message === "configuration_selection_changed";
      if (known || selectionChanged) intent.current = null;
      setState((old) => ({
        ...old,
        status: selectionChanged ? "unavailable" : old.status,
        retryable: intent.current !== null,
        error: configurationError(cause, localeRef.current),
      }));
      if (cause instanceof ControlApiClientError && cause.status === 409) {
        try {
          const snapshot = await readSnapshot(client, expected, signal);
          if (alive(current))
            setState((old) => ({
              ...snapshotState(old, snapshot, true),
              error: configurationError(cause, localeRef.current),
              retryable: false,
            }));
        } catch {
          /* Keep the original conflict and draft if the authoritative reread is unavailable. */
        }
      }
    } finally {
      if (alive(current)) {
        running.current = false;
        setState((old) => ({ ...old, busy: false }));
      }
    }
  };
  const refresh = () => {
    if (alive(owner.current) && !running.current && !intent.current)
      setRefreshCount((value) => value + 1);
  };
  const abandonRetry = () => {
    if (!alive(owner.current) || running.current) return;
    intent.current = null;
    setState((old) => ({
      ...old,
      retryable: false,
      status: "loading",
      feedback: null,
      error: text(
        "已放弃重试，正在读取当前配置以确认结果。",
        "Retry abandoned. Reading current configuration to confirm the result.",
      ),
    }));
    setRefreshCount((value) => value + 1);
  };
  const sameOwner =
    requested.current.client === owner.current.client &&
    requested.current.key === owner.current.key;
  const visible = alive(owner.current)
    ? state
    : sameOwner && owner.current.controller.signal.aborted
      ? { ...EMPTY, status: "unavailable" as const, error: state.error }
      : EMPTY;
  const validation =
    visible.schema && visible.draft
      ? validatePluginConfigurationDraft(visible.schema, visible.draft)
      : null;
  return {
    ...visible,
    validation,
    saveDisabled:
      visible.status !== "available" ||
      visible.busy ||
      visible.retryable ||
      visible.credentialsUnsupported ||
      !validation?.valid ||
      (!visible.dirty &&
        visible.configuration?.pluginVersion === visible.package?.version),
    setDraft,
    save: () => run(false),
    retry: () => run(true),
    refresh,
    abandonRetry,
  };
}

async function readSelectionPackage(
  client: InstalledPluginConfigurationClient,
  expected: PluginSelectionView,
  signal: AbortSignal,
): Promise<PluginPackageView> {
  if (
    expected.state === "uninstalled" ||
    expected.selectedPackageDigest === null
  )
    throw new Error("configuration_selection_changed");
  const response = await client.plugins.getSelection(expected.pluginId, {
    signal,
  });
  if (
    !response.selection ||
    selectionKey(response.selection) !== selectionKey(expected)
  )
    throw new Error("configuration_selection_changed");
  const result = await client.plugins.getPackage(
    expected.selectedPackageDigest,
    { signal },
  );
  const pkg = result.package;
  if (
    !pkg ||
    pkg.pluginId !== expected.pluginId ||
    pkg.publisherId !== expected.publisherId ||
    pkg.packageDigest !== expected.selectedPackageDigest
  )
    throw new Error("configuration_selection_changed");
  return Object.freeze({ ...pkg });
}

async function readSnapshot(
  client: InstalledPluginConfigurationClient,
  expected: PluginSelectionView,
  signal: AbortSignal,
): Promise<Snapshot> {
  const pkg = await readSelectionPackage(client, expected, signal);
  const [catalog, saved] = await Promise.all([
    client.listExtensions({ signal }),
    client.getExtensionConfiguration(expected.pluginId, {}, { signal }),
  ]);
  const entries = catalog.extensions.filter(
    (entry) =>
      entry.pluginId === pkg.pluginId && entry.pluginVersion === pkg.version,
  );
  if (entries.length !== 1)
    throw new Error("configuration_metadata_unavailable");
  const entry = entries[0]!;
  const schema = parseWorkflowObjectSchema(entry.configurationSchema);
  if (saved.configuration?.pluginVersion === pkg.version)
    createPluginConfigurationDraft(schema, saved.configuration.parameters);
  const after = await readSelectionPackage(client, expected, signal);
  if (!sameJson(pkg, after)) throw new Error("configuration_selection_changed");
  return Object.freeze({
    package: pkg,
    schema,
    configuration: saved.configuration,
    credentialsUnsupported:
      entry.credentialSlots.length > 0 ||
      (saved.configuration?.credentialBindings.length ?? 0) > 0,
  });
}

function snapshotState(
  old: State,
  snapshot: Snapshot,
  preserveDraft: boolean,
): State {
  const sameVersion =
    snapshot.configuration?.pluginVersion === snapshot.package.version;
  return {
    ...old,
    ...snapshot,
    status: "available",
    draft:
      preserveDraft && old.draft
        ? old.draft
        : createPluginConfigurationDraft(
            snapshot.schema,
            sameVersion ? snapshot.configuration!.parameters : undefined,
          ),
    dirty: preserveDraft && old.dirty,
    retryable: false,
    error: old.dirty ? old.error : null,
  };
}
function selectionKey(selection: PluginSelectionView): string {
  return JSON.stringify([
    selection.pluginId,
    selection.publisherId,
    selection.selectedPackageDigest,
    selection.revision,
    selection.state,
  ]);
}
function sameJson(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
function freezeRequest(
  input: SaveExtensionConfigurationRequest,
): SaveExtensionConfigurationRequest {
  const freeze = (value: unknown): void => {
    if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(input);
  return input;
}
function configurationError(cause: unknown, locale: Locale): string {
  const zh = locale === "zh";
  if (cause instanceof ControlApiClientError && cause.status === 409)
    return zh
      ? "配置修订冲突，草稿已保留，请核对最新配置。"
      : "Configuration revision conflict. Your draft is preserved; review the latest configuration.";
  if (
    cause instanceof Error &&
    cause.message === "configuration_selection_changed"
  )
    return zh
      ? "当前插件版本或选择已变化，请重新打开业务配置。"
      : "The selected package changed. Reopen configuration.";
  if (
    cause instanceof ControlApiClientError &&
    [401, 403].includes(cause.status)
  )
    return zh
      ? "当前会话无权读取或保存此配置。"
      : "This session cannot read or save this configuration.";
  return zh
    ? "业务配置服务不可用或结果尚未确认。请刷新，或以原请求重试。"
    : "Configuration is unavailable or the result is unconfirmed. Refresh or retry the original request.";
}
