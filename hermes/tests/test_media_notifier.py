import hashlib
import hmac
import io
import importlib.machinery
import importlib.util
import json
import pathlib
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import ThreadingHTTPServer
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
JOB_ID = "00000000-0000-0000-0000-000000000999"
TRACKING_ID = "00000000-0000-0000-0000-000000000555"


def load_module():
    scripts = ROOT / "scripts"
    sys.path.insert(0, str(scripts))
    try:
        loader = importlib.machinery.SourceFileLoader(
            "media_notifier_tests", str(scripts / "media-notifier")
        )
        spec = importlib.util.spec_from_loader(loader.name, loader)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        loader.exec_module(module)
        return module
    finally:
        sys.path.pop(0)


def payload(**overrides):
    value = {
        "event_type": "media.notification",
        "schema_version": 2,
        "delivery_kind": "card",
        "card_key": f"media-live:{JOB_ID}",
        "revision": 1,
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
        "progress": {"downloaded_bytes": 1024},
        "stage": "download",
        "next_step": "process",
        "actions": ["cancel", "details"],
    }
    value.update(overrides)
    return value


def legacy_payload(**overrides):
    return payload(card_key=f"media-job:{JOB_ID}", **overrides)


def seed_persisted_legacy_card(module, telegram, state_dir, *, terminal=False):
    dispatcher = module.NotificationDispatcher(telegram, state_dir, "123")
    value = payload(
        revision=2 if terminal else 1,
        terminal=terminal,
        state="completed" if terminal else "downloading",
        stage="publish" if terminal else "download",
        next_step="none" if terminal else "process",
        actions=[] if terminal else ["cancel", "details"],
    )
    dispatcher.deliver(value, "pre-upgrade-card")
    path = state_dir / "media-notifications.json"
    state = module.load_state(path)
    state.cards[f"123:media-job:{JOB_ID}"] = state.cards.pop(
        f"123:media-live:{JOB_ID}"
    )
    module.save_state(path, state)
    return module.NotificationDispatcher(telegram, state_dir, "123")


class FakeTelegram:
    def __init__(self):
        self.sent = []
        self.edited = []
        self.send_error = None
        self.edit_error = None

    def send(self, text, *, button_rows=(), reply_to_message_id=None, photo=None):
        if self.send_error is not None:
            raise self.send_error
        self.sent.append((text, button_rows, reply_to_message_id, photo))
        return str(100 + len(self.sent))

    def send_card(self, text, *, button_rows=(), photo=None):
        message_id = self.send(text, button_rows=button_rows, photo=photo)
        return message_id, photo is not None

    def edit(self, message_id, text, *, button_rows=(), has_photo=False):
        if self.edit_error is not None:
            raise self.edit_error
        self.edited.append((message_id, text, button_rows, has_photo))


