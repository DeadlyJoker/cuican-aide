import { useEffect, useState } from "react";

import { isCommandShellHash } from "./appRouting";

export function useAppCommandShellRoute() {
  const [commandShellRouteActive, setCommandShellRouteActive] = useState(() =>
    isCommandShellHash(window.location.hash),
  );

  useEffect(() => {
    const syncCommandShellRoute = () => {
      setCommandShellRouteActive(isCommandShellHash(window.location.hash));
    };

    window.addEventListener("hashchange", syncCommandShellRoute);
    return () => window.removeEventListener("hashchange", syncCommandShellRoute);
  }, []);

  const closeCommandShellRoute = () => {
    if (isCommandShellHash(window.location.hash)) {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    }
    setCommandShellRouteActive(false);
  };

  return {
    closeCommandShellRoute,
    commandShellRouteActive,
  };
}
