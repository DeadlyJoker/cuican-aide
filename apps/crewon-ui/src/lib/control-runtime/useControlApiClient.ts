import { useEffect, useState } from "react";
import { getDesktopBridge } from "../desktop/desktopBridge";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";
import { DESKTOP_PROVIDER_CHANGED_EVENT } from "../model-provider/providerCredentialStore";
import { loadControlApiClient } from "./controlRuntimeBootstrap";

type ControlClient = Awaited<ReturnType<typeof loadControlApiClient>>;
const DESKTOP_RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000, 8_000] as const;

/** Retry session discovery only; never restart a runtime or replay a business operation. */
export function useControlApiClient(): ControlClient {
  const [controlClient, setControlClient] = useState<ControlClient>(null);
  useEffect(() => {
    let active = true;
    let generation = 0;
    let connected = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const nativeRuntime = getDesktopBridge()?.runtime;
    const reloadControlClient = () => {
      clearTimeout(timer);
      const requestedGeneration = ++generation;
      let retry = 0;
      const discover = async () => {
        pending = true;
        const client = await loadControlApiClient();
        if (!active || requestedGeneration !== generation) return;
        pending = false;
        connected = client !== null;
        setControlClient(client);
        const delay = DESKTOP_RETRY_DELAYS[retry++];
        if (nativeRuntime && !connected && delay !== undefined) {
          timer = setTimeout(() => {
            void discover();
          }, delay);
        }
      };
      void discover();
    };
    const recoverOnActivation = () => {
      if (nativeRuntime && !connected && !pending) reloadControlClient();
    };
    reloadControlClient();
    window.addEventListener(
      AGENT_PLATFORM_SESSION_CHANGED_EVENT,
      reloadControlClient,
    );
    window.addEventListener(
      DESKTOP_PROVIDER_CHANGED_EVENT,
      reloadControlClient,
    );
    window.addEventListener("focus", recoverOnActivation);
    window.addEventListener("online", recoverOnActivation);
    const unsubscribeNativeSession =
      nativeRuntime?.onLocalManagementAccessChanged?.(() => {
        if (!active) return;
        connected = false;
        setControlClient(null);
        reloadControlClient();
      });
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        reloadControlClient,
      );
      window.removeEventListener(
        DESKTOP_PROVIDER_CHANGED_EVENT,
        reloadControlClient,
      );
      window.removeEventListener("focus", recoverOnActivation);
      window.removeEventListener("online", recoverOnActivation);
      unsubscribeNativeSession?.();
    };
  }, []);
  return controlClient;
}
