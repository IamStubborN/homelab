//! Family health service.

pub mod auth;
pub mod charts;
pub mod config;
pub mod healthcheck;
pub mod mcp;
pub mod ops;
pub mod storage;

#[cfg(test)]
mod charts_tests {
    use crate::{charts, storage};
    use health_core::MeasurementKind;

    #[test]
    fn renders_weight_series_as_png() {
        let points: Vec<storage::SeriesPoint> = (0..10)
            .map(|i| storage::SeriesPoint {
                event_time: time::macros::datetime!(2026-08-01 08:00 UTC) + time::Duration::days(i),
                values: serde_json::json!({"value": 120.5 - i as f64 * 0.2}),
            })
            .collect();

        let png = charts::render_measurement_chart(&charts::ChartRequest {
            title: "test",
            kind: MeasurementKind::Weight,
            points: &points,
        })
        .unwrap();

        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        assert!(png.len() > 1000);
    }

    #[test]
    fn empty_series_is_an_error() {
        let error = charts::render_measurement_chart(&charts::ChartRequest {
            title: "t",
            kind: MeasurementKind::Pulse,
            points: &[],
        })
        .unwrap_err();

        assert!(matches!(error, charts::ChartError::Empty));
    }

    #[test]
    fn single_point_series_renders_a_visible_marker() {
        let points = [storage::SeriesPoint {
            event_time: time::macros::datetime!(2026-08-01 08:00 UTC),
            values: serde_json::json!({"value": 80}),
        }];

        let png = charts::render_measurement_chart(&charts::ChartRequest {
            title: "t",
            kind: MeasurementKind::Pulse,
            points: &points,
        })
        .unwrap();
        let image = image::load_from_memory(&png).unwrap().into_rgb8();

        assert!(
            image.pixels().any(|pixel| pixel.0 == [0, 0, 255]),
            "the single measurement must be visible in the series color"
        );
    }

    #[test]
    fn renders_blood_pressure_series_with_cyrillic_title() {
        let points = [
            storage::SeriesPoint {
                event_time: time::macros::datetime!(2026-08-01 08:00 UTC),
                values: serde_json::json!({"systolic": 120, "diastolic": 80}),
            },
            storage::SeriesPoint {
                event_time: time::macros::datetime!(2026-08-02 08:00 UTC),
                values: serde_json::json!({"systolic": 118, "diastolic": 78}),
            },
        ];

        let png = charts::render_measurement_chart(&charts::ChartRequest {
            title: "Андрей — давление, 30 дней",
            kind: MeasurementKind::BloodPressure,
            points: &points,
        })
        .unwrap();

        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        assert!(png.len() > 1000);
    }

    #[test]
    fn malformed_single_value_series_is_a_render_error() {
        let points = [storage::SeriesPoint {
            event_time: time::macros::datetime!(2026-08-01 08:00 UTC),
            values: serde_json::json!({"unexpected": 80}),
        }];

        let error = charts::render_measurement_chart(&charts::ChartRequest {
            title: "t",
            kind: MeasurementKind::Pulse,
            points: &points,
        })
        .unwrap_err();

        assert!(matches!(error, charts::ChartError::Render(_)));
    }

    #[test]
    fn malformed_blood_pressure_series_is_a_render_error() {
        let points = [storage::SeriesPoint {
            event_time: time::macros::datetime!(2026-08-01 08:00 UTC),
            values: serde_json::json!({"systolic": 120}),
        }];

        let error = charts::render_measurement_chart(&charts::ChartRequest {
            title: "t",
            kind: MeasurementKind::BloodPressure,
            points: &points,
        })
        .unwrap_err();

        assert!(matches!(error, charts::ChartError::Render(_)));
    }
}
