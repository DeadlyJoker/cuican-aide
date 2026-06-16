const PERSONAL_ACCESS_TOKEN_PREFIX: &str = "at-";

pub(super) enum CrewonAccessToken<'a> {
    PersonalAccessToken(&'a str),
    AgentIdentityJwt(&'a str),
}

pub(super) fn classify_crewon_access_token(access_token: &str) -> CrewonAccessToken<'_> {
    if access_token.starts_with(PERSONAL_ACCESS_TOKEN_PREFIX) {
        CrewonAccessToken::PersonalAccessToken(access_token)
    } else {
        CrewonAccessToken::AgentIdentityJwt(access_token)
    }
}

#[cfg(test)]
#[path = "access_token_tests.rs"]
mod tests;
