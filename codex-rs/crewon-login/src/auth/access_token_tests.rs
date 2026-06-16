use super::*;

#[test]
fn classifies_personal_access_tokens_by_prefix() {
    assert!(matches!(
        classify_crewon_access_token("at-example"),
        CrewonAccessToken::PersonalAccessToken("at-example")
    ));
    assert!(matches!(
        classify_crewon_access_token("header.payload.signature"),
        CrewonAccessToken::AgentIdentityJwt("header.payload.signature")
    ));
}
