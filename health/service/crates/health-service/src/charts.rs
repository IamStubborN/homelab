use std::sync::OnceLock;

use health_core::MeasurementKind;
use image::{ImageEncoder, RgbImage, codecs::png::PngEncoder};
use plotters::prelude::*;
use time::OffsetDateTime;
use time_tz::OffsetDateTimeExt;

use crate::storage::SeriesPoint;

const WIDTH: u32 = 900;
const HEIGHT: u32 = 500;
const FONT_NAME: &str = "DejaVu Sans";
const FONT_BYTES: &[u8] = include_bytes!("../../../assets/DejaVuSans.ttf");

static FONT_REGISTRATION: OnceLock<Result<(), &'static str>> = OnceLock::new();

pub struct ChartRequest<'a> {
    pub title: &'a str,
    pub kind: MeasurementKind,
    pub points: &'a [SeriesPoint],
}

#[derive(Debug, thiserror::Error)]
pub enum ChartError {
    #[error("measurement series is empty")]
    Empty,
    #[error("chart rendering failed: {0}")]
    Render(String),
}

pub fn render_measurement_chart(req: &ChartRequest<'_>) -> Result<Vec<u8>, ChartError> {
    if req.points.is_empty() {
        return Err(ChartError::Empty);
    }

    register_font()?;

    let series = extract_series(req)?;
    let all_values = series
        .iter()
        .flat_map(|(_, values)| values.iter().map(|(_, value)| *value));
    let (y_min, y_max) = value_range(all_values)?;
    let x_max = (req.points.len().saturating_sub(1)).max(1) as f64;
    let labels: Vec<String> = req
        .points
        .iter()
        .map(|point| kyiv_date_label(point.event_time))
        .collect();

    let mut rgb = vec![255; (WIDTH * HEIGHT * 3) as usize];
    {
        let root = BitMapBackend::with_buffer(&mut rgb, (WIDTH, HEIGHT)).into_drawing_area();
        root.fill(&WHITE).map_err(render_error)?;

        let mut chart = ChartBuilder::on(&root)
            .caption(req.title, (FONT_NAME, 28).into_font())
            .margin(20)
            .x_label_area_size(45)
            .y_label_area_size(60)
            .build_cartesian_2d(0.0..x_max, y_min..y_max)
            .map_err(render_error)?;

        let label_for_x = |x: &f64| {
            let index = x.round().clamp(0.0, (labels.len() - 1) as f64) as usize;
            labels[index].clone()
        };
        chart
            .configure_mesh()
            .x_labels(labels.len().min(10))
            .x_label_formatter(&label_for_x)
            .label_style((FONT_NAME, 16).into_font())
            .axis_desc_style((FONT_NAME, 16).into_font())
            .draw()
            .map_err(render_error)?;

        for (name, values) in &series {
            let color = if *name == "systolic" { RED } else { BLUE };
            chart
                .draw_series(LineSeries::new(
                    values.iter().copied(),
                    color.stroke_width(3),
                ))
                .map_err(render_error)?
                .label(*name)
                .legend(move |(x, y)| {
                    PathElement::new(vec![(x, y), (x + 24, y)], color.stroke_width(3))
                });
            chart
                .draw_series(
                    values
                        .iter()
                        .copied()
                        .map(|point| Circle::new(point, 4, color.filled())),
                )
                .map_err(render_error)?;
        }

        if req.kind == MeasurementKind::BloodPressure {
            chart
                .configure_series_labels()
                .label_font((FONT_NAME, 16).into_font())
                .background_style(WHITE.mix(0.8))
                .border_style(BLACK)
                .draw()
                .map_err(render_error)?;
        }

        root.present().map_err(render_error)?;
    }

    let image = RgbImage::from_raw(WIDTH, HEIGHT, rgb)
        .ok_or_else(|| ChartError::Render("invalid RGB buffer dimensions".to_owned()))?;
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(
            image.as_raw(),
            WIDTH,
            HEIGHT,
            image::ExtendedColorType::Rgb8,
        )
        .map_err(render_error)?;
    Ok(png)
}

pub fn kyiv_date_label(event_time: OffsetDateTime) -> String {
    let timezone = time_tz::timezones::get_by_name("Europe/Kyiv")
        .expect("the vendored IANA database includes Europe/Kyiv");
    let date = event_time.to_timezone(timezone).date();
    format!("{:02}.{:02}", date.day(), u8::from(date.month()))
}

type NamedSeries = (&'static str, Vec<(f64, f64)>);

fn extract_series(req: &ChartRequest<'_>) -> Result<Vec<NamedSeries>, ChartError> {
    match req.kind {
        MeasurementKind::BloodPressure => Ok(vec![
            ("systolic", extract_values(req.points, "systolic")?),
            ("diastolic", extract_values(req.points, "diastolic")?),
        ]),
        _ => Ok(vec![("value", extract_values(req.points, "value")?)]),
    }
}

fn extract_values(points: &[SeriesPoint], field: &str) -> Result<Vec<(f64, f64)>, ChartError> {
    points
        .iter()
        .enumerate()
        .map(|(index, point)| {
            let value = point
                .values
                .get(field)
                .and_then(serde_json::Value::as_f64)
                .filter(|value| value.is_finite())
                .ok_or_else(|| {
                    ChartError::Render(format!(
                        "point {index} has no finite numeric `{field}` value"
                    ))
                })?;
            Ok((index as f64, value))
        })
        .collect()
}

fn value_range(values: impl Iterator<Item = f64>) -> Result<(f64, f64), ChartError> {
    let (minimum, maximum) = values.fold(
        (f64::INFINITY, f64::NEG_INFINITY),
        |(minimum, maximum), value| (minimum.min(value), maximum.max(value)),
    );
    if !minimum.is_finite() || !maximum.is_finite() {
        return Err(ChartError::Render(
            "series has no finite numeric values".to_owned(),
        ));
    }

    let span = maximum - minimum;
    if !span.is_finite() {
        return Err(ChartError::Render(
            "series value range exceeds finite chart bounds".to_owned(),
        ));
    }
    let headroom = if span > 0.0 {
        span * 0.05
    } else {
        (maximum.abs() * 0.05).max(1.0)
    };
    let lower = minimum - headroom;
    let upper = maximum + headroom;
    if !headroom.is_finite() || !lower.is_finite() || !upper.is_finite() || lower >= upper {
        return Err(ChartError::Render(
            "series value range exceeds finite chart bounds".to_owned(),
        ));
    }
    Ok((lower, upper))
}

fn register_font() -> Result<(), ChartError> {
    FONT_REGISTRATION
        .get_or_init(|| {
            plotters::style::register_font(FONT_NAME, FontStyle::Normal, FONT_BYTES)
                .map_err(|_| "invalid vendored DejaVu Sans font")
        })
        .map_err(|message| ChartError::Render((*message).to_owned()))
}

fn render_error(error: impl std::fmt::Debug) -> ChartError {
    ChartError::Render(format!("{error:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_range_rejects_overflowing_finite_extremes() {
        let error = value_range([-f64::MAX, f64::MAX].into_iter()).unwrap_err();

        assert!(matches!(error, ChartError::Render(_)));
    }
}
