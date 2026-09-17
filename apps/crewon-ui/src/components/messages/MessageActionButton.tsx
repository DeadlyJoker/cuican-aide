import type { ComponentProps } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";

export function MessageActionButton({
  label,
  ...props
}: ComponentProps<"button"> & { label: string }) {
  return (
    <TooltipProvider delayDuration={350}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            {...props}
            type="button"
            aria-label={label}
            className="message-action-button"
          />
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