class MediaNotifierTests(unittest.TestCase):
    def test_final_push_persists_terminal_state_before_late_progress_card(self):
        module = load_module()
        telegram = FakeTelegram()
        progress = legacy_payload(lifecycle_cycle=2)
        final_push = payload(
            delivery_kind="final-push",
            card_key=f"media-event:{JOB_ID}",
            revision=2,
            lifecycle_cycle=2,
            terminal=True,
            state="completed",
            stage="publish",
            next_step="none",
            actions=[],
        )
        late_same_cycle = legacy_payload(
            revision=2,
            lifecycle_cycle=2,
            state="processing",
            stage="process",
            next_step="publish",
        )
        late_older_cycle = legacy_payload(
            revision=99,
            lifecycle_cycle=1,
            state="processing",
            stage="process",
            next_step="publish",
        )

        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            dispatcher = module.NotificationDispatcher(telegram, state_dir, "123")

            self.assertEqual(dispatcher.deliver(progress, "progress"), HTTPStatus.OK)
            self.assertEqual(dispatcher.deliver(final_push, "final-push"), HTTPStatus.OK)
            self.assertEqual(len(telegram.sent), 1)
            state = module.load_state(state_dir / "media-notifications.json")
            stored = state.cards[f"123:media-job:{JOB_ID}"]
            self.assertEqual(
                (stored.lifecycle_cycle, stored.revision, stored.terminal),
                (2, 2, True),
            )
            self.assertEqual(stored.message_id, "101")
            self.assertEqual(
                stored.action_callbacks,
                (f"mp:job:{JOB_ID}",),
            )

            self.assertEqual(
                dispatcher.deliver(late_same_cycle, "late-same-cycle"),
                HTTPStatus.OK,
            )
            self.assertEqual(
                dispatcher.deliver(late_older_cycle, "late-older-cycle"),
                HTTPStatus.OK,
            )
            state = module.load_state(state_dir / "media-notifications.json")
            stored = state.cards[f"123:media-job:{JOB_ID}"]
            self.assertEqual(
                (stored.lifecycle_cycle, stored.revision, stored.terminal),
                (2, 2, True),
            )
            self.assertEqual(stored.message_id, "101")
            self.assertEqual(len(telegram.sent), 1)
            self.assertEqual(telegram.edited, [])

    def test_final_push_from_older_lifecycle_is_silently_fenced(self):
        module = load_module()
        telegram = FakeTelegram()
        current = legacy_payload(
            revision=1,
            lifecycle_cycle=2,
            terminal=True,
            state="completed",
            stage="publish",
            next_step="none",
            actions=[],
        )
        stale_push = payload(
            delivery_kind="final-push",
            card_key=f"media-event:{JOB_ID}",
            revision=99,
            lifecycle_cycle=1,
            terminal=True,
            state="completed",
            stage="publish",
            next_step="none",
            actions=[],
        )

        with tempfile.TemporaryDirectory() as directory:
            dispatcher = module.NotificationDispatcher(
                telegram, pathlib.Path(directory), "123"
            )
            self.assertEqual(dispatcher.deliver(current, "current"), HTTPStatus.OK)
            sends = len(telegram.sent)
            edits = len(telegram.edited)

            self.assertEqual(dispatcher.deliver(stale_push, "stale"), HTTPStatus.OK)

        self.assertEqual(len(telegram.sent), sends)
        self.assertEqual(len(telegram.edited), edits)

    def test_pre_rollout_progress_card_is_persisted_without_telegram_side_effect(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            dispatcher = module.NotificationDispatcher(telegram, state_dir, "123")

            self.assertEqual(
                dispatcher.deliver(legacy_payload(), "leased-progress"), HTTPStatus.OK
            )

            state = module.load_state(state_dir / "media-notifications.json")
            stored = state.cards[f"123:media-job:{JOB_ID}"]
            self.assertIsNone(stored.message_id)
            self.assertEqual(stored.revision, 1)
        self.assertEqual(telegram.sent, [])
        self.assertEqual(telegram.edited, [])

    def test_pre_rollout_terminal_card_and_final_push_make_one_compact_event(self):
        module = load_module()
        telegram = FakeTelegram()
        terminal = legacy_payload(
            revision=2,
            terminal=True,
            state="completed",
            stage="publish",
            next_step="none",
            actions=[],
        )
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = module.NotificationDispatcher(telegram, pathlib.Path(directory), "123")
            self.assertEqual(
                dispatcher.deliver(legacy_payload(), "leased-progress"), HTTPStatus.OK
            )
            self.assertEqual(dispatcher.deliver(terminal, "leased-terminal"), HTTPStatus.OK)
            self.assertEqual(
                dispatcher.deliver(
                    dict(terminal, delivery_kind="final-push"),
                    "leased-final-push",
                ),
                HTTPStatus.OK,
            )

        self.assertEqual(len(telegram.sent), 1)
        self.assertEqual(telegram.edited, [])
        self.assertEqual(
            telegram.sent[0][1][0][0].callback_data,
            f"mp:job:{JOB_ID}",
        )

    def test_pre_rollout_cancelled_card_and_push_are_silent(self):
        module = load_module()
        telegram = FakeTelegram()
        cancelled = legacy_payload(
            revision=2,
            terminal=True,
            state="cancelled",
            stage=None,
            next_step=None,
            actions=[],
        )
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = module.NotificationDispatcher(telegram, pathlib.Path(directory), "123")
            self.assertEqual(dispatcher.deliver(cancelled, "leased-cancel"), HTTPStatus.OK)
            self.assertEqual(
                dispatcher.deliver(
                    dict(cancelled, delivery_kind="final-push"),
                    "leased-cancel-push",
                ),
                HTTPStatus.OK,
            )

        self.assertEqual(telegram.sent, [])
        self.assertEqual(telegram.edited, [])

    def test_new_event_reuses_persisted_legacy_job_card_after_restart(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            seed_persisted_legacy_card(module, telegram, state_dir)

            restored = module.NotificationDispatcher(telegram, state_dir, "123")
            event = payload(
                delivery_kind="final-push",
                card_key=f"media-event:{JOB_ID}",
                state="completed",
                terminal=True,
                revision=2,
                actions=[],
            )
            self.assertEqual(restored.deliver(event, "new-event"), HTTPStatus.OK)

        self.assertEqual(len(telegram.sent), 1)
        self.assertEqual(telegram.edited[-1][0], "101")
        self.assertEqual(
            telegram.edited[-1][2][0][0].callback_data,
            f"mp:job:{JOB_ID}",
        )

    def test_pre_rollout_final_push_is_absorbed_by_new_event_receipt(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            dispatcher = seed_persisted_legacy_card(module, telegram, state_dir)
            completed = legacy_payload(
                revision=2,
                terminal=True,
                state="completed",
                stage="publish",
                next_step="none",
                actions=[],
            )
            legacy_push = dict(completed, delivery_kind="final-push")
            event = dict(
                completed,
                delivery_kind="final-push",
                card_key=f"media-event:{JOB_ID}",
            )

            self.assertEqual(dispatcher.deliver(event, "new-event"), HTTPStatus.OK)
            self.assertEqual(dispatcher.deliver(legacy_push, "leased-old-push"), HTTPStatus.OK)

        self.assertEqual(len(telegram.sent), 1)
        self.assertEqual(len(telegram.edited), 1)

    def test_persisted_legacy_push_receipt_suppresses_new_event_after_restart(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            seed_persisted_legacy_card(module, telegram, state_dir, terminal=True)
            completed = legacy_payload(
                revision=2, terminal=True, state="completed", stage="publish", next_step="none", actions=[]
            )
            state = module.load_state(state_dir / "media-notifications.json")
            state.push_receipts.append(f"media-job:{JOB_ID}:1:2")
            module.save_state(state_dir / "media-notifications.json", state)

            restored = module.NotificationDispatcher(telegram, state_dir, "123")
            event = dict(
                completed,
                delivery_kind="final-push",
                card_key=f"media-event:{JOB_ID}",
            )
            self.assertEqual(restored.deliver(event, "new-event"), HTTPStatus.OK)

        self.assertEqual(len(telegram.sent), 1)
        self.assertEqual(len(telegram.edited), 0)

    def test_persisted_legacy_sending_intent_blocks_new_event_after_restart(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            state = module.load_state(state_dir / "media-notifications.json")
            legacy_key = f"push:media-job:{JOB_ID}:1:2"
            state.pending_card_deliveries[legacy_key] = {
                "phase": "sending",
                "receipt_key": f"media-job:{JOB_ID}:1:2",
            }
            module.save_state(state_dir / "media-notifications.json", state)

            restored = module.NotificationDispatcher(telegram, state_dir, "123")
            event = payload(
                delivery_kind="final-push",
                card_key=f"media-event:{JOB_ID}",
                state="completed",
                terminal=True,
                revision=2,
                actions=[],
            )
            self.assertEqual(
                restored.deliver(event, "new-event"),
                HTTPStatus.SERVICE_UNAVAILABLE,
            )

            persisted = module.load_state(state_dir / "media-notifications.json")

        self.assertEqual(telegram.sent, [])
        self.assertIn(legacy_key, persisted.pending_card_deliveries)

    def test_canonical_reconciliation_resolves_a_legacy_pending_push_intent(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            state = module.load_state(state_dir / "media-notifications.json")
            legacy_key = f"push:media-job:{JOB_ID}:1:2"
            state.pending_card_deliveries[legacy_key] = {
                "phase": "sending",
                "receipt_key": f"media-job:{JOB_ID}:1:2",
            }
            module.save_state(state_dir / "media-notifications.json", state)

            restored = module.NotificationDispatcher(telegram, state_dir, "123")
            response = restored.reconcile_delivery(
                {
                    "kind": "push",
                    "delivery_id": f"media-event:{JOB_ID}:1:2",
                    "resolution": "retry",
                },
                "reconcile-legacy-push",
            )

            persisted = module.load_state(state_dir / "media-notifications.json")

        self.assertEqual(response.status, HTTPStatus.OK)
        self.assertNotIn(legacy_key, persisted.pending_card_deliveries)

    def test_persisted_legacy_sent_intent_completes_new_event_without_duplicate(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            state = module.load_state(state_dir / "media-notifications.json")
            legacy_key = f"push:media-job:{JOB_ID}:1:2"
            state.pending_card_deliveries[legacy_key] = {
                "phase": "sent",
                "message_id": "456",
            }
            module.save_state(state_dir / "media-notifications.json", state)

            restored = module.NotificationDispatcher(telegram, state_dir, "123")
            event = payload(
                delivery_kind="final-push",
                card_key=f"media-event:{JOB_ID}",
                state="completed",
                terminal=True,
                revision=2,
                actions=[],
            )
            self.assertEqual(restored.deliver(event, "new-event"), HTTPStatus.OK)

            persisted = module.load_state(state_dir / "media-notifications.json")

        self.assertEqual(telegram.sent, [])
        self.assertNotIn(legacy_key, persisted.pending_card_deliveries)
        self.assertIn(
            f"media-event:{JOB_ID}:1:2",
            persisted.push_receipts,
        )

    def test_event_delivery_sends_once_with_in_place_job_button(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = module.NotificationDispatcher(
                telegram, pathlib.Path(directory), "123"
            )
            event = payload(
                delivery_kind="final-push",
                card_key=f"media-event:{JOB_ID}",
                state="completed",
                terminal=True,
                revision=2,
                actions=[],
            )

            self.assertEqual(dispatcher.deliver(event, "event-1"), HTTPStatus.OK)
            self.assertEqual(dispatcher.deliver(event, "event-1"), HTTPStatus.OK)

        self.assertEqual(len(telegram.sent), 1)
        self.assertEqual(telegram.sent[0][2], None)
        self.assertEqual(
            telegram.sent[0][1][0][0].callback_data,
            f"mp:job:{JOB_ID}",
        )

    def test_event_delivery_suppresses_cancellation(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = module.NotificationDispatcher(
                telegram, pathlib.Path(directory), "123"
            )
            event = payload(
                delivery_kind="final-push",
                card_key=f"media-event:{JOB_ID}",
                state="cancelled",
                terminal=True,
                actions=[],
            )

            self.assertEqual(dispatcher.deliver(event, "cancel-event"), HTTPStatus.OK)

        self.assertEqual(telegram.sent, [])

    def test_telegram_http_500_is_delivery_unknown_and_does_not_fallback(self):
        module = load_module()
        error = urllib.error.HTTPError(
            "https://api.telegram.org/sendPhoto",
            500,
            "Internal Server Error",
            {},
            io.BytesIO(b'{"ok":false,"description":"server error"}'),
        )
        with patch.object(module.urllib.request, "urlopen", side_effect=error) as call:
            with self.assertRaises(module.TelegramError) as raised:
                module.TelegramClient("token", "123").send(
                    "Card caption", photo="https://static.tvmaze.com/poster.jpg"
                )

        self.assertTrue(raised.exception.delivery_unknown)
        self.assertEqual(call.call_count, 1)

    def test_telegram_client_sends_source_choice_as_photo_card(self):
        module = load_module()

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            @staticmethod
            def read():
                return b'{"ok":true,"result":{"message_id":321}}'

        with tempfile.TemporaryDirectory() as directory:
            photo = pathlib.Path(directory) / "poster.jpg"
            photo.write_bytes(b"jpeg-bytes")
            with patch.object(module.urllib.request, "urlopen", return_value=Response()) as call:
                message_id = module.TelegramClient("token", "123").send(
                    "Card caption",
                    photo=str(photo),
                )

        self.assertEqual(message_id, "321")
        request = call.call_args.args[0]
        self.assertTrue(request.full_url.endswith("/sendPhoto"))
        self.assertIn("multipart/form-data", request.headers["Content-type"])
        self.assertIn(b'filename="poster.jpg"', request.data)
        self.assertIn(b"Card caption", request.data)
        self.assertIn(b"jpeg-bytes", request.data)

    def test_telegram_client_sends_remote_poster_by_url(self):
        module = load_module()

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            @staticmethod
            def read():
                return b'{"ok":true,"result":{"message_id":322}}'

        with patch.object(module.urllib.request, "urlopen", return_value=Response()) as call:
            message_id = module.TelegramClient("token", "123").send(
                "Card caption",
                photo="https://static.tvmaze.com/poster.jpg",
            )

        self.assertEqual(message_id, "322")
        request = call.call_args.args[0]
        self.assertTrue(request.full_url.endswith("/sendPhoto"))
        self.assertIn(b"photo=https%3A%2F%2Fstatic.tvmaze.com%2Fposter.jpg", request.data)

    def test_telegram_client_edits_photo_card_caption(self):
        module = load_module()

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            @staticmethod
            def read():
                return b'{"ok":true,"result":{}}'

        with patch.object(module.urllib.request, "urlopen", return_value=Response()) as call:
            module.TelegramClient("token", "123").edit(
                "321",
                "Updated caption",
                has_photo=True,
            )

        request = call.call_args.args[0]
        self.assertTrue(request.full_url.endswith("/editMessageCaption"))
        self.assertIn(b"caption=Updated+caption", request.data)
        self.assertNotIn(b"text=", request.data)

    def test_source_choice_uses_explicit_provider_buttons(self):
        module = load_module()
        telegram = FakeTelegram()
        source_choice = {
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
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = module.NotificationDispatcher(
                telegram, pathlib.Path(directory), "123"
            )

            self.assertEqual(
                dispatcher.deliver(source_choice, "source-choice-1"), HTTPStatus.OK
            )

        self.assertEqual(len(telegram.sent), 1)
        self.assertEqual(
            [[action.label for action in row] for row in telegram.sent[0][1]],
            [["🌐 Rezka", "🧲 Prowlarr"]],
        )
        self.assertIn("✅ Rezka · серия и озвучки", telegram.sent[0][0])
        self.assertIn("✅ Prowlarr · раздачи", telegram.sent[0][0])
        self.assertEqual(
            telegram.sent[0][3],
            "https://static.tvmaze.com/poster.jpg",
        )

    def test_source_choice_with_one_confirmed_source_opens_that_provider(self):
        module = load_module()
        for action, label in (("rezka", "Rezka"), ("prowlarr", "Prowlarr")):
            with self.subTest(action=action), tempfile.TemporaryDirectory() as directory:
                telegram = FakeTelegram()
                dispatcher = module.NotificationDispatcher(
                    telegram, pathlib.Path(directory), "123"
                )
                source_choice = {
                    "event_type": "media.source-choice",
                    "schema_version": 1,
                    "card_key": f"tracking:{TRACKING_ID}:3:5",
                    "tracking_id": TRACKING_ID,
                    "title": "Реинкарнация безработного",
                    "season": 3,
                    "episode": 5,
                    "actions": [action],
                }

                self.assertEqual(
                    dispatcher.deliver(source_choice, f"source-choice-{action}"),
                    HTTPStatus.OK,
                )
                self.assertEqual(
                    [[button.label for button in row] for row in telegram.sent[0][1]],
                    [["🌐 Rezka" if action == "rezka" else "🧲 Prowlarr"]],
                )
                self.assertEqual(
                    telegram.sent[0][1][0][0].callback_data,
                    f"ms:{'r' if action == 'rezka' else 'p'}:{TRACKING_ID}:3:5",
                )
                self.assertIn(f"✅ {label} ·", telegram.sent[0][0])

    def test_source_choice_crash_after_send_is_fail_closed_after_restart(self):
        module = load_module()
        telegram = FakeTelegram()
        source_choice = {
            "event_type": "media.source-choice",
            "schema_version": 1,
            "card_key": f"tracking:{TRACKING_ID}:3:5",
            "tracking_id": TRACKING_ID,
            "title": "Реинкарнация безработного",
            "season": 3,
            "episode": 5,
            "actions": ["rezka"],
        }
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            dispatcher = module.NotificationDispatcher(telegram, state_dir, "123")
            original_save = dispatcher._save_legacy
            saves = 0

            def crash_after_send():
                nonlocal saves
                saves += 1
                if saves == 2:
                    raise OSError("simulated process death after Telegram send")
                original_save()

            with patch.object(dispatcher, "_save_legacy", side_effect=crash_after_send):
                with self.assertRaises(OSError):
                    dispatcher.deliver(source_choice, "source-choice-crash")

            self.assertEqual(len(telegram.sent), 1)
            restored = module.NotificationDispatcher(telegram, state_dir, "123")
            self.assertEqual(
                restored.deliver(source_choice, "source-choice-crash"),
                HTTPStatus.SERVICE_UNAVAILABLE,
            )
            self.assertEqual(len(telegram.sent), 1)

    def test_source_choice_http_500_keeps_ambiguous_intent(self):
        module = load_module()
        telegram = FakeTelegram()
        telegram.send_error = module.TelegramError("Telegram HTTP 500")
        source_choice = {
            "event_type": "media.source-choice",
            "schema_version": 1,
            "card_key": f"tracking:{TRACKING_ID}:3:5",
            "tracking_id": TRACKING_ID,
            "title": "Реинкарнация безработного",
            "season": 3,
            "episode": 5,
            "actions": ["rezka"],
        }
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = module.NotificationDispatcher(
                telegram, pathlib.Path(directory), "123"
            )
            with self.assertRaises(module.TelegramError):
                dispatcher.deliver(source_choice, "source-http-500")
            self.assertEqual(
                dispatcher.deliver(source_choice, "source-http-500"),
                HTTPStatus.SERVICE_UNAVAILABLE,
            )
            self.assertIn(
                "source-http-500", dispatcher._legacy["pending_receipts"]
            )

    def test_initial_card_crash_after_send_is_fail_closed_after_restart(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            dispatcher = module.NotificationDispatcher(telegram, state_dir, "123")
            original_save = module.save_state
            saves = 0

            def crash_after_send(path, state):
                nonlocal saves
                saves += 1
                if saves == 2:
                    raise OSError("simulated process death after Telegram send")
                original_save(path, state)

            with patch.object(module, "save_state", side_effect=crash_after_send):
                with self.assertRaises(OSError):
                    dispatcher.deliver(payload(), "card-crash")

            self.assertEqual(len(telegram.sent), 1)
            restored = module.NotificationDispatcher(telegram, state_dir, "123")
            self.assertEqual(
                restored.deliver(payload(), "card-crash"),
                HTTPStatus.SERVICE_UNAVAILABLE,
            )
            self.assertEqual(len(telegram.sent), 1)

    def test_initial_card_sent_intent_is_reconciled_after_restart(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            dispatcher = module.NotificationDispatcher(telegram, state_dir, "123")
            original_save = module.save_state
            saves = 0

            def crash_before_card_commit(path, state):
                nonlocal saves
                saves += 1
                if saves == 3:
                    raise OSError("simulated process death before card commit")
                original_save(path, state)

            with patch.object(module, "save_state", side_effect=crash_before_card_commit):
                with self.assertRaises(OSError):
                    dispatcher.deliver(payload(), "card-reconcile")

            restored = module.NotificationDispatcher(telegram, state_dir, "123")
            self.assertEqual(
                restored.deliver(payload(), "card-reconcile"), HTTPStatus.OK
            )
            self.assertEqual(len(telegram.sent), 1)
            state = module.load_state(state_dir / "media-notifications.json")
            self.assertEqual(next(iter(state.cards.values())).message_id, "101")
            self.assertEqual(state.pending_card_deliveries, {})

    def test_definite_card_rejection_clears_intent_for_retry(self):
        module = load_module()
        telegram = FakeTelegram()
        telegram.send_error = module.TelegramError(
            "Bad Request: chat not found", delivery_unknown=False
        )
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            dispatcher = module.NotificationDispatcher(telegram, state_dir, "123")
            with self.assertRaises(module.TelegramError):
                dispatcher.deliver(payload(), "card-definite-failure")

            state = module.load_state(state_dir / "media-notifications.json")
            self.assertEqual(state.pending_card_deliveries, {})
            telegram.send_error = None
            self.assertEqual(
                dispatcher.deliver(payload(), "card-definite-retry"), HTTPStatus.OK
            )
            self.assertEqual(len(telegram.sent), 1)

    def test_card_http_500_keeps_ambiguous_intent(self):
        module = load_module()
        telegram = FakeTelegram()
        telegram.send_error = module.TelegramError("Telegram HTTP 500")
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            dispatcher = module.NotificationDispatcher(telegram, state_dir, "123")
            with self.assertRaises(module.TelegramError):
                dispatcher.deliver(payload(), "card-http-500")

            state = module.load_state(state_dir / "media-notifications.json")
            self.assertEqual(
                state.pending_card_deliveries[
                    f"123:media-live:{JOB_ID}"
                ]["phase"],
                "sending",
            )

    def test_pre_send_state_failure_does_not_poison_card(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            dispatcher = module.NotificationDispatcher(telegram, state_dir, "123")
            original_save = module.save_state
            with patch.object(
                module,
                "save_state",
                side_effect=OSError("simulated pre-send persistence failure"),
            ):
                with self.assertRaises(OSError):
                    dispatcher.deliver(payload(), "card-pre-send-failure")

            self.assertEqual(dispatcher._state.pending_card_deliveries, {})
            with patch.object(module, "save_state", side_effect=original_save):
                self.assertEqual(
                    dispatcher.deliver(payload(), "card-pre-send-retry"), HTTPStatus.OK
                )
            self.assertEqual(len(telegram.sent), 1)

    def test_ambiguous_card_can_be_explicitly_retried_by_admin(self):
        module = load_module()
        telegram = FakeTelegram()
        telegram.send_error = module.TelegramError("connection reset")
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = module.NotificationDispatcher(
                telegram, pathlib.Path(directory), "123"
            )
            with self.assertRaises(module.TelegramError):
                dispatcher.deliver(payload(), "card-ambiguous")

            self.assertEqual(
                dispatcher.reconcile_delivery(
                    {
                        "kind": "card",
                        "delivery_id": f"media-live:{JOB_ID}",
                        "resolution": "retry",
                    },
                    "admin-retry-1",
                ).payload,
                {"status": "retry"},
            )
            telegram.send_error = None
            self.assertEqual(
                dispatcher.deliver(payload(), "card-after-admin-retry"), HTTPStatus.OK
            )
            self.assertEqual(len(telegram.sent), 1)

    def test_ambiguous_card_can_be_reconciled_with_verified_message_id(self):
        module = load_module()
        telegram = FakeTelegram()
        telegram.send_error = module.TelegramError("connection reset")
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            dispatcher = module.NotificationDispatcher(telegram, state_dir, "123")
            with self.assertRaises(module.TelegramError):
                dispatcher.deliver(payload(), "card-ambiguous-delivered")

            self.assertEqual(
                dispatcher.reconcile_delivery(
                    {
                        "kind": "card",
                        "delivery_id": f"media-live:{JOB_ID}",
                        "resolution": "delivered",
                        "message_id": "777",
                        "has_photo": True,
                    },
                    "admin-delivered-1",
                ).payload,
                {"status": "delivered"},
            )
            state = module.load_state(state_dir / "media-notifications.json")
            self.assertEqual(next(iter(state.cards.values())).message_id, "777")
            self.assertEqual(state.pending_card_deliveries, {})

    def test_orphaned_legacy_final_push_crash_is_fail_closed_after_restart(self):
        module = load_module()
        telegram = FakeTelegram()
        completed = legacy_payload(
            revision=2,
            terminal=True,
            state="completed",
            stage="publish",
            next_step="none",
            actions=["details"],
        )
        final_push = dict(completed, delivery_kind="final-push")
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            dispatcher = module.NotificationDispatcher(telegram, state_dir, "123")
            original_save = module.save_state
            saves = 0

            def crash_after_push(path, state):
                nonlocal saves
                saves += 1
                if saves == 2:
                    raise OSError("simulated process death after final push")
                original_save(path, state)

            with patch.object(module, "save_state", side_effect=crash_after_push):
                with self.assertRaises(OSError):
                    dispatcher.deliver(final_push, "three")

            restored = module.NotificationDispatcher(telegram, state_dir, "123")
            self.assertEqual(
                restored.deliver(final_push, "three"),
                HTTPStatus.SERVICE_UNAVAILABLE,
            )
            self.assertEqual(len(telegram.sent), 1)

    def test_orphaned_legacy_final_push_http_500_keeps_ambiguous_intent(self):
        module = load_module()
        telegram = FakeTelegram()
        completed = legacy_payload(
            revision=2,
            terminal=True,
            state="completed",
            stage="publish",
            next_step="none",
            actions=["details"],
        )
        final_push = dict(completed, delivery_kind="final-push")
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            dispatcher = module.NotificationDispatcher(telegram, state_dir, "123")
            telegram.send_error = module.TelegramError("Telegram HTTP 500")
            with self.assertRaises(module.TelegramError):
                dispatcher.deliver(final_push, "push-http-500")

            state = module.load_state(state_dir / "media-notifications.json")
            intent_key = f"push:media-event:{JOB_ID}:1:2"
            self.assertEqual(
                state.pending_card_deliveries[intent_key]["phase"], "sending"
            )

    def test_event_crash_after_send_is_fail_closed_after_restart(self):
        module = load_module()
        telegram = FakeTelegram()
        event = payload(
            delivery_kind="final-push",
            card_key=f"media-event:{JOB_ID}",
            revision=2,
            terminal=True,
            state="completed",
            stage="publish",
            next_step="none",
            actions=[],
        )
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            dispatcher = module.NotificationDispatcher(telegram, state_dir, "123")
            original_save = module.save_state
            saves = 0

            def crash_after_event(path, state):
                nonlocal saves
                saves += 1
                if saves == 2:
                    raise OSError("simulated process death after event send")
                original_save(path, state)

            with patch.object(module, "save_state", side_effect=crash_after_event):
                with self.assertRaises(OSError):
                    dispatcher.deliver(event, "event-crash")

            restored = module.NotificationDispatcher(telegram, state_dir, "123")
            self.assertEqual(
                restored.deliver(event, "event-crash"),
                HTTPStatus.SERVICE_UNAVAILABLE,
            )
            self.assertEqual(len(telegram.sent), 1)

    def test_control_updates_the_same_card_and_persists_view(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            dispatcher = module.NotificationDispatcher(telegram, state_dir, "123")
            self.assertEqual(dispatcher.deliver(payload(), "delivery-1"), HTTPStatus.OK)

            self.assertEqual(
                dispatcher.control(
                    {
                        "command": "expand",
                        "job_id": JOB_ID,
                        "message_id": "101",
                    },
                    "control-1",
                ).payload,
                {"status": "updated"},
            )
            self.assertIn("Подробности", telegram.edited[-1][1])

            restored = module.NotificationDispatcher(telegram, state_dir, "123")
            self.assertEqual(
                restored.control(
                    {
                        "command": "collapse",
                        "job_id": JOB_ID,
                        "message_id": "101",
                    },
                    "control-2",
                ).payload,
                {"status": "updated"},
            )

        self.assertNotIn("Подробности", telegram.edited[-1][1])

    def test_control_rejects_unknown_stale_and_replayed_requests(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = module.NotificationDispatcher(
                telegram, pathlib.Path(directory), "123"
            )
            self.assertEqual(dispatcher.deliver(payload(), "delivery-1"), HTTPStatus.OK)
            command = {
                "command": "expand",
                "job_id": JOB_ID,
                "message_id": "999",
            }
            self.assertEqual(
                dispatcher.control(command, "stale-1").payload,
                {"error": "stale_card"},
            )
            command["message_id"] = "101"
            self.assertEqual(
                dispatcher.control(command, "control-1").payload,
                {"status": "updated"},
            )
            self.assertEqual(
                dispatcher.control(command, "control-1").payload,
                {"error": "replayed_request"},
            )
            command["job_id"] = "00000000-0000-0000-0000-000000000111"
            self.assertEqual(
                dispatcher.control(command, "missing-1").payload,
                {"error": "card_not_found"},
            )

    def test_control_noop_preserves_progress_timestamp_and_duplicate_cards_fail(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            dispatcher = module.NotificationDispatcher(telegram, state_dir, "123")
            with patch.object(module.time, "time", return_value=100.0):
                dispatcher.deliver(payload(), "delivery-1")
            response = dispatcher.control(
                {
                    "command": "collapse",
                    "job_id": JOB_ID,
                    "message_id": "101",
                },
                "control-noop",
            )
            state = module.load_state(state_dir / "media-notifications.json")
            card = next(iter(state.cards.values()))
            self.assertEqual(response.payload, {"status": "unchanged"})
            self.assertEqual(card.updated_at, 100.0)

            state.cards["123:media-job:duplicate"] = card
            module.save_state(state_dir / "media-notifications.json", state)
            duplicated = module.NotificationDispatcher(telegram, state_dir, "123")
            self.assertEqual(
                duplicated.control(
                    {
                        "command": "expand",
                        "job_id": JOB_ID,
                        "message_id": "101",
                    },
                    "control-duplicate",
                ).payload,
                {"error": "stale_card"},
            )

    def test_control_requires_request_id_uuid_and_preserves_state_on_edit_failure(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            dispatcher = module.NotificationDispatcher(telegram, state_dir, "123")
            self.assertEqual(dispatcher.deliver(payload(), "delivery-1"), HTTPStatus.OK)
            command = {
                "command": "expand",
                "job_id": JOB_ID,
                "message_id": "101",
            }

            self.assertEqual(
                dispatcher.control(command, "").payload,
                {"error": "invalid_request_id"},
            )
            malformed = dict(command, job_id="not-a-uuid")
            self.assertEqual(
                dispatcher.control(malformed, "malformed-1").payload,
                {"error": "invalid_payload"},
            )

            telegram.edit_error = module.TelegramError("temporary failure")
            with self.assertRaises(module.TelegramError):
                dispatcher.control(command, "control-failed")
            restored = module.load_state(state_dir / "media-notifications.json")
            card = next(iter(restored.cards.values()))
            self.assertEqual(card.view, module.CardView.COMPACT)
            self.assertNotIn("control-failed", restored.control_receipts)

    def test_progress_removes_cancel_confirmation_when_cancel_is_no_longer_allowed(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            dispatcher = module.NotificationDispatcher(telegram, state_dir, "123")
            self.assertEqual(dispatcher.deliver(payload(), "delivery-1"), HTTPStatus.OK)
            dispatcher.control(
                {
                    "command": "confirm-cancel",
                    "job_id": JOB_ID,
                    "message_id": "101",
                },
                "control-1",
            )

            self.assertEqual(
                dispatcher.deliver(
                    payload(revision=2, actions=["details"]),
                    "delivery-2",
                ),
                HTTPStatus.OK,
            )

            card = next(
                iter(module.load_state(state_dir / "media-notifications.json").cards.values())
            )
            self.assertEqual(card.view, module.CardView.COMPACT)
            self.assertNotIn("Отменить загрузку?", telegram.edited[-1][1])

    def test_generic_card_is_sent_edited_and_final_push_replies_to_it(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = module.NotificationDispatcher(
                telegram, pathlib.Path(directory), "123"
            )
            self.assertEqual(dispatcher.deliver(payload(), "one"), HTTPStatus.OK)
            self.assertEqual(len(telegram.sent), 1)
            self.assertEqual(telegram.sent[0][2], None)
            self.assertEqual(
                telegram.sent[0][3],
                "https://image.tmdb.org/t/p/w780/mashle.jpg",
            )

            completed = payload(
                revision=2,
                terminal=True,
                state="completed",
                stage="publish",
                next_step="none",
                actions=["details"],
            )
            self.assertEqual(dispatcher.deliver(completed, "two"), HTTPStatus.OK)
            self.assertEqual(telegram.edited[0][0], "101")
            self.assertTrue(telegram.edited[0][3])

            final_push = dict(completed, delivery_kind="final-push")
            self.assertEqual(dispatcher.deliver(final_push, "three"), HTTPStatus.OK)
            self.assertEqual(len(telegram.sent), 2)
            self.assertEqual(telegram.sent[-1][2], "101")
            self.assertEqual(dispatcher.deliver(final_push, "three"), HTTPStatus.OK)
            self.assertEqual(len(telegram.sent), 2)
            self.assertEqual(len(telegram.edited), 1)

    def test_terminal_update_collapses_an_expanded_card(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory)
            dispatcher = module.NotificationDispatcher(telegram, state_dir, "123")
            self.assertEqual(dispatcher.deliver(payload(), "one"), HTTPStatus.OK)
            dispatcher.control(
                {
                    "command": "expand",
                    "job_id": JOB_ID,
                    "message_id": "101",
                },
                "control-one",
            )
            self.assertIn("Подробности", telegram.edited[-1][1])

            completed = payload(
                revision=2,
                terminal=True,
                state="completed",
                stage="publish",
                next_step="none",
                actions=["details"],
            )
            self.assertEqual(dispatcher.deliver(completed, "two"), HTTPStatus.OK)

            self.assertNotIn("ℹ️ Подробности", telegram.edited[-1][1])
            card = next(
                iter(module.load_state(state_dir / "media-notifications.json").cards.values())
            )
            self.assertEqual(card.view, module.CardView.COMPACT)

    def test_terminal_card_rejects_cancel_confirmation_even_if_action_is_present(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = module.NotificationDispatcher(
                telegram, pathlib.Path(directory), "123"
            )
            completed = payload(
                terminal=True,
                state="completed",
                stage="publish",
                next_step="none",
                actions=["details", "cancel"],
            )
            self.assertEqual(dispatcher.deliver(completed, "one"), HTTPStatus.OK)

            response = dispatcher.control(
                {
                    "command": "confirm-cancel",
                    "job_id": JOB_ID,
                    "message_id": "101",
                },
                "control-terminal",
            )

            self.assertEqual(response.status, HTTPStatus.CONFLICT)
            self.assertEqual(response.payload, {"error": "stale_card"})
            self.assertEqual(telegram.edited, [])

    def test_http_endpoint_requires_timestamped_hmac(self):
        module = load_module()

        class Dispatcher:
            calls = 0

            def deliver(self, value, request_id):
                self.calls += 1
                return HTTPStatus.OK

        dispatcher = Dispatcher()
        secret = b"test-secret"
        server = ThreadingHTTPServer(("127.0.0.1", 0), module._handler(dispatcher, secret))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            body = json.dumps({"event_type": "media.notification", "message": "ok"}).encode()
            timestamp = str(int(time.time()))
            signature = hmac.new(
                secret, timestamp.encode() + b"." + body, hashlib.sha256
            ).hexdigest()
            request = urllib.request.Request(
                f"http://127.0.0.1:{server.server_port}/webhooks/media-notify",
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "X-Webhook-Timestamp": timestamp,
                    "X-Webhook-Signature-V2": signature,
                    "X-Request-ID": "delivery-1",
                },
                method="POST",
            )
            with urllib.request.urlopen(request) as response:
                self.assertEqual(response.status, HTTPStatus.OK)
            self.assertEqual(dispatcher.calls, 1)

            request.headers["X-webhook-signature-v2"] = "0" * 64
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(request)
            self.assertEqual(caught.exception.code, HTTPStatus.UNAUTHORIZED)
            self.assertEqual(dispatcher.calls, 1)
        finally:
            server.shutdown()
            server.server_close()

    def test_control_http_endpoint_requires_hmac_and_rejects_replay(self):
        module = load_module()

        class Dispatcher:
            calls = 0

            def control(self, value, request_id):
                self.calls += 1
                return module.ControlResponse(HTTPStatus.OK, {"status": "updated"})

        dispatcher = Dispatcher()
        secret = b"test-secret"
        server = ThreadingHTTPServer(
            ("127.0.0.1", 0), module._handler(dispatcher, secret)
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            body = json.dumps(
                {
                    "command": "expand",
                    "job_id": JOB_ID,
                    "message_id": "101",
                },
                separators=(",", ":"),
            ).encode()
            timestamp = str(int(time.time()))
            signature = hmac.new(
                secret, timestamp.encode() + b"." + body, hashlib.sha256
            ).hexdigest()
            request = urllib.request.Request(
                f"http://127.0.0.1:{server.server_port}/control/card",
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "X-Webhook-Timestamp": timestamp,
                    "X-Webhook-Signature-V2": signature,
                    "X-Request-ID": "control-1",
                },
                method="POST",
            )
            with urllib.request.urlopen(request) as response:
                self.assertEqual(response.status, HTTPStatus.OK)
            self.assertEqual(dispatcher.calls, 1)
        finally:
            server.shutdown()
            server.server_close()

    def test_signature_helper_rejects_stale_and_other_profile_secret(self):
        module = load_module()
        body = b'{"command":"expand"}'
        timestamp = "1000"
        signature = hmac.new(
            b"andrii-secret",
            timestamp.encode() + b"." + body,
            hashlib.sha256,
        ).hexdigest()

        self.assertTrue(
            module._verify_signed_request(
                body,
                timestamp,
                signature,
                b"andrii-secret",
                now=1000,
            )
        )
        self.assertFalse(
            module._verify_signed_request(
                body,
                timestamp,
                signature,
                b"andrii-secret",
                now=1000 + module.MAX_CLOCK_SKEW_SECONDS + 1,
            )
        )
        self.assertFalse(
            module._verify_signed_request(
                body,
                timestamp,
                signature,
                b"valentyna-secret",
                now=1000,
            )
        )

    def test_control_http_endpoint_rejects_replayed_request_id(self):
        module = load_module()
        telegram = FakeTelegram()
        secret = b"test-secret"
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = module.NotificationDispatcher(
                telegram, pathlib.Path(directory), "123"
            )
            dispatcher.deliver(payload(), "delivery-1")
            server = ThreadingHTTPServer(
                ("127.0.0.1", 0), module._handler(dispatcher, secret)
            )
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                body = json.dumps(
                    {
                        "command": "expand",
                        "job_id": JOB_ID,
                        "message_id": "101",
                    },
                    separators=(",", ":"),
                ).encode()
                timestamp = str(int(time.time()))
                signature = hmac.new(
                    secret,
                    timestamp.encode() + b"." + body,
                    hashlib.sha256,
                ).hexdigest()

                def request():
                    return urllib.request.Request(
                        f"http://127.0.0.1:{server.server_port}/control/card",
                        data=body,
                        headers={
                            "Content-Type": "application/json",
                            "X-Webhook-Timestamp": timestamp,
                            "X-Webhook-Signature-V2": signature,
                            "X-Request-ID": "same-control",
                        },
                        method="POST",
                    )

                with urllib.request.urlopen(request()) as response:
                    self.assertEqual(response.status, HTTPStatus.OK)
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(request())
                self.assertEqual(caught.exception.code, HTTPStatus.CONFLICT)
                self.assertIn(
                    "replayed_request",
                    caught.exception.read().decode("utf-8"),
                )
            finally:
                server.shutdown()
                server.server_close()

    def test_control_http_requires_request_id_and_maps_telegram_failure_to_502(self):
        module = load_module()
        telegram = FakeTelegram()
        secret = b"test-secret"
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = module.NotificationDispatcher(
                telegram, pathlib.Path(directory), "123"
            )
            dispatcher.deliver(payload(), "delivery-1")
            server = ThreadingHTTPServer(
                ("127.0.0.1", 0), module._handler(dispatcher, secret)
            )
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                body = json.dumps(
                    {
                        "command": "expand",
                        "job_id": JOB_ID,
                        "message_id": "101",
                    },
                    separators=(",", ":"),
                ).encode()
                timestamp = str(int(time.time()))
                signature = hmac.new(
                    secret,
                    timestamp.encode() + b"." + body,
                    hashlib.sha256,
                ).hexdigest()

                def request(request_id=None):
                    headers = {
                        "Content-Type": "application/json",
                        "X-Webhook-Timestamp": timestamp,
                        "X-Webhook-Signature-V2": signature,
                    }
                    if request_id is not None:
                        headers["X-Request-ID"] = request_id
                    return urllib.request.Request(
                        f"http://127.0.0.1:{server.server_port}/control/card",
                        data=body,
                        headers=headers,
                        method="POST",
                    )

                with self.assertRaises(urllib.error.HTTPError) as missing:
                    urllib.request.urlopen(request())
                self.assertEqual(missing.exception.code, HTTPStatus.BAD_REQUEST)
                self.assertIn(
                    "invalid_request_id",
                    missing.exception.read().decode("utf-8"),
                )

                telegram.edit_error = module.TelegramError("temporary failure")
                with self.assertRaises(urllib.error.HTTPError) as failed:
                    urllib.request.urlopen(request("control-failure"))
                self.assertEqual(failed.exception.code, HTTPStatus.BAD_GATEWAY)
                self.assertIn(
                    "telegram_unavailable",
                    failed.exception.read().decode("utf-8"),
                )
            finally:
                server.shutdown()
                server.server_close()

    def test_new_revision_with_identical_card_content_is_acknowledged_without_edit(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = module.NotificationDispatcher(telegram, pathlib.Path(directory), "123")
            self.assertEqual(dispatcher.deliver(payload(revision=1), "one"), HTTPStatus.OK)
            self.assertEqual(dispatcher.deliver(payload(revision=2), "two"), HTTPStatus.OK)

            self.assertEqual(len(telegram.sent), 1)
            self.assertEqual(telegram.edited, [])
            state = module.load_state(pathlib.Path(directory) / "media-notifications.json")
            self.assertEqual(next(iter(state.cards.values())).revision, 2)

    def test_changed_progress_updates_coalesce_within_five_seconds(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = module.NotificationDispatcher(telegram, pathlib.Path(directory), "123")
            with patch.object(module.time, "time", return_value=100.0):
                self.assertEqual(dispatcher.deliver(payload(revision=1), "one"), HTTPStatus.OK)
            with patch.object(module.time, "time", return_value=101.0):
                self.assertEqual(
                    dispatcher.deliver(
                        payload(revision=2, progress={"downloaded_bytes": 2048}), "two"
                    ),
                    HTTPStatus.SERVICE_UNAVAILABLE,
                )
                self.assertEqual(
                    dispatcher.deliver(
                        payload(revision=3, progress={"downloaded_bytes": 4096}), "three"
                    ),
                    HTTPStatus.SERVICE_UNAVAILABLE,
                )
            with patch.object(module.time, "time", return_value=105.0):
                self.assertEqual(
                    dispatcher.deliver(
                        payload(revision=3, progress={"downloaded_bytes": 4096}), "three"
                    ),
                    HTTPStatus.OK,
                )

            self.assertEqual(len(telegram.edited), 1)
            self.assertIn("4 КБ", telegram.edited[0][1])

    def test_processing_transition_edits_immediately_inside_progress_window(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = module.NotificationDispatcher(telegram, pathlib.Path(directory), "123")
            with patch.object(module.time, "time", return_value=100.0):
                self.assertEqual(dispatcher.deliver(payload(revision=1), "one"), HTTPStatus.OK)
            with patch.object(module.time, "time", return_value=101.0):
                self.assertEqual(
                    dispatcher.deliver(
                        payload(revision=2, state="processing", stage="process", next_step="publish"),
                        "two",
                    ),
                    HTTPStatus.OK,
                )

            self.assertEqual(len(telegram.edited), 1)

    def test_action_set_transition_edits_immediately_inside_progress_window(self):
        module = load_module()
        telegram = FakeTelegram()
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = module.NotificationDispatcher(telegram, pathlib.Path(directory), "123")
            with patch.object(module.time, "time", return_value=100.0):
                self.assertEqual(dispatcher.deliver(payload(revision=1), "one"), HTTPStatus.OK)
            with patch.object(module.time, "time", return_value=101.0):
                self.assertEqual(
                    dispatcher.deliver(payload(revision=2, actions=["details"]), "two"),
                    HTTPStatus.OK,
                )

            self.assertEqual(len(telegram.edited), 1)


if __name__ == "__main__":
    unittest.main()
