use std::collections::HashSet;

use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;

use super::MAX_MEMORY_CONTENT_CHARS;
use super::MAX_MEMORY_EVIDENCE_REFS;
use super::MAX_MEMORY_KEYWORD_CHARS;
use super::MAX_MEMORY_KEYWORDS;
use super::MAX_MEMORY_PROMPT_BYTES;
use super::MAX_MEMORY_TAG_CHARS;
use super::MAX_OFFICE_MEMORY_INDEX_BYTES;
use super::MAX_OFFICE_MEMORY_ITEMS;
use super::OfficeMemoryEntry;
use super::OfficeMemoryEvidenceRef;
use super::OfficeMemoryIndex;
use super::build_member_prompt_context;
use super::build_prompt_context;
use super::office_memory_index_path;
use super::office_memory_key;
use super::office_memory_keys;
use super::read_office_memory_index;
use super::tokenize_memory_text;
use super::write_office_memory_index;

#[test]
fn stable_record_id_is_primary_while_legacy_memory_keys_remain_readable() {
    let config = json!({
        "id": "legacy-config-id",
        "title": "Memory Office",
        "workspace": {
            "recordId": "record-stable",
            "threadId": "thread-current",
            "activity": {
                "runs": [{ "threadId": "thread-previous" }]
            }
        }
    });

    assert_eq!(office_memory_key(&config), "record-stable");
    assert_eq!(
        office_memory_keys(&config),
        HashSet::from(["record-stable".to_string(), "legacy-config-id".to_string(),])
    );
}

#[test]
fn legacy_thread_keys_do_not_include_the_potentially_colliding_title_key() {
    let config = json!({
        "title": "Shared Office Name",
        "workspace": {
            "recordId": "record-stable",
            "threadId": "thread-current",
            "activity": {
                "runs": [{ "threadId": "thread-previous" }]
            }
        }
    });

    assert_eq!(
        office_memory_keys(&config),
        HashSet::from([
            "record-stable".to_string(),
            "thread-current".to_string(),
            "thread-previous".to_string(),
        ])
    );
}

#[tokio::test]
async fn retrieving_a_legacy_thread_key_migrates_it_to_record_id() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let entry = OfficeMemoryEntry {
        id: "memory-legacy".to_string(),
        office_key: "thread-previous".to_string(),
        scope: "office".to_string(),
        member_id: None,
        member: None,
        agent_id: None,
        kind: "decision".to_string(),
        content: "Keep the stable launch checklist".to_string(),
        confidence: "high".to_string(),
        importance: "high".to_string(),
        status: "accepted".to_string(),
        evidence_refs: Vec::new(),
        keywords: vec!["launch".to_string(), "checklist".to_string()],
        created_at: "2026-07-12T00:00:00Z".to_string(),
        updated_at: "2026-07-12T00:00:00Z".to_string(),
        last_used_at: None,
        usage_count: 0,
    };
    write_office_memory_index(
        &cwd,
        &OfficeMemoryIndex {
            version: 1,
            memories: vec![entry],
        },
    )
    .await
    .expect("seed legacy memory");
    let config = json!({
        "title": "Memory Office",
        "workspace": {
            "recordId": "record-stable",
            "threadId": "thread-current",
            "activity": {
                "runs": [{ "threadId": "thread-previous" }]
            }
        }
    });

    let prompt = build_prompt_context(&cwd, &config, "launch checklist", Some("en"))
        .await
        .expect("retrieve legacy memory");
    assert!(prompt.prompt.contains("Keep the stable launch checklist"));
    let migrated = read_office_memory_index(&cwd)
        .await
        .expect("read migrated memory index");
    assert_eq!(migrated.memories[0].office_key, "record-stable");
}

