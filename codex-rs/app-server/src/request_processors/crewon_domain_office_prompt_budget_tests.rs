use pretty_assertions::assert_eq;

use super::truncate_middle_utf8_bytes;
use super::truncate_utf8_bytes;

#[test]
fn office_prompt_budgets_are_hard_utf8_byte_caps() {
    let value = format!("HEAD-{}-TAIL", "🧪界".repeat(/*n*/ 4_000));
    let prefix = truncate_utf8_bytes(&value, /*max_bytes*/ 2_000);
    let middle = truncate_middle_utf8_bytes(&value, /*max_bytes*/ 2_000);

    assert_eq!(
        (prefix.len() <= 2_000, prefix.is_char_boundary(prefix.len())),
        (true, true)
    );
    assert_eq!(
        (middle.len() <= 2_000, middle.is_char_boundary(middle.len())),
        (true, true)
    );
    assert!(middle.starts_with("HEAD-"));
    assert!(middle.ends_with("-TAIL"));
}
