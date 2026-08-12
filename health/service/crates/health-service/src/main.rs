use health_service::{auth::TokenMap, config::Config, mcp};
use sea_orm_migration::MigratorTrait;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    match (args.next().as_deref(), args.next()) {
        (Some("healthcheck"), None) => {
            health_service::healthcheck::check("127.0.0.1:8080")?;
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
    axum::serve(listener, mcp::router(db, tokens)).await?;
    Ok(())
}
