use std::{fs, path::Path};

use health_core::{Person, RequestCtx, Via};

use crate::config::{Config, ConfigError};

const MAX_BEARER_TOKEN_BYTES: usize = 512;

pub struct TokenMap {
    andrii: String,
    valentyna: String,
}

impl TokenMap {
    pub fn load(config: &Config) -> Result<Self, ConfigError> {
        let andrii = read_token(&config.andrii_token_file)?;
        let valentyna = read_token(&config.valentyna_token_file)?;

        if constant_time_eq(andrii.as_bytes(), valentyna.as_bytes()) {
            return Err(ConfigError::IdenticalTokens);
        }

        Ok(Self { andrii, valentyna })
    }

    pub fn resolve(&self, bearer: &str) -> Option<RequestCtx> {
        let matches_andrii = constant_time_eq(bearer.as_bytes(), self.andrii.as_bytes());
        let matches_valentyna = constant_time_eq(bearer.as_bytes(), self.valentyna.as_bytes());

        match (matches_andrii, matches_valentyna) {
            (true, false) => Some(RequestCtx {
                actor: Person::Andrii,
                via: Via::HermesAndrii,
                default_person: Person::Andrii,
            }),
            (false, true) => Some(RequestCtx {
                actor: Person::Valentyna,
                via: Via::HermesValentyna,
                default_person: Person::Valentyna,
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
        andrii_token_file: &std::path::Path,
        valentyna_token_file: &std::path::Path,
    ) -> Config {
        Config {
            database_url: "postgres://localhost/health".to_owned(),
            listen_addr: "0.0.0.0:8080".parse().unwrap(),
            andrii_token_file: andrii_token_file.to_owned(),
            valentyna_token_file: valentyna_token_file.to_owned(),
        }
    }

    #[test]
    fn resolve_maps_each_token_to_its_profile() {
        let dir = tempfile::tempdir().unwrap();
        let andrii = dir.path().join("andrii-token");
        let valentyna = dir.path().join("valentyna-token");
        fs::write(&andrii, " andrii-secret\n").unwrap();
        fs::write(&valentyna, "valentyna-secret\r\n").unwrap();
        let tokens = TokenMap::load(&config(&andrii, &valentyna)).unwrap();

        let andrii_ctx = tokens.resolve("andrii-secret").unwrap();
        assert_eq!(andrii_ctx.actor, Person::Andrii);
        assert_eq!(andrii_ctx.via, Via::HermesAndrii);
        assert_eq!(andrii_ctx.default_person, Person::Andrii);

        let valentyna_ctx = tokens.resolve("valentyna-secret").unwrap();
        assert_eq!(valentyna_ctx.actor, Person::Valentyna);
        assert_eq!(valentyna_ctx.via, Via::HermesValentyna);
        assert_eq!(valentyna_ctx.default_person, Person::Valentyna);
    }

    #[test]
    fn resolve_rejects_unknown_token() {
        let dir = tempfile::tempdir().unwrap();
        let andrii = dir.path().join("andrii-token");
        let valentyna = dir.path().join("valentyna-token");
        fs::write(&andrii, "andrii-secret").unwrap();
        fs::write(&valentyna, "valentyna-secret").unwrap();
        let tokens = TokenMap::load(&config(&andrii, &valentyna)).unwrap();

        assert!(tokens.resolve("unknown-secret").is_none());
    }

    #[test]
    fn identical_tokens_for_both_profiles_is_a_config_error() {
        let dir = tempfile::tempdir().unwrap();
        let andrii = dir.path().join("andrii-token");
        let valentyna = dir.path().join("valentyna-token");
        fs::write(&andrii, "same-secret\n").unwrap();
        fs::write(&valentyna, " same-secret ").unwrap();

        assert!(TokenMap::load(&config(&andrii, &valentyna)).is_err());
    }

    #[test]
    fn missing_file_is_error() {
        let dir = tempfile::tempdir().unwrap();
        let andrii = dir.path().join("missing-andrii-token");
        let valentyna = dir.path().join("valentyna-token");
        fs::write(&valentyna, "valentyna-secret").unwrap();

        assert!(TokenMap::load(&config(&andrii, &valentyna)).is_err());
    }

    #[test]
    fn empty_token_is_error() {
        let dir = tempfile::tempdir().unwrap();
        let andrii = dir.path().join("andrii-token");
        let valentyna = dir.path().join("valentyna-token");
        fs::write(&andrii, " \r\n\t").unwrap();
        fs::write(&valentyna, "valentyna-secret").unwrap();

        assert!(TokenMap::load(&config(&andrii, &valentyna)).is_err());
    }

    #[test]
    fn tokens_must_be_accepted_by_the_http_bearer_parser() {
        for invalid in [
            "a".repeat(513),
            "contains whitespace".to_owned(),
            "non-ascii-🔐".to_owned(),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let andrii = dir.path().join("andrii-token");
            let valentyna = dir.path().join("valentyna-token");
            fs::write(&andrii, invalid).unwrap();
            fs::write(&valentyna, "valentyna-secret").unwrap();

            assert!(TokenMap::load(&config(&andrii, &valentyna)).is_err());
        }
    }
}
