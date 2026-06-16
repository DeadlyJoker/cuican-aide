use std::io;
use std::path::Path;
use std::path::PathBuf;

use chrono::Utc;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::KnowledgeData;
use crewon_app_server_protocol::KnowledgeEntry;
use crewon_app_server_protocol::KnowledgeListParams;
use crewon_app_server_protocol::KnowledgeListResponse;
use crewon_app_server_protocol::KnowledgeMemoryWriteParams;
use crewon_app_server_protocol::KnowledgeMemoryWriteResponse;
use crewon_app_server_protocol::KnowledgeSource;
use tokio::fs;

use crate::error_code::internal_error;
use crate::error_code::invalid_params;

#[cfg(test)]
#[path = "knowledge_processor_tests.rs"]
mod tests;

const DEFAULT_MEMORY_LIMIT: usize = 24;
const MAX_MEMORY_LIMIT: usize = 100;
const PREVIEW_LIMIT: usize = 220;

#[derive(Default)]
pub(crate) struct KnowledgeRequestProcessor;

impl KnowledgeRequestProcessor {
    pub(crate) fn new() -> Self {
        Self
    }

    pub(crate) async fn knowledge_list(
        &self,
        params: KnowledgeListParams,
    ) -> Result<KnowledgeListResponse, JSONRPCErrorError> {
        list_knowledge(&params.cwd, params.limit)
            .await
            .map(|data| KnowledgeListResponse { data })
    }

    pub(crate) async fn knowledge_memory_write(
        &self,
        params: KnowledgeMemoryWriteParams,
    ) -> Result<KnowledgeMemoryWriteResponse, JSONRPCErrorError> {
        let cwd = workspace_root(&params.cwd)?;
        let crewon_dir = cwd.join(".crewon");
        fs::create_dir_all(&crewon_dir)
            .await
            .map_err(map_io_error)?;
        let file_path = crewon_dir.join("knowledge.md");
        let existing = match fs::read_to_string(&file_path).await {
            Ok(existing) => existing,
            Err(err) if err.kind() == io::ErrorKind::NotFound => String::new(),
            Err(err) => return Err(map_io_error(err)),
        };
        let next = append_memory_entry(
            existing,
            &params.cwd,
            params.title.as_deref(),
            params.thread_id.as_deref(),
            params.note.as_deref(),
        );
        fs::write(&file_path, next).await.map_err(map_io_error)?;
        let data = list_knowledge(&params.cwd, Some(DEFAULT_MEMORY_LIMIT as u32)).await?;
        Ok(KnowledgeMemoryWriteResponse {
            file_path: file_path.to_string_lossy().into_owned(),
            data,
        })
    }
}

async fn list_knowledge(cwd: &str, limit: Option<u32>) -> Result<KnowledgeData, JSONRPCErrorError> {
    let root = workspace_root(cwd)?;
    let root_entries = read_root_entries(&root).await?;
    let sources = build_sources(&root, &root_entries);
    let memories = build_memories(&root, limit).await?;
    Ok(KnowledgeData { memories, sources })
}

fn workspace_root(cwd: &str) -> Result<PathBuf, JSONRPCErrorError> {
    if cwd.trim().is_empty() {
        return Err(invalid_params("cwd must not be empty"));
    }
    let root = PathBuf::from(cwd);
    if !root.is_absolute() {
        return Err(invalid_params("cwd must be an absolute path"));
    }
    Ok(root)
}

async fn read_root_entries(root: &Path) -> Result<Vec<KnowledgeRootEntry>, JSONRPCErrorError> {
    let mut entries = match fs::read_dir(root).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(map_io_error(err)),
    };
    let important_names = [
        ".crewon",
        "AGENTS.md",
        "ARCHITECTURE.md",
        "README.md",
        "README",
        "apps",
        "codex-rs",
        "docs",
        "packages",
        "pnpm-workspace.yaml",
    ];
    let mut visible_entries = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(map_io_error)? {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !important_names.contains(&file_name.as_str()) {
            continue;
        }
        let is_directory = entry
            .file_type()
            .await
            .map(|file_type| file_type.is_dir())
            .unwrap_or(false);
        visible_entries.push(KnowledgeRootEntry {
            file_name,
            is_directory,
        });
    }
    visible_entries.sort_by(|left, right| left.file_name.cmp(&right.file_name));
    Ok(visible_entries)
}

