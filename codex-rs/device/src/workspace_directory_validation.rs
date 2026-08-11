use serde::Serialize;

use super::OUTPUT_SCHEMA_VERSION;
use super::WorkspaceDirectoryBinding;
use super::WorkspaceDirectoryEntry;
use super::WorkspaceDirectoryEntryKind;
use super::WorkspaceDirectoryError;

pub(super) fn entry_from_utf8_bytes(
    name_bytes: &[u8],
    kind: WorkspaceDirectoryEntryKind,
    max_name_bytes: usize,
) -> Result<WorkspaceDirectoryEntry, WorkspaceDirectoryError> {
    if name_bytes.is_empty() || name_bytes.len() > max_name_bytes {
        return Err(WorkspaceDirectoryError::new(
            "workspace_list_entry_name_invalid",
        ));
    }
    let name = std::str::from_utf8(name_bytes).map_err(|error| {
        WorkspaceDirectoryError::with_source("workspace_list_entry_name_invalid", error)
    })?;
    if name == "."
        || name == ".."
        || name
            .chars()
            .any(|character| is_unsafe_name_character(character) || matches!(character, '/' | '\\'))
    {
        return Err(WorkspaceDirectoryError::new(
            "workspace_list_entry_name_invalid",
        ));
    }
    Ok(WorkspaceDirectoryEntry {
        name: name.to_string(),
        kind,
    })
}

pub(super) fn require_output_bound(
    entries: &[WorkspaceDirectoryEntry],
    truncated: bool,
    maximum: usize,
) -> Result<(), WorkspaceDirectoryError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct OutputAuthority<'a> {
        schema_version: &'static str,
        entries: &'a [WorkspaceDirectoryEntry],
        truncated: bool,
    }
    let encoded = serde_json::to_vec(&OutputAuthority {
        schema_version: OUTPUT_SCHEMA_VERSION,
        entries,
        truncated,
    })
    .map_err(|error| {
        WorkspaceDirectoryError::with_source("workspace_list_result_invalid", error)
    })?;
    if encoded.len() > maximum {
        return Err(WorkspaceDirectoryError::new(
            "workspace_list_output_too_large",
        ));
    }
    Ok(())
}

pub(super) fn validate_binding(
    binding: &WorkspaceDirectoryBinding,
) -> Result<(), WorkspaceDirectoryError> {
    require_opaque_id(&binding.workspace_binding_id, "workspace_binding_invalid")?;
    require_opaque_id(&binding.incarnation_id, "workspace_binding_invalid")
}

pub(super) fn require_opaque_id(
    value: &str,
    code: &'static str,
) -> Result<(), WorkspaceDirectoryError> {
    let mut bytes = value.bytes();
    if value.len() > 512
        || !bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        || !bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(WorkspaceDirectoryError::new(code));
    }
    Ok(())
}

fn is_unsafe_name_character(character: char) -> bool {
    character.is_control()
        || matches!(
            character as u32,
            0x00AD
                | 0x061C
                | 0x06DD
                | 0x070F
                | 0x08E2
                | 0x180E
                | 0x200B..=0x200F
                | 0x2028..=0x202E
                | 0x2060..=0x2064
                | 0x2066..=0x206F
                | 0xFEFF
                | 0xFFF9..=0xFFFB
                | 0x110BD
                | 0x110CD
                | 0x13430..=0x1343F
                | 0x1BCA0..=0x1BCA3
                | 0x1D173..=0x1D17A
                | 0xE0001
                | 0xE0020..=0xE007F
                | 0x0600..=0x0605
                | 0x0890..=0x0891
        )
}
