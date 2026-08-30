use super::*;

pub(crate) async fn prepare(
    params: OfficeRunParams,
    dispatch_receipt_id: String,
) -> Result<PreparedOfficeRun, JSONRPCErrorError> {
    prepare_with_mode(
        params,
        RunPreparationMode::SubmittedMessage {
            dispatch_receipt_id,
        },
    )
    .await
}

pub(crate) async fn additional_context(
    cwd: &str,
    config: &JsonValue,
    text: &str,
    client_user_message_id: &str,
    locale: Option<&str>,
) -> Result<HashMap<String, AdditionalContextEntry>, JSONRPCErrorError> {
    let mentioned_member_ids = office_message_mentioned_member_ids(config, client_user_message_id)?;
    let submitted_message_intent =
        OfficeMessageIntent::from_canonical_message(config, client_user_message_id)
            .unwrap_or(OfficeMessageIntent::Task);
    let message_intent = active_manager_message_intent(config).unwrap_or(submitted_message_intent);
    let memory_context = if message_intent == OfficeMessageIntent::Conversation {
        office_memory::OfficeMemoryPromptContext::default()
    } else {
        office_memory::build_prompt_context(cwd, config, text, locale).await?
    };
    let context_snapshot = build_office_run_snapshot(
        config,
        locale,
        &memory_context.prompt,
        &mentioned_member_ids,
        message_intent,
    );
    Ok(office_model_additional_context(
        "office_manager_context",
        &context_snapshot,
        MAX_OFFICE_MANAGER_PROMPT_BYTES,
        match message_intent {
            OfficeMessageIntent::Conversation => OfficeContextContract::ManagerConversation,
            OfficeMessageIntent::Task => OfficeContextContract::ManagerTask,
        },
        locale,
    ))
}

fn active_manager_message_intent(config: &JsonValue) -> Option<OfficeMessageIntent> {
    config
        .get("workspace")?
        .get("activity")?
        .get("runs")?
        .as_array()?
        .iter()
        .rev()
        .find(|run| {
            run.get("status").and_then(JsonValue::as_str) == Some("running")
                && run
                    .get("turnId")
                    .and_then(JsonValue::as_str)
                    .is_some_and(|turn_id| !turn_id.trim().is_empty())
        })
        .map(OfficeMessageIntent::from_run)
}
