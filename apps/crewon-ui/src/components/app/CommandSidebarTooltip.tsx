import { useEffect, useState, type ReactElement } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Escape dismisses the hint before any containing directory or workbench. */
export function CommandSidebarTooltip({
  children,
  label,
  disabled = false,
}: {
  children: ReactElement;
  label: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <Tooltip
      open={disabled ? false : open}
      onOpenChange={setOpen}
      disableHoverableContent
    >
      <TooltipTrigger
        asChild
        onKeyDown={(event) => {
          if (event.key === "Escape" && open && !disabled) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        side="right"
        sideOffset={8}
        className="command-rail-tooltip"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
