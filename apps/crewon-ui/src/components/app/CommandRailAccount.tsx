import { useState } from "react";
import { CommandSidebarTooltip } from "./CommandSidebarTooltip";
import { KeyRound, LogOut, Settings2, UserRound } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Locale } from "../../lib/i18n";
import type { AgentPlatformAccount } from "../auth/AgentPlatformAuthGate";

export function CommandRailAccount({
  account,
  locale,
  onSettings,
}: {
  account: AgentPlatformAccount | null;
  locale: Locale;
  onSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const displayName = account
    ? (
        account.user.display_name ||
        account.user.nickname ||
        account.user.username
      ).trim() || account.user.username
    : locale === "zh"
      ? "用户"
      : "User";
  const menuLabel =
    locale === "zh"
      ? `账号菜单：${displayName}`
      : `Account menu: ${displayName}`;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <CommandSidebarTooltip label={menuLabel} disabled={open}>
        <DropdownMenuTrigger asChild>
          <button
            className="command-rail-account"
            aria-label={menuLabel}
            type="button"
            data-od-id="desktop-account-entry"
          >
            <span className="command-rail-avatar" aria-hidden="true">
              {account ? displayName.charAt(0).toUpperCase() : <UserRound />}
            </span>
          </button>
        </DropdownMenuTrigger>
      </CommandSidebarTooltip>
      <DropdownMenuContent
        side="right"
        align="end"
        sideOffset={10}
        collisionPadding={8}
        className="command-rail-account-menu"
        aria-label={menuLabel}
      >
        <DropdownMenuLabel className="command-rail-account-header">
          <span className="command-rail-avatar" aria-hidden="true">
            {account ? displayName.charAt(0).toUpperCase() : <UserRound />}
          </span>
          <span>
            <strong>{displayName}</strong>
            {account ? <small>{account.providerLabel}</small> : null}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {onSettings ? (
          <DropdownMenuItem onSelect={onSettings}>
            <Settings2 aria-hidden="true" />
            <span>{locale === "zh" ? "设置" : "Settings"}</span>
          </DropdownMenuItem>
        ) : null}
        {account?.needsPassword ? (
          <DropdownMenuItem onSelect={account.onSetPassword}>
            <KeyRound aria-hidden="true" />
            <span>
              {locale === "zh" ? "设置登录密码" : "Set login password"}
            </span>
          </DropdownMenuItem>
        ) : null}
        {account ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={account.onLogout}>
              <LogOut aria-hidden="true" />
              <span>{locale === "zh" ? "退出登录" : "Sign out"}</span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
