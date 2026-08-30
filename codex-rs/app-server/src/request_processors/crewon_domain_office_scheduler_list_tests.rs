use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;

use super::list_office_records_for_scheduler;
use super::office_record_id;

#[tokio::test]
async fn stable_record_cursor_reaches_pending_offices_after_the_default_24() {
    let workspace = TempDir::new().expect("temporary workspace");
    let office_directory = workspace.path().join(".crewon").join("offices");
    std::fs::create_dir_all(&office_directory).expect("create Office directory");
    for index in 0..30 {
        let record_id = format!("record-{index:03}");
        let persisted = json!({
            "version": 1,
            "kind": "office",
            "savedAt": format!("2026-07-13T00:00:{:02}.000Z", 29 - index),
            "config": {
                "title": format!("Office {index:03}"),
                "workspace": {
                    "recordId": record_id,
                    "members": [{
                        "agentId": format!("agent-{index:03}"),
                        "runtime": { "threadId": format!("runtime-{index:03}") }
                    }],
                    "activity": {
                        "runs": [{
                            "status": "completed",
                            "delegations": [{
                                "agentId": format!("agent-{index:03}"),
                                "status": "pending",
                                "task": format!("Pending tail task {index:03}")
                            }]
                        }]
                    }
                }
            }
        });
        std::fs::write(
            office_directory.join(format!("office-{index:03}.json")),
            serde_json::to_vec_pretty(&persisted).expect("serialize Office record"),
        )
        .expect("write Office record");
    }
    let cwd = workspace.path().to_string_lossy();

    let (first_page, first_cursor) =
        list_office_records_for_scheduler(&cwd, None, /*limit*/ 24)
            .await
            .expect("list first scheduler page");
    let (tail_page, tail_cursor) =
        list_office_records_for_scheduler(&cwd, first_cursor.as_deref(), /*limit*/ 24)
            .await
            .expect("list scheduler tail page");

    assert_eq!(first_page.len(), 24);
    assert_eq!(first_cursor.as_deref(), Some("record-023"));
    assert_eq!(
        tail_page
            .iter()
            .filter_map(|record| office_record_id(&record.config))
            .collect::<Vec<_>>(),
        vec![
            "record-024",
            "record-025",
            "record-026",
            "record-027",
            "record-028",
            "record-029",
        ]
    );
    assert_eq!(tail_cursor, None);
    assert_eq!(
        tail_page
            .last()
            .and_then(|record| record
                .config
                .pointer("/workspace/activity/runs/0/delegations/0/status"))
            .and_then(serde_json::Value::as_str),
        Some("pending")
    );
}
