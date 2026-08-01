use pretty_assertions::assert_eq;

use super::RuntimeTurnOwnership;

#[test]
fn runtime_turn_ownership_remains_until_the_last_guard_drops() {
    let ownership = RuntimeTurnOwnership::default();
    let first = ownership.retain("turn-1");
    let second = ownership.retain("turn-1");

    assert_eq!(ownership.contains("turn-1"), true);
    drop(first);
    assert_eq!(ownership.contains("turn-1"), true);
    drop(second);
    assert_eq!(ownership.contains("turn-1"), false);
}
