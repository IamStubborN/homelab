use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
CREATE TYPE person AS ENUM ('andrii', 'valentyna');
CREATE TYPE via_channel AS ENUM ('hermes_andrii', 'hermes_valentyna', 'system');
CREATE TYPE fact_status AS ENUM (
  'confirmed_by_doctor','confirmed_by_document','user_reported',
  'suspected','model_inference','historical_uncertain','resolved');

CREATE TABLE people (
  id person PRIMARY KEY,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO people (id, display_name) VALUES ('andrii','Andrii'), ('valentyna','Valentyna');

-- Shared columns for every event-like table:
-- person_id, status, actor, via, event_time, created_at, deleted_at, dedup_hash

CREATE TABLE measurements (
  id uuid PRIMARY KEY,
  person_id person NOT NULL REFERENCES people(id),
  kind text NOT NULL, -- health-core MeasurementKind strings
  values_json jsonb NOT NULL, -- e.g. {"systolic":136,"diastolic":97,"pulse":91} or {"value":120.5,"unit":"kg"}
  source text,
  status fact_status NOT NULL DEFAULT 'user_reported',
  actor person NOT NULL,
  via via_channel NOT NULL,
  event_time timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  dedup_hash bytea NOT NULL
);
CREATE UNIQUE INDEX measurements_dedup ON measurements (dedup_hash) WHERE deleted_at IS NULL;
CREATE INDEX measurements_person_kind_time ON measurements (person_id, kind, event_time);

CREATE TABLE meals (
  id uuid PRIMARY KEY,
  person_id person NOT NULL REFERENCES people(id),
  description text NOT NULL,
  items_json jsonb,
  calories integer,
  status fact_status NOT NULL DEFAULT 'user_reported',
  actor person NOT NULL,
  via via_channel NOT NULL,
  event_time timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  dedup_hash bytea NOT NULL
);
CREATE UNIQUE INDEX meals_dedup ON meals (dedup_hash) WHERE deleted_at IS NULL;
CREATE INDEX meals_person_time ON meals (person_id, event_time);

CREATE TABLE symptoms (
  id uuid PRIMARY KEY,
  person_id person NOT NULL REFERENCES people(id),
  description text NOT NULL,
  severity integer CHECK (severity BETWEEN 1 AND 10),
  status fact_status NOT NULL DEFAULT 'user_reported',
  actor person NOT NULL,
  via via_channel NOT NULL,
  event_time timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  dedup_hash bytea NOT NULL
);
CREATE UNIQUE INDEX symptoms_dedup ON symptoms (dedup_hash) WHERE deleted_at IS NULL;

CREATE TABLE sleep_records (
  id uuid PRIMARY KEY,
  person_id person NOT NULL REFERENCES people(id),
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL CHECK (end_time > start_time),
  quality integer CHECK (quality BETWEEN 1 AND 10),
  notes text,
  status fact_status NOT NULL DEFAULT 'user_reported',
  actor person NOT NULL,
  via via_channel NOT NULL,
  event_time timestamptz NOT NULL, -- = start_time, kept for uniform querying
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  dedup_hash bytea NOT NULL
);
CREATE UNIQUE INDEX sleep_dedup ON sleep_records (dedup_hash) WHERE deleted_at IS NULL;

CREATE TABLE medications (
  id uuid PRIMARY KEY,
  person_id person NOT NULL REFERENCES people(id),
  name text NOT NULL,
  dose text,
  schedule text, -- free text for phase 1, e.g. "1 tab 09:00"
  started_at timestamptz NOT NULL,
  stopped_at timestamptz,
  stop_reason text,
  status fact_status NOT NULL DEFAULT 'user_reported',
  actor person NOT NULL,
  via via_channel NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX medications_person_active ON medications (person_id) WHERE stopped_at IS NULL AND deleted_at IS NULL;

CREATE TABLE conditions (
  id uuid PRIMARY KEY,
  person_id person NOT NULL REFERENCES people(id),
  name text NOT NULL,
  notes text,
  diagnosed_at date,
  resolved_at date,
  status fact_status NOT NULL DEFAULT 'user_reported',
  actor person NOT NULL,
  via via_channel NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE allergies (
  id uuid PRIMARY KEY,
  person_id person NOT NULL REFERENCES people(id),
  allergen text NOT NULL,
  reaction text,
  severity text, -- free text: "mild" | "moderate" | "severe" | doctor's wording
  status fact_status NOT NULL DEFAULT 'user_reported',
  actor person NOT NULL,
  via via_channel NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE labs (
  id uuid PRIMARY KEY,
  person_id person NOT NULL REFERENCES people(id),
  test_date date NOT NULL,
  test_name text NOT NULL,
  value numeric NOT NULL,
  unit text,
  reference_min numeric,
  reference_max numeric,
  flag text, -- 'low' | 'normal' | 'high' | lab's wording
  laboratory text,
  source_document text, -- file name/path until documents table arrives in phase 2
  status fact_status NOT NULL DEFAULT 'user_reported',
  actor person NOT NULL,
  via via_channel NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  dedup_hash bytea NOT NULL
);
CREATE UNIQUE INDEX labs_dedup ON labs (dedup_hash) WHERE deleted_at IS NULL;
CREATE INDEX labs_person_name_date ON labs (person_id, test_name, test_date);

CREATE TABLE corrections (
  id uuid PRIMARY KEY,
  entity_table text NOT NULL,
  entity_id uuid NOT NULL,
  old_value jsonb NOT NULL,
  new_value jsonb NOT NULL,
  reason text NOT NULL,
  actor person NOT NULL,
  via via_channel NOT NULL,
  corrected_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX corrections_entity ON corrections (entity_table, entity_id);

CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor person NOT NULL,
  via via_channel NOT NULL,
  target_person person NOT NULL,
  action text NOT NULL,        -- e.g. 'add_measurement'
  entity_table text,
  entity_id uuid,
  result text NOT NULL,        -- 'success' | 'duplicate' | 'rejected'
  old_value jsonb,
  new_value jsonb
);
CREATE INDEX audit_log_at ON audit_log (at);
"#,
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
DROP TABLE audit_log;
DROP TABLE corrections;
DROP TABLE labs;
DROP TABLE allergies;
DROP TABLE conditions;
DROP TABLE medications;
DROP TABLE sleep_records;
DROP TABLE symptoms;
DROP TABLE meals;
DROP TABLE measurements;
DROP TABLE people;
DROP TYPE fact_status;
DROP TYPE via_channel;
DROP TYPE person;
"#,
            )
            .await?;

        Ok(())
    }
}
