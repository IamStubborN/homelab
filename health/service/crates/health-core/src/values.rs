use crate::MeasurementKind;

#[derive(Debug, thiserror::Error)]
pub enum ValidationError {
    #[error("missing or invalid field: {0}")]
    MissingField(&'static str),
    #[error("field {field} is out of range: {value}")]
    OutOfRange { field: &'static str, value: f64 },
    #[error("unexpected field: {0}")]
    UnexpectedField(String),
}

pub fn validate_measurement(
    kind: MeasurementKind,
    values: &serde_json::Value,
) -> Result<(), ValidationError> {
    match kind {
        MeasurementKind::BloodPressure => {
            let values =
                object_with_fields(values, &["systolic", "diastolic", "pulse"], "systolic")?;
            integer_in_range(values, "systolic", 50, 300)?;
            integer_in_range(values, "diastolic", 30, 200)?;
            if values.contains_key("pulse") {
                integer_in_range(values, "pulse", 20, 250)?;
            }
        }
        MeasurementKind::Weight => {
            let values = object_with_fields(values, &["value", "unit"], "value")?;
            number_in_range(values, "value", 20.0, 400.0)?;
            exact_optional_unit(values, "kg")?;
        }
        MeasurementKind::Pulse => {
            let values = object_with_fields(values, &["value"], "value")?;
            integer_in_range(values, "value", 20, 250)?;
        }
        MeasurementKind::Temperature => {
            let values = object_with_fields(values, &["value", "unit"], "value")?;
            number_in_range(values, "value", 34.0, 43.0)?;
            exact_optional_unit(values, "c")?;
        }
        MeasurementKind::Spo2 => {
            let values = object_with_fields(values, &["value"], "value")?;
            integer_in_range(values, "value", 50, 100)?;
        }
        MeasurementKind::Glucose => {
            let values = object_with_fields(values, &["value", "unit"], "value")?;
            number_in_range(values, "value", 1.0, 40.0)?;
            exact_optional_unit(values, "mmol_l")?;
        }
    }

    Ok(())
}

fn object_with_fields<'a>(
    values: &'a serde_json::Value,
    allowed_fields: &[&str],
    required_field: &'static str,
) -> Result<&'a serde_json::Map<String, serde_json::Value>, ValidationError> {
    let values = values
        .as_object()
        .ok_or(ValidationError::MissingField(required_field))?;

    if let Some(field) = values
        .keys()
        .find(|field| !allowed_fields.contains(&field.as_str()))
    {
        return Err(ValidationError::UnexpectedField(field.clone()));
    }

    Ok(values)
}

fn integer_in_range(
    values: &serde_json::Map<String, serde_json::Value>,
    field: &'static str,
    minimum: i64,
    maximum: i64,
) -> Result<(), ValidationError> {
    let value = values
        .get(field)
        .and_then(|value| {
            value
                .as_i64()
                .map(|value| value as f64)
                .or_else(|| value.as_u64().map(|value| value as f64))
        })
        .ok_or(ValidationError::MissingField(field))?;

    if !(minimum as f64..=maximum as f64).contains(&value) {
        return Err(ValidationError::OutOfRange { field, value });
    }

    Ok(())
}

fn number_in_range(
    values: &serde_json::Map<String, serde_json::Value>,
    field: &'static str,
    minimum: f64,
    maximum: f64,
) -> Result<(), ValidationError> {
    let value = values
        .get(field)
        .and_then(serde_json::Value::as_f64)
        .ok_or(ValidationError::MissingField(field))?;

    if !(minimum..=maximum).contains(&value) {
        return Err(ValidationError::OutOfRange { field, value });
    }

    Ok(())
}

