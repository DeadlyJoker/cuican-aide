use sqlx::QueryBuilder;
use sqlx::Row;
use sqlx::Sqlite;

use super::StateRuntime;
use super::cloud_agent_turn::additional_outputs;
use super::cloud_agent_turn::turn_from_row;
use crate::CloudAgentTurnPage;
use crate::CloudAgentTurnPageQuery;
use crate::CloudAgentTurnSortDirection;

const TURN_COLUMNS: &str = r#"
turn_id, thread_id, client_user_message_id, origin_kind, task_id, import_id,
local_actor_id, local_tenant_id, local_space_id, workspace_key,
execution_binding_id, execution_binding_revision,
prompt_artifact_id, prompt_artifact_revision, status, last_provider_sequence,
primary_output_artifact_id, primary_output_artifact_revision,
error_code, trace_id, revision, creation_digest, record_hash,
created_at, updated_at, completed_at
"#;

impl StateRuntime {
    /// Lists one bounded page of Cloud Agent Turns using a stable `(createdAt, turnId)` order.
    pub async fn list_cloud_agent_turn_page(
        &self,
        query: &CloudAgentTurnPageQuery,
    ) -> anyhow::Result<CloudAgentTurnPage> {
        query.validate()?;
        let anchor = match query.anchor.as_ref() {
            Some(anchor) => Some(
                sqlx::query(
                    "SELECT created_at, turn_id FROM cloud_agent_turns WHERE thread_id = ? AND turn_id = ?",
                )
                .bind(&query.thread_id)
                .bind(&anchor.turn_id)
                .fetch_optional(self.pool.as_ref())
                .await?
                .ok_or_else(|| anyhow::anyhow!("Cloud Agent Turn page anchor was not found"))?,
            ),
            None => None,
        };

        let mut builder = QueryBuilder::<Sqlite>::new("SELECT ");
        builder.push(TURN_COLUMNS);
        builder.push(" FROM cloud_agent_turns WHERE thread_id = ");
        builder.push_bind(&query.thread_id);
        if let (Some(anchor), Some(anchor_query)) = (anchor, query.anchor.as_ref()) {
            let created_at: i64 = anchor.try_get("created_at")?;
            let turn_id: String = anchor.try_get("turn_id")?;
            let comparison = match (query.sort_direction, anchor_query.include_anchor) {
                (CloudAgentTurnSortDirection::Asc, true) => ">=",
                (CloudAgentTurnSortDirection::Asc, false) => ">",
                (CloudAgentTurnSortDirection::Desc, true) => "<=",
                (CloudAgentTurnSortDirection::Desc, false) => "<",
            };
            builder.push(" AND (created_at, turn_id) ");
            builder.push(comparison);
            builder.push(" (");
            builder.push_bind(created_at);
            builder.push(", ");
            builder.push_bind(turn_id);
            builder.push(")");
        }
        match query.sort_direction {
            CloudAgentTurnSortDirection::Asc => {
                builder.push(" ORDER BY created_at ASC, turn_id ASC");
            }
            CloudAgentTurnSortDirection::Desc => {
                builder.push(" ORDER BY created_at DESC, turn_id DESC");
            }
        }
        builder.push(" LIMIT ");
        builder.push_bind(i64::from(query.limit) + 1);
        let mut rows = builder.build().fetch_all(self.pool.as_ref()).await?;
        let has_more = rows.len() > query.limit as usize;
        rows.truncate(query.limit as usize);

        let mut data = Vec::with_capacity(rows.len());
        for row in rows {
            let turn_id: String = row.try_get("turn_id")?;
            let additional = additional_outputs(self.pool.as_ref(), &turn_id).await?;
            let record = turn_from_row(row, additional)?;
            record.validate()?;
            data.push(record);
        }
        Ok(CloudAgentTurnPage { data, has_more })
    }
}

#[cfg(test)]
#[path = "cloud_agent_turn_page_tests.rs"]
mod tests;