#[tokio::test]
async fn same_name_members_never_share_private_memory_by_display_name() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let memory = |id: &str, member_id: Option<&str>, agent_id: Option<&str>, content: &str| {
        OfficeMemoryEntry {
            id: id.to_string(),
            office_key: "record-stable".to_string(),
            scope: "member".to_string(),
            member_id: member_id.map(str::to_string),
            member: Some("Reviewer".to_string()),
            agent_id: agent_id.map(str::to_string),
            kind: "fact".to_string(),
            content: content.to_string(),
            confidence: "high".to_string(),
            importance: "high".to_string(),
            status: "accepted".to_string(),
            evidence_refs: Vec::new(),
            keywords: vec!["private".to_string()],
            created_at: "2026-07-12T00:00:00Z".to_string(),
            updated_at: "2026-07-12T00:00:00Z".to_string(),
            last_used_at: None,
            usage_count: 0,
        }
    };
    write_office_memory_index(
        &cwd,
        &OfficeMemoryIndex {
            version: 1,
            memories: vec![
                memory(
                    "memory-a",
                    Some("member-a"),
                    Some("agent-a"),
                    "PRIVATE_A_ONLY",
                ),
                memory(
                    "memory-b",
                    Some("member-b"),
                    Some("agent-b"),
                    "PRIVATE_B_ONLY",
                ),
                memory("memory-legacy", None, None, "AMBIGUOUS_LEGACY_PRIVATE"),
            ],
        },
    )
    .await
    .expect("seed private memories");
    let config = json!({
        "title": "Memory Office",
        "workspace": {
            "recordId": "record-stable",
            "members": [
                { "memberId": "member-a", "name": "Reviewer", "agentId": "agent-a" },
                { "memberId": "member-b", "name": "Reviewer", "agentId": "agent-b" }
            ]
        }
    });

    let prompt = build_member_prompt_context(
        &cwd,
        &config,
        "",
        "Reviewer",
        "agent-a",
        "privateAndShared",
        Some("en"),
    )
    .await
    .expect("build exact private memory context");

    assert!(prompt.prompt.contains("PRIVATE_A_ONLY"));
    assert!(!prompt.prompt.contains("PRIVATE_B_ONLY"));
    assert!(!prompt.prompt.contains("AMBIGUOUS_LEGACY_PRIVATE"));
}

#[tokio::test]
async fn disk_index_and_prompt_fields_are_hard_bounded() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let path = office_memory_index_path(&cwd).expect("memory index path");
    std::fs::create_dir_all(path.parent().expect("memory index parent"))
        .expect("create memory index directory");
    let oversized_keywords = (0..=MAX_MEMORY_KEYWORDS)
        .map(|index| {
            format!(
                "review-{index}-{}",
                "k".repeat(MAX_MEMORY_KEYWORD_CHARS + 10)
            )
        })
        .collect::<Vec<_>>();
    let oversized_evidence = (0..=MAX_MEMORY_EVIDENCE_REFS)
        .map(|index| {
            json!({
                "runId": format!("run-{index}-{}", "r".repeat(200)),
                "threadId": format!("thread-{index}-{}", "t".repeat(200)),
                "turnId": format!("turn-{index}-{}", "u".repeat(200))
            })
        })
        .collect::<Vec<_>>();
    let memories = (0..=MAX_OFFICE_MEMORY_ITEMS)
        .map(|index| {
            let evidence_refs = if index == 0 {
                oversized_evidence.clone()
            } else {
                Vec::new()
            };
            let keywords = if index == 0 {
                oversized_keywords.clone()
            } else {
                vec!["review".to_string()]
            };
            let scope = if index == 0 {
                "s".repeat(MAX_MEMORY_TAG_CHARS + 20)
            } else {
                "office".to_string()
            };
            json!({
                "id": format!("memory-{index}"),
                "officeKey": "office-thread",
                "scope": scope,
                "member": "m".repeat(200),
                "agentId": "agent-reviewer",
                "kind": "k".repeat(MAX_MEMORY_TAG_CHARS + 20),
                "content": format!("Review check {index} {}", "c".repeat(MAX_MEMORY_CONTENT_CHARS + 20)),
                "confidence": "high",
                "importance": "high",
                "status": "accepted",
                "evidenceRefs": evidence_refs,
                "keywords": keywords,
                "createdAt": "2026-07-12T00:00:00Z",
                "updatedAt": "2026-07-12T00:00:00Z",
                "lastUsedAt": null,
                "usageCount": 0
            })
        })
        .collect::<Vec<_>>();
    std::fs::write(
        &path,
        serde_json::to_vec(&json!({ "version": 1, "memories": memories }))
            .expect("serialize oversized index"),
    )
    .expect("write oversized index");

    let index = read_office_memory_index(&cwd)
        .await
        .expect("read bounded index");
    assert_eq!(index.memories.len(), MAX_OFFICE_MEMORY_ITEMS);
    let first = &index.memories[0];
    assert_eq!(first.scope.chars().count(), MAX_MEMORY_TAG_CHARS);
    assert_eq!(first.kind.chars().count(), MAX_MEMORY_TAG_CHARS);
    assert_eq!(first.content.chars().count(), MAX_MEMORY_CONTENT_CHARS);
    assert_eq!(first.keywords.len(), MAX_MEMORY_KEYWORDS);
    assert!(
        first
            .keywords
            .iter()
            .all(|keyword| keyword.chars().count() <= MAX_MEMORY_KEYWORD_CHARS)
    );
    assert_eq!(first.evidence_refs.len(), MAX_MEMORY_EVIDENCE_REFS);

    let prompt = build_prompt_context(
        &cwd,
        &json!({
            "title": "Bounded Office",
            "workspace": { "threadId": "office-thread" }
        }),
        "review checks",
        Some("en"),
    )
    .await
    .expect("build bounded prompt");
    let ref_count = prompt
        .refs
        .expect("memory refs")
        .as_array()
        .map(Vec::len)
        .expect("memory ref array");
    assert_eq!(
        (
            ref_count > 0,
            ref_count <= 6,
            prompt.prompt.len() <= MAX_MEMORY_PROMPT_BYTES,
        ),
        (true, true, true)
    );
    assert!(
        !prompt
            .prompt
            .contains(&"k".repeat(MAX_MEMORY_TAG_CHARS + 1))
    );
    assert!(!prompt.prompt.contains(&"m".repeat(81)));
}

