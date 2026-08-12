use crate::Person;
use sha2::{Digest, Sha256};

// Canonical JSON key ordering depends on serde_json's default BTreeMap-backed Value;
// the workspace must keep serde_json's `preserve_order` feature disabled.
pub fn event_dedup_hash(
    person: Person,
    event_type: &str,
    event_time: time::OffsetDateTime,
    normalized_values: &serde_json::Value,
    attachment_sha256: Option<&[u8; 32]>,
) -> [u8; 32] {
    let timestamp = event_time.unix_timestamp().to_string();
    let values = serde_json::to_string(normalized_values)
        .expect("serializing serde_json::Value cannot fail");
    let attachment = attachment_sha256.map(hex::encode).unwrap_or_default();
    let mut hasher = Sha256::new();

    hasher.update(person.as_str());
    hasher.update(b"\x1f");
    hasher.update(event_type);
    hasher.update(b"\x1f");
    hasher.update(timestamp);
    hasher.update(b"\x1f");
    hasher.update(values);
    hasher.update(b"\x1f");
    hasher.update(attachment);

    hasher.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    #[test]
    fn hash_is_deterministic_and_key_order_independent() {
        let t = datetime!(2026-08-04 14:30 +03:00);
        let a = serde_json::json!({"systolic": 136, "diastolic": 97, "pulse": 91});
        let b = serde_json::json!({"pulse": 91, "diastolic": 97, "systolic": 136});

        assert_eq!(
            event_dedup_hash(Person::Andrii, "blood_pressure", t, &a, None),
            event_dedup_hash(Person::Andrii, "blood_pressure", t, &b, None),
        );
    }

    #[test]
    fn hash_differs_by_person_type_time_values_attachment() {
        let t = datetime!(2026-08-04 14:30 +03:00);
        let v = serde_json::json!({"value": 120.5});
        let base = event_dedup_hash(Person::Andrii, "weight", t, &v, None);

        assert_ne!(
            base,
            event_dedup_hash(Person::Valentyna, "weight", t, &v, None)
        );
        assert_ne!(base, event_dedup_hash(Person::Andrii, "pulse", t, &v, None));
        assert_ne!(
            base,
            event_dedup_hash(
                Person::Andrii,
                "weight",
                t + time::Duration::minutes(1),
                &v,
                None,
            )
        );
        assert_ne!(
            base,
            event_dedup_hash(
                Person::Andrii,
                "weight",
                t,
                &serde_json::json!({"value": 120.6}),
                None,
            )
        );
        assert_ne!(
            base,
            event_dedup_hash(Person::Andrii, "weight", t, &v, Some(&[7_u8; 32]))
        );
    }

    #[test]
    fn hash_normalizes_timezone() {
        let kyiv = datetime!(2026-08-04 14:30 +03:00);
        let utc = datetime!(2026-08-04 11:30 UTC);
        let v = serde_json::json!({"value": 1});

        assert_eq!(
            event_dedup_hash(Person::Andrii, "weight", kyiv, &v, None),
            event_dedup_hash(Person::Andrii, "weight", utc, &v, None),
        );
    }

    #[test]
    fn hash_matches_canonical_sha256_bytes() {
        let t = datetime!(2026-08-04 14:30 +03:00);
        let v = serde_json::json!({"value": 120.5});

        assert_eq!(
            hex::encode(event_dedup_hash(Person::Andrii, "weight", t, &v, None,)),
            "ad5b15733dfdc8e4b49038c5dc839c179b87f752ae4d4a5cb4bb6b453b12eb4e",
        );
    }
}
