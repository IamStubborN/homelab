use std::{fs, net::SocketAddr, path::PathBuf};

const DEFAULT_LISTEN_ADDR: &str = "0.0.0.0:8080";

pub struct Config {
    pub database_url: String,
    pub listen_addr: SocketAddr,
    pub andrii_token_file: PathBuf,
    pub valentyna_token_file: PathBuf,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let listen_addr = listen_addr_from_env()?;

        Ok(Self {
            database_url: database_url()?,
            listen_addr,
            andrii_token_file: required_env("HEALTH_TOKEN_FILE_ANDRII")?.into(),
            valentyna_token_file: required_env("HEALTH_TOKEN_FILE_VALENTYNA")?.into(),
        })
    }
}

pub fn listen_addr_from_env() -> Result<SocketAddr, ConfigError> {
    match std::env::var("HEALTH_LISTEN_ADDR") {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => DEFAULT_LISTEN_ADDR.to_owned(),
        Err(std::env::VarError::NotUnicode(_)) => {
            return Err(ConfigError::InvalidEnvEncoding("HEALTH_LISTEN_ADDR"));
        }
    }
    .parse()
    .map_err(ConfigError::InvalidListenAddr)
}

pub fn healthcheck_address(listen_addr: SocketAddr) -> SocketAddr {
    match listen_addr {
        SocketAddr::V4(address) => {
            SocketAddr::new(std::net::Ipv4Addr::LOCALHOST.into(), address.port())
        }
        SocketAddr::V6(address) => {
            SocketAddr::new(std::net::Ipv6Addr::LOCALHOST.into(), address.port())
        }
    }
}

fn database_url() -> Result<String, ConfigError> {
    match std::env::var("DATABASE_URL") {
        Ok(value) => return Ok(value),
        Err(std::env::VarError::NotUnicode(_)) => {
            return Err(ConfigError::InvalidEnvEncoding("DATABASE_URL"));
        }
        Err(std::env::VarError::NotPresent) => {}
    }

    let host = required_env("HEALTH_DB_HOST")?;
    let port = required_env("HEALTH_DB_PORT")?;
    let name = required_env("HEALTH_DB_NAME")?;
    let user = required_env("HEALTH_DB_USER")?;
    let password_file = PathBuf::from(required_env("HEALTH_DB_PASSWORD_FILE")?);
    let password = fs::read_to_string(&password_file).map_err(|source| {
        ConfigError::ReadDatabasePasswordFile {
            path: password_file.clone(),
            source,
        }
    })?;
    let password = password.trim_end_matches(['\r', '\n']);
    if password.is_empty() {
        return Err(ConfigError::EmptyDatabasePasswordFile(password_file));
    }

    Ok(format!(
        "postgres://{}:{}@{}:{}/{}",
        percent_encode(&user),
        percent_encode(password),
        host,
        port,
        name
    ))
}

fn percent_encode(value: &str) -> String {
    use std::fmt::Write;

    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            write!(&mut encoded, "%{byte:02X}").expect("writing to a String cannot fail");
        }
    }
    encoded
}

