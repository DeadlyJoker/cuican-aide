use crewon_provider_agent_platform::AgentPlatformIdentitySourceClient;
use crewon_provider_agent_platform::IdentitySourceAuthorizer;
use crewon_provider_agent_platform::PrincipalRevocationCursor;
use crewon_provider_agent_platform::PrincipalRevocationReadPage;
use crewon_provider_agent_platform::PrincipalRevocationSnapshotPage;

use super::principal_revocation_listener::PrincipalRevocationFeed;
use super::principal_revocation_listener::PrincipalRevocationFeedError;

impl<Authorizer> PrincipalRevocationFeed for AgentPlatformIdentitySourceClient<Authorizer>
where
    Authorizer: IdentitySourceAuthorizer,
{
    async fn snapshot(
        &self,
        after_sequence: u64,
        watermark_sequence: Option<u64>,
        limit: u32,
        now: i64,
    ) -> Result<PrincipalRevocationSnapshotPage, PrincipalRevocationFeedError> {
        self.principal_revocation_snapshot(after_sequence, watermark_sequence, limit, now)
            .await
            .map_err(|_| PrincipalRevocationFeedError::Unavailable)
    }

    async fn read(
        &self,
        cursor: &PrincipalRevocationCursor,
        limit: u32,
        now: i64,
    ) -> Result<PrincipalRevocationReadPage, PrincipalRevocationFeedError> {
        self.principal_revocation_read(cursor, limit, now)
            .await
            .map_err(|_| PrincipalRevocationFeedError::Unavailable)
    }
}
