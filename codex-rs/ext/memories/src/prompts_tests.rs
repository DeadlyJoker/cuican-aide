use super::*;
use crewon_utils_absolute_path::AbsolutePathBuf;
use pretty_assertions::assert_eq;
use tempfile::tempdir;
use tokio::fs as tokio_fs;

#[tokio::test]
async fn build_memory_tool_developer_instructions_renders_embedded_template() {
    let temp = tempdir().unwrap();
    let crewon_home = AbsolutePathBuf::from_absolute_path(temp.path()).unwrap();
    let memories_dir = crewon_home.join("memories");
    tokio_fs::create_dir_all(&memories_dir).await.unwrap();
    tokio_fs::write(
        memories_dir.join("memory_summary.md"),
        "Short memory summary for tests.",
    )
    .await
    .unwrap();

    let instructions = build_memory_tool_developer_instructions(&crewon_home)
        .await
        .unwrap();

    assert!(instructions.contains(&format!(
        "- {}/memory_summary.md (already provided below; do NOT open again)",
        memories_dir.display()
    )));
    assert!(instructions.contains("Short memory summary for tests."));
    assert!(instructions.contains("extensions/ad_hoc/notes/"));
    assert!(instructions.contains("You MUST search memory"));
    assert_eq!(
        instructions
            .matches("========= MEMORY_SUMMARY BEGINS =========")
            .count(),
        1
    );
}

#[tokio::test]
async fn build_memory_tool_developer_instructions_uses_pending_notes_without_summary() {
    let temp = tempdir().unwrap();
    let crewon_home = AbsolutePathBuf::from_absolute_path(temp.path()).unwrap();
    let notes_dir = crewon_home.join("memories/extensions/ad_hoc/notes");
    tokio_fs::create_dir_all(&notes_dir).await.unwrap();
    tokio_fs::write(
        notes_dir.join("2026-08-03T06-40-42-favorite-fruit.md"),
        "User preference: likes apples.",
    )
    .await
    .unwrap();

    let instructions = build_memory_tool_developer_instructions(&crewon_home)
        .await
        .unwrap();

    assert!(instructions.contains(PENDING_MEMORY_SUMMARY_PLACEHOLDER));
    assert!(instructions.contains("extensions/ad_hoc/notes/"));
    assert!(!instructions.contains("likes apples"));
}

#[tokio::test]
async fn build_memory_tool_developer_instructions_skips_empty_memory_root() {
    let temp = tempdir().unwrap();
    let crewon_home = AbsolutePathBuf::from_absolute_path(temp.path()).unwrap();

    assert_eq!(
        build_memory_tool_developer_instructions(&crewon_home).await,
        None
    );
}
