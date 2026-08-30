use crate::MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_SUMMARY_TOKEN_LIMIT;
use crewon_utils_absolute_path::AbsolutePathBuf;
use crewon_utils_output_truncation::TruncationPolicy;
use crewon_utils_output_truncation::truncate_text;
use crewon_utils_template::Template;
use std::sync::LazyLock;
use tokio::fs;

static MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_TEMPLATE: LazyLock<Template> = LazyLock::new(|| {
    parse_embedded_template(
        include_str!("../templates/memories/read_path.md"),
        "memories/read_path.md",
    )
});

const PENDING_MEMORY_SUMMARY_PLACEHOLDER: &str = "No consolidated memory summary is available yet. Pending ad-hoc notes may still contain remembered facts; search them before concluding that memory is empty.";

fn parse_embedded_template(source: &'static str, template_name: &str) -> Template {
    match Template::parse(source) {
        Ok(template) => template,
        Err(err) => panic!("embedded template {template_name} is invalid: {err}"),
    }
}

/// Build the memory read-path prompt that is added to developer instructions.
///
/// Large `memory_summary.md` files are truncated at
/// [MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_SUMMARY_TOKEN_LIMIT].
pub(crate) async fn build_memory_tool_developer_instructions(
    crewon_home: &AbsolutePathBuf,
) -> Option<String> {
    let base_path = crewon_home.join("memories");
    let memory_summary_path = base_path.join("memory_summary.md");
    let memory_summary = fs::read_to_string(&memory_summary_path)
        .await
        .ok()
        .map(|summary| summary.trim().to_string())
        .filter(|summary| !summary.is_empty());
    if memory_summary.is_none() {
        let notes_path = base_path.join("extensions").join("ad_hoc").join("notes");
        let mut entries = fs::read_dir(notes_path).await.ok()?;
        let mut has_ad_hoc_note = false;
        while let Ok(Some(entry)) = entries.next_entry().await {
            let file_name = entry.file_name();
            if file_name.to_string_lossy().starts_with('.') {
                continue;
            }
            if entry
                .file_type()
                .await
                .is_ok_and(|file_type| file_type.is_file())
            {
                has_ad_hoc_note = true;
                break;
            }
        }
        if !has_ad_hoc_note {
            return None;
        }
    }
    let memory_summary =
        memory_summary.unwrap_or_else(|| PENDING_MEMORY_SUMMARY_PLACEHOLDER.to_string());
    let memory_summary = truncate_text(
        &memory_summary,
        TruncationPolicy::Tokens(MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_SUMMARY_TOKEN_LIMIT),
    );
    let base_path = base_path.display().to_string();
    MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_TEMPLATE
        .render([
            ("base_path", base_path.as_str()),
            ("memory_summary", memory_summary.as_str()),
        ])
        .ok()
}

#[cfg(test)]
#[path = "prompts_tests.rs"]
mod tests;
