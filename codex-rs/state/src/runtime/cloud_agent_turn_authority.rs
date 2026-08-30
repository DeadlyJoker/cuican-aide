use super::provider_access_grant::grant_from_row;
use super::provider_access_grant::grant_query;
use super::provider_connection::connection_by_id;
use super::provider_identity::binding_from_row as identity_from_row;
use crate::CloudAgentTurnCreateBundle;
use crate::ProviderAccessGrantStatus;
use crate::ProviderIdentityBindingStatus;
use crate::ProviderResourceBindingRecord;

pub(super) async fn cloud_agent_authority_is_current(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    execution_binding: &ProviderResourceBindingRecord,
    bundle: &CloudAgentTurnCreateBundle,
    authorized_at: i64,
) -> anyhow::Result<bool> {
    let Some(connection) = connection_by_id(tx, &execution_binding.connection_id).await? else {
        return Ok(false);
    };
    if connection.local_actor_id != bundle.turn.local_actor_id
        || connection.local_tenant_id != bundle.turn.local_tenant_id
        || connection.local_space_id != bundle.turn.local_space_id
        || connection.provider_id != bundle.execution_spec.provider_id
        || connection.protocol_version != bundle.execution_spec.protocol_version
        || connection.credential_id != bundle.execution_spec.credential_id
        || connection.credential_revision != bundle.execution_spec.credential_revision
        || connection.created_at > authorized_at
    {
        return Ok(false);
    }
    let grant = grant_query()
        .bind(&bundle.execution_spec.credential_id)
        .fetch_optional(&mut **tx)
        .await?
        .map(grant_from_row)
        .transpose()?;
    let Some(grant) = grant else {
        return Ok(false);
    };
    if grant.status != ProviderAccessGrantStatus::Active
        || grant.local_actor_id != bundle.turn.local_actor_id
        || grant.local_tenant_id != bundle.turn.local_tenant_id
        || grant.local_space_id != bundle.turn.local_space_id
        || grant.provider_id != bundle.execution_spec.provider_id
        || grant.revision != bundle.execution_spec.credential_revision
        || grant.created_at > authorized_at
        || grant.expires_at <= authorized_at
    {
        return Ok(false);
    }
    let identity = sqlx::query(
        r#"
SELECT binding_id, local_actor_id, local_tenant_id, local_space_id, provider_id,
       provider_subject, provider_tenant_id, provider_space_id, authority_id,
       source_binding_id, source_revision, source_fresh_until, revision, status, record_hash,
       created_at, updated_at
FROM provider_identity_bindings
WHERE local_actor_id = ? AND local_tenant_id = ? AND local_space_id = ?
  AND provider_id = ? AND status = 'active' AND source_fresh_until > ?
        "#,
    )
    .bind(&bundle.turn.local_actor_id)
    .bind(&bundle.turn.local_tenant_id)
    .bind(&bundle.turn.local_space_id)
    .bind(&bundle.execution_spec.provider_id)
    .bind(authorized_at)
    .fetch_optional(&mut **tx)
    .await?
    .map(identity_from_row)
    .transpose()?;
    Ok(identity.is_some_and(|identity| {
        identity.status == ProviderIdentityBindingStatus::Active
            && identity.source_binding_id == grant.source_binding_id
            && identity.source_revision == grant.source_revision
            && identity.created_at <= authorized_at
    }))
}
