import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ProviderCredentialStore } from "./providerCredentials.ts";
import type { RuntimePaths } from "./runtimeSupervisor.ts";
import { providerModelCatalogForForm } from "./providerModelCatalog.ts";

const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mock.spawn }));

describe("model discovery credential routing", () => {
  it.each([
    ["https://original.example/v1", null, "stored-key"],
    ["https://original.example/v1/", null, "stored-key"],
    ["https://different.example/v1", null, null],
    ["https://original.example/api", null, null],
    ["https://different.example/v1", "new-key", "new-key"],
  ])(
    "queries %s with only the appropriate key",
    async (endpoint, apiKey, expectedKey) => {
      const output = new EventEmitter() as EventEmitter & {
        setEncoding: () => void;
      };
      output.setEncoding = () => {};
      const child = Object.assign(new EventEmitter(), {
        stdout: output,
        stderr: new EventEmitter(),
        exitCode: 0,
        signalCode: null,
        kill: vi.fn(),
        stdin: Object.assign(new EventEmitter(), {
          end: vi.fn((_input: string) => {
            queueMicrotask(() => {
              output.emit(
                "data",
                JSON.stringify({
                  models: ["__crewon_form_default__", "model-a", "model-b"],
                  status: "ok",
                }),
              );
              child.emit("close", 0);
            });
          }),
        }),
      });
      mock.spawn.mockReturnValue(child);
      const secretFor = vi.fn(() => "stored-key");
      const providers = {
        catalog: () => ({
          bindings: [
            { providerId: "existing", endpoint: "https://original.example/v1" },
          ],
        }),
        secretFor,
      } as unknown as ProviderCredentialStore;
      const result = await providerModelCatalogForForm(
        {
          apiKey,
          endpoint,
          defaultModelId: null,
          environmentVariable: null,
          providerId: "existing",
        },
        {
          providers,
          paths: {
            modelCatalog: "/test/catalog.mjs",
            source: false,
          } as RuntimePaths,
        },
      );
      expect(
        JSON.parse(child.stdin.end.mock.calls[0]![0] as unknown as string),
      ).toMatchObject({ apiKey: expectedKey });
      expect(result).toEqual({ models: ["model-a", "model-b"], status: "ok" });
      if (expectedKey !== "stored-key")
        expect(secretFor).not.toHaveBeenCalled();
    },
  );
});
