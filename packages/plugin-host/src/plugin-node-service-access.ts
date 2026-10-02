import type { PluginPackageDescriptor } from "@crewon/contracts/plugins";
import type { PluginIdentity } from "@crewon/plugin-sdk/node";
import type {
  PluginHostService,
  PluginHostServiceLifetime,
} from "./plugin-host-service.ts";

type Service = PluginHostService & Readonly<{ owner: object | null }>;
type Instance<S extends Service, E extends Error> = {
  identity: PluginIdentity;
  descriptor: Pick<PluginPackageDescriptor, "requires">;
  dependencies: ReadonlyMap<string, S>;
  boundServices: Map<S, object>;
  bindingFailure: E | null;
  phase: string;
};
type ServiceAccess = Readonly<{
  get<T extends object>(service: string, apiVersion: string): T;
  getOptional<T extends object>(
    service: string,
    apiVersion: string,
  ): T | undefined;
}>;

/** Reads the instance's captured dependencies; availability never follows today's registry. */
export function createPluginNodeServiceAccess<
  S extends Service,
  E extends Error,
>(
  instance: Instance<S, E>,
  lifetime: PluginHostServiceLifetime,
  checks: Readonly<{
    checkService(service: string, apiVersion: string, value: object): void;
    bindingError(cause: unknown): E;
    fail(code: string): never;
  }>,
): ServiceAccess {
  function read(
    service: string,
    apiVersion: string,
    optional: boolean,
  ): object | undefined {
    const declaration = instance.descriptor.requires.find(
      (item) => item.service === service,
    );
    if (!declaration || declaration.apiVersion !== apiVersion)
      checks.fail("plugin_dependency_undeclared");
    if (optional && !declaration.optional)
      checks.fail("plugin_dependency_not_optional");
    // Absence cannot conceal a failed binding or an already disposed instance.
    if (optional) {
      if (instance.phase === "disposed" || instance.phase === "cleanupFailed")
        checks.fail("plugin_instance_unavailable");
      if (instance.bindingFailure !== null) throw instance.bindingFailure;
    }
    const value = instance.dependencies.get(service);
    if (!value) {
      if (optional) return undefined;
      checks.fail("plugin_dependency_unavailable");
    }
    if (instance.phase === "disposed" || instance.phase === "cleanupFailed")
      checks.fail("plugin_instance_unavailable");
    if (value.owner !== null || value.bindForPlugin === undefined)
      return value.value;
    const cached = instance.boundServices.get(value);
    if (cached !== undefined) return cached;
    if (instance.bindingFailure !== null) throw instance.bindingFailure;
    try {
      const bound = value.bindForPlugin(instance.identity, lifetime);
      if (bound instanceof Promise) {
        void bound.catch(() => undefined);
        checks.fail("plugin_host_service_binding_invalid");
      }
      checks.checkService(service, apiVersion, bound);
      instance.boundServices.set(value, bound);
      return bound;
    } catch (cause) {
      instance.bindingFailure = checks.bindingError(cause);
      throw instance.bindingFailure;
    }
  }
  return Object.freeze({
    get: <T extends object>(service: string, apiVersion: string): T =>
      read(service, apiVersion, false) as T,
    getOptional: <T extends object>(
      service: string,
      apiVersion: string,
    ): T | undefined => read(service, apiVersion, true) as T | undefined,
  });
}
