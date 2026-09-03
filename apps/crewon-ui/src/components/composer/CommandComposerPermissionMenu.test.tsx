import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const selectHarness = vi.hoisted(() => {
  let open = false;
  const itemHandlers = new Map<string, () => void>();

  return {
    isOpen: () => open,
    openMenu: () => {
      open = true;
    },
    registerItem: (value: string, handler: () => void) => {
      itemHandlers.set(value, handler);
    },
    reset: () => {
      open = false;
      itemHandlers.clear();
    },
    selectItem: (value: string) => {
      const handler = itemHandlers.get(value);
      if (!handler) {
        throw new Error(`Permission item ${value} is not rendered`);
      }
      handler();
    },
  };
});

vi.mock("radix-ui", async () => {
  const React = await import("react");
  const SelectContext = React.createContext<{
    disabled: boolean;
    value: string;
    onValueChange: (value: string) => void;
  } | null>(null);

  return {
    Select: {
      Root({
        children,
        disabled = false,
        onValueChange,
        value,
      }: {
        children: ReactNode;
        disabled?: boolean;
        onValueChange: (value: string) => void;
        value: string;
      }) {
        return (
          <SelectContext.Provider value={{ disabled, onValueChange, value }}>
            <div
              data-radix-select-root=""
              data-state={selectHarness.isOpen() ? "open" : "closed"}
            >
              {children}
            </div>
          </SelectContext.Provider>
        );
      },
      Trigger({
        children,
        ...props
      }: {
        children: ReactNode;
        [key: string]: unknown;
      }) {
        return (
          <button
            {...props}
            aria-expanded={selectHarness.isOpen()}
            role="combobox"
            type="button"
          >
            {children}
          </button>
        );
      },
      Icon({ children }: { asChild?: boolean; children: ReactNode }) {
        return children;
      },
      Content({
        align,
        children,
        className,
        position,
        side,
        sideOffset,
      }: {
        align?: string;
        children: ReactNode;
        className?: string;
        position?: string;
        side?: string;
        sideOffset?: number;
      }) {
        if (!selectHarness.isOpen()) {
          return null;
        }
        return (
          <div
            className={className}
            data-align={align}
            data-position={position}
            data-side={side}
            data-side-offset={sideOffset}
            data-state="open"
            role="listbox"
          >
            {children}
          </div>
        );
      },
      Viewport({
        children,
        ...props
      }: {
        children: ReactNode;
        [key: string]: unknown;
      }) {
        return <div {...props}>{children}</div>;
      },
      Group({
        children,
        ...props
      }: {
        children: ReactNode;
        [key: string]: unknown;
      }) {
        return <div {...props}>{children}</div>;
      },
      Label({
        children,
        ...props
      }: {
        children: ReactNode;
        [key: string]: unknown;
      }) {
        return <div {...props}>{children}</div>;
      },
      Item({
        children,
        disabled = false,
        value,
        ...props
      }: {
        children: ReactNode;
        disabled?: boolean;
        value: string;
        [key: string]: unknown;
      }) {
        const context = React.useContext(SelectContext);
        if (!context) {
          throw new Error("Select item rendered without a root");
        }
        selectHarness.registerItem(value, () => {
          if (!disabled && !context.disabled) {
            context.onValueChange(value);
          }
        });
        return (
          <button
            {...props}
            aria-selected={context.value === value}
            data-state={context.value === value ? "checked" : "unchecked"}
            disabled={disabled}
            role="option"
            type="button"
          >
            {children}
          </button>
        );
      },
      ItemText({ children }: { children: ReactNode }) {
        return children;
      },
    },
  };
});

import { CommandComposerSelect } from "./CommandComposer";
import {
  commandComposerPermissionLearnMoreLabel,
  commandComposerPermissionLearnMoreUrl,
  commandComposerPermissionMenuTitle,
  commandComposerPermissionOptions,
} from "./commandComposerPermissionOptions";

describe("CommandComposerSelect permission menu", () => {
  beforeEach(() => {
    selectHarness.reset();
  });

  it("opens the dark permission menu and switches through a rendered option", () => {
    const onChange = vi.fn();
    selectHarness.openMenu();

    const markup = renderToStaticMarkup(
      <div data-theme="dark">
        <CommandComposerSelect
          ariaLabel="权限选择"
          className="max-w-[180px]"
          contentClassName="w-[min(360px,var(--radix-select-content-available-width))]"
          menuHelp={{
            href: commandComposerPermissionLearnMoreUrl,
            label: commandComposerPermissionLearnMoreLabel("zh"),
          }}
          menuTitle={commandComposerPermissionMenuTitle("zh")}
          options={commandComposerPermissionOptions("zh")}
          showChevron={false}
          value="approve-for-me"
          onChange={onChange}
        />
      </div>,
    );

    expect(
      Array.from(markup.matchAll(/data-value="([^"]+)"/g), (match) => match[1]),
    ).toEqual([
      "request-approval",
      "approve-for-me",
      "full-access",
    ]);
    expect(markup).toContain('data-theme="dark"');
    expect(markup).toContain(
      'data-tone="normal" data-value="approve-for-me" aria-selected="true" data-state="checked"',
    );
    expect(markup.match(/lucide-check/g)).toHaveLength(1);
    expect(markup).toContain(`href="${commandComposerPermissionLearnMoreUrl}"`);
    expect(markup).toContain("应如何批准 ChatGPT 操作？");
    expect(markup).toContain(">了解更多</a>");

    // Stable leading paths from the three 20x20 icons in the permission menu.
    expect(markup).toContain("M12.6683 4.16699");
    expect(markup).toContain("M13.4678 11.4318");
    expect(markup).toContain("M10.8883 13.1116");
    expect(markup.replaceAll("><", ">\n<")).toMatchSnapshot();

    selectHarness.selectItem("full-access");
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("full-access");
  });
});
