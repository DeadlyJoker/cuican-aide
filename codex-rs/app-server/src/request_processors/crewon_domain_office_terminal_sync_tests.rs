use std::time::Duration;

use crewon_app_server_protocol::Turn;
use crewon_app_server_protocol::TurnItemsView;
use crewon_app_server_protocol::TurnStatus;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;
use tokio::time::timeout;

use super::CrewonDomainRequestProcessor;
use super::OfficeCreateParams;
use super::OfficeRunParams;

#[tokio::test]
async fn terminal_sync_completes_and_persists_the_exact_office_record() {
    let workspace = TempDir::new().expect("create workspace");
    let cwd = workspace.path().to_string_lossy().into_owned();
    let processor = CrewonDomainRequestProcessor::new();
    let created = processor
        .office_create(OfficeCreateParams {
            cwd: cwd.clone(),
            title: "Terminal Sync Office".to_string(),
            subtitle: None,
            thread_id: Some("thread-terminal-sync".to_string()),
            goal: Some("Persist terminal turn state".to_string()),
        })
        .await
        .expect("create Office");
    let permitted = processor
        .office_run_prepare_permitted(OfficeRunParams {
            cwd: cwd.clone(),
            config: created.config,
            message: json!({
                "author": "User",
                "glyph": "@",
                "accent": "slate",
                "time": "now",
                "kind": "message",
                "text": "Complete this run"
            }),
            text: "Complete this run".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: Some("terminal-sync-message".to_string()),
        })
        .await
        .expect("prepare Office run");
    let run_id = permitted.prepared().run_id.clone();
    processor
        .office_run_mark_started_permitted(permitted, "turn-terminal-sync")
        .await
        .expect("mark Office run started");

    let completed_turn = Turn {
        id: "turn-terminal-sync".to_string(),
        items: Vec::new(),
        items_view: TurnItemsView::Full,
        error: None,
        status: TurnStatus::Completed,
        started_at: None,
        completed_at: None,
        duration_ms: None,
    };
    let updates = timeout(
        Duration::from_secs(2),
        processor.sync_office_run_updates_for_thread_turn(
            &cwd,
            "thread-terminal-sync",
            &completed_turn,
        ),
    )
    .await
    .expect("terminal sync must not deadlock")
    .expect("terminal sync must succeed");

    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0].file_path, created.file_path);
    let run = updates[0].config["workspace"]["activity"]["runs"]
        .as_array()
        .expect("Office runs")
        .iter()
        .find(|run| run["id"] == run_id)
        .expect("synced run");
    assert_eq!(run["status"], json!("completed"));
}
