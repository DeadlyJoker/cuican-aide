use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;
use ts_rs::TS;

use super::Turn;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase", export_to = "v2/")]
pub struct OfficeMessageMention {
    pub member_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", export_to = "v2/")]
pub enum OfficeMessageProcessingPhase {
    Reserved,
    Dispatching,
    Recovering,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(tag = "type", rename_all = "camelCase", export_to = "v2/")]
pub enum OfficeMessageDelivery {
    #[serde(rename_all = "camelCase")]
    #[ts(rename_all = "camelCase")]
    Processing {
        phase: OfficeMessageProcessingPhase,
        retry_after_ms: u32,
    },
    #[serde(rename_all = "camelCase")]
    #[ts(rename_all = "camelCase")]
    RunStarted {
        run_id: String,
        thread_id: String,
        turn: Turn,
    },
    #[serde(rename_all = "camelCase")]
    #[ts(rename_all = "camelCase")]
    InteractionStarted {
        interaction_id: String,
        thread_id: String,
        turn: Turn,
    },
    #[serde(rename_all = "camelCase")]
    #[ts(rename_all = "camelCase")]
    Steered {
        run_id: String,
        thread_id: String,
        turn_id: String,
    },
    #[serde(rename_all = "camelCase")]
    #[ts(rename_all = "camelCase")]
    Queued { after_run_id: String, position: u32 },
    #[serde(rename_all = "camelCase")]
    #[ts(rename_all = "camelCase")]
    Answered {
        interaction_id: String,
        thread_id: String,
        turn_id: String,
    },
    #[serde(rename_all = "camelCase")]
    #[ts(rename_all = "camelCase")]
    Failed {
        code: String,
        message: String,
        retryable: bool,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(rename_all = "camelCase", export_to = "v2/")]
pub struct OfficeMessageSubmitParams {
    pub cwd: String,
    pub config: JsonValue,
    pub text: String,
    pub client_user_message_id: String,
    #[ts(optional = nullable)]
    pub locale: Option<String>,
    #[ts(optional = nullable)]
    pub thread_id: Option<String>,
    #[ts(optional = nullable)]
    pub mentions: Option<Vec<OfficeMessageMention>>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", export_to = "v2/")]
pub struct OfficeMessageSubmitResponse {
    pub file_path: String,
    pub config: JsonValue,
    pub receipt_id: String,
    pub client_user_message_id: String,
    pub replayed: bool,
    pub delivery: OfficeMessageDelivery,
}

#[cfg(test)]
#[path = "crewon_domain_office_message_tests.rs"]
mod tests;
