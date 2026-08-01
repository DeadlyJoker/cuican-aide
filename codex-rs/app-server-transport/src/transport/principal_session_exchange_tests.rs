use pretty_assertions::assert_eq;

use super::PrincipalSessionExchangeError;
use super::PrincipalSessionExchangeResult;
use super::PrincipalSessionExchangeService;

#[tokio::test]
async fn exchange_validates_bounds_and_redacts_sensitive_values() {
    let service = PrincipalSessionExchangeService::new(|bootstrap| async move {
        assert_eq!(bootstrap, "signed-bootstrap");
        PrincipalSessionExchangeResult::new("signed-session", 1_900_000_000)
    });

    let result = service
        .exchange("signed-bootstrap".to_string())
        .await
        .expect("exchange result");
    assert!(!format!("{result:?}").contains("signed-session"));
    assert_eq!(
        result.into_parts(),
        ("signed-session".to_string(), 1_900_000_000)
    );
    assert_eq!(
        format!("{service:?}"),
        "PrincipalSessionExchangeService([REDACTED])"
    );

    assert!(matches!(
        service.exchange(String::new()).await,
        Err(PrincipalSessionExchangeError::Invalid)
    ));
    assert!(matches!(
        PrincipalSessionExchangeResult::new("session\nforged", 1),
        Err(PrincipalSessionExchangeError::Invalid)
    ));
}
