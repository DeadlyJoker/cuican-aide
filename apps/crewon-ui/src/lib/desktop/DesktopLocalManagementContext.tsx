import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  isDesktopLocalManagementAccess,
  subscribeDesktopLocalManagementAccess,
  type DesktopLocalManagementAccess,
} from "./desktopLocalManagementAccess";

const Context = createContext<{
  access: DesktopLocalManagementAccess;
  onLoginAccount?: () => void;
} | null>(null);

export function useNativeLocalManagementAccess(): DesktopLocalManagementAccess | null {
  const [access, setAccess] = useState<DesktopLocalManagementAccess | null>(
    null,
  );
  useEffect(() => subscribeDesktopLocalManagementAccess(setAccess), []);
  return isDesktopLocalManagementAccess(access) ? access : null;
}

export function useDesktopLocalManagementAccess(): DesktopLocalManagementAccess | null {
  const access = useContext(Context)?.access ?? null;
  return isDesktopLocalManagementAccess(access) ? access : null;
}

export function useDesktopLocalManagementLoginAction(): (() => void) | null {
  const context = useContext(Context);
  return isDesktopLocalManagementAccess(context?.access)
    ? (context?.onLoginAccount ?? null)
    : null;
}

export function DesktopLocalManagementAccessProvider({
  access,
  onLoginAccount,
  children,
}: {
  access: DesktopLocalManagementAccess | null;
  onLoginAccount?: () => void;
  children: ReactNode;
}) {
  return (
    <Context.Provider
      value={
        isDesktopLocalManagementAccess(access)
          ? { access, onLoginAccount }
          : null
      }
    >
      {children}
    </Context.Provider>
  );
}
