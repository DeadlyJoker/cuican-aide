/*
 * Comment-aware CSS rule scanner used to keep dead overrides out of the styles.
 *
 * A naive /[^{}]+\{[^{}]*\}/ pass treats braces inside comments and strings as
 * rule boundaries, which misreports selectors and would corrupt the file if the
 * spans were ever used to edit it. This walker tracks comment and string state,
 * so every span it reports is a real rule.
 */

export interface CssRule {
  /** Selector text with runs of whitespace collapsed. */
  selector: string;
  /** Offset of the first selector character, past any leading comment. */
  start: number;
  /** Offset just past the rule's closing brace. */
  end: number;
  /**
   * Full preludes of the at-rules enclosing this rule, outermost first, e.g.
   * `@media (max-width: 860px)`. The condition is part of the identity: two
   * rules under different breakpoints are unrelated, so storing only the word
   * `media` would report legitimate overrides as dead.
   */
  atRules: readonly string[];
  /** Raw declaration block, braces excluded. */
  body: string;
}

/** Skip a comment starting at `index`, returning the offset just past it. */
function skipComment(source: string, index: number): number {
  const close = source.indexOf("*/", index + 2);
  return close === -1 ? source.length : close + 2;
}

/** Skip a quoted string starting at `index`, returning the offset just past it. */
function skipString(source: string, index: number): number {
  const quote = source[index];
  let cursor = index + 1;
  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (source[cursor] === quote) return cursor + 1;
    cursor += 1;
  }
  return cursor;
}

function isCommentStart(source: string, index: number): boolean {
  return source[index] === "/" && source[index + 1] === "*";
}

/** Advance past whitespace and comments so a selector never absorbs a comment. */
function firstSelectorChar(source: string, from: number, limit: number): number {
  let cursor = from;
  while (cursor < limit) {
    if (/\s/.test(source[cursor])) {
      cursor += 1;
      continue;
    }
    if (isCommentStart(source, cursor)) {
      cursor = Math.min(skipComment(source, cursor), limit);
      continue;
    }
    break;
  }
  return cursor;
}

/** Offset just past the brace matching the one that opens at `openBrace`. */
function matchingBrace(source: string, openBrace: number): number {
  let depth = 1;
  let cursor = openBrace + 1;
  while (cursor < source.length && depth > 0) {
    if (isCommentStart(source, cursor)) {
      cursor = skipComment(source, cursor);
      continue;
    }
    if (source[cursor] === '"' || source[cursor] === "'") {
      cursor = skipString(source, cursor);
      continue;
    }
    if (source[cursor] === "{") depth += 1;
    else if (source[cursor] === "}") depth -= 1;
    cursor += 1;
  }
  return cursor;
}

/** Every declaration-bearing rule in `source`, in document order. */
export function scanRules(source: string): CssRule[] {
  const rules: CssRule[] = [];
  const atRules: string[] = [];
  let index = 0;
  let preludeStart = 0;

  while (index < source.length) {
    if (isCommentStart(source, index)) {
      index = skipComment(source, index);
      continue;
    }
    if (source[index] === '"' || source[index] === "'") {
      index = skipString(source, index);
      continue;
    }

    if (source[index] === "{") {
      const prelude = source.slice(preludeStart, index).trim();

      if (prelude.startsWith("@")) {
        atRules.push(prelude.replace(/\s+/g, " "));
        index += 1;
        preludeStart = index;
        continue;
      }

      const start = firstSelectorChar(source, preludeStart, index);
      const end = matchingBrace(source, index);
      rules.push({
        selector: source.slice(start, index).replace(/\s+/g, " ").trim(),
        start,
        end,
        atRules: [...atRules],
        body: source.slice(index + 1, end - 1),
      });
      index = end;
      preludeStart = index;
      continue;
    }

    if (source[index] === "}") {
      atRules.pop();
      index += 1;
      preludeStart = index;
      continue;
    }

    index += 1;
  }

  return rules;
}

/** Property names declared directly in a rule body, ignoring comments and values. */
export function declaredProperties(body: string): Set<string> {
  const props = new Set<string>();
  let index = 0;
  let nameStart = 0;
  let name: string | null = null;

  while (index < body.length) {
    if (isCommentStart(body, index)) {
      index = skipComment(body, index);
      continue;
    }
    if (body[index] === '"' || body[index] === "'") {
      index = skipString(body, index);
      continue;
    }
    // Values such as url(a;b) or var(--x, y) must not be split on ; or :.
    if (body[index] === "(") {
      let depth = 1;
      index += 1;
      while (index < body.length && depth > 0) {
        if (body[index] === "(") depth += 1;
        else if (body[index] === ")") depth -= 1;
        index += 1;
      }
      continue;
    }
    if (body[index] === ":" && name === null) {
      name = body.slice(nameStart, index).trim();
    } else if (body[index] === ";") {
      if (name) props.add(name);
      nameStart = index + 1;
      name = null;
    }
    index += 1;
  }
  if (name) props.add(name);

  return props;
}

const KEYFRAME_STEP = /^(from|to|[\d.]+%(\s*,\s*[\d.]+%)*)$/i;

export interface DeadRule {
  selector: string;
  line: number;
  properties: string[];
}

/**
 * Rules whose every declaration is redeclared by a later rule with the same
 * selector at the same nesting level.
 *
 * Only same-selector pairs are compared, so specificity ties and source order
 * decides the winner. Rules inside at-rules are grouped by their enclosing
 * condition, because a rule in `@media (max-width: 860px)` legitimately
 * overrides a top-level rule without being dead itself.
 */
export function findDeadRules(source: string): DeadRule[] {
  const groups = new Map<string, { rule: CssRule; props: Set<string> }[]>();

  for (const rule of scanRules(source)) {
    if (!rule.selector || rule.selector.startsWith("@")) continue;
    if (KEYFRAME_STEP.test(rule.selector)) continue;
    const props = declaredProperties(rule.body);
    if (props.size === 0) continue;

    const key = `${rule.atRules.join(">")}|${rule.selector}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push({ rule, props });
    else groups.set(key, [{ rule, props }]);
  }

  const dead: DeadRule[] = [];
  for (const entries of groups.values()) {
    if (entries.length < 2) continue;
    for (let index = 0; index < entries.length - 1; index += 1) {
      const later = new Set<string>();
      for (const successor of entries.slice(index + 1)) {
        for (const prop of successor.props) later.add(prop);
      }
      const { rule, props } = entries[index];
      if ([...props].every((prop) => later.has(prop))) {
        dead.push({
          selector: rule.selector,
          line: source.slice(0, rule.start).split("\n").length,
          properties: [...props].sort(),
        });
      }
    }
  }

  return dead.sort((a, b) => a.line - b.line);
}
