use super::*;
use pretty_assertions::assert_eq;

#[test]
fn opaque_target_tokens_are_stable_and_do_not_expose_resource_ids() {
    let token = opaque_target_token("/workspace", "agent", "agent-sensitive-name");
    assert_eq!(token.len(), 68);
    assert_eq!(token.starts_with("tgt_"), true);
    assert_eq!(token.contains("sensitive"), false);
    assert_eq!(
        token,
        opaque_target_token("/workspace", "agent", "agent-sensitive-name")
    );
}