fn required_env(name: &'static str) -> Result<String, ConfigError> {
    std::env::var(name).map_err(|_| ConfigError::MissingEnv(name))
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("required environment variable {0} is missing or invalid")]
    MissingEnv(&'static str),
    #[error("environment variable {0} is not valid Unicode")]
    InvalidEnvEncoding(&'static str),
    #[error("HEALTH_LISTEN_ADDR is not a valid socket address")]
    InvalidListenAddr(#[source] std::net::AddrParseError),
    #[error("failed to read database password file {path}")]
    ReadDatabasePasswordFile {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("database password file {0} is empty")]
    EmptyDatabasePasswordFile(PathBuf),
    #[error("failed to read token file {path}")]
    ReadTokenFile {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("token file {0} is empty")]
    EmptyTokenFile(PathBuf),
    #[error("token file {0} contains a bearer token unsupported by the HTTP API")]
    InvalidTokenFile(PathBuf),
    #[error("Andrii and Valentyna token files contain the same token")]
    IdenticalTokens,
}

#[cfg(test)]
mod tests {
    use std::{fs, process::Command};

    use super::Config;

    #[test]
    fn healthcheck_uses_configured_port_on_loopback() {
        assert_eq!(
            super::healthcheck_address("0.0.0.0:9090".parse().unwrap()),
            "127.0.0.1:9090".parse().unwrap()
        );
        assert_eq!(
            super::healthcheck_address("[::]:9090".parse().unwrap()),
            "[::1]:9090".parse().unwrap()
        );
    }

    const CASE_ENV: &str = "HEALTH_CONFIG_TEST_CASE";

    fn run_config_case(case: &str) {
        let tempdir = tempfile::tempdir().unwrap();
        let password_file = tempdir.path().join("database-password");
        fs::write(&password_file, "p@ss word\n").unwrap();

        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .arg("config::tests::config_from_env_child")
            .arg("--exact")
            .arg("--nocapture")
            .env_clear()
            .env(CASE_ENV, case)
            .env("HEALTH_TOKEN_FILE_ANDRII", "/run/secrets/andrii")
            .env("HEALTH_TOKEN_FILE_VALENTYNA", "/run/secrets/valentyna");
        if case == "split" {
            command
                .env("HEALTH_DB_HOST", "health-postgres")
                .env("HEALTH_DB_PORT", "5432")
                .env("HEALTH_DB_NAME", "health")
                .env("HEALTH_DB_USER", "health")
                .env("HEALTH_DB_PASSWORD_FILE", &password_file);
        } else {
            command.env("DATABASE_URL", "postgres://localhost/family-health");
        }
        if case == "override" {
            command
                .env("HEALTH_DB_HOST", "ignored")
                .env("HEALTH_DB_PORT", "9999")
                .env("HEALTH_DB_NAME", "ignored")
                .env("HEALTH_DB_USER", "ignored")
                .env("HEALTH_DB_PASSWORD_FILE", &password_file);
        }
        if case == "custom" {
            command.env("HEALTH_LISTEN_ADDR", "127.0.0.1:9090");
        }
        #[cfg(unix)]
        if case == "non_unicode" {
            use std::os::unix::ffi::OsStringExt;

            command.env(
                "HEALTH_LISTEN_ADDR",
                std::ffi::OsString::from_vec(vec![0xff]),
            );
        }
        let output = command.output().unwrap();

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            output.status.success(),
            "child test failed:\n{stdout}\n{stderr}"
        );
        assert!(
            stdout.contains("1 passed"),
            "child test did not execute exactly once:\n{stdout}"
        );
    }

    #[test]
    fn config_from_env_uses_default_listen_address() {
        run_config_case("default");
    }

    #[test]
    fn config_from_env_reads_custom_listen_address() {
        run_config_case("custom");
    }

    #[test]
    fn config_from_env_assembles_database_url_from_secret_file() {
        run_config_case("split");
    }

    #[test]
    fn database_url_overrides_split_database_environment() {
        run_config_case("override");
    }

    #[cfg(unix)]
    #[test]
    fn config_from_env_rejects_non_unicode_listen_address() {
        run_config_case("non_unicode");
    }

    #[test]
    fn config_from_env_child() {
        let Ok(case) = std::env::var(CASE_ENV) else {
            return;
        };

        let config = Config::from_env();
        if case == "non_unicode" {
            assert!(config.is_err());
            return;
        }
        let config = config.unwrap();
        assert_eq!(
            config.database_url,
            if case == "split" {
                "postgres://health:p%40ss%20word@health-postgres:5432/health"
            } else {
                "postgres://localhost/family-health"
            }
        );
        assert_eq!(
            config.listen_addr,
            if case == "custom" {
                "127.0.0.1:9090".parse().unwrap()
            } else {
                "0.0.0.0:8080".parse().unwrap()
            }
        );
        assert_eq!(
            config.andrii_token_file,
            std::path::Path::new("/run/secrets/andrii")
        );
        assert_eq!(
            config.valentyna_token_file,
            std::path::Path::new("/run/secrets/valentyna")
        );
    }
}
