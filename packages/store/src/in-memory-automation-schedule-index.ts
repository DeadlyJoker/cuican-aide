import type { AutomationListCursor } from "@crewon/application";

type Node = {
  key: AutomationListCursor;
  left: Node | null;
  right: Node | null;
  height: number;
};

/** Rebuildable keys only. AVL insertion and seek avoid copying/sorting definition bodies per page. */
export class InMemoryAutomationScheduleIndex {
  #root: Node | null = null;

  insert(key: AutomationListCursor): void {
    this.#root = insert(this.#root, {
      automationId: key.automationId,
      updatedAt: key.updatedAt,
    });
  }

  list(
    before: AutomationListCursor | null,
    limit: number,
  ): readonly AutomationListCursor[] {
    const stack: Node[] = [];
    let current = this.#root;
    while (current !== null) {
      if (before !== null && compare(current.key, before) >= 0) {
        current = current.left;
      } else {
        stack.push(current);
        current = current.right;
      }
    }
    const result: AutomationListCursor[] = [];
    while (stack.length > 0 && result.length < limit) {
      const node = stack.pop()!;
      result.push({ ...node.key });
      current = node.left;
      while (current !== null) {
        stack.push(current);
        current = current.right;
      }
    }
    return result;
  }
}

function compare(
  left: AutomationListCursor,
  right: AutomationListCursor,
): number {
  if (left.updatedAt !== right.updatedAt)
    return left.updatedAt < right.updatedAt ? -1 : 1;
  if (left.automationId === right.automationId) return 0;
  return left.automationId < right.automationId ? -1 : 1;
}

function height(node: Node | null): number {
  return node?.height ?? 0;
}

function updateHeight(node: Node): void {
  node.height = Math.max(height(node.left), height(node.right)) + 1;
}

function rotateLeft(root: Node): Node {
  const next = root.right!;
  root.right = next.left;
  next.left = root;
  updateHeight(root);
  updateHeight(next);
  return next;
}

function rotateRight(root: Node): Node {
  const next = root.left!;
  root.left = next.right;
  next.right = root;
  updateHeight(root);
  updateHeight(next);
  return next;
}

function insert(node: Node | null, key: AutomationListCursor): Node {
  if (node === null)
    return { key: { ...key }, height: 1, left: null, right: null };
  const order = compare(key, node.key);
  if (order === 0) return node;
  if (order < 0) node.left = insert(node.left, key);
  else node.right = insert(node.right, key);
  updateHeight(node);
  const balance = height(node.left) - height(node.right);
  if (balance > 1) {
    if (compare(key, node.left!.key) > 0) node.left = rotateLeft(node.left!);
    return rotateRight(node);
  }
  if (balance < -1) {
    if (compare(key, node.right!.key) < 0)
      node.right = rotateRight(node.right!);
    return rotateLeft(node);
  }
  return node;
}
