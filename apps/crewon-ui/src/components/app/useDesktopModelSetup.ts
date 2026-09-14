import { useEffect, useState } from "react";
import {
  DESKTOP_PROVIDER_CHANGED_EVENT,
  providerCredentialStore,
} from "../../lib/model-provider/providerCredentialStore";

export function useDesktopModelSetup(enabled = true): boolean {
  const [needsModel, setNeedsModel] = useState(false);
  useEffect(() => {
    const store = providerCredentialStore();
    if (!store || !enabled) return;
    let active = true;
    let generation = 0;
    const refresh = () => {
      const request = ++generation;
      void store
        .catalog()
        .then((catalog) => {
          if (!active || request !== generation) return;
          const binding = catalog.bindings.find((item) => item.isActive);
          setNeedsModel(!binding?.credentialAvailable || !binding.modelId);
        })
        .catch(() => {
          if (active && request === generation) setNeedsModel(false);
        });
    };
    refresh();
    globalThis.addEventListener(DESKTOP_PROVIDER_CHANGED_EVENT, refresh);
    return () => {
      active = false;
      globalThis.removeEventListener(DESKTOP_PROVIDER_CHANGED_EVENT, refresh);
    };
  }, [enabled]);

  return needsModel;
}
