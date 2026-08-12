use std::str::FromStr;

#[derive(Debug, thiserror::Error)]
#[error("unknown value: {0}")]
pub struct ParseEnumError(String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Person {
    Andrii,
    Valentyna,
}

impl Person {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Andrii => "andrii",
            Self::Valentyna => "valentyna",
        }
    }
}

impl FromStr for Person {
    type Err = ParseEnumError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "andrii" => Ok(Self::Andrii),
            "valentyna" => Ok(Self::Valentyna),
            _ => Err(ParseEnumError(value.to_owned())),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Via {
    HermesAndrii,
    HermesValentyna,
    System,
}

impl Via {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::HermesAndrii => "hermes_andrii",
            Self::HermesValentyna => "hermes_valentyna",
            Self::System => "system",
        }
    }
}

impl FromStr for Via {
    type Err = ParseEnumError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "hermes_andrii" => Ok(Self::HermesAndrii),
            "hermes_valentyna" => Ok(Self::HermesValentyna),
            "system" => Ok(Self::System),
            _ => Err(ParseEnumError(value.to_owned())),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactStatus {
    ConfirmedByDoctor,
    ConfirmedByDocument,
    UserReported,
    Suspected,
    ModelInference,
    HistoricalUncertain,
    Resolved,
}

impl FactStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ConfirmedByDoctor => "confirmed_by_doctor",
            Self::ConfirmedByDocument => "confirmed_by_document",
            Self::UserReported => "user_reported",
            Self::Suspected => "suspected",
            Self::ModelInference => "model_inference",
            Self::HistoricalUncertain => "historical_uncertain",
            Self::Resolved => "resolved",
        }
    }
}

impl FromStr for FactStatus {
    type Err = ParseEnumError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "confirmed_by_doctor" => Ok(Self::ConfirmedByDoctor),
            "confirmed_by_document" => Ok(Self::ConfirmedByDocument),
            "user_reported" => Ok(Self::UserReported),
            "suspected" => Ok(Self::Suspected),
            "model_inference" => Ok(Self::ModelInference),
            "historical_uncertain" => Ok(Self::HistoricalUncertain),
            "resolved" => Ok(Self::Resolved),
            _ => Err(ParseEnumError(value.to_owned())),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeasurementKind {
    BloodPressure,
    Weight,
    Pulse,
    Temperature,
    Spo2,
    Glucose,
}

impl MeasurementKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::BloodPressure => "blood_pressure",
            Self::Weight => "weight",
            Self::Pulse => "pulse",
            Self::Temperature => "temperature",
            Self::Spo2 => "spo2",
            Self::Glucose => "glucose",
        }
    }
}

impl FromStr for MeasurementKind {
    type Err = ParseEnumError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "blood_pressure" => Ok(Self::BloodPressure),
            "weight" => Ok(Self::Weight),
            "pulse" => Ok(Self::Pulse),
            "temperature" => Ok(Self::Temperature),
            "spo2" => Ok(Self::Spo2),
            "glucose" => Ok(Self::Glucose),
            _ => Err(ParseEnumError(value.to_owned())),
        }
    }
}

pub struct RequestCtx {
    pub actor: Person,
    pub via: Via,
    pub default_person: Person,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn person_round_trips_via_serde_and_str() {
        use std::str::FromStr;

        assert_eq!(
            serde_json::to_string(&Person::Andrii).unwrap(),
            "\"andrii\""
        );
        assert_eq!(Person::from_str("valentyna").unwrap(), Person::Valentyna);
        assert!(Person::from_str("someone").is_err());
        assert_eq!(Person::Valentyna.as_str(), "valentyna");
    }

    #[test]
    fn fact_status_uses_snake_case() {
        assert_eq!(
            serde_json::to_string(&FactStatus::ConfirmedByDoctor).unwrap(),
            "\"confirmed_by_doctor\""
        );
    }

    #[test]
    fn measurement_kind_strings() {
        assert_eq!(MeasurementKind::BloodPressure.as_str(), "blood_pressure");
        assert_eq!(
            serde_json::to_string(&MeasurementKind::Spo2).unwrap(),
            "\"spo2\""
        );
    }
}
