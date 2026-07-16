use crewon_protocol::models::ContentItem;
use crewon_protocol::models::ResponseItem;

/// Removes internal-only content provenance from caller-provided response items.
///
/// Responses API clients normally use `input_text` for non-assistant messages, but the shared
/// wire type can deserialize `output_text` for every role. Internally, non-assistant
/// `OutputText` marks trusted context restored from a Crewon rollout, so external API boundaries
/// must downgrade it before the items enter model-visible history.
pub(super) fn normalize_external_response_items(items: &mut [ResponseItem]) {
    for item in items {
        let ResponseItem::Message { role, content, .. } = item else {
            continue;
        };
        if role == "assistant" {
            continue;
        }
        for content_item in content {
            if let ContentItem::OutputText { text } = content_item {
                *content_item = ContentItem::InputText {
                    text: std::mem::take(text),
                };
            }
        }
    }
}
