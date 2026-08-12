use health_migration::MigratorTrait;
use health_service::{auth::TokenMap, config::Config, mcp};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    match (args.next().as_deref(), args.next()) {
        (Some("healthcheck"), None) => {
            let listen_addr = health_service::config::listen_addr_from_env()?;
            let address = health_service::config::healthcheck_address(listen_addr);
            health_service::healthcheck::check(&address.to_string())?;
            return Ok(());
        }
        (None, None) => {}
        _ => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "usage: health-service [healthcheck]",
            )
            .into());
        }
    }

    tracing_subscriber::fmt::init();

    let config = Config::from_env()?;
    let tokens = TokenMap::load(&config)?;
    let db = sea_orm::Database::connect(&config.database_url).await?;
    health_migration::Migrator::up(&db, None).await?;
    tracing::info!("database migrations applied");

    let listener = tokio::net::TcpListener::bind(config.listen_addr).await?;
    tracing::info!(listen_addr = %config.listen_addr, "health service listening");
    axum::serve(listener, mcp::router(db, tokens, config.listen_addr)).await?;
    Ok(())
}
