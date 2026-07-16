use super::*;

pub(super) struct ValidatedSubmit {
    pub(super) cwd: String,
    pub(super) config: JsonValue,
    pub(super) text: String,
    pub(super) client_user_message_id: String,
    pub(super) locale: Option<String>,
    pub(super) thread_id: Option<String>,
    pub(super) mentions: Vec<String>,
    pub(super) payload_hash: String,
    pub(super) receipt_id: String,
    pub(super) message_id: String,
}

pub(super) fn validate_submit(
    params: OfficeMessageSubmitParams,
) -> Result<ValidatedSubmit, JSONRPCErrorError> {
    if !DomainKind::Office.config_matches(&params.config) {
        return Err(invalid_params("office config is missing required fields"));
    }
    let record_id = office_record_id(&params.config)
        .ok_or_else(|| invalid_params("workspace.recordId is required to submit a message"))?;
    let text = params.text.trim().to_string();
    if text.is_empty() || text.len() > MAX_TEXT_BYTES {
        return Err(invalid_params(format!(
            "text must be non-empty and at most {MAX_TEXT_BYTES} UTF-8 bytes"
        )));
    }
    let client_id = params.client_user_message_id;
    if client_id.is_empty()
        || client_id != client_id.trim()
        || client_id.len() > MAX_CLIENT_ID_BYTES
        || client_id.chars().any(char::is_control)
    {
        return Err(invalid_params(
            "clientUserMessageId must be trimmed, non-empty, and at most 256 UTF-8 bytes",
        ));
    }
    let thread_id = params
        .thread_id
        .map(|thread_id| thread_id.trim().to_string())
        .filter(|thread_id| !thread_id.is_empty());
    if thread_id.as_ref().is_some_and(|thread_id| {
        thread_id.len() > MAX_CLIENT_ID_BYTES || thread_id.chars().any(char::is_control)
    }) {
        return Err(invalid_params(
            "threadId must be at most 256 UTF-8 bytes and contain no control characters",
        ));
    }
    if !matches!(params.locale.as_deref(), None | Some("zh" | "en")) {
        return Err(invalid_params("locale must be `zh`, `en`, or omitted"));
    }
    let mentions = validate_mentions(params.mentions.unwrap_or_default())?;
    let payload = serde_json::to_vec(&json!({
        "text": &text,
        "threadId": &thread_id,
        "mentions": &mentions,
    }))
    .map_err(|error| internal_error(format!("failed to hash Office message payload: {error}")))?;
    let payload_hash = sha256_hex(&payload);
    let identity_hash = sha256_hex(format!("{record_id}\0{client_id}").as_bytes());
    Ok(ValidatedSubmit {
        cwd: params.cwd,
        config: params.config,
        text,
        client_user_message_id: client_id,
        locale: params.locale,
        thread_id,
        mentions,
        payload_hash,
        receipt_id: format!("office-message-receipt-{identity_hash}"),
        message_id: format!("office-message-{identity_hash}"),
    })
}

fn validate_mentions(
    mentions: Vec<OfficeMessageMention>,
) -> Result<Vec<String>, JSONRPCErrorError> {
    if mentions.len() > MAX_MENTIONS {
        return Err(invalid_params("mentions exceeds the 16-item limit"));
    }
    let mut validated = Vec::with_capacity(mentions.len());
    for mention in mentions {
        let member_id = mention.member_id;
        if member_id.is_empty()
            || member_id != member_id.trim()
            || member_id.len() > MAX_MEMBER_ID_BYTES
            || member_id.chars().any(char::is_control)
            || validated.iter().any(|existing| existing == &member_id)
        {
            let mut error =
                invalid_params("mentions must reference distinct, exact workspace memberId values");
            error.data = Some(json!({
                "type": "officeMessageMentionInvalid",
                "memberId": member_id,
            }));
            return Err(error);
        }
        validated.push(member_id);
    }
    Ok(validated)
}

pub(super) fn input_for_mutation(input: &ValidatedSubmit) -> ValidatedSubmit {
    ValidatedSubmit {
        cwd: input.cwd.clone(),
        config: JsonValue::Null,
        text: input.text.clone(),
        client_user_message_id: input.client_user_message_id.clone(),
        locale: input.locale.clone(),
        thread_id: input.thread_id.clone(),
        mentions: input.mentions.clone(),
        payload_hash: input.payload_hash.clone(),
        receipt_id: input.receipt_id.clone(),
        message_id: input.message_id.clone(),
    }
}
