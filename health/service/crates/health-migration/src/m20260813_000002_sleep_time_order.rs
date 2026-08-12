use sea_orm_migration::prelude::*;

const CONSTRAINT: &str = "sleep_records_end_after_start";

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(&format!(
                "ALTER TABLE sleep_records ADD CONSTRAINT {CONSTRAINT} CHECK (end_time > start_time)"
            ))
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(&format!(
                "ALTER TABLE sleep_records DROP CONSTRAINT {CONSTRAINT}"
            ))
            .await?;
        Ok(())
    }
}
