//! Family health service database migrations.

pub use sea_orm_migration::MigratorTrait;
use sea_orm_migration::prelude::*;

mod m20260804_000001_initial;
mod m20260813_000002_sleep_time_order;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20260804_000001_initial::Migration),
            Box::new(m20260813_000002_sleep_time_order::Migration),
        ]
    }
}
