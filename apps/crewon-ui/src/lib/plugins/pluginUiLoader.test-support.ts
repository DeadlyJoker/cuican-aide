import { vi } from "vitest";
import type { PluginUiLease } from "@crewon/contracts/plugins";
import type {
  PluginUiDefinition,
  PluginUiProps,
  PluginUiServices,
} from "@crewon/plugin-sdk/ui";
import {
  TrustedPluginUiLoader,
  type PluginUiHostPorts,
  type PluginUiModuleImporter,
} from "./trustedPluginUiLoader";

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function flush() {
  // Real Control parsing, independently cancellable validation waiters and both live fences settle asynchronously.
  // This drains microtasks only; timers and physical HTTP acknowledgement gates remain controlled by each test.
  for (let count = 0; count < 48; count++) await Promise.resolve();
}

export function uiLease(serial = 1): PluginUiLease {
  return {
    schemaVersion: "crewon.plugin-ui-lease.v1",
    mountRef: `mount_${String(serial).padStart(32, "0")}`,
    expiresAt: "2099-10-02T00:00:00.000Z",
    selectionRevision: serial,
    packageDigest: `sha256:${String(serial % 10).repeat(64)}`,
    descriptor: {
      schemaVersion: "crewon.plugin-package.v1",
      hostApi: "crewon.plugin-host.v1",
      pluginId: "example.workbench",
      version: `1.0.${serial}`,
      title: "测试工作台",
      description: "Deterministic ABI unit fixture",
      publisherId: "example.publisher",
      entrypoints: {
        node: null,
        ui: { path: "ui/index.js", mode: "trustedModule" },
      },
      businessManifestPath: null,
      requires: [],
      provides: [],
      contributions: [
        {
          id: "workbench",
          title: "工作台",
          kind: "module",
          slot: "main.content",
        },
      ],
      files: [
        { path: "ui/index.js", byteLength: 100, sha256: "a".repeat(64) },
        { path: "ui/chunk.js", byteLength: 100, sha256: "b".repeat(64) },
        { path: "assets/封面.png", byteLength: 10, sha256: "c".repeat(64) },
      ],
    },
    contributionId: "workbench",
    publicAssets: ["ui/index.js", "ui/chunk.js", "assets/封面.png"],
  };
}

export function uiProps(
  data: PluginUiProps["data"] = { title: "初始内容" },
): PluginUiProps {
  return {
    schemaVersion: "crewon.plugin-ui-props.v1",
    contributionId: "workbench",
    theme: { mode: "light", tokens: { "--app-text": "#202020" } },
    data,
  };
}

export function uiHarness(
  importer?: PluginUiModuleImporter,
  overrides: Partial<PluginUiHostPorts> = {},
) {
  const instances: {
    root: HTMLElement;
    props: PluginUiProps;
    services: PluginUiServices;
    update: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }[] = [];
  const definition: PluginUiDefinition = {
    apiVersion: "crewon.plugin-ui.v1",
    pluginId: "example.workbench",
    mount(root, props, services) {
      root.textContent = JSON.stringify(props.data);
      const update = vi.fn(async (next: PluginUiProps) => {
        root.textContent = JSON.stringify(next.data);
      });
      const dispose = vi.fn(async () => {
        root.replaceChildren();
      });
      instances.push({ root, props, services, update, dispose });
      return { update, dispose };
    },
  };
  const ports = {
    validateMount: vi.fn<PluginUiHostPorts["validateMount"]>(
      overrides.validateMount ?? (async () => undefined),
    ),
    invoke: vi.fn<PluginUiHostPorts["invoke"]>(
      overrides.invoke ?? (async (_lease, input) => ({ echoed: input.input })),
    ),
    closeMount: vi.fn<PluginUiHostPorts["closeMount"]>(
      overrides.closeMount ?? (async () => undefined),
    ),
    onDiagnostic: vi.fn<PluginUiHostPorts["onDiagnostic"]>(
      overrides.onDiagnostic ?? (() => undefined),
    ),
  } satisfies PluginUiHostPorts;
  const importModule = vi.fn(
    importer ?? (async () => ({ default: definition })),
  );
  const loader = new TrustedPluginUiLoader({
    ports,
    assetBasePath: "/api/plugin-ui/assets",
    importer: importModule,
  });
  const root = document.createElement("div");
  document.body.append(root);
  return { loader, root, ports, instances, definition, importModule };
}