#[tokio::test]
async fn oversized_disk_index_is_ignored_before_deserialization() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let path = office_memory_index_path(&cwd).expect("memory index path");
    std::fs::create_dir_all(path.parent().expect("memory index parent"))
        .expect("create memory index directory");
    std::fs::write(
        path,
        vec![b' '; usize::try_from(MAX_OFFICE_MEMORY_INDEX_BYTES).unwrap() + 1],
    )
    .expect("write oversized memory index");

    let index = read_office_memory_index(&cwd)
        .await
        .expect("ignore oversized index");
    assert!(index.memories.is_empty());
}

#[tokio::test]
async fn written_memory_index_never_exceeds_its_read_limit() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let escaped = |count| "\0".repeat(count);
    let evidence_ref = OfficeMemoryEvidenceRef {
        run_id: Some(escaped(/*count*/ 160)),
        thread_id: Some(escaped(/*count*/ 160)),
        turn_id: Some(escaped(/*count*/ 160)),
    };
    let entry = OfficeMemoryEntry {
        id: escaped(/*count*/ 160),
        office_key: escaped(/*count*/ 160),
        scope: escaped(/*count*/ 80),
        member_id: None,
        member: Some(escaped(/*count*/ 80)),
        agent_id: Some(escaped(/*count*/ 160)),
        kind: escaped(/*count*/ 80),
        content: escaped(/*count*/ 360),
        confidence: escaped(/*count*/ 80),
        importance: escaped(/*count*/ 80),
        status: escaped(/*count*/ 80),
        evidence_refs: vec![evidence_ref; 8],
        keywords: vec![escaped(/*count*/ 80); 16],
        created_at: escaped(/*count*/ 64),
        updated_at: escaped(/*count*/ 64),
        last_used_at: Some(escaped(/*count*/ 64)),
        usage_count: 0,
    };
    let index = OfficeMemoryIndex {
        version: 1,
        memories: vec![entry; 256],
    };

    write_office_memory_index(&cwd, &index)
        .await
        .expect("write byte-bounded memory index");
    let path = office_memory_index_path(&cwd).expect("memory index path");
    assert!(
        std::fs::metadata(path)
            .expect("memory index metadata")
            .len()
            <= MAX_OFFICE_MEMORY_INDEX_BYTES
    );
    let read_back = read_office_memory_index(&cwd)
        .await
        .expect("read byte-bounded memory index");
    assert!(!read_back.memories.is_empty() && read_back.memories.len() < index.memories.len());
}

#[test]
fn office_plural_normalization_is_bounded_to_known_terms() {
    let policy_terms = tokenize_memory_text("policy policies check checks");
    assert!(policy_terms.contains("policy"));
    assert!(policy_terms.contains("check"));

    let news_terms = tokenize_memory_text("news");
    assert!(news_terms.contains("news"));
    assert!(!news_terms.contains("new"));
}
