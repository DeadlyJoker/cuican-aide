use crewon_app_server_protocol::KnowledgeListParams;
use crewon_app_server_protocol::KnowledgeMemoryWriteParams;
use pretty_assertions::assert_eq;
use tempfile::TempDir;

use super::KnowledgeRequestProcessor;

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

    let response = KnowledgeRequestProcessor::new()
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
    let knowledge = std::fs::read_to_string(expected_path).expect("read knowledge file");
    assert!(knowledge.contains("# Crewon Knowledge"));
    assert!(knowledge.contains("- Session: Demo session"));
    assert!(knowledge.contains("- Thread: thread-demo"));
    assert!(knowledge.contains("- Note: Remember office recruiting flow."));
    assert_eq!(response.data.memories[0].title, "Crewon Knowledge");
}