fn exact_optional_unit(
    values: &serde_json::Map<String, serde_json::Value>,
    expected: &'static str,
) -> Result<(), ValidationError> {
    if values.get("unit").is_some_and(|unit| unit != expected) {
        return Err(ValidationError::MissingField("unit"));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn valid_values_are_accepted_for_every_measurement_kind() {
        let cases = [
            (
                MeasurementKind::BloodPressure,
                json!({"systolic": 120, "diastolic": 80, "pulse": 60}),
            ),
            (MeasurementKind::Weight, json!({"value": 80, "unit": "kg"})),
            (MeasurementKind::Pulse, json!({"value": 80})),
            (
                MeasurementKind::Temperature,
                json!({"value": 36.6, "unit": "c"}),
            ),
            (MeasurementKind::Spo2, json!({"value": 98})),
            (
                MeasurementKind::Glucose,
                json!({"value": 5.5, "unit": "mmol_l"}),
            ),
        ];

        for (kind, values) in cases {
            assert!(
                validate_measurement(kind, &values).is_ok(),
                "{} should accept {values}",
                kind.as_str()
            );
        }
    }

    #[test]
    fn bp_missing_diastolic_fails() {
        let error = validate_measurement(MeasurementKind::BloodPressure, &json!({"systolic": 120}))
            .unwrap_err();

        assert!(matches!(error, ValidationError::MissingField("diastolic")));
    }

    #[test]
    fn weight_600kg_fails() {
        let error = validate_measurement(
            MeasurementKind::Weight,
            &json!({"value": 600, "unit": "kg"}),
        )
        .unwrap_err();

        assert!(matches!(
            error,
            ValidationError::OutOfRange {
                field: "value",
                value: 600.0
            }
        ));
    }

    #[test]
    fn unexpected_key_fails() {
        let error =
            validate_measurement(MeasurementKind::Pulse, &json!({"value": 80, "note": "x"}))
                .unwrap_err();

        assert!(matches!(
            error,
            ValidationError::UnexpectedField(field) if field == "note"
        ));
    }

    #[test]
    fn integer_fields_reject_fractional_numbers() {
        let error =
            validate_measurement(MeasurementKind::Pulse, &json!({"value": 80.5})).unwrap_err();

        assert!(matches!(&error, ValidationError::MissingField("value")));
        assert_eq!(error.to_string(), "missing or invalid field: value");
    }

    #[test]
    fn optional_units_must_match_exactly() {
        let error = validate_measurement(
            MeasurementKind::Glucose,
            &json!({"value": 5.5, "unit": "mg_dl"}),
        )
        .unwrap_err();

        assert!(matches!(&error, ValidationError::MissingField("unit")));
        assert_eq!(error.to_string(), "missing or invalid field: unit");
    }

    #[test]
    fn non_object_values_have_a_truthful_error() {
        let error = validate_measurement(MeasurementKind::Weight, &json!([80])).unwrap_err();

        assert!(matches!(&error, ValidationError::MissingField("value")));
        assert_eq!(error.to_string(), "missing or invalid field: value");
    }

    #[test]
    fn huge_unsigned_integer_is_out_of_range() {
        let error =
            validate_measurement(MeasurementKind::Pulse, &json!({"value": u64::MAX})).unwrap_err();

        assert!(matches!(
            error,
            ValidationError::OutOfRange {
                field: "value",
                value
            } if value == u64::MAX as f64
        ));
    }

    #[test]
    fn range_endpoints_and_omitted_optional_units_are_valid() {
        let cases = [
            (
                MeasurementKind::BloodPressure,
                json!({"systolic": 50, "diastolic": 30, "pulse": 20}),
            ),
            (
                MeasurementKind::BloodPressure,
                json!({"systolic": 300, "diastolic": 200, "pulse": 250}),
            ),
            (MeasurementKind::Weight, json!({"value": 20})),
            (MeasurementKind::Weight, json!({"value": 400})),
            (MeasurementKind::Pulse, json!({"value": 20})),
            (MeasurementKind::Pulse, json!({"value": 250})),
            (MeasurementKind::Temperature, json!({"value": 34.0})),
            (MeasurementKind::Temperature, json!({"value": 43.0})),
            (MeasurementKind::Spo2, json!({"value": 50})),
            (MeasurementKind::Spo2, json!({"value": 100})),
            (MeasurementKind::Glucose, json!({"value": 1.0})),
            (MeasurementKind::Glucose, json!({"value": 40.0})),
        ];

        for (kind, values) in cases {
            assert!(
                validate_measurement(kind, &values).is_ok(),
                "{} should accept endpoint values {values}",
                kind.as_str()
            );
        }
    }

    #[test]
    fn wrong_primitives_are_rejected() {
        let cases = [
            (MeasurementKind::Pulse, json!({"value": "80"})),
            (MeasurementKind::Weight, json!({"value": true})),
        ];

        for (kind, values) in cases {
            let error = validate_measurement(kind, &values).unwrap_err();

            assert!(
                matches!(&error, ValidationError::MissingField("value")),
                "{} should reject primitive values in {values}",
                kind.as_str()
            );
            assert_eq!(error.to_string(), "missing or invalid field: value");
        }
    }

    #[test]
    fn every_kind_rejects_extra_fields() {
        let cases = [
            (
                MeasurementKind::BloodPressure,
                json!({"systolic": 120, "diastolic": 80, "extra": true}),
            ),
            (MeasurementKind::Weight, json!({"value": 80, "extra": true})),
            (MeasurementKind::Pulse, json!({"value": 80, "extra": true})),
            (
                MeasurementKind::Temperature,
                json!({"value": 36.6, "extra": true}),
            ),
            (MeasurementKind::Spo2, json!({"value": 98, "extra": true})),
            (
                MeasurementKind::Glucose,
                json!({"value": 5.5, "extra": true}),
            ),
        ];

        for (kind, values) in cases {
            assert!(
                matches!(
                    validate_measurement(kind, &values),
                    Err(ValidationError::UnexpectedField(field)) if field == "extra"
                ),
                "{} should reject extra fields in {values}",
                kind.as_str()
            );
        }
    }

    #[test]
    fn unit_kinds_reject_wrong_units() {
        let cases = [
            (MeasurementKind::Weight, json!({"value": 80, "unit": "lb"})),
            (
                MeasurementKind::Temperature,
                json!({"value": 36.6, "unit": "f"}),
            ),
            (
                MeasurementKind::Glucose,
                json!({"value": 5.5, "unit": "mg_dl"}),
            ),
        ];

        for (kind, values) in cases {
            assert!(
                matches!(
                    validate_measurement(kind, &values),
                    Err(ValidationError::MissingField("unit"))
                ),
                "{} should reject incorrect units in {values}",
                kind.as_str()
            );
        }
    }
}