fn build_sources(root: &Path, entries: &[KnowledgeRootEntry]) -> Vec<KnowledgeSource> {
    let mut sources = vec![KnowledgeSource {
        name: root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("workspace")
            .to_string(),
        glyph: "K".to_string(),
        accent: "blue".to_string(),
        status: "indexed".to_string(),
        path: root.to_string_lossy().into_owned(),
        is_directory: true,
        meta: format!("{} indexed entries - app-server knowledge", entries.len()),
    }];
    sources.extend(entries.iter().enumerate().map(|(index, entry)| {
        let path = root.join(&entry.file_name);
        KnowledgeSource {
            name: entry.file_name.clone(),
            glyph: if entry.is_directory { "D" } else { "F" }.to_string(),
            accent: accent(index + 1).to_string(),
            status: "indexed".to_string(),
            path: path.to_string_lossy().into_owned(),
            is_directory: entry.is_directory,
            meta: if entry.is_directory {
                "Directory - available as a knowledge source"
            } else {
                "File - metadata available"
            }
            .to_string(),
        }
    }));
    sources
}

async fn build_memories(
    root: &Path,
    limit: Option<u32>,
) -> Result<Vec<KnowledgeEntry>, JSONRPCErrorError> {
    let paths = [
        root.join("AGENTS.md"),
        root.join("README.md"),
        root.join(".crewon").join("memory.md"),
        root.join(".crewon").join("knowledge.md"),
    ];
    let limit = normalize_limit(limit);
    let mut memories = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        if memories.len() >= limit {
            break;
        }
        let text = match fs::read_to_string(path).await {
            Ok(text) => text,
            Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
            Err(err) => return Err(map_io_error(err)),
        };
        if text.trim().is_empty() {
            continue;
        }
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("memory");
        let is_agents = file_name == "AGENTS.md";
        memories.push(KnowledgeEntry {
            title: knowledge_title(path),
            glyph: if is_agents { "A" } else { "M" }.to_string(),
            accent: if is_agents {
                "amber"
            } else {
                accent(index + 2)
            }
            .to_string(),
            kind: if is_agents {
                "Agent rules"
            } else {
                "Workspace memory"
            }
            .to_string(),
            preview: preview(&text),
            path: path.to_string_lossy().into_owned(),
            meta: format!("{} - {} chars", path.to_string_lossy(), text.len()),
            pinned: is_agents,
        });
    }
    Ok(memories)
}

fn append_memory_entry(
    existing: String,
    cwd: &str,
    title: Option<&str>,
    thread_id: Option<&str>,
    note: Option<&str>,
) -> String {
    let title = title
        .filter(|title| !title.trim().is_empty())
        .unwrap_or("Crewon workspace memory");
    let now = Utc::now().to_rfc3339();
    let mut lines = vec![
        format!("## {now}"),
        String::new(),
        "- Source: Crewon app-server knowledge API".to_string(),
        format!("- Workspace: {cwd}"),
        format!("- Session: {title}"),
    ];
    if let Some(thread_id) = thread_id.filter(|thread_id| !thread_id.trim().is_empty()) {
        lines.push(format!("- Thread: {thread_id}"));
    }
    let note = note.filter(|note| !note.trim().is_empty()).unwrap_or(
        "Backend-connected knowledge memory can be reused by agents, offices, and automations.",
    );
    lines.push(format!("- Note: {note}"));
    lines.push(String::new());
    let entry = lines.join("\n");
    if existing.trim().is_empty() {
        format!("# Crewon Knowledge\n\n{entry}\n")
    } else {
        format!("{}\n\n{entry}\n", existing.trim_end())
    }
}

fn knowledge_title(path: &Path) -> String {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Knowledge");
    match file_name {
        "AGENTS.md" => "Agent Instructions".to_string(),
        "README.md" | "README" => "Workspace README".to_string(),
        "memory.md" => "Crewon Memory".to_string(),
        "knowledge.md" => "Crewon Knowledge".to_string(),
        name => name.to_string(),
    }
}

fn preview(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= PREVIEW_LIMIT {
        return collapsed;
    }
    let mut truncated = collapsed.chars().take(PREVIEW_LIMIT).collect::<String>();
    truncated.push('…');
    truncated
}

fn normalize_limit(limit: Option<u32>) -> usize {
    limit
        .map(|limit| limit.clamp(1, MAX_MEMORY_LIMIT as u32) as usize)
        .unwrap_or(DEFAULT_MEMORY_LIMIT)
}

fn accent(index: usize) -> &'static str {
    const ACCENTS: &[&str] = &["blue", "green", "amber", "violet", "cyan", "rose", "slate"];
    ACCENTS[index % ACCENTS.len()]
}

fn map_io_error(err: io::Error) -> JSONRPCErrorError {
    internal_error(err.to_string())
}

struct KnowledgeRootEntry {
    file_name: String,
    is_directory: bool,
}
