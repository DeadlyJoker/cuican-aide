use super::MemoriesUsageKind;
use super::memories_usage_kinds_from_command;
use pretty_assertions::assert_eq;

#[test]
fn classifies_searches_of_pending_ad_hoc_notes() {
    let command = [
        "grep",
        "-R",
        "apple",
        "/tmp/crewon/memories/extensions/ad_hoc/notes",
    ]
    .map(str::to_string);

    assert_eq!(
        memories_usage_kinds_from_command(&command),
        vec![MemoriesUsageKind::AdHocNotes]
    );
}
