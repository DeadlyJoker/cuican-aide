import type { CommandComposerSelectOption } from "./CommandComposer";

export type ComposerSelectSection<TValue extends string> = {
  id: string;
  label: string | null;
  options: CommandComposerSelectOption<TValue>[];
};

/**
 * Split select options into labelled sections.
 *
 * Options without a group come first under no label, which keeps a single
 * primary choice (such as the local agent) at the top of the menu. Labelled
 * sections then follow in the order the caller declared them, and a section
 * with no options is dropped so callers can declare the full set without
 * checking what happens to be available.
 *
 * Options carrying a group the caller never declared keep their order and land
 * in a trailing section labelled by the group id, so a new group cannot silently
 * disappear from the menu.
 */
export function composerSelectSections<TValue extends string>(
  options: CommandComposerSelectOption<TValue>[],
  groups: Array<{ id: string; label: string }>,
): Array<ComposerSelectSection<TValue>> {
  const declared = new Set(groups.map((group) => group.id));
  const undeclared: string[] = [];
  for (const option of options) {
    const group = option.group;
    if (group && !declared.has(group) && !undeclared.includes(group)) {
      undeclared.push(group);
    }
  }

  const sections: Array<ComposerSelectSection<TValue>> = [
    {
      id: "ungrouped",
      label: null,
      options: options.filter((option) => !option.group),
    },
    ...groups.map((group) => ({
      id: group.id,
      label: group.label,
      options: options.filter((option) => option.group === group.id),
    })),
    ...undeclared.map((group) => ({
      id: group,
      label: group,
      options: options.filter((option) => option.group === group),
    })),
  ];

  return sections.filter((section) => section.options.length > 0);
}
