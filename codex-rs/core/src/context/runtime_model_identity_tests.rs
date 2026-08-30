use super::*;
use pretty_assertions::assert_eq;

#[test]
fn renders_active_model_identity_as_developer_context() {
    let identity = RuntimeModelIdentity::new("gpt-5.6-codex");

    assert_eq!(
        identity.render(),
        "<runtime_model_identity>\nThe active model identifier for this conversation is `gpt-5.6-codex`. If the user asks which model is running, state this identifier directly. Do not claim that the model identity is unavailable.\n</runtime_model_identity>"
    );
}

#[test]
fn bounds_and_sanitizes_model_identity() {
    let identity = RuntimeModelIdentity::new(&format!("<model>{}", "x".repeat(200)));
    let rendered = identity.render();

    assert!(!rendered.contains("<model>"));
    assert!(rendered.contains("?model?"));
    assert_eq!(identity.model_id.chars().count(), MAX_MODEL_ID_CHARS);
}
