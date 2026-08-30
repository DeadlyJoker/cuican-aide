import { cn } from "@/lib/cn";

/**
 * Shared Tailwind class recipes for the workspace sidebar.
 * Replaces the former `.sidebar-primary-nav` / `.thread-row` / `.search-box`
 * hand-rolled CSS so nav rows, thread rows, and the search field stay
 * visually consistent and adjustable in one place.
 */

/** Primary nav / footer command row: icon + label, 30px tall. */
export const sidebarNavItemClass = cn(
  "flex h-[30px] w-full cursor-pointer items-center gap-[9px] rounded-[7px] px-[10px] text-left",
  "text-[calc(13px_+_var(--user-ui-font-delta))] font-medium text-[var(--n-alpha-60)]",
  "transition-[background,color] duration-[var(--dur-fast)] ease-[var(--ease)]",
  "hover:bg-[var(--n-alpha-06)] hover:text-[var(--n-1000)]",
  "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent,#2563eb)]",
  "[&>svg]:shrink-0 [&>svg]:opacity-80",
);

/** Extra class for a nav item reflecting the active library/section. */
export const sidebarNavItemActiveClass =
  "bg-[var(--n-alpha-08)] text-[var(--n-1000)]";

/** Thread row container: title + hover-revealed actions. */
export const sidebarThreadRowClass = cn(
  "group/thread-row relative grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center",
  "min-h-[28px] cursor-pointer rounded-[7px] px-[8px] text-left",
  "text-[var(--n-alpha-60)] transition-[background,color] duration-[var(--dur-fast)] ease-[var(--ease)]",
  "hover:bg-[var(--n-alpha-06)]",
);

/** Selected thread row. */
export const sidebarThreadRowSelectedClass =
  "bg-[var(--n-alpha-10)] text-[var(--n-1000)]";

/** Icon action button revealed on row hover / selection / focus. */
export const sidebarThreadActionClass = cn(
  "grid size-[22px] place-items-center rounded-[var(--radius-sm)] border-0 bg-transparent p-0",
  "cursor-pointer text-[var(--n-alpha-45)] opacity-0",
  "transition-[opacity,background,color] duration-[var(--dur-fast)] ease-[var(--ease)]",
  "group-hover/thread-row:opacity-100 group-focus-within/thread-row:opacity-100 focus-visible:opacity-100",
  "group-data-[selected=true]/thread-row:opacity-100",
  "hover:bg-[var(--n-alpha-10)]",
);
