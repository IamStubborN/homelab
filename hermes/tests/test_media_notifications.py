import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "hermes_media_notifications.py"
JOB_ID = "00000000-0000-0000-0000-000000000999"
TRACKING_ID = "00000000-0000-0000-0000-000000000555"


def load_module():
    spec = importlib.util.spec_from_file_location("hermes_media_notifications_tests", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def payload(**overrides):
    value = {
        "event_type": "media.notification",
        "schema_version": 2,
        "delivery_kind": "card",
        "card_key": f"media-job:{JOB_ID}",
        "revision": 7,
        "lifecycle_cycle": 1,
        "terminal": False,
        "state": "downloading",
        "media": {
            "job_id": JOB_ID,
            "title": "Магия и мускулы",
            "kind": "series",
            "provider": "rezka",
            "season": 1,
            "translation": "AniLibria",
            "poster_url": "https://image.tmdb.org/t/p/w780/mashle.jpg",
        },
        "progress": {
            "completed_episodes": 7,
            "total_episodes": 12,
            "current_episode": 8,
            "downloaded_bytes": 195035136,
            "total_bytes": 688385900,
            "download_speed_bps": 5452595,
            "percentage": 28,
            "eta_seconds": 91,
            "seeds": 3,
            "peers": 1,
            "source_state": "downloading",
        },
        "stage": "download",
        "next_step": "process",
        "actions": ["cancel", "details"],
    }
    value.update(overrides)
    return value


def detailed_completed_payload(**overrides):
    value = payload(
        revision=20,
        terminal=True,
        state="completed",
        media={
            "job_id": JOB_ID,
            "title": "Клинки Хранителей",
            "kind": "series",
            "provider": "rezka",
            "season": 2,
            "translation": "AniLibria",
        },
        progress={
            "completed_episodes": 1,
            "total_episodes": 1,
            "current_episode": 8,
        },
        stage="publish",
        next_step="none",
        result={
            "video": {"codec": "hevc", "profile": "Main", "width": 1920, "height": 1080},
            "audio": {
                "language": "rus",
                "codec": "aac",
                "channels": 2,
                "channel_layout": "stereo",
                "title": "AniLibria",
            },
            "subtitles": {"downloaded": 2, "missing": 0},
            "file_size_bytes": 440401920,
            "duration_seconds": 1421,
            "processing": {"mode": "vaapi-upscale", "elapsed_seconds": 252},
            "publication": {
                "library": "tv-shows",
                "title": "Клинки Хранителей",
                "season": 2,
                "episode": 8,
            },
        },
        actions=["details"],
    )
    value.update(overrides)
    return value


class MediaNotificationRenderTests(unittest.TestCase):
    def test_card_text_and_keyboard_limits_are_enforced(self):
        module = load_module()

        bounded = module._bounded_card_text(["x" * 5000])

        self.assertEqual(len(bounded), 1024)
        self.assertTrue(bounded.endswith("..."))
        action = module.RenderedAction("A", f"hm:e:{JOB_ID}")
        with self.assertRaises(ValueError):
            module.RenderedCard(
                "too many",
                tuple((action,) for _ in range(101)),
            )

    def test_compact_details_and_cancel_confirmation_use_explicit_rows(self):
        module = load_module()
        notification = module.parse_notification(payload())

        compact = module.render_card(notification, module.CardView.COMPACT)
        details = module.render_card(notification, module.CardView.DETAILS)
        confirmation = module.render_card(
            notification, module.CardView.CONFIRM_CANCEL
        )

        self.assertEqual(
            [[action.label for action in row] for row in compact.button_rows],
            [["Подробнее", "Отменить"]],
        )

        self.assertEqual(
            [[action.label for action in row] for row in details.button_rows],
            [["Назад", "Отменить"]],
        )
        self.assertEqual(
            [[action.label for action in row] for row in confirmation.button_rows],
            [["Да, отменить", "Назад"]],
        )
        self.assertNotIn(
            f"ma:cancel:{JOB_ID}",
            [action.callback_data for action in compact.actions],
        )
        self.assertNotIn(
            f"ma:cancel:{JOB_ID}",
            [action.callback_data for action in details.actions],
        )
        self.assertEqual(
            [action.callback_data for action in confirmation.actions],
            [
                module.callback_data(
                    "cancel",
                    JOB_ID,
                    lifecycle_cycle=notification.lifecycle_cycle,
                    revision=notification.revision,
                ),
                f"hm:x:{JOB_ID}",
            ],
        )
        self.assertIn("Подробности", details.text)
        self.assertIn("Осталось примерно: 1 мин 31 сек", details.text)
        self.assertIn("источников: 3 · подключений: 1", details.text)
        self.assertIn("Состояние источника: скачивается", details.text)
        self.assertIn("Отменить загрузку?", confirmation.text)
        self.assertNotIn(JOB_ID, compact.text + details.text + confirmation.text)
        self.assertEqual(
            compact.photo,
            "https://image.tmdb.org/t/p/w780/mashle.jpg",
        )
        self.assertEqual(details.photo, compact.photo)
        self.assertEqual(confirmation.photo, compact.photo)

    def test_terminal_event_is_compact_and_opens_shared_job_card(self):
        module = load_module()
        notification = module.parse_notification(
            detailed_completed_payload(delivery_kind="final-push")
        )

        event = module.render_event(notification)

        self.assertIn("уже в Plex", event.text)
        self.assertNotIn(JOB_ID, event.text)
        self.assertEqual(
            [[action.callback_data for action in row] for row in event.button_rows],
            [[f"mp:job:{JOB_ID}"]],
        )

    def test_terminal_and_needs_action_cards_render_canonical_media_title(self):
        module = load_module()
        canonical = "Легенда об Аанге: Последний маг воздуха"
        for state, terminal in (("completed", True), ("failed", True), ("needs-action", True)):
            raw = payload(state=state, terminal=terminal)
            raw["media"]["title"] = canonical
            if state == "needs-action":
                raw["issue"] = {"code": "identity_ambiguous", "message": "needs action"}
                raw["actions"] = ["details"]

            notification = module.parse_notification(raw)

            self.assertIn(canonical, module.render_card(notification).text)

    def test_job_card_uses_local_fallback_when_poster_is_missing(self):
        module = load_module()
        raw = payload()
        raw["media"].pop("poster_url")

        card = module.render_card(module.parse_notification(raw))

        self.assertEqual(card.photo, module._SOURCE_CHOICE_FALLBACK_PHOTO)

    def test_presentation_callback_protocol_is_short_and_strict(self):
        module = load_module()

        callback = module.presentation_callback_data("expand", JOB_ID)

        self.assertEqual(callback, f"hm:e:{JOB_ID}")
        self.assertLess(len(callback.encode("utf-8")), 64)
        self.assertEqual(
            module.parse_presentation_callback_data(callback),
            ("expand", JOB_ID),
        )
        self.assertIsNone(
            module.parse_presentation_callback_data("hm:e:not-a-uuid")
        )

    def test_source_choice_card_uses_explicit_provider_buttons(self):
        module = load_module()
        notification = module.parse_source_choice(
            {
                "event_type": "media.source-choice",
                "schema_version": 1,
                "card_key": f"tracking:{TRACKING_ID}:3:5",
                "tracking_id": TRACKING_ID,
                "title": "Реинкарнация безработного",
                "season": 3,
                "episode": 5,
                "actions": ["all", "rezka", "prowlarr"],
                "poster_url": "https://static.tvmaze.com/poster.jpg",
            }
        )

        card = module.render_source_choice(notification)

        self.assertEqual(
            card.text,
            "\n".join(
                [
                    "🎬 Реинкарнация безработного",
                    "🆕 S03E05",
                    "",
                    "✅ Rezka · серия и озвучки",
                    "✅ Prowlarr · раздачи",
                ]
            ),
        )
        self.assertEqual(
            card.photo,
            "https://static.tvmaze.com/poster.jpg",
        )
        self.assertEqual(
            [(action.label, action.callback_data) for action in card.actions],
            [
                ("🌐 Rezka", f"ms:r:{TRACKING_ID}:3:5"),
                ("🧲 Prowlarr", f"ms:p:{TRACKING_ID}:3:5"),
            ],
        )
        self.assertEqual(
            [[action.label for action in row] for row in card.button_rows],
            [["🌐 Rezka", "🧲 Prowlarr"]],
        )

    def test_parser_accepts_detailed_and_legacy_schema_v2_payloads(self):
        module = load_module()

        detailed = module.parse_notification(detailed_completed_payload())
        legacy = module.parse_notification(payload())

        self.assertEqual(detailed.result.video.width, 1920)
        self.assertEqual(detailed.result.processing.mode, "vaapi-upscale")
        self.assertIsNone(legacy.result)

    def test_parser_accepts_prowlarr_original_and_tracked_episode_payloads(self):
        module = load_module()
        prowlarr = module.parse_notification(
            detailed_completed_payload(
                media={
                    "job_id": JOB_ID,
                    "title": "Экспансия",
                    "kind": "series",
                    "provider": "prowlarr",
                    "season": 3,
                },
                progress={"completed_episodes": 10, "total_episodes": 10},
                result={"processing": {"mode": "original"}},
            )
        )
        tracked = module.parse_notification(
            payload(
                state="queued",
                stage=None,
                media={**payload()["media"], "origin": "tracked-episode"},
            )
        )

        self.assertEqual(prowlarr.result.processing.mode, "original")
        self.assertEqual(tracked.media.origin, "tracked-episode")

    def test_parser_rejects_invalid_detailed_result_and_recovery_values(self):
        module = load_module()
        cases = (
            detailed_completed_payload(result={"unknown": "field"}),
            detailed_completed_payload(
                result={"video": {"codec": "hevc", "width": 0, "height": 1080}}
            ),
            payload(
                progress={"connection_attempt": 21, "connection_attempt_limit": 20},
                issue={"code": "source_recovering", "message": "source transfer is being recovered"},
            ),
            payload(progress={"storage_required_bytes": 100}),
            detailed_completed_payload(
                result={"video": {"codec": "https://unsafe.example", "width": 1920, "height": 1080}}
            ),
            detailed_completed_payload(result={"processing": {"mode": "original"}}),
        )

        for invalid in cases:
            with self.subTest(invalid=invalid):
                with self.assertRaises(module.NotificationParseError):
                    module.parse_notification(invalid)

    def test_parser_rejects_unsafe_primary_result_display_text_before_rendering(self):
        module = load_module()
        cases = (
            (
                "audio title URL",
                {"audio": {"codec": "aac", "title": "https://example.test/?token=secret"}},
            ),
            (
                "audio title bare URL",
                {"audio": {"codec": "aac", "title": "cdn.example.test/media/file.mka"}},
            ),
            (
                "video codec absolute path",
                {"video": {"codec": "/var/lib/media/source.mkv", "width": 1920, "height": 1080}},
            ),
            (
                "video profile home path",
                {"video": {"codec": "hevc", "profile": "~/.config/token", "width": 1920, "height": 1080}},
            ),
            (
                "audio language Windows path",
                {"audio": {"codec": "aac", "language": r"C:\\Users\\hermes\\secret.txt"}},
            ),
            (
                "audio layout shell command",
                {"audio": {"codec": "aac", "channel_layout": "curl --header Authorization:Bearer"}},
            ),
            (
                "publication title secret",
                {"publication": {"library": "tv-shows", "title": "api_key=super-secret-value"}},
            ),
            (
                "audio title bearer secret",
                {"audio": {"codec": "aac", "title": "Bearer eyJhbGciOiJIUzI1NiJ9"}},
            ),
            (
                "internal error code",
                {"audio": {"codec": "aac", "title": "INTERNAL_RENDER_FAILURE"}},
            ),
        )

        for description, result in cases:
            with self.subTest(description=description):
                with self.assertRaises(module.NotificationParseError):
                    module.parse_notification(detailed_completed_payload(result=result))

    def test_parser_rejects_unsafe_media_display_text_before_rendering(self):
        module = load_module()
        cases = (
            ("title URL", "title", "https://example.test/media"),
            ("translation URL", "translation", "cdn.example.test/voice"),
            ("title absolute path", "title", "/var/lib/media/source.mkv"),
            ("translation Windows path", "translation", r"C:\\Users\\hermes\\secret.txt"),
            ("title shell command", "title", "curl --header Authorization:Bearer"),
            ("translation shell command", "translation", "python3 export.py"),
            ("title secret", "title", "api_key=super-secret-value"),
            ("translation bearer secret", "translation", "Bearer eyJhbGciOiJIUzI1NiJ9"),
            ("title internal code", "title", "INTERNAL_RENDER_FAILURE"),
            ("translation internal code", "translation", "TRANSLATION_LOOKUP_ERROR"),
        )

        for description, field, value in cases:
            with self.subTest(description=description):
                with self.assertRaises(module.NotificationParseError):
                    module.parse_notification(
                        payload(media={**payload()["media"], field: value})
                    )

    def test_parser_rejects_bounded_display_text_bypasses_in_every_source(self):
        module = load_module()
        sources = (
            "media.title",
            "media.translation",
            "result.video.codec",
            "result.video.profile",
            "result.audio.language",
            "result.audio.codec",
            "result.audio.channel_layout",
            "result.audio.title",
            "result.publication.title",
        )
        dangerous_values = (
            ("contextual echo command", "Safe title: echo hello"),
            ("contextual rm command", "Track: rm -rf media"),
            ("contextual ls command", "Track: ls -la"),
            ("contextual git command", "Track: git status"),
            ("punctuation-attached absolute path", "Film:/var/lib/media"),
            ("Unicode bare domain", "Watch example.рф"),
        )

        for source in sources:
            for description, value in dangerous_values:
                with self.subTest(source=source, description=description):
                    invalid = detailed_completed_payload()
                    target = invalid
                    *parents, field = source.split(".")
                    for parent in parents:
                        target = target[parent]
                    target[field] = value

                    with self.assertRaises(module.NotificationParseError):
                        module.parse_notification(invalid)

    def test_parser_accepts_multilingual_display_text_in_every_source(self):
        module = load_module()
        cases = (
            ("media.title", "神之塔: 王子の帰還"),
            ("media.translation", "Дубляж AniLibria"),
            ("result.video.codec", "H.265/HEVC"),
            ("result.video.profile", "Main 10 (HDR)"),
            ("result.audio.language", "русский"),
            ("result.audio.codec", "DTS-HD MA"),
            ("result.audio.channel_layout", "5.1"),
            ("result.audio.title", "Кубик в Кубе: режиссёрская версия"),
            ("result.publication.title", "Lupin III: Part 2 - Episode 08"),
        )

        for source, value in cases:
            with self.subTest(source=source):
                valid = detailed_completed_payload()
                target = valid
                *parents, field = source.split(".")
                for parent in parents:
                    target = target[parent]
                target[field] = value

                module.parse_notification(valid)

    def test_media_display_text_keeps_human_multilingual_names(self):
        module = load_module()
        notification = module.parse_notification(
            payload(
                media={
                    **payload()["media"],
                    "title": "神之塔: 王子の帰還",
                    "translation": "Дубляж AniLibria",
                }
            )
        )

        card = module.render_card(notification, module.CardView.DETAILS)

        self.assertIn("⬇️ 神之塔: 王子の帰還 · Сезон 1", card.text)
        self.assertIn("🎙 Дубляж AniLibria · Rezka", card.text)

    def test_primary_result_display_text_keeps_human_multilingual_labels(self):
        module = load_module()
        notification = module.parse_notification(
            detailed_completed_payload(
                result={
                    "video": {
                        "codec": "H.265/HEVC",
                        "profile": "Main 10 (HDR)",
                        "width": 3840,
                        "height": 2160,
                    },
                    "audio": {
                        "language": "русский",
                        "codec": "DTS-HD MA",
                        "channel_layout": "5.1",
                        "title": "Кубик в Кубе: режиссёрская версия",
                    },
                    "publication": {
                        "library": "tv-shows",
                        "title": "Lupin III: Part 2 - Episode 08",
                    },
                }
            )
        )

        card = module.render_card(notification, module.CardView.DETAILS)

        self.assertIn("Видео: 3840x2160 · H.265/HEVC Main 10 (HDR)", card.text)
        self.assertIn("Аудио: русский · DTS-HD MA 5.1 · Кубик в Кубе: режиссёрская версия", card.text)
        self.assertIn("Plex → Сериалы → Lupin III: Part 2 - Episode 08", card.text)

    def test_detailed_completed_episode_renders_confirmed_measurements(self):
        module = load_module()
        notification = module.parse_notification(detailed_completed_payload())

        card = module.render_card(notification, module.CardView.DETAILS)

        self.assertIn("Клинки Хранителей · S02E08", card.text)
        self.assertIn("Видео: 1920x1080 · HEVC Main", card.text)
        self.assertIn("Аудио: русский · AAC Stereo", card.text)
        self.assertIn("Субтитры: 2 дорожки", card.text)
        self.assertIn("Обработка: VAAPI upscale · 4 мин 12 сек", card.text)
        self.assertIn("Plex → Сериалы → Клинки Хранителей → Сезон 2", card.text)
        self.assertNotIn("Клинки Хранителей · Сезон 2", card.text.splitlines()[0])
        self.assertEqual(module.render_push(notification), "✅ Клинки Хранителей · S02E08 уже в Plex")

    def test_original_prowlarr_processing_and_absent_metadata_are_truthful(self):
        module = load_module()
        notification = module.parse_notification(
            detailed_completed_payload(
                media={
                    "job_id": JOB_ID,
                    "title": "Экспансия",
                    "kind": "series",
                    "provider": "prowlarr",
                    "season": 3,
                },
                progress={"completed_episodes": 10, "total_episodes": 10},
                result={"processing": {"mode": "original"}},
            )
        )

        text = module.render_card(notification, module.CardView.DETAILS).text

        self.assertIn("Без перекодирования", text)
        self.assertNotIn("VAAPI", text)
        self.assertNotIn("Видео:", text)
        self.assertNotIn("Аудио:", text)
        self.assertNotIn("Субтитры:", text)

    def test_tracked_episode_recovery_storage_and_plex_pending_copy(self):
        module = load_module()
        tracked = module.parse_notification(
            payload(
                state="queued",
                stage=None,
                media={**payload()["media"], "origin": "tracked-episode"},
            )
        )
        recovery = module.parse_notification(
            payload(
                progress={
                    "connection_attempt": 5,
                    "connection_attempt_limit": 20,
                    "vpn_rotation_pending": True,
                },
                issue={"code": "source_recovering", "message": "source transfer is being recovered"},
            )
        )
        storage = module.parse_notification(
            payload(
                terminal=True,
                state="needs-action",
                progress={"storage_required_bytes": 20 * 1024**3, "storage_available_bytes": 5 * 1024**3},
                issue={"code": "storage_blocked", "message": "storage is required"},
                actions=["resume-storage", "details"],
            )
        )
        plex_pending = module.parse_notification(
            detailed_completed_payload(
                terminal=False,
                state="publishing",
                issue={"code": "plex_pending", "message": "Plex publication is pending"},
                actions=["retry", "details"],
            )
        )

        self.assertTrue(module.render_card(tracked).text.startswith("🆕 Найдена новая серия"))
        self.assertIn("⬇️ Автоматическое скачивание началось", module.render_card(tracked).text)
        recovery_text = module.render_card(recovery, module.CardView.DETAILS).text
        self.assertIn("Попытка соединения: 5 из 20", recovery_text)
        self.assertIn("VPN", recovery_text)
        self.assertNotIn("раздача активна", recovery_text)
        storage_text = module.render_card(storage, module.CardView.DETAILS).text
        self.assertIn("Требуется: 20 ГБ", storage_text)
        self.assertTrue(module.render_push(storage).startswith("⛔ Требуется действие:"))
        self.assertIn("Доступно: 5 ГБ", storage_text)
        pending_text = module.render_card(plex_pending).text
        self.assertIn("Подготовленный файл сохранён", pending_text)
        self.assertIn("будет повторена только публикация в Plex", pending_text)

    def test_partial_season_has_retry_alternative_and_diagnostics_actions(self):
        module = load_module()
        notification = module.parse_notification(
            payload(
                terminal=True,
                state="partial",
                progress={
                    "completed_episodes": 11,
                    "total_episodes": 12,
                    "missing_episodes": [{"season": 1, "episode": 12}],
                },
                stage="publish",
                next_step="none",
                actions=["retry-missing", "search-alternative", "details"],
            )
        )

        card = module.render_card(notification)

        self.assertIn("В Plex: 11 из 12 серий", card.text)
        self.assertEqual(
            [action.label for action in card.actions],
            ["Докачать недостающее", "Выбрать другой источник", "Подробнее"],
        )

    def test_every_job_action_has_a_user_facing_inline_callback(self):
        module = load_module()
        notification = module.parse_notification(
            payload(
                actions=[
                    "cancel",
                    "retry",
                    "retry-missing",
                    "resume-storage",
                    "details",
                    "search-alternative",
                ]
            )
        )

        card = module.render_card(notification)

        self.assertEqual(
            [action.label for action in card.actions],
            ["Повторить", "Выбрать другой источник", "Подробнее", "Отменить"],
        )
        self.assertEqual(
            [
                action.callback_data.split(":", 2)[:2]
                for action in card.actions
            ],
            [["ma", "retry"], ["ma", "search-alternative"], ["hm", "e"], ["hm", "c"]],
        )
        self.assertTrue(
            all(len(action.callback_data.encode("utf-8")) < 64 for action in card.actions)
        )

    def test_rezka_card_uses_balanced_russian_layout(self):
        module = load_module()

        card = module.render_card(module.parse_notification(payload()))

        self.assertEqual(
            card.text,
            "\n".join(
                [
                    "⬇️ Магия и мускулы · Сезон 1",
                    "📺 Готово: 7 из 12 серий",
                    "🎙 AniLibria · Rezka",
                "📦 Серия 8: 186 МБ из 656,5 МБ · 5,2 МБ/с",
                    "🔄 Скачиваю исходное видео",
                    "➡️ Далее: обработка и добавление в Plex",
                ]
            ),
        )
        self.assertEqual(
            [(action.label, action.callback_data) for action in card.actions],
            [
                ("Подробнее", f"hm:e:{JOB_ID}"),
                ("Отменить", f"hm:c:{JOB_ID}"),
            ],
        )

    def test_specials_card_uses_plex_friendly_label(self):
        module = load_module()
        notification = module.parse_notification(
            payload(
                media={
                    **payload()["media"],
                    "title": "Атака титанов",
                    "season": 0,
                    "translation": "Дубляж",
                },
                progress={
                    "completed_episodes": 1,
                    "total_episodes": 1,
                    "current_episode": 1,
                    "missing_episodes": [{"season": 0, "episode": 2}],
                },
            )
        )

        card = module.render_card(notification)

        self.assertIn("⬇️ Атака титанов · S00E01", card.text)
        self.assertIn("⚠️ Не добавлена серия: 2", card.text)

    def test_prowlarr_card_includes_torrent_measurements(self):
        module = load_module()
        notification = module.parse_notification(
            payload(
                media={
                    "job_id": JOB_ID,
                    "title": "Планета сокровищ",
                    "kind": "movie",
                    "provider": "prowlarr",
                },
                progress={
                    "percentage": 42,
                    "downloaded_bytes": 1073741824,
                    "download_speed_bps": 10485760,
                },
            )
        )

        text = module.render_card(notification).text

        self.assertIn("🧲 Prowlarr", text)
        self.assertIn("📦 42%: 1 ГБ · 10 МБ/с", text)

    def test_missing_hls_total_never_invents_percent_or_eta(self):
        module = load_module()
        notification = module.parse_notification(
            payload(progress={"downloaded_bytes": 10485760, "download_speed_bps": 1048576})
        )

        text = module.render_card(notification).text

        self.assertIn("📦 10 МБ · 1 МБ/с", text)
        self.assertNotIn("%", text)
        self.assertNotIn("ETA", text)

    def test_single_episode_job_keeps_the_provider_episode_number(self):
        module = load_module()
        notification = module.parse_notification(
            payload(
                progress={
                    "completed_episodes": 0,
                    "total_episodes": 1,
                    "current_episode": 4,
                }
            )
        )

        self.assertEqual(notification.progress.current_episode, 4)

    def test_partial_result_lists_missing_episodes_and_retry_action(self):
        module = load_module()
        notification = module.parse_notification(
            payload(
                revision=12,
                terminal=True,
                state="partial",
                progress={
                    "completed_episodes": 11,
                    "total_episodes": 12,
                    "missing_episodes": [{"season": 1, "episode": 12}],
                },
                stage="publish",
                next_step="none",
                actions=["retry-missing", "details"],
            )
        )

        card = module.render_card(notification)

        self.assertIn("📺 В Plex: 11 из 12 серий", card.text)
        self.assertIn("⚠️ Не добавлена серия: 12", card.text)
        self.assertEqual(card.actions[0].label, "Докачать недостающее")

    def test_publish_and_none_next_step_use_contract_values(self):
        module = load_module()
        publishing = module.render_card(
            module.parse_notification(
                payload(state="publishing", stage="publish", next_step="none", actions=[])
            )
        )

        self.assertIn("Добавляю в Plex", publishing.text)
        self.assertNotIn("➡️ Далее", publishing.text)

    def test_terminal_card_and_push_hide_internal_fields(self):
        module = load_module()
        notification = module.parse_notification(
            payload(
                revision=20,
                terminal=True,
                state="completed",
                stage="publish",
                next_step="none",
                progress={"completed_episodes": 12, "total_episodes": 12},
                issue={"code": "INTERNAL_ONLY", "message": "Internal failure"},
            )
        )

        text = module.render_card(notification).text
        push = module.render_push(notification)

        self.assertIn("✅ Готово", text)
        self.assertEqual(push, "✅ Магия и мускулы · Сезон 1 уже в Plex")
        for hidden in (JOB_ID, "INTERNAL_ONLY", "/secret/path", "7"):
            self.assertNotIn(hidden, text)
            self.assertNotIn(hidden, push)

    def test_cancelled_push_names_the_outcome(self):
        module = load_module()
        notification = module.parse_notification(
            payload(
                revision=21,
                terminal=True,
                state="cancelled",
                stage=None,
                next_step="none",
                actions=["details"],
            )
        )

        self.assertEqual(
            module.render_push(notification),
            "⏹️ Отменено: Магия и мускулы · Сезон 1",
        )

    def test_parser_rejects_unknown_or_incomplete_wire_payload(self):
        module = load_module()

        with self.assertRaises(ValueError):
            module.parse_notification(payload(schema_version=3))
        with self.assertRaises(ValueError):
            module.parse_notification(payload(media={"title": "no id"}))
        with self.assertRaises(ValueError):
            module.parse_notification(payload(actions=["delete-everything"]))
        with self.assertRaises(ValueError):
            module.parse_notification(
                payload(media={**payload()["media"], "provider": "https://host/video?token=secret"})
            )

    def test_issue_codes_render_safe_user_facing_copy(self):
        module = load_module()
        cases = {
            "storage_blocked": "Недостаточно свободного места",
            "needs_action": "Нужен ваш выбор",
            "media_failed": "Не удалось скачать или обработать видео",
            "subtitles_missing": "Некоторые субтитры недоступны",
            "unexpected_internal_code": "Загрузка требует внимания",
        }

        for code, expected in cases.items():
            with self.subTest(code=code):
                notification = module.parse_notification(
                    payload(
                        terminal=True,
                        state="failed",
                        next_step="none",
                        actions=["retry", "details"],
                        issue={"code": code, "message": "https://secret/path?token=value"},
                    )
                )
                text = module.render_card(notification).text
                self.assertIn(expected, text)
                self.assertNotIn("https://secret", text)
                self.assertNotIn("unexpected_internal_code", text)

    def test_parser_rejects_unknown_fields_in_every_schema_v2_object(self):
        module = load_module()
        malformed_payloads = [
            payload(unexpected=True),
            payload(media={**payload()["media"], "episode": 1}),
            payload(progress={**payload()["progress"], "percent": 42}),
            payload(
                progress={
                    **payload()["progress"],
                    "missing_episodes": [{"season": 1, "episode": 8, "extra": True}],
                }
            ),
            payload(issue={"code": "FAILED", "message": "Failed", "path": "/secret"}),
        ]

        for malformed in malformed_payloads:
            with self.subTest(payload=malformed):
                with self.assertRaises(ValueError):
                    module.parse_notification(malformed)

    def test_parser_accepts_omitted_progress_and_actions_for_terminal_pushes(self):
        module = load_module()

        terminal = payload(
            delivery_kind="final-push",
            terminal=True,
            state="completed",
            stage="publish",
            next_step="none",
        )
        terminal.pop("progress")
        terminal.pop("actions")

        notification = module.parse_notification(terminal)

        self.assertIsNone(notification.progress)
        self.assertEqual(notification.actions, ())
        self.assertIn("✅ Готово", module.render_card(notification).text)
        self.assertEqual(module.render_push(notification), "✅ Магия и мускулы · Сезон 1 уже в Plex")

    def test_parser_rejects_null_or_malformed_present_optional_fields(self):
        module = load_module()
        malformed_payloads = [
            payload(progress=None),
            payload(actions=None),
            payload(progress=[]),
            payload(actions={}),
            payload(progress={"completed_episodes": "7"}),
            payload(actions=["unknown"]),
        ]

        for malformed in malformed_payloads:
            with self.subTest(payload=malformed):
                with self.assertRaises(ValueError):
                    module.parse_notification(malformed)

    def test_parser_rejects_malformed_action_shapes_as_value_error(self):
        module = load_module()

        for malformed_action in ({}, [], 1, None):
            with self.subTest(action=malformed_action):
                with self.assertRaises(ValueError):
                    module.parse_notification(payload(actions=[malformed_action]))

    def test_parser_rejects_final_push_that_is_not_terminal(self):
        module = load_module()

        with self.assertRaises(ValueError):
            module.parse_notification(payload(delivery_kind="final-push"))
        with self.assertRaises(ValueError):
            module.parse_notification(
                payload(delivery_kind="final-push", terminal=False, state="completed")
            )

    def test_callback_protocol_is_short_and_strict(self):
        module = load_module()

        callback = module.callback_data("retry-missing", JOB_ID)

        self.assertEqual(callback, f"ma:retry-missing:{JOB_ID}")
        self.assertLess(len(callback.encode("utf-8")), 64)
        self.assertEqual(module.parse_callback_data(callback), ("retry-missing", JOB_ID))
        self.assertIsNone(module.parse_callback_data("ma:cancel:not-a-uuid"))

    def test_mutation_callbacks_are_scoped_to_notification_lifecycle(self):
        module = load_module()

        first = module.callback_data(
            "resume-storage", JOB_ID, lifecycle_cycle=2, revision=7
        )
        replay = module.callback_data(
            "resume-storage", JOB_ID, lifecycle_cycle=2, revision=7
        )
        later = module.callback_data(
            "resume-storage", JOB_ID, lifecycle_cycle=2, revision=8
        )
        next_lifecycle = module.callback_data(
            "resume-storage", JOB_ID, lifecycle_cycle=3, revision=1
        )

        self.assertEqual(first, replay)
        self.assertEqual(first, later)
        self.assertNotEqual(first, next_lifecycle)
        self.assertEqual(first, f"ma:resume-storage:{JOB_ID}:0baf780f")
        self.assertRegex(first, rf"^ma:resume-storage:{JOB_ID}:[0-9a-f]{{8}}$")
        self.assertEqual(module.parse_callback_data(first), ("resume-storage", JOB_ID))
        self.assertLessEqual(len(first.encode("utf-8")), 64)

    def test_rendered_retry_and_cancel_use_notification_generation(self):
        module = load_module()
        notification = module.parse_notification(
            payload(revision=7, lifecycle_cycle=2, actions=["retry", "cancel"])
        )

        retry_card = module.render_card(notification)
        cancel_card = module.render_card(notification, module.CardView.CONFIRM_CANCEL)
        callbacks = [
            action.callback_data
            for card in (retry_card, cancel_card)
            for action in card.actions
            if action.callback_data.startswith("ma:")
        ]

        self.assertTrue(callbacks)
        for callback in callbacks:
            self.assertRegex(callback, r":[0-9a-f]{8}$")


class MediaNotificationStateTests(unittest.TestCase):
    def test_terminal_card_never_renders_cancel_from_malformed_actions(self):
        module = load_module()
        terminal_payload = detailed_completed_payload(actions=["details", "cancel"])
        notification = module.parse_notification(terminal_payload)

        rendered_cards = (
            module.render_card(notification),
            module.render_card(notification, module.CardView.DETAILS),
            module.render_card(notification, module.CardView.CONFIRM_CANCEL),
        )
        callbacks = [
            action.callback_data
            for rendered in rendered_cards
            for action in rendered.actions
        ]

        self.assertFalse(
            any(value.startswith(("hm:c:", "ma:cancel:")) for value in callbacks)
        )

    def test_update_state_never_persists_invalid_cancel_confirmation(self):
        module = load_module()
        notification = module.parse_notification(payload(actions=["details"]))
        state = module.NotificationState()
        confirmation = module.render_card(
            module.parse_notification(payload()),
            module.CardView.CONFIRM_CANCEL,
        )

        module.update_card_state(
            state,
            "123:media-job:test",
            notification,
            "456",
            rendered=confirmation,
            view=module.CardView.CONFIRM_CANCEL,
            notification_payload=payload(actions=["details"]),
        )

        card = state.cards["123:media-job:test"]
        self.assertEqual(card.view, module.CardView.COMPACT)
        self.assertEqual(
            card.fingerprint,
            module.card_fingerprint(
                module.render_card(notification, module.CardView.COMPACT)
            ),
        )

    def test_malformed_cached_payload_is_dropped_without_losing_card(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "media-notifications.json"
            path.write_text(
                json.dumps(
                    {
                        "version": 4,
                        "cards": {
                            "123:media-job:old": {
                                "message_id": "456",
                                "revision": 7,
                                "lifecycle_cycle": 1,
                                "terminal": False,
                                "stage": "download",
                                "updated_at": 100.0,
                                "fingerprint": "",
                                "action_callbacks": [],
                                "view": "details",
                                "notification_payload": {"schema_version": 999},
                            }
                        },
                        "push_receipts": [],
                        "control_receipts": [],
                    }
                ),
                encoding="utf-8",
            )

            card = module.load_state(path).cards["123:media-job:old"]

        self.assertEqual(card.message_id, "456")
        self.assertEqual(card.view, module.CardView.DETAILS)
        self.assertIsNone(card.notification_payload)

    def test_state_persists_view_and_validated_notification_payload(self):
        module = load_module()
        notification_payload = payload()
        notification = module.parse_notification(notification_payload)
        state = module.NotificationState()

        module.update_card_state(
            state,
            "123:media-job:test",
            notification,
            "456",
            view=module.CardView.DETAILS,
            notification_payload=notification_payload,
        )

        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "media-notifications.json"
            module.save_state(path, state)
            restored = module.load_state(path)

        card = restored.cards["123:media-job:test"]
        self.assertEqual(card.view, module.CardView.DETAILS)
        self.assertEqual(
            module.parse_notification(card.notification_payload).media.job_id,
            JOB_ID,
        )

    def test_version_three_state_migrates_to_compact_without_payload(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "media-notifications.json"
            path.write_text(
                json.dumps(
                    {
                        "version": 3,
                        "cards": {
                            "123:media-job:old": {
                                "message_id": "456",
                                "revision": 7,
                                "lifecycle_cycle": 1,
                                "terminal": False,
                                "stage": "download",
                                "updated_at": 100.0,
                                "fingerprint": "",
                                "action_callbacks": [],
                            }
                        },
                        "push_receipts": [],
                    }
                ),
                encoding="utf-8",
            )

            card = module.load_state(path).cards["123:media-job:old"]

        self.assertEqual(card.view, module.CardView.COMPACT)
        self.assertIsNone(card.notification_payload)

    def test_updating_a_card_refreshes_its_retention_order(self):
        module = load_module()
        state = module.NotificationState(
            cards={
                "old": module.CardState("1", 1, 1, False, "download", 1.0),
                "new": module.CardState("2", 1, 1, False, "download", 2.0),
            }
        )
        notification = module.parse_notification(payload(revision=2))

        module.update_card_state(state, "old", notification, "1", now=3.0)

        self.assertEqual(list(state.cards), ["new", "old"])

    def test_stale_equal_and_throttled_progress_are_not_applied(self):
        module = load_module()
        stored = module.CardState("123", 7, 1, False, "download", 100.0)

        self.assertEqual(
            module.decide_update(stored, module.parse_notification(payload(revision=7)), now=105.0),
            module.UpdateDecision.IGNORE,
        )
        self.assertEqual(
            module.decide_update(stored, module.parse_notification(payload(revision=8)), now=104.0),
            module.UpdateDecision.RETRY,
        )

    def test_stage_change_and_explicit_retry_reopen_card(self):
        module = load_module()
        stored = module.CardState("123", 7, 1, False, "download", 100.0)

        self.assertEqual(
            module.decide_update(stored, module.parse_notification(payload(revision=8, stage="process")), now=105.0),
            module.UpdateDecision.EDIT,
        )
        self.assertEqual(
            module.decide_update(stored, module.parse_notification(payload(revision=1, lifecycle_cycle=2)), now=105.0),
            module.UpdateDecision.EDIT,
        )

    def test_terminal_lock_and_missing_message_replacement(self):
        module = load_module()
        terminal = module.CardState("123", 20, 1, True, "completed", 100.0)
        missing = module.CardState(None, 7, 1, False, "download", 100.0)

        self.assertEqual(
            module.decide_update(terminal, module.parse_notification(payload(revision=21)), now=120.0),
            module.UpdateDecision.IGNORE,
        )
        self.assertEqual(
            module.decide_update(missing, module.parse_notification(payload(revision=8)), now=120.0),
            module.UpdateDecision.SEND,
        )

    def test_state_migrates_legacy_cards_and_suppresses_acknowledged_push(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "media-notifications.json"
            path.write_text(json.dumps({"123:media-job:old": "456"}), encoding="utf-8")

            state = module.load_state(path)
            stored = state.cards["123:media-job:old"]
            notification = module.parse_notification(
                payload(
                    delivery_kind="final-push",
                    terminal=True,
                    revision=20,
                    state="completed",
                    stage="publish",
                    next_step="none",
                )
            )

            self.assertEqual((stored.message_id, stored.revision, stored.lifecycle_cycle, stored.terminal), ("456", 0, 0, False))
            self.assertFalse(module.has_push_receipt(state, notification))
            module.record_push_receipt(state, notification)
            self.assertTrue(module.has_push_receipt(state, notification))
            module.save_state(path, state)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["version"], 6)

    def test_stale_final_push_is_suppressed_by_newer_job_card(self):
        module = load_module()
        notification = module.parse_notification(
            payload(
                delivery_kind="final-push",
                terminal=True,
                state="completed",
                revision=7,
                lifecycle_cycle=1,
            )
        )
        state = module.NotificationState(cards={
            f"123:media-job:{JOB_ID}": module.CardState(
                "456", 1, 2, False, "download", 100.0
            )
        })

        self.assertTrue(module.has_push_receipt(state, notification))

        state.cards[f"123:media-job:{JOB_ID}"] = module.CardState(
            "456", 8, 1, False, "download", 100.0
        )
        self.assertTrue(module.has_push_receipt(state, notification))

        state.cards[f"123:media-job:{JOB_ID}"] = module.CardState(
            "456", 7, 1, True, "publish", 100.0
        )
        self.assertFalse(module.has_push_receipt(state, notification))

    def test_stale_final_push_is_suppressed_by_newer_push_receipt(self):
        module = load_module()
        notification = module.parse_notification(
            payload(
                delivery_kind="final-push",
                terminal=True,
                state="completed",
                revision=7,
                lifecycle_cycle=1,
            )
        )
        state = module.NotificationState(
            push_receipts=[f"media-event:{JOB_ID}:1:8"]
        )

        self.assertTrue(module.has_push_receipt(state, notification))

    def test_version_two_cards_migrate_with_an_empty_fingerprint(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "media-notifications.json"
            path.write_text(
                json.dumps(
                    {
                        "version": 2,
                        "cards": {
                            "123:media-job:old": {
                                "message_id": "456",
                                "revision": 7,
                                "lifecycle_cycle": 1,
                                "terminal": False,
                                "stage": "download",
                                "updated_at": 100.0,
                            }
                        },
                        "push_receipts": [],
                    }
                ),
                encoding="utf-8",
            )

            state = module.load_state(path)

            self.assertEqual(state.cards["123:media-job:old"].fingerprint, "")
            self.assertEqual(state.cards["123:media-job:old"].action_callbacks, ())


if __name__ == "__main__":
    unittest.main()
