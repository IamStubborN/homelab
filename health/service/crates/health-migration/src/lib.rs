//! Family health service database migrations.

pub use sea_orm_migration::MigratorTrait;
use sea_orm_migration::prelude::*;

mod m20260804_000001_initial;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![Box::new(m20260804_000001_initial::Migration)]
    }
}
