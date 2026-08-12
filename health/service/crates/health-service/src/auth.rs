use std::{fs, path::Path};

use health_core::{Person, RequestCtx, Via};

use crate::config::{Config, ConfigError};

const MAX_BEARER_TOKEN_BYTES: usize = 512;

pub struct TokenMap {
    primary: String,
    secondary: String,
}

impl TokenMap {
    pub fn load(config: &Config) -> Result<Self, ConfigError> {
        let primary = read_token(&config.primary_token_file)?;
        let secondary = read_token(&config.secondary_token_file)?;

        if constant_time_eq(primary.as_bytes(), secondary.as_bytes()) {
            return Err(ConfigError::IdenticalTokens);
        }

        Ok(Self { primary, secondary })
    }

    pub fn resolve(&self, bearer: &str) -> Option<RequestCtx> {
        let matches_primary = constant_time_eq(bearer.as_bytes(), self.primary.as_bytes());
        let matches_secondary = constant_time_eq(bearer.as_bytes(), self.secondary.as_bytes());

        match (matches_primary, matches_secondary) {
            (true, false) => Some(RequestCtx {
                actor: Person::Primary,
                via: Via::HermesPrimary,
                default_person: Person::Primary,
            }),
            (false, true) => Some(RequestCtx {
                actor: Person::Secondary,
                via: Via::HermesSecondary,
                default_person: Person::Secondary,
            }),
            _ => None,
        }
    }
}

fn read_token(path: &Path) -> Result<String, ConfigError> {
    let contents = fs::read_to_string(path).map_err(|source| ConfigError::ReadTokenFile {
        path: path.to_owned(),
        source,
    })?;
    let token = contents.trim();
    if token.is_empty() {
        return Err(ConfigError::EmptyTokenFile(path.to_owned()));
    }
    if !is_supported_bearer_token(token.as_bytes()) {
        return Err(ConfigError::InvalidTokenFile(path.to_owned()));
    }
    Ok(token.to_owned())
}

pub(crate) fn is_supported_bearer_token(token: &[u8]) -> bool {
    !token.is_empty()
        && token.len() <= MAX_BEARER_TOKEN_BYTES
        && token.iter().all(|byte| (0x21..=0x7e).contains(byte))
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    let compared_len = left.len().max(right.len());

    difference |= (0..compared_len).fold(0, |difference, index| {
        let left_byte = left.get(index).copied().unwrap_or(0);
        let right_byte = right.get(index).copied().unwrap_or(0);
        difference | usize::from(left_byte ^ right_byte)
    });

    difference == 0
}

#[cfg(test)]
mod tests {
    use std::fs;

    use health_core::{Person, Via};

    use super::TokenMap;
    use crate::config::Config;

    fn config(
        primary_token_file: &std::path::Path,
        secondary_token_file: &std::path::Path,
    ) -> Config {
        Config {
            database_url: "postgres://localhost/health".to_owned(),
            listen_addr: "0.0.0.0:8080".parse().unwrap(),
            primary_token_file: primary_token_file.to_owned(),
            secondary_token_file: secondary_token_file.to_owned(),
        }
    }

    #[test]
    fn resolve_maps_each_token_to_its_profile() {
        let dir = tempfile::tempdir().unwrap();
        let primary = dir.path().join("primary-token");
        let secondary = dir.path().join("secondary-token");
        fs::write(&primary, " primary-secret\n").unwrap();
        fs::write(&secondary, "secondary-secret\r\n").unwrap();
        let tokens = TokenMap::load(&config(&primary, &secondary)).unwrap();

        let primary_ctx = tokens.resolve("primary-secret").unwrap();
        assert_eq!(primary_ctx.actor, Person::Primary);
        assert_eq!(primary_ctx.via, Via::HermesPrimary);
        assert_eq!(primary_ctx.default_person, Person::Primary);

        let secondary_ctx = tokens.resolve("secondary-secret").unwrap();
        assert_eq!(secondary_ctx.actor, Person::Secondary);
        assert_eq!(secondary_ctx.via, Via::HermesSecondary);
        assert_eq!(secondary_ctx.default_person, Person::Secondary);
    }

    #[test]
    fn resolve_rejects_unknown_token() {
        let dir = tempfile::tempdir().unwrap();
        let primary = dir.path().join("primary-token");
        let secondary = dir.path().join("secondary-token");
        fs::write(&primary, "primary-secret").unwrap();
        fs::write(&secondary, "secondary-secret").unwrap();
        let tokens = TokenMap::load(&config(&primary, &secondary)).unwrap();

        assert!(tokens.resolve("unknown-secret").is_none());
    }

    #[test]
    fn identical_tokens_for_both_profiles_is_a_config_error() {
        let dir = tempfile::tempdir().unwrap();
        let primary = dir.path().join("primary-token");
        let secondary = dir.path().join("secondary-token");
        fs::write(&primary, "same-secret\n").unwrap();
        fs::write(&secondary, " same-secret ").unwrap();

        assert!(TokenMap::load(&config(&primary, &secondary)).is_err());
    }

    #[test]
    fn missing_file_is_error() {
        let dir = tempfile::tempdir().unwrap();
        let primary = dir.path().join("missing-primary-token");
        let secondary = dir.path().join("secondary-token");
        fs::write(&secondary, "secondary-secret").unwrap();

        assert!(TokenMap::load(&config(&primary, &secondary)).is_err());
    }

    #[test]
    fn empty_token_is_error() {
        let dir = tempfile::tempdir().unwrap();
        let primary = dir.path().join("primary-token");
        let secondary = dir.path().join("secondary-token");
        fs::write(&primary, " \r\n\t").unwrap();
        fs::write(&secondary, "secondary-secret").unwrap();

        assert!(TokenMap::load(&config(&primary, &secondary)).is_err());
    }

    #[test]
    fn tokens_must_be_accepted_by_the_http_bearer_parser() {
        for invalid in [
            "a".repeat(513),
            "contains whitespace".to_owned(),
            "non-ascii-🔐".to_owned(),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let primary = dir.path().join("primary-token");
            let secondary = dir.path().join("secondary-token");
            fs::write(&primary, invalid).unwrap();
            fs::write(&secondary, "secondary-secret").unwrap();

            assert!(TokenMap::load(&config(&primary, &secondary)).is_err());
        }
    }
}
