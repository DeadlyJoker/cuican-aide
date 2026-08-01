use pretty_assertions::assert_eq;
use serde_json::json;

use super::LegacySessionSourceError;
use super::read_legacy_session_source;
use super::session_key;

const NAMESPACE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[tokio::test]
async fn reads_bounded_complete_and_trailing_user_rounds() {
    let home = tempfile::tempdir().expect("temporary legacy root");
    let root = home.path().join("sessions");
    tokio::fs::create_dir_all(&root)
        .await
        .expect("create legacy root");
    write_session(
        &root,
        json!([
            {"role": "user", "content": "first question"},
            {"role": "assistant", "content": "first answer"},
            {"role": "user", "content": "unfinished question"}
        ]),
    )
    .await;

    let source = read_legacy_session_source(
        root,
        NAMESPACE.to_string(),
        /*user_id*/ 42,
        "thread-1".to_string(),
        "agent-1".to_string(),
    )
    .await
    .expect("read legacy session");
    assert_eq!(source.rounds.len(), 2);
    assert_eq!(source.rounds[0].prompt, "first question");
    assert_eq!(source.rounds[0].output.as_deref(), Some("first answer"));
    assert_eq!(source.rounds[1].prompt, "unfinished question");
    assert_eq!(source.rounds[1].output, None);
    assert!(source.source_key.contains(NAMESPACE));
    assert!(source.source_digest.starts_with("sha256:"));
}

#[cfg(unix)]
#[tokio::test]
async fn rejects_a_symlinked_session_file() {
    use std::os::unix::fs::symlink;

    let home = tempfile::tempdir().expect("temporary legacy root");
    let root = home.path().join("sessions");
    tokio::fs::create_dir_all(&root)
        .await
        .expect("create legacy root");
    let outside = home.path().join("outside.json");
    tokio::fs::write(
        &outside,
        serde_json::to_vec(&session(json!([
            {"role": "user", "content": "question"},
            {"role": "assistant", "content": "answer"}
        ])))
        .expect("serialize session"),
    )
    .await
    .expect("write outside session");
    symlink(
        &outside,
        root.join(format!(
            "{}.json",
            session_key(/*user_id*/ 42, "thread-1", "agent-1")
        )),
    )
    .expect("create session symlink");

    let result = read_legacy_session_source(
        root,
        NAMESPACE.to_string(),
        /*user_id*/ 42,
        "thread-1".to_string(),
        "agent-1".to_string(),
    )
    .await;
    assert!(matches!(
        result,
        Err(LegacySessionSourceError::InvalidSource)
    ));
}

async fn write_session(root: &std::path::Path, messages: serde_json::Value) {
    tokio::fs::write(
        root.join(format!(
            "{}.json",
            session_key(/*user_id*/ 42, "thread-1", "agent-1")
        )),
        serde_json::to_vec(&session(messages)).expect("serialize session"),
    )
    .await
    .expect("write legacy session");
}

fn session(messages: serde_json::Value) -> serde_json::Value {
    json!({
        "userId": 42,
        "threadId": "thread-1",
        "agentId": "agent-1",
        "messages": messages
    })
}
