import { ChevronUp, KeyRound, LogOut, Settings2 } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Locale } from "../../lib/i18n";
import type { AgentPlatformAccount } from "../auth/AgentPlatformAuthGate";

export function SidebarAccount({
  account,
  locale = "zh",
  onSettings,
}: {
  account: AgentPlatformAccount;
  locale?: Locale;
  onSettings?: () => void;
}) {
  const displayName =
    (
      account.user.display_name ||
      account.user.nickname ||
      account.user.username
    ).trim() || account.user.username;
  const initial = displayName.charAt(0).toUpperCase() || "U";
  const accountMenuRef = useRef<HTMLDetailsElement>(null);
  /*
   * Closing on blur ate the click: focus leaves `summary` on pointerdown, so the
   * menu unmounted before the button it was heading for could fire. Dismissal
   * keys off a pointerdown that lands outside the menu instead.
   */
  useEffect(() => {
    function closeOnOutsidePointer(event: PointerEvent) {
      const menu = accountMenuRef.current;
      if (!menu?.open || !(event.target instanceof Node)) {
        return;
      }
      if (!menu.contains(event.target)) {
        menu.removeAttribute("open");
      }
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, []);
  const secondaryLabel =
    account.providerLabel !== displayName
      ? account.providerLabel
      : account.user.username !== displayName
        ? account.user.username
        : account.providerLabel;

  return (
    <footer
      aria-label={locale === "zh" ? "当前企业账号" : "Current account"}
      className="sidebar-account"
      data-od-id="desktop-account-entry"
    >
      <details
        className="sidebar-account-menu"
        ref={accountMenuRef}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.currentTarget.removeAttribute("open");
            event.currentTarget.querySelector("summary")?.focus();
          }
        }}
      >
        <summary
          aria-label={
            locale === "zh"
              ? `账号菜单：${displayName}`
              : `Account menu: ${displayName}`
          }
          title={locale === "zh" ? "账号菜单" : "Account menu"}
        >
          <span className="account-mark" aria-hidden="true">
            {initial}
          </span>
          <span className="sidebar-account-copy">
            <strong>{displayName}</strong>
            <small>{secondaryLabel}</small>
          </span>          <span className="sidebar-account-chevron" aria-hidden="true">
            <ChevronUp />
          </span>
        </summary>
        <div className="sidebar-account-popover" role="menu">
          {onSettings ? (
            <button
              role="menuitem"
              type="button"
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                onSettings();
              }}
            >
              <Settings2 aria-hidden="true" />
              <span>{locale === "zh" ? "设置" : "Settings"}</span>
            </button>
          ) : null}
          {account.needsPassword ? (
            <button
              role="menuitem"
              type="button"
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                account.onSetPassword();
              }}
            >
              <KeyRound aria-hidden="true" />
              <span>
                {locale === "zh" ? "设置登录密码" : "Set login password"}
              </span>
            </button>
          ) : null}
          <button
            className="danger"
            role="menuitem"
            type="button"
            onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open");
              account.onLogout();
            }}
          >
            <LogOut aria-hidden="true" />
            <span>{locale === "zh" ? "退出登录" : "Sign out"}</span>
          </button>
        </div>
      </details>
    </footer>
  );
}
