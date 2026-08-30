use crewon_app_server_protocol::KnowledgeListParams;
use crewon_app_server_protocol::KnowledgeMemoryWriteParams;
use pretty_assertions::assert_eq;
use tempfile::TempDir;

use super::KnowledgeRequestProcessor;
use super::MAX_KNOWLEDGE_FILE_BYTES;
use super::MAX_KNOWLEDGE_NOTE_BYTES;

#[tokio::test]
async fn lists_workspace_knowledge_sources_and_memories() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    std::fs::write(
        temp_dir.path().join("AGENTS.md"),
        "# Rules\n\nUse tools carefully.",
    )
    .expect("write AGENTS.md");
    std::fs::write(
        temp_dir.path().join("README.md"),
        "# Demo\n\nWorkspace overview.",
    )
    .expect("write README.md");
    std::fs::create_dir(temp_dir.path().join("apps")).expect("create apps dir");

    let response = KnowledgeRequestProcessor::new()
        .knowledge_list(KnowledgeListParams {
            cwd: cwd.clone(),
            limit: Some(10),
        })
        .await
        .expect("list knowledge");

    assert_eq!(
        response.data.sources[0].path,
        temp_dir.path().to_string_lossy()
    );
    assert_eq!(response.data.sources[1].name, "AGENTS.md");
    assert_eq!(response.data.sources[2].name, "README.md");
    assert_eq!(response.data.sources[3].name, "apps");
    assert_eq!(response.data.memories[0].title, "Agent Instructions");
    assert!(response.data.memories[0].pinned);
    assert_eq!(response.data.memories[1].title, "Workspace README");
}

#[tokio::test]
async fn writes_knowledge_memory_and_returns_updated_data() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();

    let processor = KnowledgeRequestProcessor::new();
    let response = processor
        .knowledge_memory_write(KnowledgeMemoryWriteParams {
            cwd: cwd.clone(),
            title: Some("Demo session".to_string()),
            thread_id: Some("thread-demo".to_string()),
            note: Some("Remember office recruiting flow.".to_string()),
        })
        .await
        .expect("write knowledge memory");

    let expected_path = temp_dir.path().join(".crewon").join("knowledge.md");
    assert_eq!(response.file_path, expected_path.to_string_lossy());
    let knowledge = std::fs::read_to_string(&expected_path).expect("read knowledge file");
    assert!(knowledge.contains("# Crewon Knowledge"));
    assert!(knowledge.contains("- Session: Demo session"));
    assert!(knowledge.contains("- Thread: thread-demo"));
    assert!(knowledge.contains("- Note: Remember office recruiting flow."));
    assert_eq!(response.data.memories[0].title, "Crewon Knowledge");

    processor
        .knowledge_memory_write(KnowledgeMemoryWriteParams {
            cwd,
            title: Some("Follow-up session".to_string()),
            thread_id: None,
            note: Some("Keep the approved recruiting flow.".to_string()),
        })
        .await
        .expect("append knowledge memory");
    let knowledge = std::fs::read_to_string(expected_path).expect("read appended knowledge file");
    assert!(knowledge.contains("- Note: Remember office recruiting flow."));
    assert!(knowledge.contains("- Note: Keep the approved recruiting flow."));
}

#[tokio::test]
async fn rejects_oversized_knowledge_note_without_creating_file() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();

    let error = KnowledgeRequestProcessor::new()
        .knowledge_memory_write(KnowledgeMemoryWriteParams {
            cwd,
            title: None,
            thread_id: None,
            note: Some("n".repeat(MAX_KNOWLEDGE_NOTE_BYTES + 1)),
        })
        .await
        .expect_err("oversized note should be rejected");

    assert!(error.message.contains("note exceeds"));
    assert!(
        !temp_dir
            .path()
            .join(".crewon")
            .join("knowledge.md")
            .exists()
    );
}

#[tokio::test]
async fn rejects_oversized_existing_knowledge_file_without_replacing_it() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let crewon_dir = temp_dir.path().join(".crewon");
    std::fs::create_dir(&crewon_dir).expect("create .crewon");
    let knowledge_path = crewon_dir.join("knowledge.md");
    let original = "k".repeat(MAX_KNOWLEDGE_FILE_BYTES + 1);
    std::fs::write(&knowledge_path, &original).expect("write oversized knowledge file");

    let error = KnowledgeRequestProcessor::new()
        .knowledge_memory_write(KnowledgeMemoryWriteParams {
            cwd,
            title: None,
            thread_id: None,
            note: Some("new note".to_string()),
        })
        .await
        .expect_err("oversized knowledge file should be rejected");

    assert!(error.message.contains("knowledge.md exceeds"));
    assert_eq!(
        std::fs::read_to_string(knowledge_path).expect("read unchanged knowledge file"),
        original
    );
}
