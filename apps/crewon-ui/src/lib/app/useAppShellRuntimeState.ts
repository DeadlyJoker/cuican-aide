import { useRef, useState } from "react";

import { getInitialLocale, type Locale } from "../i18n";
import { getInitialTheme, type Theme } from "../theme";
import type { ConnectionState, NoticeState } from "./appRuntimeState";

export function useAppShellRuntimeState() {
  const [locale, setLocale] = useState<Locale>(getInitialLocale);
  const localeRef = useRef(locale);
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  return {
    connectionAttempt,
    connectionState,
    locale,
    localeRef,
    notice,
    setConnectionAttempt,
    setConnectionState,
    setLocale,
    setNotice,
    setTheme,
    theme,
  };
}
