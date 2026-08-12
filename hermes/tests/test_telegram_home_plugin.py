import asyncio
import hashlib
import hmac
import importlib.util
import json
import pathlib
import sys
import tempfile
import threading
import types
import unittest
import uuid
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "shared/plugins/telegram-home/__init__.py"
JOB_ID = "00000000-0000-0000-0000-000000000999"
TRACKING_ID = "00000000-0000-0000-0000-000000000555"


class FakeTelegramAdapter:
    pass


class FakeInlineKeyboardButton:
    def __init__(self, text, callback_data=None, url=None):
        self.text = text
        self.callback_data = callback_data
        self.url = url


class FakeInlineKeyboardMarkup:
    def __init__(self, inline_keyboard):
        self.inline_keyboard = inline_keyboard


class FakeInputMediaPhoto:
    def __init__(self, media, caption, parse_mode=None):
        self.media = media
        self.caption = caption
        self.parse_mode = parse_mode


class FakeInputFile:
    def __init__(self, obj, filename=None, attach=False):
        self.obj = obj
        self.filename = filename
        self.attach = attach


class FakeTelegramError(Exception):
    pass


class FakeBadRequest(FakeTelegramError):
    pass


def load_plugin():
    adapter = types.ModuleType("plugins.platforms.telegram.adapter")
    adapter.TelegramAdapter = FakeTelegramAdapter
    adapter._apply_yaml_config = object()
    adapter._is_connected = object()
    adapter._resolve_notifications_mode = lambda: "native"
    adapter._standalone_send = object()
    adapter.check_telegram_requirements = object()
    adapter.interactive_setup = object()
    telegram = types.ModuleType("telegram")
    telegram.InlineKeyboardButton = FakeInlineKeyboardButton
    telegram.InlineKeyboardMarkup = FakeInlineKeyboardMarkup
    telegram.InputFile = FakeInputFile
    telegram.InputMediaPhoto = FakeInputMediaPhoto
    telegram_error = types.ModuleType("telegram.error")
    telegram_error.BadRequest = FakeBadRequest
    telegram_error.TelegramError = FakeTelegramError
    modules = {
        "plugins": types.ModuleType("plugins"),
        "plugins.platforms": types.ModuleType("plugins.platforms"),
        "plugins.platforms.telegram": types.ModuleType("plugins.platforms.telegram"),
        "plugins.platforms.telegram.adapter": adapter,
        "telegram": telegram,
        "telegram.error": telegram_error,
    }
    previous = {name: sys.modules.get(name) for name in modules}
    sys.modules.update(modules)
    try:
        spec = importlib.util.spec_from_file_location(
            "telegram_home_test",
            PLUGIN,
            submodule_search_locations=[str(PLUGIN.parent)],
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        for name in tuple(sys.modules):
            if name == "telegram_home_test" or name.startswith("telegram_home_test."):
                sys.modules.pop(name, None)
        for name, value in previous.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value


def callback_update(data):
    sent_photo = types.SimpleNamespace(
        chat=types.SimpleNamespace(type="private"),
        chat_id=123,
        message_thread_id=None,
        message_id=78,
        edit_text=mock.AsyncMock(),
        edit_caption=mock.AsyncMock(),
        edit_media=mock.AsyncMock(),
        reply_text=mock.AsyncMock(),
        reply_photo=mock.AsyncMock(),
        delete=mock.AsyncMock(),
        photo=(object(),),
    )
    query = types.SimpleNamespace(
        data=data,
        answer=mock.AsyncMock(),
        from_user=types.SimpleNamespace(id=123, first_name="Andrii"),
        message=types.SimpleNamespace(
            chat=types.SimpleNamespace(type="private"),
            chat_id=123,
            message_thread_id=None,
            message_id=77,
            reply_text=mock.AsyncMock(),
            reply_photo=mock.AsyncMock(return_value=sent_photo),
            delete=mock.AsyncMock(),
            edit_text=mock.AsyncMock(),
            edit_caption=mock.AsyncMock(),
            edit_media=mock.AsyncMock(),
            photo=(),
        ),
    )
    return types.SimpleNamespace(callback_query=query), query


def business_callback(action, lifecycle_cycle=1):
    generation = hashlib.blake2s(
        str(lifecycle_cycle).encode("ascii"), digest_size=4
    ).hexdigest()
    return f"ma:{action}:{JOB_ID}:{generation}"


def business_job_context(*, state="running", lifecycle_cycle=1):
    ctx = mock.Mock()
    ctx.dispatch_tool.return_value = json.dumps({
        "structuredContent": {
            "id": JOB_ID,
            "provider": "rezka",
            "result_ref": "rezka:job:1",
            "state": state,
            "lifecycle_cycle": lifecycle_cycle,
            "notify_scope": "initiator",
        }
    })
    return ctx


class FakeHTTPResponse:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class TelegramHomePluginTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.plugin = load_plugin()
        self.adapter = self.plugin.HomeTelegramAdapter.__new__(
            self.plugin.HomeTelegramAdapter
        )
        self.temp_dir = tempfile.TemporaryDirectory()
        self.adapter._media_action_store = self.plugin.MediaActionStore(
            pathlib.Path(self.temp_dir.name) / "media-actions.json"
        )
        self.adapter._media_navigation_store = self.plugin.MediaNavigationStore(
            pathlib.Path(self.temp_dir.name) / "media-navigation.json"
        )
        self.adapter._business_action_receipt_store = (
            self.plugin.BusinessActionReceiptStore(
                pathlib.Path(self.temp_dir.name) / "media-business-actions.json"
            )
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_media_action_markup_groups_actions_in_compact_rows(self):
        actions = tuple(
            self.plugin.SearchAction(
                label=f"Action {index}",
                kind="download",
                payload={"index": index},
                expires_at="2099-07-27T12:00:00Z",
            )
            for index in range(1, 8)
        ) + (
            self.plugin.SearchAction(
                label="⬅️ Назад",
                kind="release-back",
                payload={},
                expires_at="2099-07-27T12:00:00Z",
            ),
            self.plugin.SearchAction(
                label="⬅️ Назад",
                kind="source-back",
                payload={
                    "tracking_id": TRACKING_ID,
                    "season": 3,
                    "episode": 5,
                },
                expires_at="2099-07-27T12:00:00Z",
            ),
            self.plugin.SearchAction(
                label="⬅️ Назад",
                kind="navigation-back",
                payload={},
                expires_at="2099-07-27T12:00:00Z",
            ),
        )

        markup = self.plugin._action_markup(
            self.adapter._media_action_store,
            actions,
        )

        self.assertEqual([len(row) for row in markup.inline_keyboard], [3, 3, 1, 1])
        self.assertEqual(
            [button.text for button in markup.inline_keyboard[-1]],
            ["⬅️ Назад"],
        )

    async def test_callback_dispatch_uses_media_mcp_without_cli(self):
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = json.dumps({
            "structuredContent": {"id": JOB_ID, "state": "cancelled"}
        })

        returncode, output = await self.plugin._run_media(
            ("mcp__media_admin__media_job_cancel", {"job_id": JOB_ID}),
            ctx,
        )

        self.assertEqual(returncode, 0)
        self.assertEqual(json.loads(output), {"id": JOB_ID, "state": "cancelled"})
        ctx.dispatch_tool.assert_called_once_with(
            "mcp__media_admin__media_job_cancel", {"job_id": JOB_ID}
        )

    def test_translation_display_name_prefers_only_latin_brand_aliases(self):
        cases = {
            "лостфильм (LostFilm)": "LostFilm",
            "колдфильм (Coldfilm)": "Coldfilm",
            "яскьер (Jaskier)": "Jaskier",
            "ньюстудио (NewStudio)": "NewStudio",
            "кероб (KerobTV)": "KerobTV",
            "октопус (Octopus/Ultradox)": "Octopus/Ultradox",
            "Оригинал (+субтитры)": "Оригинал (+субтитры)",
            "Дубляж (18+)": "Дубляж (18+)",
            "Дубляж (Netflix)": "Дубляж (Netflix)",
            "Оригинал (English)": "Оригинал (English)",
            "Лостфильм Дубляж (LostFilm)": "Лостфильм Дубляж (LostFilm)",
            "Лина (Luna)": "Лина (Luna)",
            "Марина (Karina)": "Марина (Karina)",
            "Кино (Kinopoisk)": "Кино (Kinopoisk)",
            "Аниме (AnimeVost)": "Аниме (AnimeVost)",
            "Дубляж (LostFilm)": "Дубляж (LostFilm)",
            "Оригинал (Coldfilm)": "Оригинал (Coldfilm)",
            "Студия (Jaskier)": "Студия (Jaskier)",
        }

        for raw_name, expected in cases.items():
            with self.subTest(raw_name=raw_name):
                self.assertEqual(
                    self.plugin._translation_display_name(raw_name),
                    expected,
                )

    async def test_natural_language_media_request_is_routed_through_the_agent(self):
        message = types.SimpleNamespace(
            text="найди фильм про грогу и мандалорца",
            message_id=77,
            chat_id=123,
            message_thread_id=None,
        )
        update = types.SimpleNamespace(message=message, effective_message=message)
        agent_handler = mock.AsyncMock()
        with (
            mock.patch.object(
                self.plugin.TelegramAdapter,
                "_handle_text_message",
                agent_handler,
                create=True,
            ),
            mock.patch.object(
                self.plugin,
                "_run_media",
                mock.AsyncMock(),
            ) as run_media,
        ):
            await self.adapter._handle_text_message(update, None)

        agent_handler.assert_awaited_once_with(update, None)
        run_media.assert_not_awaited()

    def test_combined_search_keeps_provider_actions_with_visible_bounded_parts(self):
        expires_at = "2099-07-27T12:00:00Z"
        back = self.plugin.SearchAction(
            label="⬅️ Назад",
            kind="navigation-back",
            payload={},
            expires_at=expires_at,
        )

        def provider_search(source):
            page = json.dumps({
                "api_version": "v1",
                "session_id": f"session-{source}",
                "source": source,
                "expires_at": expires_at,
                "results": [
                    {
                        "source": source,
                        "result_id": f"{source}:{index}",
                        "title": f"{source} result {index} " + ("X" * 70),
                        "thumbnail_url": f"https://example.test/{source}.jpg",
                        **(
                            {"translations": [{"id": 7, "name": "Dub"}]}
                            if source == "rezka"
                            else {"seeders": index, "size_bytes": 1_073_741_824}
                        ),
                    }
                    for index in range(1, 11)
                ],
            }).encode()
            return self.plugin._render_source_search(
                page, source, 1, 0, back, carousel=False
            )

        combined = self.plugin._combine_source_results(
            [
                provider_search("rezka"),
                provider_search("prowlarr"),
            ],
            [],
        )

        self.assertIsNotNone(combined)
        self.assertEqual(len(combined.parts), 1)
        self.assertEqual(
            sum(action.kind == "navigation-back" for action in combined.actions),
            1,
        )
        labels = [action.label for action in combined.actions]
        self.assertEqual(
            [label for label in labels if label == "🖼 Карточки"],
            ["🖼 Карточки"],
        )
        for part in combined.parts:
            self.assertLessEqual(len(part.text), 1000 if part.photo_url else 3800)
            self.assertLessEqual(len(part.actions), 20)
        self.assertNotIn("🔎 Rezka\n", combined.text)
        self.assertNotIn("🔎 Prowlarr\n", combined.text)
        self.assertIn("Rezka", combined.text)
        self.assertIn("Prowlarr", combined.text)
        self.assertNotIn("🌐", combined.text)
        self.assertNotIn("➡️ Ещё варианты", combined.text)
        card_action = next(
            action for action in combined.actions if action.label == "🖼 Карточки"
        )
        self.assertTrue(any(action.kind == "combined-page" for action in combined.actions))
        carousel_page = card_action.payload["search_page"]
        self.assertEqual(len(carousel_page["results"]), 20)
        details = self.plugin._render_release_details(
            card_action.payload,
            search_page=carousel_page,
            source_back_action=back,
        )
        self.assertIsNotNone(details)
        self.assertNotIn("вариант 1", details.text)
        self.assertEqual(
            [action.label for action in details.actions[:3]],
            ["⬅️", "1/20", "➡️"],
        )
        next_payload = details.actions[2].payload
        self.assertEqual(next_payload["title"], carousel_page["results"][1]["title"])
        markup = self.plugin._action_markup(
            self.adapter._media_action_store, combined.actions
        )
        self.assertEqual(
            [[button.text for button in row] for row in markup.inline_keyboard],
            [
                ["⬅️", "1/4", "➡️"],
                ["🖼 Карточки"],
                ["⬅️ Назад"],
            ],
        )

    def test_combined_search_uses_one_normalized_cross_provider_score(self):
        expires_at = "2099-07-27T12:00:00Z"

        def render(source, results):
            return self.plugin._render_source_search(
                json.dumps({
                    "api_version": "v1",
                    "session_id": f"session-{source}",
                    "source": source,
                    "expires_at": expires_at,
                    "results": results,
                }).encode(),
                source,
                1,
                0,
                carousel=False,
            )

        rezka = render("rezka", [{
            "source": "rezka",
            "result_id": "rezka:top",
            "title": "Approximate title",
            "translations": [{"id": 1, "name": "Dub"}],
        }])
        prowlarr = render("prowlarr", [
            {
                "source": "prowlarr",
                "result_id": "prowlarr:weak",
                "title": "Weak release",
                "seeders": 0,
                "ranking": {},
            },
            {
                "source": "prowlarr",
                "result_id": "prowlarr:exact",
                "title": "Exact S01 1080p release",
                "seeders": 100,
                "ranking": {
                    "exact_title": True,
                    "exact_season": True,
                    "quality_preference": 4,
                    "language_preference": 4,
                    "codec_preference": 4,
                    "release_group_preference": 4,
                },
            },
        ])

        combined = self.plugin._combine_source_results([rezka, prowlarr], [])
        card_action = next(
            action for action in combined.actions if action.label == "🖼 Карточки"
        )
        ranked_ids = [
            result["result_id"]
            for result in card_action.payload["search_page"]["results"]
        ]

        self.assertEqual(ranked_ids[0], "prowlarr:exact")
        self.assertEqual(set(ranked_ids), {
            "rezka:top", "prowlarr:weak", "prowlarr:exact"
        })

    def test_combined_search_reports_a_successful_empty_provider(self):
        expires_at = "2099-07-27T12:00:00Z"

        def render(source, results):
            return self.plugin._render_source_search(
                json.dumps({
                    "api_version": "v1",
                    "session_id": f"session-{source}",
                    "source": source,
                    "expires_at": expires_at,
                    "results": results,
                }).encode(),
                source,
                1,
                0,
                carousel=False,
            )

        combined = self.plugin._combine_source_results([
            render("rezka", [{
                "source": "rezka",
                "result_id": "rezka:one",
                "title": "Show",
                "translations": [{"id": 1, "name": "Dub"}],
            }]),
            render("prowlarr", []),
        ], [])

        self.assertIn("Rezka", combined.text)
        self.assertNotIn("🌐", combined.text)
        self.assertIn("ℹ️ Prowlarr: подходящих вариантов нет.", combined.text)
        self.assertNotIn("временно недоступен", combined.text)

    async def test_combined_page_callback_keeps_unified_result_identity(self):
        expires_at = "2099-07-27T12:00:00Z"
        back = self.plugin.SearchAction(
            label="⬅️ Назад",
            kind="navigation-back",
            payload={},
            expires_at=expires_at,
        )

        def render(source, count):
            return self.plugin._render_source_search(
                json.dumps({
                    "api_version": "v1",
                    "session_id": f"session-{source}",
                    "source": source,
                    "expires_at": expires_at,
                    "results": [
                        {
                            "source": source,
                            "result_id": f"{source}:{index}",
                            "title": f"{source} result {index}",
                            **(
                                {"translations": [{"id": 1, "name": "Dub"}]}
                                if source == "rezka"
                                else {"seeders": index, "ranking": {}}
                            ),
                        }
                        for index in range(1, count + 1)
                    ],
                }).encode(),
                source,
                1,
                0,
                back,
                carousel=False,
            )

        combined = self.plugin._combine_source_results([
            render("rezka", 4),
            render("prowlarr", 4),
        ], [])
        next_page = next(
            action
            for action in combined.actions
            if action.kind == "combined-page" and action.label == "➡️"
        )
        token = self.adapter._media_action_store.create(next_page)
        persisted_action = self.adapter._media_action_store.resolve(token)[0]
        self.assertIsInstance(
            persisted_action.payload["combined_context"]["back_action"],
            dict,
        )
        update, query = callback_update(f"md:{token}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True

        await self.adapter._handle_callback_query(update, None)

        rendered = query.message.edit_text.await_args.args[0]
        markup = query.message.edit_text.await_args.kwargs["reply_markup"]
        self.assertIn("🔎 Варианты", rendered)
        card_button = next(
            button
            for row in markup.inline_keyboard
            for button in row
            if button.text == "🖼 Карточки"
        )
        card_action = self.adapter._media_action_store.resolve(
            card_button.callback_data.removeprefix("md:")
        )[0]
        self.assertEqual(card_action.payload["result_index"], 6)
        results = card_action.payload["search_page"]["results"]
        identities = {
            (
                result["_choice_source"],
                result["_choice_session_id"],
                result["result_id"],
            )
            for result in results
        }
        self.assertEqual(len(identities), 8)
        self.assertTrue(all(
            session_id == f"session-{source}" and result_id.startswith(f"{source}:")
            for source, session_id, result_id in identities
        ))
        self.assertEqual(card_action.payload["combined_page"], 1)
        self.assertIn(
            "⬅️ Назад",
            [button.text for row in markup.inline_keyboard for button in row],
        )

    async def test_release_back_restores_combined_provider_results(self):
        def page(source, result):
            return json.dumps(
                {
                    "api_version": "v1",
                    "session_id": f"session-{source}",
                    "source": source,
                    "expires_at": "2099-07-27T12:00:00Z",
                    "results": [result],
                }
            ).encode()

        rezka = page(
            "rezka",
            {
                "source": "rezka",
                "result_id": "rezka:1",
                "title": "Hacks",
                "translations": [{"id": 7, "name": "Dub"}],
            },
        )
        prowlarr = page(
            "prowlarr",
            {
                "source": "prowlarr",
                "result_id": "prowlarr:1",
                "title": "Hacks.S01.1080p.WEB-DL",
                "seeders": 10,
                "ranking": {},
            },
        )
        combined = self.plugin._combine_source_results(
            [
                self.plugin._render_source_search(
                    rezka, "rezka", 1, 0, carousel=False
                ),
                self.plugin._render_source_search(
                    prowlarr, "prowlarr", 1, 0, carousel=False
                ),
            ],
            [],
        )
        release = next(
            action
            for action in combined.actions
            if action.kind == "release-details" and action.payload["source"] == "rezka"
        )
        token = self.adapter._media_action_store.create(release)
        update, query = callback_update(f"md:{token}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True

        await self.adapter._handle_callback_query(update, None)

        details_markup = query.message.edit_text.await_args.kwargs["reply_markup"]
        back_button = next(
            button
            for row in details_markup.inline_keyboard
            for button in row
            if button.text == "⬅️ Назад"
        )
        back_update, back_query = callback_update(back_button.callback_data)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True

        await self.adapter._handle_callback_query(back_update, None)

        restored = back_query.message.edit_text.await_args.args[0]
        restored_markup = back_query.message.edit_text.await_args.kwargs["reply_markup"]
        self.assertIn("🔎 Варианты", restored)
        self.assertIn("Rezka", restored)
        self.assertIn("Prowlarr", restored)
        self.assertNotIn("🌐", restored)
        card_button = next(
            button
            for row in restored_markup.inline_keyboard
            for button in row
            if button.text == "🖼 Карточки"
        )
        restored_action = self.adapter._media_action_store.resolve(
            card_button.callback_data.removeprefix("md:")
        )[0]
        self.assertEqual(
            [
                result["_choice_session_id"]
                for result in restored_action.payload["search_page"]["results"]
            ],
            ["session-rezka", "session-prowlarr"],
        )

    async def test_provider_continuation_back_restores_prior_combined_results(self):
        def page(source, result, continuation=None):
            payload = {
                "api_version": "v1",
                "session_id": f"session-{source}",
                "source": source,
                "expires_at": "2099-07-27T12:00:00Z",
                "results": [result],
            }
            if continuation is not None:
                payload["continuation"] = continuation
            return json.dumps(payload).encode()

        rezka = page(
            "rezka",
            {
                "source": "rezka",
                "result_id": "rezka:original",
                "title": "Hacks",
                "translations": [{"id": 7, "name": "Dub"}],
            },
            "rezka-next-page",
        )
        prowlarr = page(
            "prowlarr",
            {
                "source": "prowlarr",
                "result_id": "prowlarr:original",
                "title": "Hacks.S01.1080p.WEB-DL",
                "ranking": {},
            },
        )
        combined = self.plugin._combine_source_results(
            [
                self.plugin._render_source_search(
                    rezka, "rezka", 1, 0, carousel=False
                ),
                self.plugin._render_source_search(
                    prowlarr, "prowlarr", 1, 0, carousel=False
                ),
            ],
            [],
        )
        continuation = next(
            action for action in combined.actions if action.kind == "continue"
        )
        token = self.adapter._media_action_store.create(continuation)
        update, query = callback_update(f"md:{token}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        next_page = page(
            "rezka",
            {
                "source": "rezka",
                "result_id": "rezka:next",
                "title": "Hacks alternate",
                "translations": [{"id": 8, "name": "Alt Dub"}],
            },
        )

        with mock.patch.object(
            self.plugin,
            "_run_media",
            mock.AsyncMock(return_value=(0, next_page)),
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)

        self.assertEqual(
            run_media.await_args.args[0],
            (
                "mcp__media_admin__media_search",
                {"source": "rezka", "continuation": "rezka-next-page"},
            ),
        )
        restored = query.message.edit_text.await_args.args[0]
        self.assertIn("🔎 Варианты", restored)
        self.assertIn("Hacks alternate", restored)
        self.assertIn("Rezka", restored)
        self.assertIn("Prowlarr", restored)
        self.assertNotIn("🌐", restored)
        markup = query.message.edit_text.await_args.kwargs["reply_markup"]
        card_button = next(
            button
            for row in markup.inline_keyboard
            for button in row
            if button.text == "🖼 Карточки"
        )
        card_action = self.adapter._media_action_store.resolve(
            card_button.callback_data.removeprefix("md:")
        )[0]
        results = card_action.payload["search_page"]["results"]
        self.assertEqual(
            {result["result_id"] for result in results},
            {"rezka:original", "rezka:next", "prowlarr:original"},
        )
        self.assertEqual(
            {result["_choice_session_id"] for result in results},
            {"session-rezka", "session-prowlarr"},
        )

    async def test_unified_continuation_preserves_results_after_ten(self):
        expires_at = "2099-07-27T12:00:00Z"

        def page(source, results, continuation=None):
            value = {
                "api_version": "v1",
                "session_id": f"session-{source}",
                "source": source,
                "expires_at": expires_at,
                "results": results,
            }
            if continuation is not None:
                value["continuation"] = continuation
            return json.dumps(value).encode()

        rezka_results = [
            {
                "source": "rezka",
                "result_id": f"rezka:{index}",
                "title": f"Show variant {index}",
                "translations": [{"id": index, "name": "Dub"}],
            }
            for index in range(1, 11)
        ]
        combined = self.plugin._combine_source_results([
            self.plugin._render_source_search(
                page("rezka", rezka_results, "rezka-next"),
                "rezka",
                1,
                0,
                carousel=False,
            ),
            self.plugin._render_source_search(
                page("prowlarr", []),
                "prowlarr",
                1,
                0,
                carousel=False,
            ),
        ], [], page=1)
        continuation = next(
            action for action in combined.actions if action.kind == "continue"
        )
        token = self.adapter._media_action_store.create(continuation)
        update, query = callback_update(f"md:{token}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        next_results = [
            {
                "source": "rezka",
                "result_id": f"rezka:{index}",
                "title": f"Show variant {index}",
                "translations": [{"id": index, "name": "Dub"}],
            }
            for index in (11, 12)
        ]

        with mock.patch.object(
            self.plugin,
            "_run_media",
            mock.AsyncMock(return_value=(0, page("rezka", next_results))),
        ):
            await self.adapter._handle_callback_query(update, None)

        merged_markup = query.message.edit_text.await_args.kwargs["reply_markup"]
        next_button = next(
            button
            for row in merged_markup.inline_keyboard
            for button in row
            if button.text == "➡️"
        )
        page_update, page_query = callback_update(next_button.callback_data)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True

        await self.adapter._handle_callback_query(page_update, None)

        rendered = page_query.message.edit_text.await_args.args[0]
        self.assertIn("Show variant 11", rendered)
        self.assertIn("Show variant 12", rendered)
        page_markup = page_query.message.edit_text.await_args.kwargs["reply_markup"]
        card_button = next(
            button
            for row in page_markup.inline_keyboard
            for button in row
            if button.text == "🖼 Карточки"
        )
        card_action = self.adapter._media_action_store.resolve(
            card_button.callback_data.removeprefix("md:")
        )[0]
        self.assertEqual(card_action.payload["result_index"], 11)
        results = card_action.payload["search_page"]["results"][10:12]
        self.assertEqual(
            [(result["_choice_session_id"], result["result_id"])
             for result in results],
            [("session-rezka", "rezka:11"), ("session-rezka", "rezka:12")],
        )

    async def test_source_chooser_opens_provider_results_in_same_message(self):
        page = {
            "api_version": "v1",
            "session_id": "session-rezka",
            "source": "rezka",
            "expires_at": "2099-07-27T12:00:00Z",
            "results": [
                {
                    "source": "rezka",
                    "result_id": "rezka:1",
                    "title": "Hacks",
                    "translations": [{"id": 7, "name": "Dub"}],
                }
            ],
        }
        action = self.plugin.SearchAction(
            label="Rezka · 1",
            kind="provider-open",
            payload={
                "source": "rezka",
                "search_page": page,
                "season": 1,
                "episode": 0,
                "source_back": {
                    "kind": "all-search-back",
                    "payload": {
                        "query": "Hacks",
                        "media_kind": "series",
                        "season": 1,
                        "episode": 0,
                    },
                    "expires_at": "2099-07-27T12:00:00Z",
                },
            },
            expires_at="2099-07-27T12:00:00Z",
        )
        token = self.adapter._media_action_store.create(action)
        update, query = callback_update(f"md:{token}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True

        await self.adapter._handle_callback_query(update, None)

        query.message.edit_text.assert_awaited_once()
        rendered = query.message.edit_text.await_args.args[0]
        markup = query.message.edit_text.await_args.kwargs["reply_markup"]
        self.assertIn("Hacks", rendered)
        self.assertIn("⬅️ Назад", [
            button.text for row in markup.inline_keyboard for button in row
        ])
        query.message.reply_text.assert_not_awaited()

    def test_release_details_back_action_keeps_episode_coordinates(self):
        search_page = {
            "api_version": "v1",
            "session_id": "00000000-0000-0000-0000-000000000222",
            "source": "prowlarr",
            "expires_at": "2099-07-27T12:00:00Z",
            "results": [],
        }
        rendered = self.plugin._render_release_details(
            {
                "source": "prowlarr",
                "session_id": search_page["session_id"],
                "result_id": "prowlarr:1:2",
                "result_index": 1,
                "result": {"title": "Hacks.S01.1080p.WEB-DL"},
                "season": 1,
                "episode": 0,
                "title": "Hacks.S01.1080p.WEB-DL",
            },
            search_page=search_page,
        )

        self.assertIsNotNone(rendered)
        back_action = next(
            action for action in rendered.actions if action.kind == "release-back"
        )
        self.assertEqual(back_action.payload["season"], 1)
        self.assertEqual(back_action.payload["episode"], 0)

    def test_successful_download_marker_suppresses_only_the_next_telegram_reply(self):
        marker = pathlib.Path(self.temp_dir.name) / "media-download-succeeded"
        marker.write_text("100", encoding="utf-8")

        with (
            mock.patch.dict(
                "os.environ",
                {"HERMES_MEDIA_SILENCE_MARKER": str(marker)},
            ),
            mock.patch.object(self.plugin.time, "time", return_value=120),
        ):
            self.assertEqual(
                self.plugin._suppress_download_confirmation(
                    response_text="Загрузка запущена", platform="telegram"
                ),
                "NO_REPLY",
            )
            self.assertIsNone(
                self.plugin._suppress_download_confirmation(
                    "Обычный ответ", platform="telegram"
                )
            )

        self.assertFalse(marker.exists())

    def test_download_marker_does_not_suppress_non_telegram_or_stale_replies(self):
        marker = pathlib.Path(self.temp_dir.name) / "media-download-succeeded"
        marker.write_text("100", encoding="utf-8")

        with (
            mock.patch.dict(
                "os.environ",
                {"HERMES_MEDIA_SILENCE_MARKER": str(marker)},
            ),
            mock.patch.object(self.plugin.time, "time", return_value=401),
        ):
            self.assertIsNone(
                self.plugin._suppress_download_confirmation(
                    "Обычный ответ", platform="telegram"
                )
            )
            marker.write_text("401", encoding="utf-8")
            self.assertIsNone(
                self.plugin._suppress_download_confirmation(
                    "CLI answer", platform="cli"
                )
            )

    def test_notifier_control_client_signs_compact_card_request(self):
        secret_path = pathlib.Path(self.temp_dir.name) / "webhook_hmac"
        secret = b"control-secret"
        secret_path.write_bytes(secret + b"\n")
        client = self.plugin.NotifierControlClient(
            "http://media-notifier-andrii:8644", secret_path
        )
        urlopen = mock.Mock(side_effect=[FakeHTTPResponse(), FakeHTTPResponse()])

        with mock.patch("urllib.request.urlopen", urlopen):
            client.control("expand", JOB_ID, "77")
            client.control("collapse", JOB_ID, "77")

        first_request = urlopen.call_args_list[0].args[0]
        body = json.dumps(
            {"command": "expand", "job_id": JOB_ID, "message_id": "77"},
            separators=(",", ":"),
        ).encode("utf-8")
        headers = dict(first_request.header_items())
        self.assertEqual(
            first_request.full_url,
            "http://media-notifier-andrii:8644/control/card",
        )
        self.assertEqual(first_request.get_method(), "POST")
        self.assertEqual(first_request.data, body)
        self.assertTrue(headers["X-webhook-timestamp"].isdigit())
        self.assertEqual(
            headers["X-webhook-signature-v2"],
            hmac.new(
                secret,
                headers["X-webhook-timestamp"].encode("ascii") + b"." + body,
                hashlib.sha256,
            ).hexdigest(),
        )
        request_ids = [
            dict(call.args[0].header_items())["X-request-id"]
            for call in urlopen.call_args_list
        ]
        self.assertNotEqual(*request_ids)
        for request_id in request_ids:
            self.assertEqual(str(uuid.UUID(request_id)), request_id)
        for call in urlopen.call_args_list:
            request = call.args[0]
            self.assertEqual(call.kwargs["timeout"], 10)
            serialized = request.data.decode("utf-8") + str(request.header_items())
            self.assertNotIn("telegram-token", serialized)
            self.assertNotIn("media-api-token", serialized)
            self.assertNotIn("raw message text", serialized)

    def test_notifier_control_client_rejects_empty_secret_and_non_http_url(self):
        secret_path = pathlib.Path(self.temp_dir.name) / "webhook_hmac"
        secret_path.write_text("\n", encoding="utf-8")

        with self.assertRaises(ValueError):
            self.plugin.NotifierControlClient(
                "http://media-notifier-andrii:8644", secret_path
            )

        secret_path.write_text("control-secret\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            self.plugin.NotifierControlClient(
                "https://media-notifier-andrii:8644", secret_path
            )

    def test_notifier_control_client_normalizes_secret_file_errors(self):
        secret_path = pathlib.Path(self.temp_dir.name) / "webhook_hmac"

        for error in (FileNotFoundError(), PermissionError()):
            with self.subTest(error=type(error).__name__):
                with mock.patch.object(pathlib.Path, "read_bytes", side_effect=error):
                    with self.assertRaises(self.plugin.NotifierControlUnavailableError):
                        self.plugin.NotifierControlClient(
                            "http://media-notifier-andrii:8644", secret_path
                        )

    async def test_authorized_presentation_callback_only_calls_notifier(self):
        update, query = callback_update(f"hm:e:{JOB_ID}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        notifier = mock.Mock()
        self.adapter._notifier_control_client = notifier
        llm_callback = mock.AsyncMock()

        with (
            mock.patch.object(self.plugin, "_run_media", mock.AsyncMock()) as run_media,
            mock.patch.object(
                self.plugin.TelegramAdapter,
                "_handle_callback_query",
                llm_callback,
                create=True,
            ),
        ):
            await self.adapter._handle_callback_query(update, None)

        notifier.control.assert_called_once_with("expand", JOB_ID, "77")
        run_media.assert_not_awaited()
        llm_callback.assert_not_awaited()
        query.message.reply_text.assert_not_awaited()
        query.answer.assert_awaited_once_with()

    async def test_presentation_callback_runs_notifier_control_off_the_event_loop(self):
        update, query = callback_update(f"hm:e:{JOB_ID}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        notifier = mock.Mock()
        self.adapter._notifier_control_client = notifier

        async def run_in_test_thread(function, *args):
            function(*args)

        with mock.patch.object(
            self.plugin.asyncio,
            "to_thread",
            mock.AsyncMock(side_effect=run_in_test_thread),
        ) as to_thread:
            await self.adapter._handle_callback_query(update, None)

        to_thread.assert_awaited_once_with(notifier.control, "expand", JOB_ID, "77")
        query.answer.assert_awaited_once_with()

    async def test_presentation_callback_acknowledges_before_notifier_io(self):
        update, query = callback_update(f"hm:e:{JOB_ID}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.adapter._notifier_control_client = mock.Mock()
        events = []
        entered_io = asyncio.Event()
        release_io = asyncio.Event()

        async def answer(**_kwargs):
            events.append("ack")

        async def blocked_io(*_args, **_kwargs):
            events.append("io")
            entered_io.set()
            await release_io.wait()

        query.answer.side_effect = answer
        with mock.patch.object(
            self.plugin.asyncio, "to_thread", side_effect=blocked_io
        ):
            task = asyncio.create_task(
                self.adapter._handle_callback_query(update, None)
            )
            await asyncio.wait_for(entered_io.wait(), timeout=1)
            self.assertEqual(events, ["ack", "io"])
            release_io.set()
            await task

        query.answer.assert_awaited_once_with()

    async def test_presentation_callback_reports_unavailable_secret_file(self):
        update, query = callback_update(f"hm:e:{JOB_ID}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True

        with mock.patch.object(
            pathlib.Path, "read_bytes", side_effect=FileNotFoundError()
        ):
            await self.adapter._handle_callback_query(update, None)

        query.answer.assert_awaited_once_with()
        self.assertIn(
            "Не удалось обновить карточку",
            query.message.edit_text.await_args.args[0],
        )

    async def test_unauthorized_presentation_callback_does_not_call_notifier(self):
        update, query = callback_update(f"hm:e:{JOB_ID}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: False
        notifier = mock.Mock()
        self.adapter._notifier_control_client = notifier

        await self.adapter._handle_callback_query(update, None)

        notifier.control.assert_not_called()
        query.message.reply_text.assert_not_awaited()
        query.answer.assert_awaited_once_with()

    async def test_presentation_callback_acknowledges_each_successful_view_change(self):
        expectations = (
            ("b", "collapse", "Возвращаю краткий вид"),
            ("c", "confirm-cancel", "Подтвердите отмену"),
            ("x", "dismiss-cancel", "Возвращаю краткий вид"),
        )
        for code, command, acknowledgement in expectations:
            with self.subTest(command=command):
                update, query = callback_update(f"hm:{code}:{JOB_ID}")
                self.adapter._is_callback_user_authorized = (
                    lambda *_args, **_kwargs: True
                )
                notifier = mock.Mock()
                self.adapter._notifier_control_client = notifier

                await self.adapter._handle_callback_query(update, None)

                notifier.control.assert_called_once_with(command, JOB_ID, "77")
                query.answer.assert_awaited_once_with()

    async def test_presentation_callback_reports_stale_card(self):
        update, query = callback_update(f"hm:e:{JOB_ID}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        notifier = mock.Mock()
        notifier.control.side_effect = self.plugin.NotifierControlStaleError("stale")
        self.adapter._notifier_control_client = notifier

        await self.adapter._handle_callback_query(update, None)

        query.answer.assert_awaited_once_with()
        self.assertIn("Карточка устарела", query.message.edit_text.await_args.args[0])

    async def test_presentation_callback_reports_unavailable_notifier(self):
        update, query = callback_update(f"hm:e:{JOB_ID}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        notifier = mock.Mock()
        notifier.control.side_effect = self.plugin.NotifierControlUnavailableError(
            "offline"
        )
        self.adapter._notifier_control_client = notifier

        await self.adapter._handle_callback_query(update, None)

        query.answer.assert_awaited_once_with()
        self.assertIn(
            "Не удалось обновить карточку",
            query.message.edit_text.await_args.args[0],
        )

    async def test_cancel_confirmation_only_updates_the_existing_card(self):
        update, query = callback_update(f"hm:c:{JOB_ID}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        notifier = mock.Mock()
        self.adapter._notifier_control_client = notifier

        await self.adapter._handle_callback_query(update, None)

        notifier.control.assert_called_once_with("confirm-cancel", JOB_ID, "77")
        query.message.reply_text.assert_not_awaited()
        query.answer.assert_awaited_once_with()

    async def test_cancel_business_action_runs_once_without_a_status_message(self):
        update, query = callback_update(business_callback("cancel"))
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.adapter._media_plugin_context = business_job_context()

        with mock.patch.object(
            self.plugin,
            "_run_media",
            mock.AsyncMock(return_value=(0, b"{}")),
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_awaited_once_with(
            (
                "mcp__media_admin__media_job_cancel",
                {"job_id": JOB_ID, "expected_lifecycle_cycle": 1},
            ),
            mock.ANY,
        )
        query.message.reply_text.assert_not_awaited()
        self.assertEqual(
            [call.kwargs.get("text") for call in query.answer.await_args_list],
            ["Отменяю загрузку…", None],
        )

    async def test_cancel_ack_failure_releases_receipt_for_one_retry(self):
        update, query = callback_update(business_callback("cancel"))
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        query.answer.side_effect = [self.plugin.BadRequest("Query is too old"), None]
        self.adapter._media_plugin_context = business_job_context()

        with mock.patch.object(
            self.plugin, "_run_media", mock.AsyncMock(return_value=(0, b"{}"))
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_awaited_once()

    async def test_cancelled_ack_releases_receipt_for_same_process_retry(self):
        update, query = callback_update(business_callback("cancel"))
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        query.answer.side_effect = [asyncio.CancelledError(), None]
        self.adapter._media_plugin_context = business_job_context()

        with mock.patch.object(
            self.plugin, "_run_media", mock.AsyncMock(return_value=(0, b"{}"))
        ) as run_media:
            with self.assertRaises(asyncio.CancelledError):
                await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_awaited_once()

    async def test_cancel_without_context_releases_receipt_without_dispatch(self):
        update, query = callback_update(business_callback("cancel"))
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.plugin.HomeTelegramAdapter._media_plugin_context = None

        with mock.patch.object(
            self.plugin, "_run_media", mock.AsyncMock(return_value=(127, b"{}"))
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_not_awaited()
        self.assertEqual(query.message.edit_text.await_count, 2)

    async def test_business_read_exception_releases_but_mutation_stays_consumed(self):
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True

        details_update, details_query = callback_update(f"ma:details:{JOB_ID}")
        with mock.patch.object(
            self.plugin,
            "_run_media",
            mock.AsyncMock(side_effect=[RuntimeError("read failed"), (0, b"details")]),
        ) as read_media:
            with self.assertRaises(RuntimeError):
                await self.adapter._handle_callback_query(details_update, None)
            await self.adapter._handle_callback_query(details_update, None)
        self.assertEqual(read_media.await_count, 2)

        cancel_update, cancel_query = callback_update(business_callback("cancel"))
        self.adapter._media_plugin_context = business_job_context()
        with mock.patch.object(
            self.plugin,
            "_run_media",
            mock.AsyncMock(side_effect=RuntimeError("mutation ambiguous")),
        ) as mutate_media:
            with self.assertRaises(RuntimeError):
                await self.adapter._handle_callback_query(cancel_update, None)
            await self.adapter._handle_callback_query(cancel_update, None)
        mutate_media.assert_awaited_once()

    async def test_retry_timeout_consumes_receipt_and_never_replays(self):
        update, query = callback_update(business_callback("retry"))
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.adapter._media_plugin_context = business_job_context(state="failed")

        with mock.patch.object(
            self.plugin, "_run_media", mock.AsyncMock(return_value=(124, b"timeout"))
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_awaited_once()

    async def test_cancel_continues_when_optimistic_caption_edit_fails(self):
        update, query = callback_update(business_callback("cancel"))
        query.message.photo = (object(),)
        query.message.edit_caption.side_effect = [
            self.plugin.TelegramError("optimistic edit failed"),
            None,
        ]
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = json.dumps({
            "structuredContent": {
                "id": JOB_ID,
                "provider": "rezka",
                "state": "cancelled",
                "lifecycle_cycle": 1,
                "current_stage": "cancelled",
            }
        })
        self.plugin.HomeTelegramAdapter._media_plugin_context = ctx

        with mock.patch.object(
            self.plugin,
            "_run_media",
            mock.AsyncMock(return_value=(0, b"{}")),
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_awaited_once_with(
            (
                "mcp__media_admin__media_job_cancel",
                {"job_id": JOB_ID, "expected_lifecycle_cycle": 1},
            ),
            mock.ANY,
        )
        self.assertEqual(query.message.edit_caption.await_count, 2)
        self.assertIn(
            "отменено", query.message.edit_caption.await_args.kwargs["caption"]
        )
        query.message.reply_text.assert_not_awaited()
        self.assertEqual(
            [call.kwargs.get("text") for call in query.answer.await_args_list],
            ["Отменяю загрузку…", None],
        )

    async def test_cancelled_mutation_consumes_receipt_and_never_replays(self):
        update, query = callback_update(business_callback("cancel"))
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.adapter._media_plugin_context = business_job_context()
        first_started = asyncio.Event()
        first_cancelled = asyncio.Event()
        attempts = 0

        async def cancel_then_succeed(*_args, **_kwargs):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                first_started.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    first_cancelled.set()
                    raise
            return 0, b"{}"

        with mock.patch.object(
            self.plugin, "_run_media", side_effect=cancel_then_succeed
        ) as run_media:
            first = asyncio.create_task(
                self.adapter._handle_callback_query(update, None)
            )
            await asyncio.wait_for(first_started.wait(), timeout=1)
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
            await asyncio.wait_for(first_cancelled.wait(), timeout=1)

            self.adapter._business_action_receipt_store = (
                self.plugin.BusinessActionReceiptStore(
                    pathlib.Path(self.temp_dir.name) / "media-business-actions.json",
                    now=lambda: 2_000_000_000,
                    owner="restarted-process",
                )
            )
            await self.adapter._handle_callback_query(update, None)

        self.assertEqual(run_media.await_count, 1)
        self.assertEqual(attempts, 1)
        self.assertEqual(
            [call.kwargs.get("text") for call in query.answer.await_args_list],
            ["Отменяю загрузку…", None],
        )
        query.message.reply_text.assert_not_awaited()

    async def test_cancelled_download_stays_consumed_after_restart_and_ttl(self):
        update, query = callback_update("unused")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        action_path = pathlib.Path(self.temp_dir.name) / "media-actions.json"
        token = self.adapter._media_action_store.create(
            self.plugin.SearchAction(
                label="Скачать",
                kind="download",
                payload={
                    "source": "prowlarr",
                    "session_id": "session",
                    "result_id": "prowlarr:release",
                    "season": 1,
                    "episode": 0,
                    "title": "Сериал",
                },
                expires_at="2099-07-27T12:00:00Z",
            )
        )
        query.data = f"md:{token}"
        started = asyncio.Event()

        async def cancelled_dispatch(*_args, **_kwargs):
            started.set()
            await asyncio.Event().wait()

        with mock.patch.object(
            self.plugin, "_run_media", side_effect=cancelled_dispatch
        ) as run_media:
            first = asyncio.create_task(
                self.adapter._handle_callback_query(update, None)
            )
            await asyncio.wait_for(started.wait(), timeout=1)
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first

            self.adapter._media_action_store = self.plugin.MediaActionStore(
                action_path,
                now=lambda: 2_000_000_000,
                owner="restarted-process",
            )
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_awaited_once()

    async def test_panel_cancel_renders_the_updated_job_in_place(self):
        update, query = callback_update(business_callback("cancel"))
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        query.message.reply_markup = self.plugin.InlineKeyboardMarkup([[
            self.plugin.InlineKeyboardButton(
                "⬅️ Назад", callback_data="mp:downloads"
            )
        ]])
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = json.dumps({
            "structuredContent": {
                "id": JOB_ID,
                "provider": "rezka",
                "state": "cancelled",
                "lifecycle_cycle": 1,
                "current_stage": "cancelled",
            }
        })
        self.plugin.HomeTelegramAdapter._media_plugin_context = ctx

        with mock.patch.object(
            self.plugin,
            "_run_media",
            mock.AsyncMock(return_value=(0, b"{}")),
        ):
            await self.adapter._handle_callback_query(update, None)

        self.assertEqual(query.message.edit_caption.await_count, 2)
        self.assertIn(
            "отменено", query.message.edit_caption.await_args.kwargs["caption"]
        )
        query.message.edit_text.assert_not_awaited()
        query.answer.assert_awaited_once_with(text="Отменяю загрузку…")

    async def test_panel_cancel_shows_full_cancelling_card_before_mcp_finishes(self):
        update, query = callback_update(business_callback("cancel"))
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        query.message.reply_markup = self.plugin.InlineKeyboardMarkup([[
            self.plugin.InlineKeyboardButton(
                "⬅️ Назад", callback_data="mp:downloads-p:1"
            )
        ]])
        cancelled = False
        ctx = mock.Mock()

        def dispatch(tool, _arguments):
            job = {
                "id": JOB_ID,
                "provider": "rezka",
                "state": "cancelled" if cancelled else "running",
                "lifecycle_cycle": 1,
                "current_stage": "cancelled" if cancelled else "downloading",
                "poster_url": "https://image.test/job.jpg",
                "progress": {"progress_percent": 37},
            }
            payload = {"jobs": [job]} if tool.endswith("media_jobs_list") else job
            return json.dumps({"structuredContent": payload})

        ctx.dispatch_tool.side_effect = dispatch
        self.plugin.HomeTelegramAdapter._media_plugin_context = ctx
        action_started = asyncio.Event()
        release_action = asyncio.Event()

        async def slow_cancel(*_args, **_kwargs):
            nonlocal cancelled
            action_started.set()
            await release_action.wait()
            cancelled = True
            return 0, b"{}"

        with mock.patch.object(self.plugin, "_run_media", side_effect=slow_cancel):
            task = asyncio.create_task(
                self.adapter._handle_callback_query(update, None)
            )
            await asyncio.wait_for(action_started.wait(), timeout=1)

            query.message.edit_caption.assert_awaited_once()
            optimistic = query.message.edit_caption.await_args_list[0]
            self.assertIn("отменяется", optimistic.kwargs["caption"])
            self.assertIn("Прогресс: <b>37%</b>", optimistic.kwargs["caption"])
            optimistic_labels = [
                button.text
                for row in optimistic.kwargs["reply_markup"].inline_keyboard
                for button in row
            ]
            self.assertIn("1/1", optimistic_labels)
            self.assertIn("⬅️ Назад", optimistic_labels)
            self.assertNotIn("✖️ Отменить", optimistic_labels)

            release_action.set()
            await task

        self.assertIn(
            "отменено",
            query.message.edit_caption.await_args_list[-1].kwargs["caption"],
        )
        query.message.reply_text.assert_not_awaited()
        query.answer.assert_awaited_once_with(text="Отменяю загрузку…")

    async def test_notifier_cancel_uses_the_same_full_job_card_before_mcp_finishes(self):
        update, query = callback_update(business_callback("cancel"))
        query.message.photo = (object(),)
        query.message.reply_markup = self.plugin.InlineKeyboardMarkup([[
            self.plugin.InlineKeyboardButton(
                "✖️ Отменить", callback_data=f"ma:cancel:{JOB_ID}"
            ),
            self.plugin.InlineKeyboardButton(
                "Подробнее", callback_data=f"hm:b:{JOB_ID}"
            ),
        ]])
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        cancelled = False
        ctx = mock.Mock()

        def dispatch(tool, _arguments):
            job = {
                "id": JOB_ID,
                "provider": "rezka",
                "state": "cancelled" if cancelled else "running",
                "lifecycle_cycle": 1,
                "title": "Notifier job",
                "poster_url": "https://image.test/notifier.jpg",
                "progress": {"progress_percent": 51},
            }
            payload = {"jobs": [job]} if tool.endswith("media_jobs_list") else job
            return json.dumps({"structuredContent": payload})

        ctx.dispatch_tool.side_effect = dispatch
        self.plugin.HomeTelegramAdapter._media_plugin_context = ctx
        action_started = asyncio.Event()
        release_action = asyncio.Event()

        async def slow_cancel(*_args, **_kwargs):
            nonlocal cancelled
            action_started.set()
            await release_action.wait()
            cancelled = True
            return 0, b"{}"

        with mock.patch.object(self.plugin, "_run_media", side_effect=slow_cancel):
            task = asyncio.create_task(self.adapter._handle_callback_query(update, None))
            await asyncio.wait_for(action_started.wait(), timeout=1)

            query.message.edit_caption.assert_awaited_once()
            optimistic = query.message.edit_caption.await_args.kwargs
            self.assertIn("отменяется", optimistic["caption"])
            self.assertIn("Прогресс: <b>51%</b>", optimistic["caption"])
            self.assertEqual(
                optimistic["reply_markup"].inline_keyboard[-1][0].text,
                "⬅️ Назад",
            )
            self.assertEqual(
                optimistic["reply_markup"].inline_keyboard[-1][0].callback_data,
                "mp:downloads-p:1",
            )
            query.message.reply_text.assert_not_awaited()

            release_action.set()
            await task

        self.assertEqual(query.message.edit_caption.await_count, 2)
        self.assertIn(
            "отменено", query.message.edit_caption.await_args.kwargs["caption"]
        )
        query.answer.assert_awaited_once_with(text="Отменяю загрузку…")

    async def test_cancel_starts_before_a_blocked_optimistic_job_read(self):
        update, query = callback_update(business_callback("cancel"))
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        read_started = threading.Event()
        release_read = threading.Event()
        cancel_started = asyncio.Event()
        release_cancel = asyncio.Event()
        cancelled = False
        ctx = mock.Mock()

        def dispatch(tool, _arguments):
            if tool.endswith("media_job_get") and not cancelled:
                read_started.set()
                self.assertTrue(release_read.wait(timeout=2))
            job = {
                "id": JOB_ID,
                "provider": "rezka",
                "state": "cancelled" if cancelled else "running",
                "lifecycle_cycle": 1,
                "title": "Blocked read",
                "progress": {"progress_percent": 23},
            }
            payload = {"jobs": [job]} if tool.endswith("media_jobs_list") else job
            return json.dumps({"structuredContent": payload})

        async def slow_cancel(*_args, **_kwargs):
            nonlocal cancelled
            cancel_started.set()
            await release_cancel.wait()
            cancelled = True
            return 0, b"{}"

        ctx.dispatch_tool.side_effect = dispatch
        self.plugin.HomeTelegramAdapter._media_plugin_context = ctx
        with mock.patch.object(self.plugin, "_run_media", side_effect=slow_cancel):
            task = asyncio.create_task(self.adapter._handle_callback_query(update, None))
            await asyncio.wait_for(
                asyncio.to_thread(read_started.wait, 1), timeout=2
            )
            self.assertFalse(cancel_started.is_set())
            query.message.edit_caption.assert_not_awaited()

            release_read.set()
            await asyncio.wait_for(cancel_started.wait(), timeout=1)
            for _ in range(20):
                if query.message.edit_caption.await_count:
                    break
                await asyncio.sleep(0)
            query.message.edit_caption.assert_awaited_once()
            self.assertIn(
                "отменяется",
                query.message.edit_caption.await_args.kwargs["caption"],
            )

            release_cancel.set()
            await task

        self.assertEqual(query.message.edit_caption.await_count, 2)
        query.answer.assert_awaited_once_with(text="Отменяю загрузку…")

    async def test_cancel_error_keeps_the_full_job_card(self):
        update, query = callback_update(business_callback("cancel"))
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        job = {
            "id": JOB_ID,
            "provider": "rezka",
            "state": "completed",
            "lifecycle_cycle": 1,
            "title": "Finished during cancel",
            "poster_url": "https://image.test/finished.jpg",
            "progress": {"progress_percent": 100},
        }
        ctx = mock.Mock()
        ctx.dispatch_tool.side_effect = lambda tool, _arguments: json.dumps({
            "structuredContent": {"jobs": [job]} if tool.endswith("media_jobs_list") else job
        })
        self.plugin.HomeTelegramAdapter._media_plugin_context = ctx

        with mock.patch.object(
            self.plugin,
            "_run_media",
            mock.AsyncMock(return_value=(1, b'{"error":"terminal"}')),
        ):
            await self.adapter._handle_callback_query(update, None)

        final = query.message.edit_caption.await_args.kwargs
        self.assertIn("больше не может быть отменена", final["caption"])
        self.assertIn("Finished during cancel", final["caption"])
        self.assertIn("Прогресс: <b>100%</b>", final["caption"])
        self.assertEqual(final["reply_markup"].inline_keyboard[0][1].text, "1/1")
        self.assertEqual(final["reply_markup"].inline_keyboard[-1][0].text, "⬅️ Назад")
        query.message.reply_text.assert_not_awaited()

    async def test_cancel_double_failure_fallback_replaces_cancelling_status(self):
        update, query = callback_update(business_callback("cancel"))
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        job = {
            "id": JOB_ID,
            "provider": "rezka",
            "state": "running",
            "lifecycle_cycle": 1,
            "title": "Fallback job",
            "progress": {"progress_percent": 64},
        }
        ctx = mock.Mock()
        ctx.dispatch_tool.side_effect = lambda tool, _arguments: json.dumps({
            "structuredContent": {"jobs": [job]} if tool.endswith("media_jobs_list") else job
        })
        self.plugin.HomeTelegramAdapter._media_plugin_context = ctx

        with (
            mock.patch.object(
                self.plugin,
                "_run_media",
                mock.AsyncMock(return_value=(1, b'{"error":"temporary"}')),
            ),
            mock.patch.object(
                self.plugin,
                "render_job_cancel_error_card",
                side_effect=RuntimeError("authoritative read failed"),
            ),
        ):
            await self.adapter._handle_callback_query(update, None)

        final = query.message.edit_caption.await_args.kwargs["caption"]
        self.assertIn("Не удалось отменить загрузку", final)
        self.assertIn("Fallback job", final)
        self.assertIn("Прогресс: <b>64%</b>", final)
        self.assertIn("ошибка отмены", final)
        self.assertNotIn("отменяется", final)

    def test_empty_trending_and_similar_pages_keep_semantic_navigation(self):
        trending = self.plugin.render_trending_list({
            "category": "movie",
            "results": [],
            "page": 3,
            "total_pages": 3,
        })
        similar = self.plugin.render_similar_list(
            {"results": [], "page": 2, "total_pages": 4}, "movie", 42
        )

        self.assertEqual(
            [button.callback_data for button in trending.buttons[0]],
            ["mt:l:m:2:0:0", "mp:noop", "mp:noop"],
        )
        self.assertEqual(trending.buttons[-1][0].callback_data, "mn:b")
        self.assertEqual(
            [button.callback_data for button in similar.buttons[0]],
            ["mi:l:m:42:1:0:0", "mp:noop", "mi:l:m:42:3:0:0"],
        )
        self.assertEqual(similar.buttons[-1][0].callback_data, "mn:b")

    def test_business_job_action_restores_the_exact_carousel_page(self):
        message = types.SimpleNamespace(
            reply_markup=FakeInlineKeyboardMarkup([[
                FakeInlineKeyboardButton(
                    "↩️ К задаче", callback_data=f"mp:job:{JOB_ID}:7:t"
                ),
                FakeInlineKeyboardButton(
                    "✖️ Отменить", callback_data=f"ma:cancel:{JOB_ID}"
                ),
            ]])
        )

        self.assertEqual(self.adapter._message_job_page(message, JOB_ID), 7)
        self.assertEqual(self.adapter._message_job_filter(message, JOB_ID), "t")

    async def test_job_cancel_confirmation_preserves_the_current_photo(self):
        update, query = callback_update(f"mp:job-cancel:{JOB_ID}:1")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = json.dumps({
            "structuredContent": {
                "id": JOB_ID,
                "provider": "prowlarr",
                "state": "running",
                "title": "Existing poster job",
            }
        })
        self.plugin.HomeTelegramAdapter._media_plugin_context = ctx

        await self.adapter._handle_callback_query(update, None)

        query.message.edit_caption.assert_awaited_once()
        query.message.edit_media.assert_not_awaited()
        self.assertIn(
            "Отменить загрузку?",
            query.message.edit_caption.await_args.kwargs["caption"],
        )

    async def test_concurrent_cancel_business_actions_run_once(self):
        first_update, first_query = callback_update(business_callback("cancel"))
        second_update, second_query = callback_update(business_callback("cancel"))
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.adapter._media_plugin_context = business_job_context()

        with mock.patch.object(
            self.plugin,
            "_run_media",
            mock.AsyncMock(return_value=(0, b"{}")),
        ) as run_media:
            await asyncio.gather(
                self.adapter._handle_callback_query(first_update, None),
                self.adapter._handle_callback_query(second_update, None),
            )

        run_media.assert_awaited_once()
        first_query.answer.assert_awaited_once_with(text="Отменяю загрузку…")
        second_query.answer.assert_awaited_once_with()

    async def test_cancel_failure_consumes_receipt_and_never_replays(self):
        update, query = callback_update(business_callback("cancel"))
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.adapter._media_plugin_context = business_job_context()

        with mock.patch.object(
            self.plugin,
            "_run_media",
            mock.AsyncMock(return_value=(1, b'{"error":"temporary"}')),
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        self.assertEqual(run_media.await_count, 1)
        self.assertEqual(
            [call.kwargs.get("text") for call in query.answer.await_args_list],
            ["Отменяю загрузку…", None],
        )
        self.assertTrue(any(
            "Не удалось отменить загрузку" in call.args[0]
            for call in query.message.edit_text.await_args_list
        ))
        query.message.reply_text.assert_not_awaited()

    async def test_retry_nonzero_outcomes_consume_receipt_before_dispatch(self):
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        for returncode in (1, 127):
            with self.subTest(returncode=returncode):
                self.adapter._media_plugin_context = business_job_context(
                    state="failed"
                )
                self.adapter._business_action_receipt_store = (
                    self.plugin.BusinessActionReceiptStore(
                        pathlib.Path(self.temp_dir.name)
                        / f"business-{returncode}.json"
                    )
                )
                update, query = callback_update(business_callback("retry"))
                with mock.patch.object(
                    self.plugin,
                    "_run_media",
                    mock.AsyncMock(return_value=(returncode, b"{}")),
                ) as run_media:
                    await self.adapter._handle_callback_query(update, None)
                    await self.adapter._handle_callback_query(update, None)

                run_media.assert_awaited_once()

    async def test_cancel_of_a_no_longer_cancellable_job_is_acknowledged_as_stale(self):
        update, query = callback_update(business_callback("cancel"))
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.adapter._media_plugin_context = business_job_context()

        with mock.patch.object(
            self.plugin,
            "_run_media",
            mock.AsyncMock(return_value=(1, b'{"error":"terminal"}')),
        ):
            await self.adapter._handle_callback_query(update, None)

        query.answer.assert_awaited_once_with(text="Отменяю загрузку…")
        self.assertIn(
            "больше не может быть отменена",
            query.message.edit_text.await_args.args[0],
        )
        query.message.reply_text.assert_not_awaited()

    async def test_unauthorized_cancel_business_action_does_not_run(self):
        update, query = callback_update(business_callback("cancel"))
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: False

        with mock.patch.object(self.plugin, "_run_media", mock.AsyncMock()) as run_media:
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_not_awaited()
        query.answer.assert_awaited_once_with()

    def test_business_action_receipts_survive_restart_and_stay_bounded(self):
        path = pathlib.Path(self.temp_dir.name) / "business-receipts.json"
        callback = f"ma:cancel:{JOB_ID}"
        store = self.plugin.BusinessActionReceiptStore(path)

        self.assertEqual(store.claim(callback, "77"), "ready")
        self.assertEqual(
            self.plugin.BusinessActionReceiptStore(path).claim(callback, "77"),
            "claimed",
        )
        store.consume(callback, "77")
        self.assertEqual(
            self.plugin.BusinessActionReceiptStore(path).claim(callback, "77"),
            "consumed",
        )
        for message_id in range(500):
            store.claim(f"ma:retry:{JOB_ID}", str(message_id))

        stored = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(len(stored["receipts"]), 500)

    def test_business_action_receipt_bound_never_evicts_active_claim(self):
        path = pathlib.Path(self.temp_dir.name) / "business-receipts.json"
        callback = f"ma:cancel:{JOB_ID}"
        store = self.plugin.BusinessActionReceiptStore(path)

        self.assertEqual(store.claim(callback, "77"), "ready")
        for message_id in range(500):
            other = f"ma:retry:{JOB_ID}"
            self.assertEqual(store.claim(other, str(message_id)), "ready")
            store.consume(other, str(message_id))

        self.assertEqual(store.claim(callback, "77"), "claimed")
        stored = json.loads(path.read_text(encoding="utf-8"))
        self.assertLessEqual(len(stored["receipts"]), 500)

    def test_business_action_receipt_reclaims_expired_claim_after_restart(self):
        path = pathlib.Path(self.temp_dir.name) / "business-receipts.json"
        callback = f"ma:cancel:{JOB_ID}"
        lease = self.plugin._BUSINESS_ACTION_CLAIM_TTL_SECONDS

        first = self.plugin.BusinessActionReceiptStore(
            path, now=lambda: 100.0, owner="old-process"
        )
        self.assertEqual(first.claim(callback, "77"), "ready")
        live = self.plugin.BusinessActionReceiptStore(
            path, now=lambda: 100.0 + lease - 1, owner="new-process"
        )
        self.assertEqual(live.claim(callback, "77"), "claimed")
        recovered = self.plugin.BusinessActionReceiptStore(
            path, now=lambda: 100.0 + lease, owner="new-process"
        )
        self.assertEqual(recovered.claim(callback, "77"), "ready")

    def test_live_business_claim_is_not_reclaimed_after_lease(self):
        path = pathlib.Path(self.temp_dir.name) / "business-receipts.json"
        callback = f"ma:cancel:{JOB_ID}"
        current = [100.0]
        store = self.plugin.BusinessActionReceiptStore(
            path, now=lambda: current[0]
        )
        self.assertEqual(store.claim(callback, "77"), "ready")

        current[0] += self.plugin._BUSINESS_ACTION_CLAIM_TTL_SECONDS
        same_process = self.plugin.BusinessActionReceiptStore(
            path, now=lambda: current[0]
        )
        self.assertEqual(same_process.claim(callback, "77"), "claimed")

    async def test_business_execution_lock_fences_expired_foreign_owner(self):
        path = pathlib.Path(self.temp_dir.name) / "business-receipts.json"
        callback = f"ma:cancel:{JOB_ID}"
        current = [100.0]
        old = self.plugin.BusinessActionReceiptStore(
            path, now=lambda: current[0], owner="old-process"
        )
        self.assertEqual(old.claim(callback, "77"), "ready")
        entered = asyncio.Event()
        finish = asyncio.Event()
        side_effects = []

        async def old_worker():
            async with old.execution(callback, "77") as owns_claim:
                self.assertTrue(owns_claim)
                side_effects.append("old")
                entered.set()
                await asyncio.wait_for(finish.wait(), 2)
                old.consume(callback, "77")

        worker = asyncio.create_task(old_worker())
        await asyncio.wait_for(entered.wait(), 2)
        current[0] += self.plugin._BUSINESS_ACTION_CLAIM_TTL_SECONDS
        new = self.plugin.BusinessActionReceiptStore(
            path, now=lambda: current[0], owner="new-process"
        )
        self.assertEqual(new.claim(callback, "77"), "claimed")
        finish.set()
        await asyncio.wait_for(worker, 2)
        self.assertEqual(side_effects, ["old"])

    async def test_historical_four_twenty_seven_collision_does_not_deadlock(self):
        path = pathlib.Path(self.temp_dir.name) / "business-receipts.json"
        callback = f"ma:retry:{JOB_ID}"
        store = self.plugin.BusinessActionReceiptStore(path)
        self.assertEqual(store.claim(callback, "4"), "ready")
        self.assertEqual(store.claim(callback, "27"), "ready")
        first_entered = asyncio.Event()
        second_entered = asyncio.Event()
        release_first = asyncio.Event()

        async def first_worker():
            async with store.execution(callback, "4") as owns_claim:
                self.assertTrue(owns_claim)
                first_entered.set()
                await release_first.wait()

        async def second_worker():
            await first_entered.wait()
            async with store.execution(callback, "27") as owns_claim:
                self.assertTrue(owns_claim)
                second_entered.set()

        first = asyncio.create_task(first_worker())
        second = asyncio.create_task(second_worker())
        await asyncio.wait_for(second_entered.wait(), 1)
        release_first.set()
        await asyncio.gather(first, second)

    async def test_different_keys_in_same_lock_shard_serialize_cooperatively(self):
        path = pathlib.Path(self.temp_dir.name) / "business-receipts.json"
        callback = f"ma:retry:{JOB_ID}"
        store = self.plugin.BusinessActionReceiptStore(path)
        by_path = {}
        pair = None
        for message_id in range(1, 500):
            key = store._key(callback, message_id)
            lock_path = store._execution_lock_path(key)
            if lock_path in by_path:
                pair = (by_path[lock_path], str(message_id))
                break
            by_path[lock_path] = str(message_id)
        self.assertIsNotNone(pair)
        first_id, second_id = pair
        self.assertEqual(store.claim(callback, first_id), "ready")
        self.assertEqual(store.claim(callback, second_id), "ready")
        first_entered = asyncio.Event()
        second_entered = asyncio.Event()
        release_first = asyncio.Event()

        async def first_worker():
            async with store.execution(callback, first_id) as owns_claim:
                self.assertTrue(owns_claim)
                first_entered.set()
                await release_first.wait()

        async def second_worker():
            await first_entered.wait()
            async with store.execution(callback, second_id) as owns_claim:
                self.assertTrue(owns_claim)
                second_entered.set()

        first = asyncio.create_task(first_worker())
        second = asyncio.create_task(second_worker())
        await asyncio.wait_for(first_entered.wait(), 1)
        await asyncio.sleep(0.05)
        self.assertFalse(second_entered.is_set())
        release_first.set()
        await asyncio.wait_for(second_entered.wait(), 1)
        await asyncio.gather(first, second)

    def test_execution_lock_path_cardinality_is_bounded(self):
        path = pathlib.Path(self.temp_dir.name) / "business-receipts.json"
        callback = f"ma:retry:{JOB_ID}"
        store = self.plugin.BusinessActionReceiptStore(path)
        paths = {
            store._execution_lock_path(store._key(callback, message_id))
            for message_id in range(1, 10_001)
        }

        self.assertLessEqual(len(paths), 16**3)
        self.assertTrue(
            all(len(item.name.split(".")[-3]) == 3 for item in paths)
        )

    async def test_same_execution_key_serializes_without_blocking_event_loop(self):
        path = pathlib.Path(self.temp_dir.name) / "business-receipts.json"
        callback = f"ma:cancel:{JOB_ID}"
        store = self.plugin.BusinessActionReceiptStore(path)
        self.assertEqual(store.claim(callback, "77"), "ready")
        first_entered = asyncio.Event()
        second_entered = asyncio.Event()
        release_first = asyncio.Event()

        async def first_worker():
            async with store.execution(callback, "77") as owns_claim:
                self.assertTrue(owns_claim)
                first_entered.set()
                await release_first.wait()

        async def second_worker():
            await first_entered.wait()
            async with store.execution(callback, "77") as owns_claim:
                self.assertTrue(owns_claim)
                second_entered.set()

        first = asyncio.create_task(first_worker())
        second = asyncio.create_task(second_worker())
        await asyncio.wait_for(first_entered.wait(), 1)
        await asyncio.sleep(0.05)
        self.assertFalse(second_entered.is_set())
        release_first.set()
        await asyncio.wait_for(second_entered.wait(), 1)
        await asyncio.gather(first, second)

    def test_expired_business_claims_do_not_exhaust_capacity_after_restart(self):
        path = pathlib.Path(self.temp_dir.name) / "business-receipts.json"
        callback = f"ma:retry:{JOB_ID}"
        store = self.plugin.BusinessActionReceiptStore(
            path, now=lambda: 100.0, owner="old-process"
        )
        for message_id in range(500):
            self.assertEqual(store.claim(callback, str(message_id)), "ready")

        recovered = self.plugin.BusinessActionReceiptStore(
            path,
            now=lambda: 100.0 + self.plugin._BUSINESS_ACTION_CLAIM_TTL_SECONDS,
            owner="new-process",
        )
        self.assertEqual(recovered.claim(callback, "501"), "ready")
        stored = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(len(stored["receipts"]), 1)

    async def test_business_mutations_are_exact_once_per_callback_generation(self):
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True

        for action in ("cancel", "retry", "retry-missing", "resume-storage"):
            with self.subTest(action=action):
                first_generation = hashlib.blake2s(
                    b"1", digest_size=4
                ).hexdigest()
                next_generation = hashlib.blake2s(
                    b"2", digest_size=4
                ).hexdigest()
                first_data = f"ma:{action}:{JOB_ID}:{first_generation}"
                next_data = f"ma:{action}:{JOB_ID}:{next_generation}"
                first_update, first_query = callback_update(first_data)
                replay_update, replay_query = callback_update(first_data)
                next_update, next_query = callback_update(next_data)
                replay_query.message = first_query.message
                next_query.message = first_query.message
                ctx = mock.Mock()
                ctx.dispatch_tool.side_effect = [
                    json.dumps({
                        "structuredContent": {
                            "id": JOB_ID,
                            "state": "failed",
                            "lifecycle_cycle": 1,
                        }
                    }),
                    json.dumps({
                        "structuredContent": {
                            "id": JOB_ID,
                            "state": "failed",
                            "lifecycle_cycle": 2,
                        }
                    }),
                ]
                self.adapter._media_plugin_context = ctx
                with mock.patch.object(
                    self.plugin,
                    "_run_media",
                    mock.AsyncMock(return_value=(0, b"{}")),
                ) as run_media, mock.patch.object(
                    self.plugin,
                    "render_job_cancelling_card",
                    return_value=self.plugin.MediaPanelCard("Cancelling", ()),
                ), mock.patch.object(
                    self.plugin,
                    "render_media_panel_card",
                    return_value=self.plugin.MediaPanelCard("Current", ()),
                ):
                    await self.adapter._handle_callback_query(first_update, None)
                    await self.adapter._handle_callback_query(replay_update, None)
                    await self.adapter._handle_callback_query(next_update, None)

                self.assertEqual(run_media.await_count, 2)
                self.assertEqual(
                    [
                        call.args[0][1]["expected_lifecycle_cycle"]
                        for call in run_media.await_args_list
                    ],
                    [1, 2],
                )

    async def test_stale_business_generation_refreshes_without_mutating(self):
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        stale_generation = hashlib.blake2s(b"1:7", digest_size=4).hexdigest()
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = json.dumps({
            "structuredContent": {
                "id": JOB_ID,
                "title": "Current lifecycle",
                "provider": "rezka",
                "state": "completed",
                "lifecycle_cycle": 2,
            }
        })
        self.adapter._media_plugin_context = ctx

        for action in ("cancel", "retry", "retry-missing", "resume-storage"):
            with self.subTest(action=action):
                data = f"ma:{action}:{JOB_ID}:{stale_generation}"
                update, query = callback_update(data)
                self.adapter._business_action_receipt_store = (
                    self.plugin.BusinessActionReceiptStore(
                        pathlib.Path(self.temp_dir.name) / f"stale-{action}.json"
                    )
                )
                with mock.patch.object(
                    self.plugin, "_run_media", mock.AsyncMock()
                ) as run_media:
                    await self.adapter._handle_callback_query(update, None)

                run_media.assert_not_awaited()
                self.assertIn(
                    "Current lifecycle", query.message.edit_text.await_args.args[0]
                )
                callbacks = [
                    button.callback_data
                    for row in query.message.edit_text.await_args.kwargs[
                        "reply_markup"
                    ].inline_keyboard
                    for button in row
                ]
                self.assertIn("mp:downloads-p:1", callbacks)

    async def test_legacy_revision_hash_does_not_mutate_current_lifecycle(self):
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        legacy_generation = hashlib.blake2s(b"1:7", digest_size=4).hexdigest()
        data = f"ma:retry:{JOB_ID}:{legacy_generation}"
        update, query = callback_update(data)
        self.adapter._media_plugin_context = business_job_context(
            state="failed", lifecycle_cycle=1
        )

        with mock.patch.object(
            self.plugin, "_run_media", mock.AsyncMock()
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_not_awaited()
        self.assertIn("Загрузка из Rezka", query.message.edit_text.await_args.args[0])

    async def test_generation_check_failure_releases_claim_and_offers_retry(self):
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        generation = hashlib.blake2s(b"1", digest_size=4).hexdigest()
        data = f"ma:retry:{JOB_ID}:{generation}"
        update, query = callback_update(data)
        ctx = mock.Mock()
        ctx.dispatch_tool.side_effect = [
            OSError("media unavailable"),
            json.dumps({
                "structuredContent": {
                    "id": JOB_ID,
                    "state": "failed",
                    "lifecycle_cycle": 1,
                }
            }),
        ]
        self.adapter._media_plugin_context = ctx

        with mock.patch.object(
            self.plugin,
            "_run_media",
            mock.AsyncMock(return_value=(0, b"{}")),
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)
            run_media.assert_not_awaited()
            callbacks = [
                button.callback_data
                for row in query.message.edit_text.await_args.kwargs[
                    "reply_markup"
                ].inline_keyboard
                for button in row
            ]
            self.assertEqual(callbacks, [data, f"hm:b:{JOB_ID}"])

            await self.adapter._handle_callback_query(update, None)

        run_media.assert_awaited_once()

    async def test_unversioned_business_mutation_only_refreshes_current_job(self):
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = json.dumps({
            "structuredContent": {
                "id": JOB_ID,
                "provider": "rezka",
                "result_ref": "rezka:job:1",
                "state": "failed",
                "lifecycle_cycle": 3,
                "notify_scope": "initiator",
            }
        })
        self.adapter._media_plugin_context = ctx

        for action in ("cancel", "retry", "retry-missing", "resume-storage"):
            with self.subTest(action=action):
                update, query = callback_update(f"ma:{action}:{JOB_ID}")
                self.adapter._business_action_receipt_store = (
                    self.plugin.BusinessActionReceiptStore(
                        pathlib.Path(self.temp_dir.name) / f"legacy-{action}.json"
                    )
                )
                with mock.patch.object(
                    self.plugin, "_run_media", mock.AsyncMock()
                ) as run_media:
                    await self.adapter._handle_callback_query(update, None)

                run_media.assert_not_awaited()
                self.assertIn(
                    "Загрузка из Rezka", query.message.edit_text.await_args.args[0]
                )

    def test_business_callback_parser_accepts_versioned_and_legacy_payloads(self):
        legacy = f"ma:retry:{JOB_ID}"
        versioned = f"ma:resume-storage:{JOB_ID}:deadbeef"

        self.assertIsNotNone(self.plugin._CALLBACK_RE.fullmatch(legacy))
        self.assertIsNotNone(self.plugin._CALLBACK_RE.fullmatch(versioned))
        self.assertLess(len(versioned.encode("utf-8")), 64)

    def test_business_receipt_store_accepts_exactly_64_callback_bytes(self):
        path = pathlib.Path(self.temp_dir.name) / "business-64.json"
        store = self.plugin.BusinessActionReceiptStore(path)
        callback = "x" * 64

        self.assertEqual(store.claim(callback, 77), "ready")
        store.consume(callback, 77)
        self.assertEqual(store.claim(callback, 77), "consumed")

    async def test_answer_claimed_callback_releases_arbitrary_failures(self):
        for error in (RuntimeError("boom"), OSError("disk")):
            with self.subTest(error=type(error).__name__):
                query = mock.Mock()
                query.answer = mock.AsyncMock(side_effect=error)
                release = mock.Mock()

                with self.assertRaises(type(error)):
                    await self.plugin._answer_claimed_callback(query, release)

                release.assert_called_once_with()

    async def test_malformed_alternative_search_can_be_retried(self):
        update, query = callback_update(f"ma:search-alternative:{JOB_ID}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        valid = json.dumps(
            {
                "source": "prowlarr",
                "results": [{"title": "Release", "seeders": 5}],
            }
        ).encode()

        with mock.patch.object(
            self.plugin,
            "_run_media",
            mock.AsyncMock(side_effect=[(0, b"{}"), (0, valid)]),
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        self.assertEqual(run_media.await_count, 2)
        query.message.reply_text.assert_not_awaited()
        self.assertIn(
            "Другой источник: Prowlarr",
            query.message.edit_text.await_args_list[-1].args[0],
        )

    async def test_owner_can_search_the_other_provider_without_model_or_raw_ids(self):
        update, query = callback_update(f"ma:search-alternative:{JOB_ID}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        output = json.dumps(
            {
                "api_version": "v1",
                "session_id": "00000000-0000-0000-0000-000000000111",
                "source": "prowlarr",
                "expires_at": "2026-07-23T12:00:00Z",
                "continuation": "00000000-0000-0000-0000-000000000111:5",
                "results": [
                    {
                        "source": "prowlarr",
                        "result_id": f"result-{index}",
                        "title": f"Release {index}",
                        "size_bytes": 1_073_741_824,
                        "seeders": 10 - index,
                    }
                    for index in range(1, 7)
                ],
            }
        ).encode()
        with mock.patch.object(
            self.plugin, "_run_media", mock.AsyncMock(return_value=(0, output))
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_awaited_once_with(
            (
                "mcp__media_admin__media_job_alternatives",
                {"job_id": JOB_ID},
            ),
            mock.ANY,
        )
        query.message.reply_text.assert_not_awaited()
        rendered = query.message.edit_text.await_args.args[0]
        self.assertIn("Другой источник: Prowlarr", rendered)
        self.assertIn("1. Release 1", rendered)
        self.assertIn("5. Release 5", rendered)
        self.assertNotIn("Release 6", rendered)
        self.assertIn("показать ещё", rendered)
        self.assertNotRegex(
            rendered,
            r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}",
        )

    async def test_source_choice_rezka_callback_searches_tracked_episode_without_model(self):
        update, query = callback_update(f"ms:r:{TRACKING_ID}:3:5")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        tracking = json.dumps(
            {
                "tracking": [
                    {
                        "id": TRACKING_ID,
                        "title": "Реинкарнация безработного",
                        "release_identity": {
                            "source": "tvmaze",
                            "source_id": 81228,
                        },
                        "state": "choice_needed",
                    }
                ]
            }
        ).encode()
        release = json.dumps(
            {
                "status": "matched",
                "source": "tvmaze",
                "show": {
                    "source_id": 81228,
                    "title": "Mushoku Tensei",
                    "original_title": None,
                    "year": 2026,
                    "lifecycle": "ongoing",
                },
            }
        ).encode()
        search = json.dumps(
            {
                "api_version": "v1",
                "session_id": "00000000-0000-0000-0000-000000000111",
                "source": "rezka",
                "expires_at": "2099-07-27T12:00:00Z",
                "results": [
                    {
                        "source": "rezka",
                        "result_id": "rezka:wrong",
                        "title": "Mushoku Tensei: Documentary",
                        "original_title": "Mushoku Tensei!",
                        "year": 2022,
                        "translations": [{"id": 2, "name": "Wrong Dub"}],
                    },
                    {
                        "source": "rezka",
                        "result_id": "rezka:1",
                        "title": "Реинкарнация безработного",
                        "original_title": "Mushoku Tensei",
                        "year": 2026,
                        "translations": [{"id": 1, "name": "AniLibria"}],
                    }
                ],
            }
        ).encode()
        run_media = mock.AsyncMock(
            side_effect=[(0, tracking), (0, release), (0, search)]
        )

        with mock.patch.object(
            self.plugin, "_run_media", run_media
        ):
            await self.adapter._handle_callback_query(update, None)

        self.assertEqual(run_media.await_count, 3)
        release_call = run_media.await_args_list[1]
        self.assertEqual(
            release_call.args[0],
            (
                "mcp__media_admin__media_release_schedule",
                {
                    "title": "Реинкарнация безработного",
                    "source_id": 81228,
                },
            ),
        )
        search_call = run_media.await_args_list[2]
        self.assertEqual(
            search_call.args[0],
            (
                "mcp__media_admin__media_search",
                {
                    "source": "rezka",
                    "query": "Реинкарнация безработного",
                    "media_kind": "series",
                    "season": 3,
                },
            ),
        )
        rendered = query.message.edit_text.await_args.args[0]
        self.assertIn("🆕 S03E05", rendered)
        self.assertIn("📺 Реинкарнация безработного", rendered)
        self.assertIn("🌐 Rezka", rendered)
        self.assertNotIn("вариант 1", rendered)
        self.assertIn("🎙 AniLibria", rendered)
        self.assertNotIn("Wrong Dub", rendered)
        markup = query.message.edit_text.await_args.kwargs["reply_markup"]
        labels = [button.text for row in markup.inline_keyboard for button in row]
        self.assertEqual(
            labels,
            [
                "⬅️", "1/2", "➡️",
                "⬅️", "🎙 1/1", "➡️",
                "⬇️ Скачать", "⬅️ Назад",
            ],
        )
        self.assertTrue(markup.inline_keyboard[1][0].callback_data.startswith("md:"))
        self.assertTrue(markup.inline_keyboard[2][0].callback_data.startswith("md:"))

    async def test_source_choice_all_callback_keeps_results_when_one_provider_fails(self):
        update, query = callback_update(f"ms:a:{TRACKING_ID}:3:5")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        tracking = json.dumps(
            {
                "tracking": [
                    {
                        "id": TRACKING_ID,
                        "title": "Реинкарнация безработного",
                        "state": "choice_needed",
                    }
                ]
            }
        ).encode()
        rezka = json.dumps(
            {
                "api_version": "v1",
                "session_id": "00000000-0000-0000-0000-000000000111",
                "source": "rezka",
                "expires_at": "2099-07-27T12:00:00Z",
                "results": [
                    {
                        "source": "rezka",
                        "result_id": "rezka:1",
                        "title": "Реинкарнация безработного",
                        "translations": [{"id": 1, "name": "AniLibria"}],
                    }
                ],
            }
        ).encode()
        run_media = mock.AsyncMock(
            side_effect=[
                (0, tracking),
                (0, rezka),
                (1, b"{}"),
            ]
        )

        with mock.patch.object(
            self.plugin, "_run_media", run_media
        ):
            await self.adapter._handle_callback_query(update, None)

        rendered = query.message.edit_text.await_args.args[0]
        self.assertIn("Варианты · S03E05", rendered)
        self.assertIn("Rezka", rendered)
        self.assertNotIn("🌐", rendered)
        self.assertIn("Prowlarr временно недоступен", rendered)
        query.message.reply_text.assert_not_awaited()
        self.assertEqual(run_media.await_count, 3)

    async def test_rezka_translation_card_can_return_to_combined_results(self):
        update, query = callback_update(f"ms:b:{TRACKING_ID}:3:5")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        tracking = json.dumps(
            {
                "tracking": [
                    {"id": TRACKING_ID, "title": "Реинкарнация безработного"}
                ]
            }
        ).encode()
        run_media = mock.AsyncMock(return_value=(0, tracking))

        with mock.patch.object(
            self.plugin, "_run_media", run_media
        ):
            await self.adapter._handle_callback_query(update, None)

        self.assertEqual(run_media.await_count, 1)
        reply = query.message.edit_caption.await_args
        self.assertIn("📺 Реинкарнация безработного", reply.kwargs["caption"])
        self.assertIn("Реинкарнация безработного", reply.kwargs["caption"])
        self.assertIn("🆕 S03E05", reply.kwargs["caption"])
        self.assertIn("Выберите источник", reply.kwargs["caption"])
        markup = reply.kwargs["reply_markup"]
        self.assertEqual(
            [button.text for button in markup.inline_keyboard[0]],
            ["🌐 Rezka", "🧲 Prowlarr"],
        )
        self.assertEqual(
            [button.callback_data for button in markup.inline_keyboard[0]],
            [f"ms:r:{TRACKING_ID}:3:5", f"ms:p:{TRACKING_ID}:3:5"],
        )
        self.assertEqual(
            [button.text for button in markup.inline_keyboard[1]],
            ["⬅️ Назад"],
        )

    async def test_source_back_finds_tracking_from_a_later_cursor_page(self):
        update, query = callback_update(f"ms:b:{TRACKING_ID}:3:5")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        first_page = json.dumps(
            {
                "tracking": [
                    {"id": f"old-{index}", "title": f"Old {index}"}
                    for index in range(50)
                ],
                "next_cursor": "v1:50",
            }
        ).encode()
        second_page = json.dumps(
            {"tracking": [{"id": TRACKING_ID, "title": "Target series"}]}
        ).encode()
        run_media = mock.AsyncMock(side_effect=[(0, first_page), (0, second_page)])

        with mock.patch.object(self.plugin, "_run_media", run_media):
            await self.adapter._handle_callback_query(update, None)

        self.assertEqual(run_media.await_count, 2)
        self.assertNotIn("cursor", run_media.await_args_list[0].args[0][1])
        self.assertEqual(run_media.await_args_list[1].args[0][1]["cursor"], "v1:50")
        self.assertIn("Target series", query.message.edit_caption.await_args.kwargs["caption"])

    def test_rezka_search_renders_one_translation_carousel_and_episode_range(self):
        output = json.dumps(
            {
                "api_version": "v1",
                "session_id": "00000000-0000-0000-0000-000000000111",
                "source": "rezka",
                "expires_at": "2099-07-27T12:00:00Z",
                "continuation": "next-page",
                "results": [
                    {
                        "source": "rezka",
                        "result_id": "rezka:90825",
                        "title": "Реинкарнация безработного [ТВ-3]",
                        "year": 2026,
                        "media_kind": "series",
                        "availability": {
                            "seasons": [{"season": 3, "episodes": [1, 2, 3, 4, 5]}]
                        },
                        "translations": [
                            {
                                "id": 224,
                                "name": "AniStar",
                                "seasons": [{"season": 3, "episodes": [1, 2, 3, 4, 5]}],
                            },
                            {
                                "id": 618,
                                "name": "лостфильм (LostFilm)",
                                "seasons": [{"season": 3, "episodes": [1, 2]}],
                            },
                            {
                                "id": 238,
                                "name": "колдфильм (Coldfilm)",
                                "seasons": [{"season": 3, "episodes": [1, 2, 3]}],
                            },
                        ],
                    }
                ],
            }
        ).encode()

        rendered = self.plugin._render_source_search(output, "rezka", 3, 0)

        self.assertIsNotNone(rendered)
        self.assertIn(
            "📺 Общий диапазон 1–5 · доступность зависит от озвучки",
            rendered.text,
        )
        self.assertIn("📅 2026", rendered.text)
        self.assertIn("🎙 AniStar", rendered.text)
        self.assertIn("📺 5 серий", rendered.text)
        self.assertNotIn("LostFilm", rendered.text)
        self.assertNotIn("Coldfilm", rendered.text)
        self.assertNotIn("лостфильм (LostFilm)", rendered.text)
        self.assertNotIn("колдфильм (Coldfilm)", rendered.text)
        self.assertNotIn("Напиши номер", rendered.text)
        self.assertEqual(
            [action.label for action in rendered.actions],
            [
                "⬅️",
                "1/1+",
                "➡️",
                "⬅️",
                "🎙 1/3",
                "➡️",
                "⬇️ Скачать",
                "⬅️ Назад",
            ],
        )
        self.assertEqual(rendered.actions[2].kind, "continue")
        self.assertEqual(rendered.actions[6].payload["result_id"], "rezka:90825")
        self.assertEqual(rendered.actions[6].payload["translation"], "AniStar")
        self.assertEqual(rendered.actions[6].payload["translation_id"], 224)
        self.assertEqual(rendered.actions[6].payload["available_episode_count"], 5)
        translation_markup = self.plugin._action_markup(
            self.adapter._media_action_store,
            rendered.actions,
        )
        self.assertEqual(
            [[button.text for button in row] for row in translation_markup.inline_keyboard],
            [
                ["⬅️", "1/1+", "➡️"],
                ["⬅️", "🎙 1/3", "➡️"],
                ["⬇️ Скачать"],
                ["⬅️ Назад"],
            ],
        )

        second_payload = {
            **rendered.actions[5].payload,
            "translation_index": 2,
        }
        second = self.plugin._render_release_details(
            second_payload,
            search_page=second_payload["search_page"],
        )
        self.assertIn("🎙 LostFilm", second.text)
        self.assertIn("📺 2 серии", second.text)
        self.assertNotIn("AniStar", second.text)
        self.assertEqual(second.actions[4].label, "🎙 2/3")
        self.assertEqual(second.actions[6].payload["translation_id"], 618)

        exact_episode = self.plugin._render_source_search(output, "rezka", 3, 5)
        self.assertIn("🎙 AniStar", exact_episode.text)
        self.assertNotIn("LostFilm", exact_episode.text)
        self.assertNotIn("Coldfilm", exact_episode.text)
        self.assertEqual(exact_episode.actions[4].label, "🎙 1/1")
        self.assertEqual(exact_episode.actions[6].label, "⬇️ Скачать")

    def test_whole_season_hides_known_wrong_season_but_keeps_legacy_translation(self):
        output = json.dumps(
            {
                "api_version": "v1",
                "session_id": "session",
                "source": "rezka",
                "expires_at": "2099-07-27T12:00:00Z",
                "results": [
                    {
                        "source": "rezka",
                        "result_id": "rezka:show",
                        "title": "Show",
                        "media_kind": "series",
                        "availability": {
                            "seasons": [{"season": 1, "episodes": [1, 2]}]
                        },
                        "translations": [
                            {
                                "id": 1,
                                "name": "Season Two Only",
                                "seasons": [{"season": 2, "episodes": [1, 2]}],
                            },
                            {"id": 2, "name": "Legacy Dub"},
                            {
                                "id": 3,
                                "name": "Season One Dub",
                                "seasons": [{"season": 1, "episodes": [1, 2]}],
                            },
                        ],
                    }
                ],
            }
        ).encode()

        rendered = self.plugin._render_source_search(output, "rezka", 1, 0)

        self.assertNotIn("Season Two Only", rendered.text)
        self.assertIn("🎙 Legacy Dub", rendered.text)
        self.assertNotIn("Season One Dub", rendered.text)
        self.assertEqual(rendered.actions[1].label, "🎙 1/2")
        self.assertEqual(
            [action.label for action in rendered.actions if action.kind == "download"],
            ["⬇️ Скачать"],
        )
        second_payload = rendered.actions[2].payload
        second = self.plugin._render_release_details(
            second_payload,
            search_page=second_payload["search_page"],
        )
        self.assertIn("🎙 Season One Dub", second.text)
        self.assertIn("📺 2 серии", second.text)

    def test_prowlarr_search_renders_release_details_and_actions(self):
        output = json.dumps(
            {
                "api_version": "v1",
                "session_id": "00000000-0000-0000-0000-000000000222",
                "source": "prowlarr",
                "expires_at": "2099-07-27T12:00:00Z",
                "results": [
                    {
                        "source": "prowlarr",
                        "result_id": "prowlarr:1:2",
                        "title": "Show.S03E05.1080p.WEB-DL.HEVC",
                        "thumbnail_url": "https://image.tmdb.org/t/p/w780/show.jpg",
                        "website_url": "https://tracker.example/topic/42",
                        "indexer": "Example",
                        "size_bytes": 1_073_741_824,
                        "seeders": 42,
                        "leechers": 3,
                        "age_days": 2,
                        "release_group": "GROUP",
                        "ranking": {"exact_title": True, "exact_season": True},
                    }
                ],
            }
        ).encode()

        source_back = self.plugin.SearchAction(
            label="⬅️ Назад",
            kind="navigation-back",
            payload={},
            expires_at="2099-07-27T12:00:00Z",
        )
        rendered = self.plugin._render_source_search(
            output, "prowlarr", 3, 5, source_back
        )

        self.assertIsNotNone(rendered)
        self.assertTrue(rendered.text.startswith("📺 Show.S03E05.1080p.WEB-DL.HEVC\n🧲 Prowlarr"))
        self.assertNotIn("🔎 Prowlarr", rendered.text)
        self.assertIn("📺 Show.S03E05.1080p.WEB-DL.HEVC", rendered.text)
        self.assertNotIn("вариант 1", rendered.text)
        self.assertIn("1.0 ГиБ", rendered.text)
        self.assertIn("42 сидов", rendered.text)
        self.assertIn("Example", rendered.text)
        self.assertIn("GROUP", rendered.text)
        self.assertIn("⭐ Лучшее совпадение", rendered.text)
        self.assertIn("💎 1080p", rendered.text)
        self.assertIn("🎞 WEB-DL", rendered.text)
        self.assertIn("⚙️ HEVC", rendered.text)
        self.assertIn("🧲 3 личей", rendered.text)
        self.assertIn("📅 2 дня назад", rendered.text)
        self.assertEqual(
            [action.label for action in rendered.actions],
            ["🌐 Сайт", "⬇️ Скачать", "⬅️ Назад"],
        )
        self.assertEqual(rendered.parts[0].photo_url, "https://image.tmdb.org/t/p/w780/show.jpg")
        release_back = next(
            action for action in rendered.actions if action.kind == "release-back"
        )
        self.assertEqual(
            release_back.payload["source_back"]["kind"],
            "navigation-back",
        )

        release_list = self.plugin._render_source_search(
            output, "prowlarr", 3, 5, source_back, carousel=False
        )
        self.assertIn("1. Show.S03E05.1080p.WEB-DL.HEVC", release_list.text)
        self.assertEqual(
            [action.label for action in release_list.actions],
            ["🔎 1", "⬅️ Назад"],
        )

    def test_ten_long_prowlarr_results_fit_one_photo_caption(self):
        output = json.dumps(
            {
                "api_version": "v1",
                "session_id": "session",
                "source": "prowlarr",
                "expires_at": "2099-07-27T12:00:00Z",
                "results": [
                    {
                        "source": "prowlarr",
                        "result_id": f"prowlarr:{index}",
                        "title": "Very.Long.Release.Name." + ("X" * 140),
                        "size_bytes": 1_073_741_824,
                        "seeders": index,
                    }
                    for index in range(10)
                ],
            }
        ).encode()

        rendered = self.plugin._render_source_search(
            output, "prowlarr", 3, 5, carousel=False
        )

        self.assertEqual(len(rendered.parts), 1)
        self.assertEqual(len(rendered.actions), 10)
        self.assertLessEqual(len(rendered.parts[0].text), 1000)

    def test_prowlarr_carousel_continues_with_the_right_arrow(self):
        output = json.dumps(
            {
                "api_version": "v1",
                "session_id": "session",
                "source": "prowlarr",
                "expires_at": "2099-07-27T12:00:00Z",
                "continuation": "page-two",
                "results": [
                    {
                        "source": "prowlarr",
                        "result_id": "prowlarr:1",
                        "title": "Show S01 1080p WEB-DL RUS",
                        "seeders": 10,
                    }
                ],
            }
        ).encode()

        rendered = self.plugin._render_source_search(output, "prowlarr", 1, 0)

        self.assertEqual(
            [action.label for action in rendered.actions[:3]],
            ["⬅️", "1/1+", "➡️"],
        )
        self.assertEqual(rendered.actions[2].kind, "continue")
        self.assertEqual(
            rendered.actions[2].payload["carousel_page"]["results"][0]["result_id"],
            "prowlarr:1",
        )

    def test_large_translation_list_uses_a_bounded_carousel(self):
        translations = [
            {"id": index, "name": f"Озвучка {index} " + ("X" * 80)}
            for index in range(1, 102)
        ]
        output = json.dumps(
            {
                "api_version": "v1",
                "session_id": "session",
                "source": "rezka",
                "expires_at": "2099-07-27T12:00:00Z",
                "results": [
                    {
                        "source": "rezka",
                        "result_id": "rezka:large",
                        "title": "Большой список",
                        "translations": translations,
                    }
                ],
            }
        ).encode()

        rendered = self.plugin._render_source_search(output, "rezka", 1, 1)

        self.assertEqual(len(rendered.actions), 5)
        self.assertEqual(len(rendered.parts), 1)
        self.assertTrue(
            all(len(part.text) <= 3800 for part in rendered.parts)
        )
        self.assertTrue(
            all(len(part.actions) <= 20 for part in rendered.parts)
        )
        self.assertIn("Озвучка 1", rendered.text)
        self.assertNotIn("Озвучка 2", rendered.text)
        self.assertEqual(
            [action.label for action in rendered.actions[-5:]],
            ["⬅️", "🎙 1/101", "➡️", "⬇️ Скачать", "⬅️ Назад"],
        )
        markup = self.plugin._action_markup(
            self.adapter._media_action_store, rendered.actions
        )
        self.assertEqual(
            [[button.text for button in row] for row in markup.inline_keyboard[-3:]],
            [["⬅️", "🎙 1/101", "➡️"], ["⬇️ Скачать"], ["⬅️ Назад"]],
        )

    async def test_search_carousel_noop_is_reusable_and_side_effect_free(self):
        update, query = callback_update("unused")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        action = self.plugin.SearchAction(
            label="1/1",
            kind="noop",
            payload={},
            expires_at="2099-07-27T12:00:00Z",
        )
        token = self.adapter._media_action_store.create(action)
        query.data = f"md:{token}"

        with mock.patch.object(
            self.plugin,
            "_run_media",
            mock.AsyncMock(),
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        self.assertEqual(query.answer.await_count, 2)
        self.assertTrue(all(call.args == () and call.kwargs == {} for call in query.answer.await_args_list))
        query.message.edit_media.assert_not_awaited()
        query.message.edit_caption.assert_not_awaited()
        query.message.edit_text.assert_not_awaited()
        query.message.reply_photo.assert_not_awaited()
        query.message.reply_text.assert_not_awaited()
        run_media.assert_not_awaited()
        self.assertEqual(self.adapter._media_action_store.resolve(token), (action, False))

    async def test_download_action_creates_exact_job_once(self):
        update, query = callback_update("unused")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        token = self.adapter._media_action_store.create(
            self.plugin.SearchAction(
                label="1 · AniStar",
                kind="download",
                payload={
                    "source": "rezka",
                    "session_id": "00000000-0000-0000-0000-000000000111",
                    "result_id": "rezka:90825",
                    "translation_id": 224,
                    "season": 3,
                    "episode": 5,
                    "title": "Реинкарнация безработного [ТВ-3]",
                    "translation": "AniStar",
                },
                expires_at="2099-07-27T12:00:00Z",
            )
        )
        query.data = f"md:{token}"
        output = json.dumps({"id": JOB_ID, "state": "queued"}).encode()

        ctx = mock.Mock()
        ctx.dispatch_tool.side_effect = [
            json.dumps({"structuredContent": {"id": JOB_ID, "provider": "rezka", "state": "queued"}}),
            json.dumps({"structuredContent": {"jobs": [{"id": JOB_ID, "state": "queued"}]}}),
        ]
        self.adapter._media_plugin_context = ctx
        with mock.patch.object(
            self.plugin,
            "_run_media",
            mock.AsyncMock(return_value=(0, output)),
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_awaited_once_with(
            (
                "mcp__media_admin__media_download",
                {
                    "session_id": "00000000-0000-0000-0000-000000000111",
                    "result_id": "rezka:90825",
                    "translation_id": 224,
                    "season": 3,
                    "episode": 5,
                },
            ),
            mock.ANY,
        )
        self.assertEqual(query.message.reply_text.await_count, 0)
        self.assertEqual(query.answer.await_count, 2)
        self.assertEqual(
            query.answer.await_args_list,
            [mock.call(text="Добавляю…"), mock.call()],
        )
        result = query.message.edit_text.await_args.args[0]
        self.assertIn("Состояние", result)
        self.assertIn("Rezka", result)
        self.assertNotIn(JOB_ID, result)
        self.assertNotIn("Загрузка добавлена", result)

    async def test_download_ack_failure_releases_claim_for_one_retry(self):
        update, query = callback_update("unused")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        action = self.plugin.SearchAction(
            label="Скачать",
            kind="download",
            payload={
                "source": "prowlarr",
                "session_id": "00000000-0000-0000-0000-000000000111",
                "result_id": "prowlarr:release",
                "season": 0,
                "episode": 0,
                "title": "Movie",
            },
            expires_at="2099-07-27T12:00:00Z",
        )
        token = self.adapter._media_action_store.create(action)
        query.data = f"md:{token}"
        query.answer.side_effect = [self.plugin.BadRequest("Query is too old"), None]
        output = json.dumps({"id": JOB_ID, "state": "queued"}).encode()
        self.adapter._media_plugin_context = mock.Mock()
        self.adapter._media_plugin_context.dispatch_tool.return_value = json.dumps(
            {"structuredContent": {"id": JOB_ID, "provider": "prowlarr", "state": "queued"}}
        )

        with mock.patch.object(
            self.plugin, "_run_media", mock.AsyncMock(return_value=(0, output))
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_awaited_once()

    async def test_provider_and_release_ack_failures_release_claim_for_retry(self):
        rendered = self.plugin.RenderedSearch(
            "Карточка",
            (),
            (self.plugin.RenderedSearchPart("Карточка", ()),),
        )
        actions = (
            self.plugin.SearchAction(
                "Rezka",
                "provider-open",
                {
                    "source": "rezka",
                    "search_page": {"source": "rezka", "results": []},
                    "season": 0,
                    "episode": 0,
                },
                "2099-12-31T23:59:59Z",
            ),
            self.plugin.SearchAction(
                "Релиз",
                "release-details",
                {"search_page": {"source": "rezka", "results": []}},
                "2099-12-31T23:59:59Z",
            ),
            self.plugin.SearchAction(
                "Назад",
                "release-back",
                {
                    "search_page": {"source": "rezka", "results": []},
                    "season": 0,
                    "episode": 0,
                },
                "2099-12-31T23:59:59Z",
            ),
            self.plugin.SearchAction(
                "Загрузка",
                "job-open",
                {
                    "job_id": JOB_ID,
                    "source_back": {
                        "label": "Назад",
                        "kind": "release-page",
                        "payload": {"search_page": {}},
                        "expires_at": "2099-12-31T23:59:59Z",
                    },
                },
                "2099-12-31T23:59:59Z",
            ),
        )
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True

        for action in actions:
            with self.subTest(kind=action.kind):
                token = self.adapter._media_action_store.create(action)
                update, query = callback_update(f"md:{token}")
                query.answer.side_effect = [
                    self.plugin.BadRequest("Query is too old"),
                    None,
                ]
                with (
                    mock.patch.object(
                        self.plugin, "_render_source_search", return_value=rendered
                    ),
                    mock.patch.object(
                        self.plugin, "_render_release_details", return_value=rendered
                    ),
                    mock.patch.object(
                        self.plugin,
                        "render_media_panel_card",
                        return_value=self.plugin.MediaPanelCard(
                            "Загрузка",
                            ((self.plugin.MediaPanelButton("⬅️ Назад", "mp:downloads"),),),
                        ),
                    ),
                ):
                    await self.adapter._handle_callback_query(update, None)
                    self.assertEqual(
                        self.adapter._media_action_store.resolve(token),
                        (action, False),
                    )
                    await self.adapter._handle_callback_query(update, None)

                self.assertEqual(query.answer.await_count, 2)

    async def test_media_read_exception_releases_but_mutation_stays_consumed(self):
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        rendered = self.plugin.RenderedSearch(
            "Карточка", (), (self.plugin.RenderedSearchPart("Карточка", ()),)
        )
        read_action = self.plugin.SearchAction(
            "Rezka",
            "provider-open",
            {
                "source": "rezka",
                "search_page": {"source": "rezka", "results": []},
                "season": 0,
                "episode": 0,
            },
            "2099-12-31T23:59:59Z",
        )
        read_token = self.adapter._media_action_store.create(read_action)
        read_update, _read_query = callback_update(f"md:{read_token}")
        with (
            mock.patch.object(
                self.plugin, "_render_source_search", return_value=rendered
            ),
            mock.patch.object(
                self.adapter,
                "_present_claimed_search",
                mock.AsyncMock(side_effect=[RuntimeError("edit failed"), None]),
            ) as present,
        ):
            with self.assertRaises(RuntimeError):
                await self.adapter._handle_callback_query(read_update, None)
            await self.adapter._handle_callback_query(read_update, None)
        self.assertEqual(present.await_count, 2)

        mutation = self.plugin.SearchAction(
            "Скачать",
            "download",
            {
                "source": "prowlarr",
                "session_id": "session",
                "result_id": "prowlarr:release",
                "season": 0,
                "episode": 0,
            },
            "2099-12-31T23:59:59Z",
        )
        mutation_token = self.adapter._media_action_store.create(mutation)
        mutation_update, _mutation_query = callback_update(f"md:{mutation_token}")
        self.adapter._media_plugin_context = mock.Mock()
        with mock.patch.object(
            self.plugin,
            "_run_media",
            mock.AsyncMock(side_effect=RuntimeError("dispatch ambiguous")),
        ) as run_media:
            with self.assertRaises(RuntimeError):
                await self.adapter._handle_callback_query(mutation_update, None)
            await self.adapter._handle_callback_query(mutation_update, None)
        run_media.assert_awaited_once()

    async def test_job_open_acks_before_render_and_consumes_only_after_edit(self):
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        action = self.plugin.SearchAction(
            "Загрузка",
            "job-open",
            {
                "job_id": JOB_ID,
                "source_back": {
                    "kind": "release-page",
                    "payload": {"search_page": {}},
                    "expires_at": "2099-12-31T23:59:59Z",
                },
            },
            "2099-12-31T23:59:59Z",
        )
        token = self.adapter._media_action_store.create(action)
        update, query = callback_update(f"md:{token}")
        events = []

        async def answer(**_kwargs):
            events.append("ack")

        def render(*_args, **_kwargs):
            events.append("render")
            return self.plugin.MediaPanelCard(
                "Загрузка",
                ((self.plugin.MediaPanelButton("⬅️ Назад", "mp:downloads"),),),
            )

        async def edit(*_args, **_kwargs):
            events.append("edit")
            if events.count("edit") == 1:
                raise self.plugin.TelegramError("edit failed")

        query.answer.side_effect = answer
        query.message.edit_text.side_effect = edit
        with mock.patch.object(self.plugin, "render_media_panel_card", side_effect=render):
            await self.adapter._handle_callback_query(update, None)
            self.assertEqual(self.adapter._media_action_store.resolve(token), (action, False))
            await self.adapter._handle_callback_query(update, None)

        self.assertEqual(events[:3], ["ack", "render", "edit"])
        self.assertEqual(events[3:], ["ack", "render", "edit"])
        self.assertEqual(self.adapter._media_action_store.resolve(token), (action, True))

    async def test_concurrent_job_open_edits_once(self):
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        action = self.plugin.SearchAction(
            "Загрузка",
            "job-open",
            {
                "job_id": JOB_ID,
                "source_back": {
                    "kind": "release-page",
                    "payload": {"search_page": {}},
                    "expires_at": "2099-12-31T23:59:59Z",
                },
            },
            "2099-12-31T23:59:59Z",
        )
        token = self.adapter._media_action_store.create(action)
        first_update, first_query = callback_update(f"md:{token}")
        second_update, second_query = callback_update(f"md:{token}")
        second_query.message = first_query.message
        edit_started = asyncio.Event()
        release_edit = asyncio.Event()

        async def edit(*_args, **_kwargs):
            edit_started.set()
            await release_edit.wait()

        first_query.message.edit_text.side_effect = edit
        card = self.plugin.MediaPanelCard(
            "Загрузка",
            ((self.plugin.MediaPanelButton("⬅️ Назад", "mp:downloads"),),),
        )
        with mock.patch.object(
            self.plugin, "render_media_panel_card", return_value=card
        ) as render:
            first = asyncio.create_task(
                self.adapter._handle_callback_query(first_update, None)
            )
            await asyncio.wait_for(edit_started.wait(), timeout=1)
            await self.adapter._handle_callback_query(second_update, None)
            release_edit.set()
            await first

        render.assert_called_once()
        first_query.message.edit_text.assert_awaited_once()

    async def test_download_rc127_without_context_releases_claim_for_retry(self):
        update, query = callback_update("unused")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.adapter._media_plugin_context = None
        action = self.plugin.SearchAction(
            "Скачать",
            "download",
            {
                "source": "prowlarr",
                "session_id": "session",
                "result_id": "prowlarr:release",
                "season": 0,
                "episode": 0,
            },
            "2099-12-31T23:59:59Z",
        )
        token = self.adapter._media_action_store.create(action)
        query.data = f"md:{token}"

        with mock.patch.object(
            self.plugin, "_run_media", mock.AsyncMock(return_value=(127, b"{}"))
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        self.assertEqual(run_media.await_count, 2)

    async def test_successful_download_card_failure_never_replays_backend_action(self):
        update, query = callback_update("unused")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        action = self.plugin.SearchAction(
            label="Скачать",
            kind="download",
            payload={
                "source": "prowlarr",
                "session_id": "00000000-0000-0000-0000-000000000111",
                "result_id": "prowlarr:release",
                "season": 0,
                "episode": 0,
                "title": "Movie",
            },
            expires_at="2099-07-27T12:00:00Z",
        )
        token = self.adapter._media_action_store.create(action)
        query.data = f"md:{token}"
        output = json.dumps({"id": JOB_ID, "state": "queued"}).encode()

        with (
            mock.patch.object(
                self.plugin, "_run_media", mock.AsyncMock(return_value=(0, output))
            ) as run_media,
            mock.patch.object(
                self.plugin,
                "render_media_panel_card",
                side_effect=RuntimeError("card unavailable"),
            ),
        ):
            await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_awaited_once()

    def test_release_download_round_trip_preserves_exact_card_and_opens_job(self):
        search_page = {
            "api_version": "v1",
            "session_id": "session",
            "source": "rezka",
            "expires_at": "2099-07-27T12:00:00Z",
            "results": [{
                "source": "rezka",
                "result_id": "rezka:90825",
                "title": "Exact release",
                "translations": [
                    {"id": 224, "name": "AniStar"},
                    {"id": 225, "name": "LostFilm"},
                ],
            }],
        }
        payload = {
            "source": "rezka",
            "session_id": "session",
            "result_id": "rezka:90825",
            "result_index": 1,
            "result": search_page["results"][0],
            "season": 3,
            "episode": 5,
            "title": "Exact release",
            "translation_index": 2,
        }

        initial = self.plugin._render_release_details(payload, search_page=search_page)
        download = next(action for action in initial.actions if action.kind == "download")
        exact_back = self.plugin._source_back_action(download.payload["release_back"])
        exact_back.payload["downloaded_job_id"] = JOB_ID
        restored = self.plugin._render_release_details(
            exact_back.payload,
            search_page=exact_back.payload["search_page"],
        )
        opened = next(action for action in restored.actions if action.kind == "job-open")

        self.assertIn("LostFilm", restored.text)
        self.assertEqual(opened.label, "✅ В загрузках")
        self.assertEqual(opened.payload["job_id"], JOB_ID)
        self.assertEqual(
            self.plugin._source_back_action(opened.payload["source_back"]).payload[
                "translation_index"
            ],
            2,
        )

    async def test_whole_season_confirmation_uses_selected_translation_count(self):
        update, query = callback_update("unused")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        token = self.adapter._media_action_store.create(
            self.plugin.SearchAction(
                label="LostFilm · 2 серии",
                kind="download",
                payload={
                    "source": "rezka",
                    "session_id": "00000000-0000-0000-0000-000000000111",
                    "result_id": "rezka:90825",
                    "translation_id": 618,
                    "season": 1,
                    "episode": 0,
                    "title": "Звёздные войны: Видения. Девятый джедай",
                    "translation": "лостфильм (LostFilm)",
                    "available_episode_count": 2,
                },
                expires_at="2099-07-27T12:00:00Z",
            )
        )
        query.data = f"md:{token}"

        with mock.patch.object(
            self.plugin,
            "_run_media",
            mock.AsyncMock(return_value=(0, json.dumps({"id": JOB_ID}).encode())),
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_awaited_once_with(
            (
                "mcp__media_admin__media_download",
                {
                    "session_id": "00000000-0000-0000-0000-000000000111",
                    "result_id": "rezka:90825",
                    "translation_id": 618,
                    "season": 1,
                },
            ),
            mock.ANY,
        )
        query.answer.assert_awaited_once_with(text="Добавляю…")

    async def test_download_acknowledges_before_blocking_media_call(self):
        update, query = callback_update("unused")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        token = self.adapter._media_action_store.create(
            self.plugin.SearchAction(
                label="Скачать",
                kind="download",
                payload={
                    "source": "prowlarr",
                    "session_id": "session",
                    "result_id": "prowlarr:release",
                    "season": 1,
                    "episode": 0,
                    "title": "Сериал",
                },
                expires_at="2099-07-27T12:00:00Z",
            )
        )
        query.data = f"md:{token}"
        entered = asyncio.Event()
        release = asyncio.Event()

        async def blocked_media(*_args, **_kwargs):
            entered.set()
            await release.wait()
            return 0, json.dumps({"id": JOB_ID}).encode()

        with mock.patch.object(self.plugin, "_run_media", side_effect=blocked_media):
            task = asyncio.create_task(
                self.adapter._handle_callback_query(update, None)
            )
            await entered.wait()
            query.answer.assert_awaited_once_with(text="Добавляю…")
            query.message.edit_text.assert_not_awaited()
            release.set()
            await task

        query.answer.assert_awaited_once_with(text="Добавляю…")
        query.message.edit_text.assert_awaited_once()
        query.message.reply_text.assert_not_awaited()
        query.message.reply_photo.assert_not_awaited()

    async def test_download_failure_consumes_token_and_never_replays(self):
        update, query = callback_update("unused")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        token = self.adapter._media_action_store.create(
            self.plugin.SearchAction(
                label="Скачать",
                kind="download",
                payload={
                    "source": "prowlarr",
                    "session_id": "session",
                    "result_id": "prowlarr:release",
                    "season": 1,
                    "episode": 0,
                    "title": "Сериал",
                },
                expires_at="2099-07-27T12:00:00Z",
            )
        )
        query.data = f"md:{token}"

        with mock.patch.object(
            self.plugin, "_run_media", mock.AsyncMock(return_value=(1, b"{}"))
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_awaited_once()
        self.assertEqual(
            query.answer.await_args_list,
            [mock.call(text="Добавляю…"), mock.call()],
        )
        self.assertIn(
            "Не удалось подтвердить добавление загрузки",
            query.message.edit_text.await_args_list[0].args[0],
        )
        callbacks = [
            button.callback_data
            for row in query.message.edit_text.await_args_list[0].kwargs[
                "reply_markup"
            ].inline_keyboard
            for button in row
        ]
        self.assertEqual(callbacks, ["mn:b"])
        query.message.reply_text.assert_not_awaited()
        query.message.reply_photo.assert_not_awaited()

    async def test_download_missing_job_id_consumes_token_and_never_replays(self):
        update, query = callback_update("unused")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        token = self.adapter._media_action_store.create(
            self.plugin.SearchAction(
                label="Скачать",
                kind="download",
                payload={
                    "source": "prowlarr",
                    "session_id": "session",
                    "result_id": "prowlarr:release",
                    "season": 1,
                    "episode": 0,
                    "title": "Сериал",
                },
                expires_at="2099-07-27T12:00:00Z",
            )
        )
        query.data = f"md:{token}"

        with mock.patch.object(
            self.plugin, "_run_media", mock.AsyncMock(return_value=(0, b"{}"))
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_awaited_once()

    async def test_concurrent_download_clicks_create_only_one_job(self):
        first_update, first_query = callback_update("unused")
        second_update, second_query = callback_update("unused")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        token = self.adapter._media_action_store.create(
            self.plugin.SearchAction(
                label="1 · AniStar",
                kind="download",
                payload={
                    "source": "rezka",
                    "session_id": "session",
                    "result_id": "rezka:90825",
                    "translation_id": 224,
                    "season": 3,
                    "episode": 5,
                    "title": "Реинкарнация безработного [ТВ-3]",
                    "translation": "AniStar",
                },
                expires_at="2099-07-27T12:00:00Z",
            )
        )
        first_query.data = f"md:{token}"
        second_query.data = f"md:{token}"

        with mock.patch.object(
            self.plugin,
            "_run_media",
            mock.AsyncMock(return_value=(0, json.dumps({"id": JOB_ID}).encode())),
        ) as run_media:
            await asyncio.gather(
                self.adapter._handle_callback_query(first_update, None),
                self.adapter._handle_callback_query(second_update, None),
            )

        run_media.assert_awaited_once()
        self.assertCountEqual(
            [first_query.answer.await_args, second_query.answer.await_args],
            [mock.call(text="Добавляю…"), mock.call()],
        )

    def test_action_store_survives_restart_and_expires_stale_actions(self):
        path = pathlib.Path(self.temp_dir.name) / "persistent-actions.json"
        action = self.plugin.SearchAction(
            label="Скачать",
            kind="download",
            payload={"source": "rezka"},
            expires_at="2099-07-27T12:00:00Z",
        )
        token = self.plugin.MediaActionStore(path).create(action)

        restored = self.plugin.MediaActionStore(path).resolve(token)

        self.assertEqual(restored, (action, False))
        self.assertEqual(
            self.plugin.MediaActionStore(path).claim(token),
            (action, "ready"),
        )
        self.assertEqual(
            self.plugin.MediaActionStore(path).claim(token),
            (action, "claimed"),
        )
        stale = self.plugin.SearchAction(
            label="Устарело",
            kind="download",
            payload={"source": "rezka"},
            expires_at="2000-01-01T00:00:00Z",
        )
        stale_token = self.plugin.MediaActionStore(path).create(stale)
        self.assertIsNone(self.plugin.MediaActionStore(path).resolve(stale_token))

    def test_job_open_action_token_survives_restart(self):
        path = pathlib.Path(self.temp_dir.name) / "media-actions.json"
        action = self.plugin.SearchAction(
            "Открыть загрузку",
            "job-open",
            {
                "job_id": JOB_ID,
                "source_back": {
                    "label": "Назад",
                    "kind": "release-page",
                    "payload": {"search_page": {}},
                    "expires_at": "2099-12-31T23:59:59Z",
                },
            },
            "2099-12-31T23:59:59Z",
        )

        token = self.plugin.MediaActionStore(path).create(action)

        self.assertEqual(self.plugin.MediaActionStore(path).resolve(token), (action, False))

    def test_action_store_reclaims_expired_claim_after_restart(self):
        path = pathlib.Path(self.temp_dir.name) / "persistent-actions.json"
        action = self.plugin.SearchAction(
            label="Скачать",
            kind="download",
            payload={"source": "rezka"},
            expires_at="2099-07-27T12:00:00Z",
        )
        lease = self.plugin._MEDIA_ACTION_CLAIM_TTL_SECONDS
        first = self.plugin.MediaActionStore(
            path, now=lambda: 100.0, owner="old-process"
        )
        token = first.create(action)
        self.assertEqual(first.claim(token), (action, "ready"))

        live = self.plugin.MediaActionStore(
            path, now=lambda: 100.0 + lease - 1, owner="new-process"
        )
        self.assertEqual(live.claim(token), (action, "claimed"))
        recovered = self.plugin.MediaActionStore(
            path, now=lambda: 100.0 + lease, owner="new-process"
        )
        self.assertEqual(recovered.claim(token), (action, "ready"))

    def test_live_action_claim_is_not_reclaimed_after_lease(self):
        path = pathlib.Path(self.temp_dir.name) / "persistent-actions.json"
        action = self.plugin.SearchAction(
            label="Скачать",
            kind="download",
            payload={"source": "rezka"},
            expires_at="2099-07-27T12:00:00Z",
        )
        current = [100.0]
        store = self.plugin.MediaActionStore(path, now=lambda: current[0])
        token = store.create(action)
        self.assertEqual(store.claim(token), (action, "ready"))

        current[0] += self.plugin._MEDIA_ACTION_CLAIM_TTL_SECONDS
        same_process = self.plugin.MediaActionStore(path, now=lambda: current[0])
        self.assertEqual(same_process.claim(token), (action, "claimed"))

    async def test_action_execution_lock_fences_expired_foreign_owner(self):
        path = pathlib.Path(self.temp_dir.name) / "persistent-actions.json"
        action = self.plugin.SearchAction(
            label="Скачать",
            kind="download",
            payload={"source": "rezka"},
            expires_at="2099-07-27T12:00:00Z",
        )
        current = [100.0]
        old = self.plugin.MediaActionStore(
            path, now=lambda: current[0], owner="old-process"
        )
        token = old.create(action)
        self.assertEqual(old.claim(token), (action, "ready"))
        entered = asyncio.Event()
        finish = asyncio.Event()
        side_effects = []

        async def old_worker():
            async with old.execution(token) as owns_claim:
                self.assertTrue(owns_claim)
                side_effects.append("old")
                entered.set()
                await asyncio.wait_for(finish.wait(), 2)
                old.consume(token)

        worker = asyncio.create_task(old_worker())
        await asyncio.wait_for(entered.wait(), 2)
        current[0] += self.plugin._MEDIA_ACTION_CLAIM_TTL_SECONDS
        new = self.plugin.MediaActionStore(
            path, now=lambda: current[0], owner="new-process"
        )
        self.assertEqual(new.claim(token), (action, "claimed"))
        finish.set()
        await asyncio.wait_for(worker, 2)
        self.assertEqual(side_effects, ["old"])

    def test_action_store_bound_never_evicts_live_claim(self):
        path = pathlib.Path(self.temp_dir.name) / "persistent-actions.json"
        action = self.plugin.SearchAction(
            label="Скачать",
            kind="download",
            payload={"source": "rezka"},
            expires_at="2099-07-27T12:00:00Z",
        )
        store = self.plugin.MediaActionStore(path, now=lambda: 100.0)
        token = store.create(action)
        self.assertEqual(store.claim(token), (action, "ready"))

        for _ in range(500):
            store.create(action)

        self.assertEqual(store.claim(token), (action, "claimed"))
        stored = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(len(stored["actions"]), 500)

    async def test_prowlarr_download_does_not_send_rezka_episode_selectors(self):
        update, query = callback_update("unused")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        token = self.adapter._media_action_store.create(
            self.plugin.SearchAction(
                label="1 · Скачать из Prowlarr",
                kind="download",
                payload={
                    "source": "prowlarr",
                    "session_id": "session",
                    "result_id": "prowlarr:1:2",
                    "season": 3,
                    "episode": 5,
                    "title": "Show.S03E05.1080p.WEB-DL",
                },
                expires_at="2099-07-27T12:00:00Z",
            )
        )
        query.data = f"md:{token}"

        with mock.patch.object(
            self.plugin,
            "_run_media",
            mock.AsyncMock(return_value=(0, b"{}")),
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_awaited_once_with(
            (
                "mcp__media_admin__media_download",
                {"session_id": "session", "result_id": "prowlarr:1:2"},
            ),
            mock.ANY,
        )

    async def test_continue_action_renders_next_page_with_fresh_buttons(self):
        update, query = callback_update("unused")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        token = self.adapter._media_action_store.create(
            self.plugin.SearchAction(
                label="Ещё Rezka",
                kind="continue",
                payload={
                    "source": "rezka",
                    "continuation": "page-two",
                    "season": 3,
                    "episode": 5,
                },
                expires_at="2099-07-27T12:00:00Z",
            )
        )
        query.data = f"md:{token}"
        page = json.dumps(
            {
                "api_version": "v1",
                "session_id": "00000000-0000-0000-0000-000000000222",
                "source": "rezka",
                "expires_at": "2099-07-27T12:00:00Z",
                "results": [
                    {
                        "source": "rezka",
                        "result_id": "rezka:2",
                        "title": "Второй вариант",
                        "translations": [{"id": 7, "name": "AniLibria"}],
                    }
                ],
            }
        ).encode()

        with mock.patch.object(
            self.plugin,
            "_run_media",
            mock.AsyncMock(return_value=(0, page)),
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_awaited_once_with(
            (
                "mcp__media_admin__media_search",
                {"source": "rezka", "continuation": "page-two"},
            ),
            mock.ANY,
        )
        reply = query.message.edit_text.await_args
        self.assertIn("Второй вариант", reply.args[0])
        markup = reply.kwargs["reply_markup"]
        self.assertEqual(
            [button.text for button in markup.inline_keyboard[0]],
            ["⬅️", "🎙 1/1", "➡️"],
        )
        self.assertLessEqual(
            len(markup.inline_keyboard[0][0].callback_data.encode()), 64
        )

    async def test_continue_failure_edits_same_card_with_retry_and_exact_back(self):
        back = self.plugin.SearchAction(
            "⬅️ Назад",
            "tracking-back",
            {"tmdb_id": 42, "tracking_id": TRACKING_ID},
            "2099-07-27T12:00:00Z",
        )
        action = self.plugin.SearchAction(
            label="Ещё Rezka",
            kind="continue",
            payload={
                "source": "rezka",
                "continuation": "page-two",
                "season": 3,
                "episode": 0,
                "source_back": self.plugin._source_back_payload(back),
                "tracking_context": {
                    "mode": "configure",
                    "tmdb_id": 42,
                    "tracking_id": TRACKING_ID,
                },
            },
            expires_at="2099-07-27T12:00:00Z",
        )
        token = self.adapter._media_action_store.create(action)
        update, query = callback_update(f"md:{token}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.adapter._media_plugin_context = mock.Mock()

        with mock.patch.object(
            self.plugin,
            "_search_media_mcp",
            mock.AsyncMock(return_value=(1, b"{}")),
        ):
            await self.adapter._handle_callback_query(update, None)

        query.answer.assert_awaited_once_with()
        query.message.reply_text.assert_not_awaited()
        query.message.edit_text.assert_awaited_once()
        self.assertIn(
            "Следующая страница временно недоступна",
            query.message.edit_text.await_args.args[0],
        )
        actions = []
        markup = query.message.edit_text.await_args.kwargs["reply_markup"]
        for row in markup.inline_keyboard:
            for button in row:
                if isinstance(button.callback_data, str) and button.callback_data.startswith("md:"):
                    resolved = self.adapter._media_action_store.resolve(
                        button.callback_data.removeprefix("md:")
                    )
                    if resolved is not None:
                        actions.append(resolved[0])
        retry = next(value for value in actions if value.kind == "continue")
        exact_back = next(value for value in actions if value.kind == "tracking-back")
        self.assertEqual(retry.payload, action.payload)
        self.assertEqual(exact_back.payload, back.payload)

    async def test_release_details_action_opens_translation_card_without_starting_download(self):
        update, query = callback_update("unused")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        page = json.dumps(
            {
                "api_version": "v1",
                "session_id": "00000000-0000-0000-0000-000000000111",
                "source": "rezka",
                "expires_at": "2099-07-27T12:00:00Z",
                "results": [
                    {
                        "source": "rezka",
                        "result_id": "rezka:1",
                        "title": "Реинкарнация безработного",
                        "thumbnail_url": "https://example.test/poster.jpg",
                        "translations": [
                            {"id": 1, "name": "AniLibria"},
                            {"id": 2, "name": "Оригинал (+субтитры)"},
                        ],
                    }
                ],
            }
        ).encode()
        rendered = self.plugin._render_source_search(
            page, "rezka", 3, 5, carousel=False
        )
        self.assertEqual(
            rendered.parts[0].photo_url,
            "https://example.test/poster.jpg",
        )
        token = self.adapter._media_action_store.create(rendered.actions[0])
        query.data = f"md:{token}"

        with mock.patch.object(
            self.plugin,
            "_run_media",
            mock.AsyncMock(side_effect=AssertionError("details must not download")),
        ):
            await self.adapter._handle_callback_query(update, None)

        reply = query.message.edit_media.await_args
        media = reply.args[0]
        self.assertIn("AniLibria", media.caption)
        self.assertNotIn("Оригинал (+субтитры)", media.caption)
        labels = [
            button.text
            for row in reply.kwargs["reply_markup"].inline_keyboard
            for button in row
        ]
        self.assertEqual(
            labels,
            [
                "⬅️",
                "🎙 1/2",
                "➡️",
                "⬇️ Скачать",
                "⬅️ Назад",
            ],
        )

    async def test_unauthorized_and_stale_callbacks_never_execute_a_command(self):
        for authorized, data, expected in (
            (False, f"ma:search-alternative:{JOB_ID}", "Действие недоступно"),
            (True, "ma:search-alternative:not-an-id", "Действие устарело"),
        ):
            with self.subTest(data=data):
                update, query = callback_update(data)
                self.adapter._is_callback_user_authorized = (
                    lambda *_args, value=authorized, **_kwargs: value
                )
                run_media = mock.AsyncMock()
                with mock.patch.object(
                    self.plugin, "_run_media", run_media
                ):
                    await self.adapter._handle_callback_query(update, None)
                run_media.assert_not_awaited()
                query.answer.assert_awaited_once_with()

    async def test_alternative_search_failure_is_user_friendly(self):
        update, query = callback_update(f"ma:search-alternative:{JOB_ID}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True

        with mock.patch.object(
            self.plugin, "_run_media", mock.AsyncMock(return_value=(1, b"{}"))
        ):
            await self.adapter._handle_callback_query(update, None)

        query.answer.assert_awaited_once_with()
        query.message.reply_text.assert_not_awaited()
        self.assertIn(
            "Поиск другого источника временно недоступен",
            query.message.edit_text.await_args.args[0],
        )

    def test_registers_read_only_media_shortcut_commands(self):
        ctx = mock.Mock()
        self.plugin.register(ctx)

        registrations = {
            call.args[0]: call.kwargs
            for call in ctx.register_command.call_args_list
        }
        self.assertEqual(
            set(registrations), {"media", "watching", "movies", "series", "trending"}
        )
        for command in registrations.values():
            self.assertTrue(callable(command["handler"]))

    async def test_media_command_sends_one_inline_dashboard_without_agent(self):
        message = types.SimpleNamespace(
            text="/media",
            message_id=91,
            reply_text=mock.AsyncMock(),
            reply_photo=mock.AsyncMock(),
        )
        update = types.SimpleNamespace(message=message)
        self.adapter._effective_update_message = lambda _update: message
        self.adapter._should_process_message = lambda *_args, **_kwargs: True
        self.adapter._is_user_authorized_from_message = lambda _message: True

        with mock.patch.object(
            self.adapter,
            "_media_dashboard_photo",
            mock.AsyncMock(return_value="https://example.test/dashboard.jpg"),
        ):
            await self.adapter._handle_command(update, None)

        message.reply_text.assert_not_awaited()
        message.reply_photo.assert_awaited_once()
        reply = message.reply_photo.await_args.kwargs
        self.assertEqual(reply["photo"], "https://example.test/dashboard.jpg")
        self.assertEqual(reply["caption"], "🎬 <b>Медиа</b>\n\nВыберите раздел.")
        self.assertEqual(reply["parse_mode"], "HTML")
        markup = reply["reply_markup"]
        self.assertEqual(
            [[button.text for button in row] for row in markup.inline_keyboard],
            [
                ["🔥 Тренды", "⭐ Лучшее"],
                ["📅 Премьеры", "🎭 По жанрам"],
                ["🔔 Подписки", "⬇️ Загрузки"],
                ["📺 Plex"],
            ],
        )

    async def test_media_command_falls_back_to_text_when_photo_is_unavailable(self):
        message = types.SimpleNamespace(
            text="/media",
            message_id=92,
            reply_text=mock.AsyncMock(),
            reply_photo=mock.AsyncMock(
                side_effect=self.plugin.BadRequest("bad dashboard photo")
            ),
        )
        update = types.SimpleNamespace(message=message)
        self.adapter._effective_update_message = lambda _update: message
        self.adapter._should_process_message = lambda *_args, **_kwargs: True
        self.adapter._is_user_authorized_from_message = lambda _message: True

        with mock.patch.object(
            self.adapter,
            "_media_dashboard_photo",
            mock.AsyncMock(return_value="https://example.test/broken.jpg"),
        ):
            await self.adapter._handle_command(update, None)

        message.reply_text.assert_awaited_once()
        self.assertEqual(
            message.reply_text.await_args.args[0],
            "🎬 <b>Медиа</b>\n\nВыберите раздел.",
        )
        self.assertEqual(message.reply_text.await_args.kwargs["parse_mode"], "HTML")

    async def test_media_command_uses_local_fallback_poster_when_menu_photo_fails(self):
        message = types.SimpleNamespace(
            text="/media",
            message_id=93,
            reply_text=mock.AsyncMock(),
            reply_photo=mock.AsyncMock(
                side_effect=[self.plugin.BadRequest("bad menu photo"), None]
            ),
        )
        update = types.SimpleNamespace(message=message)
        self.adapter._effective_update_message = lambda _update: message
        self.adapter._should_process_message = lambda *_args, **_kwargs: True
        self.adapter._is_user_authorized_from_message = lambda _message: True

        await self.adapter._handle_command(update, None)

        self.assertEqual(message.reply_photo.await_count, 2)
        self.assertEqual(
            message.reply_photo.await_args_list[1].kwargs["photo"],
            self.adapter._MEDIA_DASHBOARD_FALLBACK_PHOTO,
        )
        message.reply_text.assert_not_awaited()

    async def test_media_dashboard_photo_prefers_config_then_welcome_image(self):
        with mock.patch.dict(
            self.plugin.os.environ,
            {"HERMES_MEDIA_DASHBOARD_PHOTO": "https://example.test/config.jpg"},
        ):
            self.assertEqual(
                await self.adapter._media_dashboard_photo(),
                "https://example.test/config.jpg",
            )

        with mock.patch.dict(
            self.plugin.os.environ,
            {"HERMES_MEDIA_DASHBOARD_PHOTO": ""},
        ), mock.patch.object(
            self.adapter,
            "_trending_payload",
            mock.AsyncMock(),
        ) as trending_payload:
            self.assertEqual(
                await self.adapter._media_dashboard_photo(),
                self.adapter._MEDIA_DASHBOARD_PHOTO,
            )
            trending_payload.assert_not_awaited()
        self.assertTrue(self.adapter._MEDIA_DASHBOARD_PHOTO.is_file())
        self.assertTrue(self.adapter._MEDIA_DASHBOARD_FALLBACK_PHOTO.is_file())

    async def test_media_panel_resolves_plex_item_to_tmdb_poster(self):
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = json.dumps(
            {
                "structuredContent": {
                    "MediaContainer": {
                        "Metadata": [
                            {
                                "type": "movie",
                                "ratingKey": "12508",
                                "Guid": [
                                    {"id": "imdb://tt1234567"},
                                    {"id": "tmdb://936075"},
                                ],
                            }
                        ]
                    }
                }
            }
        )
        self.plugin.HomeTelegramAdapter._media_plugin_context = ctx
        self.adapter._details_payload = mock.AsyncMock(
            return_value={"poster_url": "https://image.tmdb.org/poster.jpg"}
        )

        poster = await self.adapter._plex_poster_for_rating_key("12508")

        self.assertEqual(poster, "https://image.tmdb.org/poster.jpg")
        ctx.dispatch_tool.assert_called_once_with(
            "mcp__media_admin__plex_item_get", {"rating_key": "12508"}
        )
        self.adapter._details_payload.assert_awaited_once_with("movie", 936075)

    async def test_media_panel_callback_edits_the_same_message(self):
        update, query = callback_update("mp:recent")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = json.dumps(
            {
                "structuredContent": {
                    "MediaContainer": {
                        "Metadata": [
                            {
                                "type": "episode",
                                "grandparentTitle": "Сериал",
                                "parentIndex": 2,
                                "index": 7,
                                "ratingKey": "private-id",
                            },
                            {
                                "type": "season",
                                "title": "Сезон 9",
                                "parentTitle": "Большой сериал",
                                "index": 9,
                            },
                        ]
                    }
                }
            }
        )
        self.plugin.HomeTelegramAdapter._media_plugin_context = ctx

        await self.adapter._handle_callback_query(update, None)

        query.message.edit_media.assert_awaited_once()
        rendered_media = query.message.edit_media.await_args.args[0]
        rendered = rendered_media.caption
        markup = query.message.edit_media.await_args.kwargs["reply_markup"]
        self.assertIn("📺 Сериал · S02E07", rendered)
        self.assertIn("📺 Большой сериал · Сезон 9", rendered)
        self.assertNotIn("• Сезон 9", rendered)
        self.assertNotIn("private-id", rendered)
        self.assertEqual(
            [button.text for button in markup.inline_keyboard[-1]],
            ["⬅️ Назад"],
        )
        self.assertEqual(
            rendered_media.parse_mode, "HTML"
        )
        query.message.edit_caption.assert_not_awaited()
        query.message.edit_text.assert_not_awaited()
        query.message.reply_text.assert_not_awaited()

    async def test_media_panel_nested_route_opens_job_card_in_place(self):
        update, query = callback_update(f"mp:job:{JOB_ID}")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = json.dumps(
            {
                "structuredContent": {
                    "id": JOB_ID,
                    "provider": "rezka",
                    "state": "running",
                    "current_stage": "downloading",
                    "progress": {"progress_percent": 25},
                }
            }
        )
        self.plugin.HomeTelegramAdapter._media_plugin_context = ctx

        await self.adapter._handle_callback_query(update, None)

        query.message.edit_media.assert_awaited_once()
        rendered_media = query.message.edit_media.await_args.args[0]
        rendered = rendered_media.caption
        markup = query.message.edit_media.await_args.kwargs["reply_markup"]
        self.assertIn("Прогресс: <b>25%</b>", rendered)
        self.assertNotIn(JOB_ID, rendered)
        callbacks = [
            button.callback_data
            for row in markup.inline_keyboard
            for button in row
        ]
        self.assertIn(f"mp:job-cancel:{JOB_ID}:1", callbacks)
        self.assertIn("mp:downloads-p:1", callbacks)
        key = self.adapter._media_navigation_key(query.message)
        self.assertEqual(
            self.adapter._get_media_navigation_store().current(key),
            f"mp:job:{JOB_ID}",
        )
        query.message.edit_caption.assert_not_awaited()
        query.message.edit_text.assert_not_awaited()

    async def test_media_panel_detail_acknowledges_before_rendering_and_reuses_photo(self):
        update, query = callback_update(f"mp:job:{JOB_ID}")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        events = []
        query.answer.side_effect = lambda **_kwargs: events.append("ack")
        query.message.edit_caption.side_effect = (
            lambda **_kwargs: events.append("caption")
        )
        ctx = mock.Mock()

        def dispatch(*_args, **_kwargs):
            events.append("render")
            return json.dumps({
                "structuredContent": {
                    "id": JOB_ID,
                    "provider": "rezka",
                    "state": "running",
                    "current_stage": "downloading",
                    "poster_url": "https://image.test/job.jpg",
                }
            })

        ctx.dispatch_tool.side_effect = dispatch
        self.plugin.HomeTelegramAdapter._media_plugin_context = ctx
        self.adapter._remember_media_panel_photo(
            query.message, "https://image.test/job.jpg"
        )

        await self.adapter._handle_callback_query(update, None)

        self.assertEqual(events[:2], ["ack", "render"])
        query.message.edit_media.assert_not_awaited()
        self.assertEqual(query.message.edit_caption.await_count, 1)
        self.assertIn(
            "⬇️",
            query.message.edit_caption.await_args.kwargs["caption"],
        )

    async def test_tracking_card_uses_one_native_loading_toast(self):
        _, query = callback_update(f"mp:tracking:{TRACKING_ID}:1")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.plugin.HomeTelegramAdapter._media_plugin_context = None

        await self.adapter._handle_media_panel_callback(query)

        query.answer.assert_awaited_once_with()
        query.message.edit_caption.assert_not_awaited()
        query.message.edit_media.assert_awaited_once()
        self.assertNotIn(
            "Загружаю",
            query.message.edit_media.await_args.args[0].caption,
        )

    async def test_media_panel_without_context_keeps_original_retry_and_parent(self):
        _, query = callback_update("mp:downloads-m-p:2")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.plugin.HomeTelegramAdapter._media_plugin_context = None

        await self.adapter._handle_media_panel_callback(query)

        edit = query.message.edit_media.await_args.kwargs
        callbacks = [
            button.callback_data
            for row in edit["reply_markup"].inline_keyboard
            for button in row
        ]
        self.assertEqual(callbacks, ["mp:downloads-m-p:2", "mp:home"])
        self.assertTrue(
            all(
                self.plugin._MEDIA_PANEL_CALLBACK_RE.fullmatch(callback)
                for callback in callbacks
            )
        )

    async def test_unavailable_trending_keeps_retry_and_back_in_same_message(self):
        update, query = callback_update("mp:trending")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True

        with mock.patch.object(
            self.adapter, "_trending_payload", mock.AsyncMock(return_value=None)
        ):
            await self.adapter._handle_callback_query(update, None)

        query.message.edit_caption.assert_awaited_once()
        query.message.edit_media.assert_not_awaited()
        query.message.edit_text.assert_not_awaited()
        callbacks = [
            button.callback_data
            for row in query.message.edit_caption.await_args.kwargs[
                "reply_markup"
            ].inline_keyboard
            for button in row
        ]
        self.assertEqual(callbacks, ["mp:trending", "mp:home"])
        self.assertTrue(
            all(
                self.plugin._MEDIA_PANEL_CALLBACK_RE.fullmatch(callback)
                for callback in callbacks
            )
        )

    async def test_tracking_check_acknowledges_early_and_schedules_in_same_card(self):
        callback = f"mp:tc:{TRACKING_ID}:1:deadbeef"
        _, query = callback_update(callback)
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        events = []
        query.answer.side_effect = lambda **_kwargs: events.append("ack")
        item = {
            "id": TRACKING_ID,
            "title": "Scheduled series",
            "check_status": "no_new_episode",
            "poster_url": "https://image.test/tracking.jpg",
        }
        ctx = mock.Mock()

        def dispatch(tool, _arguments):
            events.append(tool)
            if tool == "mcp__media_admin__media_tracking_check":
                return json.dumps({"structuredContent": {"status": "scheduled"}})
            return json.dumps({"structuredContent": {"tracking": [item]}})

        ctx.dispatch_tool.side_effect = dispatch
        self.plugin.HomeTelegramAdapter._media_plugin_context = ctx
        self.adapter._remember_media_panel_photo(
            query.message, "https://image.test/tracking.jpg"
        )

        await self.adapter._handle_media_panel_callback(query)

        self.assertEqual(events[0], "ack")
        self.assertEqual(
            events.count("mcp__media_admin__media_tracking_check"), 1
        )
        query.answer.assert_awaited_once_with()
        query.message.edit_caption.assert_awaited_once()
        edit = query.message.edit_caption.await_args.kwargs
        self.assertIn("проверка запланирована", edit["caption"])
        callbacks = [
            button.callback_data
            for row in edit["reply_markup"].inline_keyboard
            for button in row
        ]
        self.assertIn("mp:noop", callbacks)
        self.assertIn("mp:tracking-p:1", callbacks)
        query.message.reply_text.assert_not_awaited()
        query.message.reply_photo.assert_not_awaited()

    async def test_tracking_check_ack_failure_releases_receipt_for_one_retry(self):
        callback = f"mp:tc:{TRACKING_ID}:1:deadbeef"
        _, query = callback_update(callback)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        query.answer.side_effect = [self.plugin.BadRequest("Query is too old"), None]
        item = {"id": TRACKING_ID, "title": "Scheduled series", "check_status": "never"}
        check_calls = 0
        ctx = mock.Mock()

        def dispatch(tool, _arguments):
            nonlocal check_calls
            if tool == "mcp__media_admin__media_tracking_check":
                check_calls += 1
                return json.dumps({"structuredContent": {"status": "scheduled"}})
            return json.dumps({"structuredContent": {"tracking": [item]}})

        ctx.dispatch_tool.side_effect = dispatch
        self.plugin.HomeTelegramAdapter._media_plugin_context = ctx

        await self.adapter._handle_media_panel_callback(query)
        await self.adapter._handle_media_panel_callback(query)

        self.assertEqual(check_calls, 1)

    async def test_tracking_check_without_context_renders_a_working_retry(self):
        callback = f"mp:tc:{TRACKING_ID}:1:deadbeef"
        _, query = callback_update(callback)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.plugin.HomeTelegramAdapter._media_plugin_context = None

        await self.adapter._handle_media_panel_callback(query)

        first_markup = query.message.edit_text.await_args.kwargs["reply_markup"]
        self.assertEqual(
            [button.callback_data for row in first_markup.inline_keyboard for button in row],
            [callback, "mp:tracking-p:1"],
        )

        item = {"id": TRACKING_ID, "title": "Scheduled series"}
        ctx = mock.Mock()
        ctx.dispatch_tool.side_effect = lambda tool, _arguments: json.dumps({
            "structuredContent": (
                {"status": "scheduled"}
                if tool == "mcp__media_admin__media_tracking_check"
                else {"tracking": [item]}
            )
        })
        self.plugin.HomeTelegramAdapter._media_plugin_context = ctx
        await self.adapter._handle_media_panel_callback(query)

        self.assertEqual(
            sum(
                call.args[0] == "mcp__media_admin__media_tracking_check"
                for call in ctx.dispatch_tool.call_args_list
            ),
            1,
        )

    async def test_tracking_check_preconsume_oserror_releases_receipt(self):
        callback = f"mp:tc:{TRACKING_ID}:1:deadbeef"
        _, query = callback_update(callback)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        item = {"id": TRACKING_ID, "title": "Scheduled series"}
        ctx = mock.Mock()
        ctx.dispatch_tool.side_effect = lambda tool, _arguments: json.dumps({
            "structuredContent": (
                {"status": "scheduled"}
                if tool == "mcp__media_admin__media_tracking_check"
                else {"tracking": [item]}
            )
        })
        self.plugin.HomeTelegramAdapter._media_plugin_context = ctx
        transition = mock.Mock(side_effect=[OSError("state unavailable"), 1])

        with mock.patch.object(self.adapter, "_media_panel_transition", transition):
            with self.assertRaises(OSError):
                await self.adapter._handle_media_panel_callback(query)
            await self.adapter._handle_media_panel_callback(query)

        self.assertEqual(transition.call_count, 2)
        self.assertEqual(
            sum(
                call.args[0] == "mcp__media_admin__media_tracking_check"
                for call in ctx.dispatch_tool.call_args_list
            ),
            1,
        )

    async def test_concurrent_tracking_check_taps_dispatch_only_once(self):
        callback = f"mp:tc:{TRACKING_ID}:1:deadbeef"
        _, first_query = callback_update(callback)
        _, second_query = callback_update(callback)
        second_query.message = first_query.message
        first_query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        entered = threading.Event()
        release = threading.Event()
        check_calls = 0
        item = {"id": TRACKING_ID, "title": "Concurrent series"}
        ctx = mock.Mock()

        def dispatch(tool, _arguments):
            nonlocal check_calls
            if tool == "mcp__media_admin__media_tracking_check":
                check_calls += 1
                entered.set()
                release.wait(timeout=2)
                return json.dumps({"structuredContent": {"status": "scheduled"}})
            return json.dumps({"structuredContent": {"tracking": [item]}})

        ctx.dispatch_tool.side_effect = dispatch
        self.plugin.HomeTelegramAdapter._media_plugin_context = ctx

        first_task = asyncio.create_task(
            self.adapter._handle_media_panel_callback(first_query)
        )
        self.assertTrue(await asyncio.to_thread(entered.wait, 1))
        await self.adapter._handle_media_panel_callback(second_query)
        release.set()
        await first_task

        self.assertEqual(check_calls, 1)
        first_query.answer.assert_awaited_once_with()
        second_query.answer.assert_awaited_once_with()
        first_query.message.reply_text.assert_not_awaited()
        first_query.message.reply_photo.assert_not_awaited()

    async def test_tracking_check_reopen_is_deduped_until_check_completes(self):
        initial = {
            "id": TRACKING_ID,
            "title": "Revision series",
            "last_checked_at": "2026-08-10T10:00:00Z",
            "next_check_at": "2026-08-10T12:00:00Z",
            "check_status": "no_new_episode",
        }
        scheduled = {
            **initial,
            "next_check_at": "2026-08-10T10:05:00Z",
        }
        completed = {
            **scheduled,
            "last_checked_at": "2026-08-10T10:06:00Z",
        }

        def callback_for(item):
            render_context = mock.Mock()
            render_context.dispatch_tool.return_value = json.dumps(
                {"structuredContent": {"tracking": [item]}}
            )
            card = self.plugin.render_media_panel_card(
                render_context, f"tracking:{TRACKING_ID}:1"
            )
            return next(
                button.callback_data
                for row in card.buttons
                for button in row
                if button.callback_data.startswith("mp:tc:")
            )

        initial_callback = callback_for(initial)
        reopened_callback = callback_for(scheduled)
        completed_callback = callback_for(completed)
        self.assertEqual(reopened_callback, initial_callback)
        self.assertNotEqual(completed_callback, initial_callback)

        _, first_query = callback_update(initial_callback)
        _, reopened_query = callback_update(reopened_callback)
        _, completed_query = callback_update(completed_callback)
        reopened_query.message = first_query.message
        completed_query.message = first_query.message
        first_query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        check_calls = 0
        current_item = scheduled
        ctx = mock.Mock()

        def dispatch(tool, _arguments):
            nonlocal check_calls
            if tool == "mcp__media_admin__media_tracking_check":
                check_calls += 1
                return json.dumps({"structuredContent": {"status": "scheduled"}})
            return json.dumps({"structuredContent": {"tracking": [current_item]}})

        ctx.dispatch_tool.side_effect = dispatch
        self.plugin.HomeTelegramAdapter._media_plugin_context = ctx

        await self.adapter._handle_media_panel_callback(first_query)
        await self.adapter._handle_media_panel_callback(reopened_query)

        self.assertEqual(check_calls, 1)
        reopened_query.answer.assert_awaited_once_with()

        current_item = completed
        await self.adapter._handle_media_panel_callback(completed_query)

        self.assertEqual(check_calls, 2)
        completed_query.answer.assert_awaited_once_with()
        first_query.message.reply_text.assert_not_awaited()
        first_query.message.reply_photo.assert_not_awaited()

    async def test_tracking_check_failure_consumes_receipt_and_never_replays(self):
        callback = f"mp:tc:{TRACKING_ID}:7:deadbeef"
        _, failed_query = callback_update(callback)
        _, retry_query = callback_update(callback)
        retry_query.message = failed_query.message
        failed_query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        check_calls = 0
        item = {"id": TRACKING_ID, "title": "Retry series"}
        ctx = mock.Mock()

        def dispatch(tool, _arguments):
            nonlocal check_calls
            if tool == "mcp__media_admin__media_tracking_check":
                check_calls += 1
                if check_calls == 1:
                    raise RuntimeError("temporary failure")
                return json.dumps({"structuredContent": {"status": "scheduled"}})
            return json.dumps({"structuredContent": {"tracking": [item]}})

        ctx.dispatch_tool.side_effect = dispatch
        self.plugin.HomeTelegramAdapter._media_plugin_context = ctx

        await self.adapter._handle_media_panel_callback(failed_query)

        failed_query.answer.assert_awaited_once_with()
        failure_edit = failed_query.message.edit_caption.await_args.kwargs
        self.assertIn("Не удалось подтвердить запуск", failure_edit["caption"])
        failure_callbacks = [
            button.callback_data
            for row in failure_edit["reply_markup"].inline_keyboard
            for button in row
        ]
        self.assertEqual(failure_callbacks, ["mp:tracking-p:7"])

        failed_query.message.edit_caption.reset_mock()
        await self.adapter._handle_media_panel_callback(retry_query)

        self.assertEqual(check_calls, 1)
        retry_query.answer.assert_awaited_once_with()
        failed_query.message.edit_caption.assert_not_awaited()
        failed_query.message.reply_text.assert_not_awaited()
        failed_query.message.reply_photo.assert_not_awaited()

    def test_media_panel_transition_rejects_an_older_generation(self):
        _, query = callback_update("mp:downloads")

        first = self.adapter._media_panel_transition(query.message)
        second = self.adapter._media_panel_transition(query.message)

        self.assertFalse(
            self.adapter._media_panel_transition_is_current(query.message, first)
        )
        self.assertTrue(
            self.adapter._media_panel_transition_is_current(query.message, second)
        )

    async def test_valid_callback_families_claim_generation_before_answer(self):
        callbacks = (
            "mt:l:a:1:0:0",
            "mi:l:m:99:1:0:0",
            "mx:d:m:42:0",
            f"ma:details:{JOB_ID}",
            "mp:downloads",
        )
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.plugin.HomeTelegramAdapter._media_plugin_context = None

        for callback in callbacks:
            with self.subTest(callback=callback):
                self.adapter._media_panel_generations = {}
                update, query = callback_update(callback)
                observed_generations = []

                async def answer(**_kwargs):
                    key = self.adapter._media_navigation_key(query.message)
                    observed_generations.append(
                        self.adapter._media_panel_generations.get(key)
                    )

                query.answer.side_effect = answer
                with (
                    mock.patch.object(
                        self.adapter,
                        "_trending_payload",
                        mock.AsyncMock(return_value=None),
                    ),
                    mock.patch.object(
                        self.adapter,
                        "_similar_payload",
                        mock.AsyncMock(return_value=None),
                    ),
                    mock.patch.object(
                        self.adapter,
                        "_details_payload",
                        mock.AsyncMock(return_value=None),
                    ),
                    mock.patch.object(
                        self.plugin,
                        "_run_media",
                        mock.AsyncMock(return_value=(1, b"")),
                    ),
                ):
                    await self.adapter._handle_callback_query(update, None)

                self.assertEqual(observed_generations, [1])

    async def test_latest_media_panel_callback_wins_while_old_edit_is_in_flight(self):
        _, old_query = callback_update(f"mp:job:{JOB_ID}:1")
        _, new_query = callback_update(f"mp:tracking:{TRACKING_ID}:1")
        new_query.message = old_query.message
        message = old_query.message
        message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.plugin.HomeTelegramAdapter._media_plugin_context = mock.Mock()

        old_edit_started = asyncio.Event()
        release_old_edit = asyncio.Event()
        edits = []

        async def edit_media(media, **_kwargs):
            edits.append(media.caption)
            if media.caption == "OLD CARD":
                old_edit_started.set()
                await release_old_edit.wait()

        message.edit_media.side_effect = edit_media
        render_calls = 0

        async def render_in_thread(function, *_args, **_kwargs):
            nonlocal render_calls
            render_calls += 1
            if render_calls == 1:
                return types.SimpleNamespace(
                    text="OLD CARD",
                    buttons=(),
                    parse_mode="HTML",
                    photo_rating_key=None,
                    photo_url="https://image.test/old.jpg",
                )
            raise RuntimeError("new render failed")

        with mock.patch.object(
            self.plugin.asyncio,
            "to_thread",
            side_effect=render_in_thread,
        ):
            old_task = asyncio.create_task(
                self.adapter._handle_media_panel_callback(old_query)
            )
            await asyncio.wait_for(old_edit_started.wait(), timeout=1)
            new_task = asyncio.create_task(
                self.adapter._handle_media_panel_callback(new_query)
            )

            key = self.adapter._media_navigation_key(message)
            for _ in range(20):
                if self.adapter._media_panel_generations.get(key) == 2:
                    break
                await asyncio.sleep(0)
            self.assertEqual(self.adapter._media_panel_generations.get(key), 2)
            release_old_edit.set()
            await asyncio.gather(old_task, new_task)

        self.assertEqual(render_calls, 2)
        self.assertEqual(edits[0], "OLD CARD")
        self.assertIn("Раздел временно недоступен", edits[-1])
        message.edit_caption.assert_not_awaited()

    async def test_stale_text_to_photo_replacement_only_deletes_its_own_message(self):
        _, old_query = callback_update("mp:best")
        _, new_query = callback_update("mp:premieres")
        new_query.message = old_query.message
        message = old_query.message
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.plugin.HomeTelegramAdapter._media_plugin_context = mock.Mock()

        _, stale_query = callback_update("unused")
        _, fresh_query = callback_update("unused")
        stale_replacement = stale_query.message.reply_photo.return_value
        fresh_replacement = fresh_query.message.reply_photo.return_value
        old_reply_started = asyncio.Event()
        release_old_reply = asyncio.Event()
        reply_count = 0

        async def reply_photo(**_kwargs):
            nonlocal reply_count
            reply_count += 1
            if reply_count == 1:
                old_reply_started.set()
                await release_old_reply.wait()
                return stale_replacement
            return fresh_replacement

        message.reply_photo.side_effect = reply_photo
        render_count = 0

        async def render_in_thread(_function, *_args, **_kwargs):
            nonlocal render_count
            render_count += 1
            label = "OLD" if render_count == 1 else "NEW"
            return types.SimpleNamespace(
                text=label,
                buttons=(),
                parse_mode="HTML",
                photo_rating_key=None,
                photo_url=f"https://image.test/{label.lower()}.jpg",
            )

        with mock.patch.object(
            self.plugin.asyncio, "to_thread", side_effect=render_in_thread
        ):
            old_task = asyncio.create_task(
                self.adapter._handle_media_panel_callback(old_query)
            )
            await asyncio.wait_for(old_reply_started.wait(), timeout=1)
            new_task = asyncio.create_task(
                self.adapter._handle_media_panel_callback(new_query)
            )
            key = self.adapter._media_navigation_key(message)
            for _ in range(20):
                if self.adapter._media_panel_generations.get(key) == 2:
                    break
                await asyncio.sleep(0)
            self.assertEqual(self.adapter._media_panel_generations.get(key), 2)
            release_old_reply.set()
            await asyncio.gather(old_task, new_task)

        self.assertEqual(message.reply_photo.await_count, 2)
        stale_replacement.delete.assert_awaited_once_with()
        fresh_replacement.delete.assert_not_awaited()
        message.delete.assert_awaited_once_with()
        self.assertTrue(
            self.adapter._media_panel_has_photo(
                fresh_replacement, "https://image.test/new.jpg"
            )
        )

    async def test_newer_home_wins_when_older_nested_callback_ack_is_blocked(self):
        old_route = f"mp:tracking:{TRACKING_ID}:1"
        _, old_query = callback_update(old_route)
        _, new_query = callback_update("mp:home")
        new_query.message = old_query.message
        message = old_query.message
        message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.plugin.HomeTelegramAdapter._media_plugin_context = mock.Mock()
        self.adapter._media_navigation_visit(message, old_route)

        old_ack_started = asyncio.Event()
        release_old_ack = asyncio.Event()

        async def blocked_old_answer(**_kwargs):
            old_ack_started.set()
            await release_old_ack.wait()

        old_query.answer.side_effect = blocked_old_answer
        old_card = types.SimpleNamespace(
            text="OLD TRACKING CARD",
            buttons=(),
            parse_mode="HTML",
            photo_rating_key=None,
            photo_url="https://image.test/old.jpg",
        )

        with (
            mock.patch.object(
                self.plugin.asyncio,
                "to_thread",
                mock.AsyncMock(return_value=old_card),
            ),
            mock.patch.object(
                self.adapter,
                "_media_dashboard_photo",
                mock.AsyncMock(return_value="https://image.test/home.jpg"),
            ),
        ):
            old_task = asyncio.create_task(
                self.adapter._handle_media_panel_callback(old_query)
            )
            await asyncio.wait_for(old_ack_started.wait(), timeout=1)
            await self.adapter._handle_media_panel_callback(new_query)

            self.assertEqual(
                self.adapter._media_navigation_current(message), "mp:home"
            )
            self.assertIsNone(
                self.adapter._get_media_navigation_store().back(
                    self.adapter._media_navigation_key(message)
                )
            )
            release_old_ack.set()
            await old_task

        self.assertEqual(message.edit_media.await_count, 1)
        self.assertIn("Медиа", message.edit_media.await_args.args[0].caption)
        self.assertEqual(self.adapter._media_navigation_current(message), "mp:home")

    async def test_stale_cleanup_continues_after_transport_error_and_is_bounded(self):
        messages = []
        for index in range(self.adapter._MAX_STALE_MESSAGE_CLEANUP + 1):
            message = types.SimpleNamespace(delete=mock.AsyncMock())
            if index == 0:
                message.delete.side_effect = self.plugin.TelegramError("timeout")
            messages.append(message)

        await self.adapter._delete_stale_messages(messages)

        for message in messages[: self.adapter._MAX_STALE_MESSAGE_CLEANUP]:
            message.delete.assert_awaited_once_with()
        messages[-1].delete.assert_not_awaited()

        programmer_error = types.SimpleNamespace(
            delete=mock.AsyncMock(side_effect=RuntimeError("programmer error"))
        )
        with self.assertRaisesRegex(RuntimeError, "programmer error"):
            await self.adapter._delete_stale_messages([programmer_error])

    async def test_new_media_panel_callback_invalidates_slow_discovery_action(self):
        _, old_query = callback_update("mx:d:m:42:0")
        _, new_query = callback_update(f"mp:tracking:{TRACKING_ID}:1")
        new_query.message = old_query.message
        message = old_query.message
        message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.plugin.HomeTelegramAdapter._media_plugin_context = None
        details_started = asyncio.Event()
        release_details = asyncio.Event()

        async def slow_details(*_args):
            details_started.set()
            await release_details.wait()
            return {
                "tmdb_id": 42,
                "media_type": "movie",
                "title": "Старая карточка",
            }

        with mock.patch.object(
            self.adapter, "_details_payload", side_effect=slow_details
        ):
            old_task = asyncio.create_task(
                self.adapter._handle_discovery_action_callback(old_query)
            )
            await asyncio.wait_for(details_started.wait(), timeout=1)
            new_task = asyncio.create_task(
                self.adapter._handle_media_panel_callback(new_query)
            )
            await asyncio.sleep(0)
            release_details.set()
            await asyncio.gather(old_task, new_task)

        message.edit_media.assert_awaited_once()
        self.assertIn(
            "Раздел временно недоступен",
            message.edit_media.await_args.args[0].caption,
        )
        old_query.answer.assert_awaited_once_with()

    async def test_new_media_panel_callback_invalidates_slow_business_action_refresh(self):
        _, old_query = callback_update(business_callback("cancel"))
        _, new_query = callback_update(f"mp:tracking:{TRACKING_ID}:1")
        new_query.message = old_query.message
        message = old_query.message
        message.photo = (object(),)
        message.reply_markup = FakeInlineKeyboardMarkup([[
            FakeInlineKeyboardButton("Загрузки", callback_data="mp:downloads")
        ]])
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.adapter._media_plugin_context = business_job_context()
        action_started = asyncio.Event()
        release_action = asyncio.Event()

        async def slow_action(*_args, **_kwargs):
            action_started.set()
            await release_action.wait()
            return 0, "{}"

        with mock.patch.object(
            self.plugin, "_run_media", side_effect=slow_action
        ):
            old_task = asyncio.create_task(
                self.adapter._handle_business_action_callback(
                    old_query, old_query.data
                )
            )
            await asyncio.wait_for(action_started.wait(), timeout=1)
            new_task = asyncio.create_task(
                self.adapter._handle_media_panel_callback(new_query)
            )
            await asyncio.sleep(0)
            release_action.set()
            await asyncio.gather(old_task, new_task)

        message.edit_media.assert_awaited_once()
        self.assertIn(
            "Подписка не найдена",
            message.edit_media.await_args.args[0].caption,
        )
        old_query.answer.assert_awaited_once_with(text="Отменяю загрузку…")

    def test_recent_uses_consistent_list_then_single_card_flow(self):
        recent_items = [
            {
                "type": "movie",
                "title": f"Фильм {index}",
                "year": 2026,
                "ratingKey": str(1000 + index),
            }
            for index in range(1, 12)
        ]
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = json.dumps(
            {
                "structuredContent": {
                    "MediaContainer": {"Metadata": recent_items}
                }
            }
        )

        list_card = self.plugin.render_media_panel_card(ctx, "recent")

        self.assertEqual(list_card.photo_rating_key, "1001")
        self.assertTrue(list_card.text.startswith("🎬 Фильм 1 (2026)"))
        self.assertIn("🎬 Фильм 10 (2026)", list_card.text)
        self.assertNotIn("1. 🎬", list_card.text)
        labels = [button.label for row in list_card.buttons for button in row]
        callbacks = [
            button.callback_data for row in list_card.buttons for button in row
        ]
        self.assertIn("🖼 Карточки", labels)
        self.assertEqual(labels[:3], ["⬅️", "1/2", "➡️"])
        self.assertNotIn("1", labels)
        self.assertIn("mp:recent-key:1001:1", callbacks)

        detailed_item = {
            **recent_items[0],
            "originalTitle": "Movie 1",
            "rating": 8.4,
            "summary": "Описание фильма.",
        }
        ctx.dispatch_tool.side_effect = [
            json.dumps(
                {
                    "structuredContent": {
                        "MediaContainer": {
                            "Metadata": [detailed_item, *recent_items[1:]]
                        }
                    }
                }
            )
        ]

        detail_card = self.plugin.render_media_panel_card(
            ctx, "recent-key:1001:1"
        )

        self.assertEqual(detail_card.photo_rating_key, "1001")
        self.assertIn("<b>🎬 Фильм 1 / Movie 1</b>", detail_card.text)
        self.assertIn("<blockquote expandable>", detail_card.text)
        detail_labels = [
            button.label for row in detail_card.buttons for button in row
        ]
        detail_callbacks = [
            button.callback_data for row in detail_card.buttons for button in row
        ]
        self.assertEqual(detail_labels[:3], ["⬅️", "1/10", "➡️"])
        self.assertEqual(detail_labels[-1], "⬅️ Назад")
        self.assertEqual(detail_callbacks[:2], ["mp:noop", "mp:noop"])
        self.assertIn("mp:recent-key:1002:1", detail_callbacks)
        self.assertIn("mp:recent-p:1", detail_callbacks)

    def test_media_panel_downloads_and_tracking_are_user_friendly(self):
        ctx = mock.Mock()
        ctx.dispatch_tool.side_effect = [
            json.dumps(
                {
                    "structuredContent": {
                        "queued": 1,
                        "active": True,
                        "runner_state": "busy",
                    }
                }
            ),
            json.dumps(
                {
                    "structuredContent": {
                        "jobs": [
                            {
                                "id": "private-job-id",
                                "provider": "rezka",
                                "state": "running",
                            }
                        ]
                    }
                }
            ),
        ]

        downloads = self.plugin._render_media_panel_section(
            ctx, "downloads"
        )

        self.assertIn("Занят · ▶️ 1 · 🕒 1", downloads)
        self.assertIn("⬇️ 🎬 Загрузка из Rezka\n🌐 Rezka", downloads)
        self.assertNotIn("<i>", downloads)
        self.assertNotIn("private-job-id", downloads)

        ctx.dispatch_tool.side_effect = None
        ctx.dispatch_tool.return_value = json.dumps(
            {
                "structuredContent": {
                    "tracking": [
                        {
                            "id": "private-tracking-id",
                            "title": "Сериал",
                            "scope": "personal",
                            "known_episodes": [{"season": 3, "episode": 5}],
                            "download": {"season": 3},
                        }
                    ]
                }
            }
        )

        tracking = self.plugin._render_media_panel_section(ctx, "tracking")

        self.assertIn("Сериал · S03E05 · авто · личная", tracking)
        self.assertNotIn("private-tracking-id", tracking)

    def test_media_panel_library_and_storage_are_compact(self):
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = json.dumps(
            {
                "structuredContent": {
                    "sections": [
                        {"section_key": 1, "title": "Movies", "type": "movie", "item_count": 42},
                        {"section_key": 2, "title": "TV", "type": "show", "item_count": 17},
                    ]
                }
            }
        )
        library = self.plugin._render_media_panel_section(ctx, "library")
        self.assertIn("Фильмы: 42", library)
        self.assertIn("Сериалы: 17", library)
        self.assertNotIn("section_key", library)

        ctx.dispatch_tool.return_value = json.dumps(
            {
                "structuredContent": {
                    "roots": [
                        {
                            "path": "/data/tv",
                            "total_bytes": 1099511627776,
                            "available_bytes": 274877906944,
                            "used_bytes": 824633720832,
                            "used_percent": 75,
                        },
                        {
                            "path": "/data/movies",
                            "total_bytes": 1099511627776,
                            "available_bytes": 274877906944,
                            "used_bytes": 824633720832,
                            "used_percent": 75,
                        },
                    ]
                }
            }
        )
        storage = self.plugin._render_media_panel_section(ctx, "storage")
        self.assertIn("Общее хранилище · 2 каталога", storage)
        self.assertIn("свободно 256.0 ГиБ из 1.0 ТиБ", storage)
        self.assertIn("занято 75%", storage)
        self.assertNotIn("/data/", storage)

    def test_trending_shortcuts_dispatch_mcp_and_render_pagination(self):
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = json.dumps(
            {
                "structuredContent": {
                    "source": "tmdb",
                    "category": "movie",
                    "page": 1,
                    "total_pages": 3,
                    "results": [
                        {
                            "tmdb_id": 42,
                            "media_type": "movie",
                            "title": "Фильм",
                            "original_title": "Movie",
                            "year": 2026,
                            "rating": 8.4,
                        }
                    ],
                }
            }
        )

        rendered = self.plugin._render_trending_command(ctx, "", "movie")

        ctx.dispatch_tool.assert_called_once_with(
            "mcp__media_admin__media_trending",
            {"category": "movie", "page": 1},
        )
        self.assertIn("Фильм / Movie (2026)", rendered)
        self.assertIn("⭐ 8.4", rendered)
        self.assertIn("/movies 2", rendered)

    async def test_trending_command_sends_ten_item_photo_card(self):
        results = [
            {
                "tmdb_id": index,
                "media_type": "movie" if index % 2 else "tv",
                "title": f"Релиз {index}",
                "year": 2026,
                "rating": 8.0,
                "poster_url": "https://image.tmdb.org/t/p/w780/poster.jpg",
                "overview": "Описание",
            }
            for index in range(1, 11)
        ]
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = json.dumps({
            "structuredContent": {
                "source": "tmdb",
                "category": "all",
                "page": 1,
                "total_pages": 100,
                "results": results,
            }
        })
        self.adapter._media_plugin_context = ctx
        self.adapter._should_process_message = lambda *_args, **_kwargs: True
        self.adapter._is_user_authorized_from_message = lambda *_args: True
        message = types.SimpleNamespace(
            text="/trending",
            message_id=15,
            reply_text=mock.AsyncMock(),
            reply_photo=mock.AsyncMock(),
        )
        self.adapter._effective_update_message = lambda _update: message

        await self.adapter._handle_command(object(), None)

        message.reply_photo.assert_awaited_once()
        reply = message.reply_photo.await_args
        self.assertEqual(
            reply.kwargs["photo"],
            "https://image.tmdb.org/t/p/w780/poster.jpg",
        )
        self.assertIn("📺 Релиз 10 (2026) ⭐8.0", reply.kwargs["caption"])
        self.assertNotIn("10. 📺", reply.kwargs["caption"])
        self.assertLessEqual(len(reply.kwargs["caption"]), 1024)
        self.assertEqual(reply.kwargs["parse_mode"], "HTML")
        rows = reply.kwargs["reply_markup"].inline_keyboard
        self.assertEqual([button.text for button in rows[1]], ["Фильмы", "Сериалы", "✅ Все"])
        self.assertEqual(rows[1][2].callback_data, "mp:noop")
        self.assertEqual(rows[2][0].text, "🖼 Карточки")

    def test_trending_list_omits_redundant_category_heading(self):
        card = self.plugin.render_trending_list({
            "category": "tv",
            "page": 1,
            "total_pages": 1,
            "results": [{
                "tmdb_id": 77,
                "media_type": "tv",
                "title": "Сериал",
                "rating": 0.0,
            }],
        })

        self.assertIsNotNone(card)
        self.assertTrue(card.text.startswith("📺 Сериал"))
        self.assertNotIn("1. 📺", card.text)
        self.assertNotIn("Сериалы TMDB", card.text)
        self.assertNotIn("⭐", card.text)

    def test_trending_and_similar_carousels_use_noop_at_edges(self):
        payload = {
            "category": "movie",
            "page": 2,
            "total_pages": 3,
            "results": [
                {"tmdb_id": 11, "media_type": "movie", "title": "Первый"},
                {"tmdb_id": 22, "media_type": "movie", "title": "Последний"},
            ],
        }

        trending_first = self.plugin.render_trending_details(payload, 0)
        trending_last = self.plugin.render_trending_details(payload, 1)
        similar_first = self.plugin.render_similar_details(payload, "movie", 99, 0)
        similar_last = self.plugin.render_similar_details(payload, "movie", 99, 1)

        self.assertEqual(trending_first.buttons[0][0].callback_data, "mp:noop")
        self.assertEqual(trending_first.buttons[0][1].callback_data, "mp:noop")
        self.assertEqual(
            trending_first.buttons[0][2].callback_data, "mt:d:m:2:1:22"
        )
        self.assertEqual(
            trending_last.buttons[0][0].callback_data, "mt:d:m:2:0:11"
        )
        self.assertEqual(trending_last.buttons[0][2].callback_data, "mp:noop")
        self.assertEqual(similar_first.buttons[0][0].callback_data, "mp:noop")
        self.assertEqual(similar_first.buttons[0][1].callback_data, "mp:noop")
        self.assertEqual(
            similar_first.buttons[0][2].callback_data, "mi:d:m:99:2:1:22"
        )
        self.assertEqual(
            similar_last.buttons[0][0].callback_data, "mi:d:m:99:2:0:11"
        )
        self.assertEqual(similar_last.buttons[0][2].callback_data, "mp:noop")

    async def test_tmdb_detail_position_callback_is_handled_as_pure_noop(self):
        payload = {
            "category": "movie",
            "page": 1,
            "total_pages": 1,
            "results": [
                {"tmdb_id": 11, "media_type": "movie", "title": "Один"}
            ],
        }
        card = self.plugin.render_trending_details(payload, 0)
        update, query = callback_update(card.buttons[0][1].callback_data)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.adapter._media_plugin_context = mock.Mock()

        await self.adapter._handle_callback_query(update, None)

        query.answer.assert_awaited_once_with()
        query.message.edit_media.assert_not_awaited()
        query.message.edit_caption.assert_not_awaited()
        query.message.edit_text.assert_not_awaited()
        self.adapter._media_plugin_context.dispatch_tool.assert_not_called()

    def test_trending_and_similar_list_pagination_is_noop_at_edges_and_center(self):
        base = {
            "category": "tv",
            "total_pages": 3,
            "results": [
                {"tmdb_id": 77, "media_type": "tv", "title": "Сериал"}
            ],
        }

        trending_first = self.plugin.render_trending_list({**base, "page": 1})
        trending_last = self.plugin.render_trending_list({**base, "page": 3})
        similar_first = self.plugin.render_similar_list(
            {**base, "page": 1}, "tv", 99
        )
        similar_last = self.plugin.render_similar_list(
            {**base, "page": 3}, "tv", 99
        )

        self.assertEqual(
            [button.callback_data for button in trending_first.buttons[0]],
            ["mp:noop", "mp:noop", "mt:l:t:2:0:0"],
        )
        self.assertEqual(
            [button.callback_data for button in trending_last.buttons[0]],
            ["mt:l:t:2:0:0", "mp:noop", "mp:noop"],
        )
        self.assertEqual(
            [button.callback_data for button in similar_first.buttons[0]],
            ["mp:noop", "mp:noop", "mi:l:t:99:2:0:0"],
        )
        self.assertEqual(
            [button.callback_data for button in similar_last.buttons[0]],
            ["mi:l:t:99:2:0:0", "mp:noop", "mp:noop"],
        )

    async def test_trending_details_edit_the_existing_photo_card(self):
        update, query = callback_update("mt:d:a:1:1:2")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        payload = {
            "source": "tmdb",
            "category": "all",
            "page": 1,
            "total_pages": 3,
            "results": [
                {
                    "tmdb_id": 1,
                    "media_type": "movie",
                    "title": "Первый",
                    "poster_url": "https://image.tmdb.org/t/p/w780/one.jpg",
                },
                {
                    "tmdb_id": 2,
                    "media_type": "tv",
                    "title": "Второй",
                    "original_title": "Second",
                    "year": 2026,
                    "rating": 8.7,
                    "poster_url": "https://image.tmdb.org/t/p/w780/two.jpg",
                    "overview": "Краткое описание сериала.",
                },
            ],
        }

        with mock.patch.object(
            self.adapter,
            "_trending_payload",
            mock.AsyncMock(return_value=payload),
        ):
            await self.adapter._handle_callback_query(update, None)

        query.message.edit_media.assert_awaited_once()
        media = query.message.edit_media.await_args.args[0]
        self.assertEqual(media.media, "https://image.tmdb.org/t/p/w780/two.jpg")
        self.assertEqual(media.parse_mode, "HTML")
        self.assertIn("<b>📺 Второй / Second</b>", media.caption)
        self.assertIn("\n📅 2026\n", media.caption)
        self.assertIn("\nTMDb: ⭐⭐⭐⭐ 8.7/10\n", media.caption)
        self.assertIn("<blockquote expandable>", media.caption)
        self.assertIn("Краткое описание сериала.", media.caption)
        self.assertIn("</blockquote>", media.caption)
        rows = query.message.edit_media.await_args.kwargs["reply_markup"].inline_keyboard
        self.assertEqual([button.text for button in rows[0]], ["⬅️", "2/2", "➡️"])
        self.assertEqual(rows[1][0].text, "🎭 Похожие")
        self.assertEqual([button.text for button in rows[2]], ["🔕 Отслеживание", "⬇️ Скачать"])
        self.assertEqual(rows[-1][0].text, "⬅️ Назад")

    async def test_media_trending_always_opens_list_first_with_single_back(self):
        update, query = callback_update("mp:trending")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        payload = {
            "source": "tmdb",
            "category": "all",
            "page": 1,
            "total_pages": 2,
            "results": [{
                "tmdb_id": 1,
                "media_type": "movie",
                "title": "Первый",
                "poster_url": "https://image.tmdb.org/t/p/w780/one.jpg",
            }],
        }

        with mock.patch.object(
            self.adapter, "_trending_payload", mock.AsyncMock(return_value=payload)
        ):
            await self.adapter._handle_callback_query(update, None)

        query.message.edit_media.assert_awaited_once()
        media = query.message.edit_media.await_args.args[0]
        self.assertEqual(media.media, "https://image.tmdb.org/t/p/w780/one.jpg")
        self.assertEqual(media.caption, "🎬 Первый")
        reply_markup = query.message.edit_media.await_args.kwargs["reply_markup"]
        self.assertEqual(
            [button.text for button in reply_markup.inline_keyboard[0]],
            ["⬅️", "1/2", "➡️"],
        )
        self.assertEqual(reply_markup.inline_keyboard[2][0].text, "🖼 Карточки")
        back_buttons = [
            button
            for row in reply_markup.inline_keyboard
            for button in row
            if button.text == "⬅️ Назад"
        ]
        self.assertEqual(len(back_buttons), 1)
        self.assertEqual(back_buttons[0].callback_data, "mn:b")
        query.message.reply_photo.assert_not_awaited()
        query.message.delete.assert_not_awaited()
        key = self.adapter._media_navigation_key(query.message)
        self.assertEqual(
            self.adapter._get_media_navigation_store().back(key), "mp:home"
        )

    async def test_media_trending_text_card_uses_shared_photo_fallback_and_cache(self):
        update, query = callback_update("mp:trending")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        payload = {
            "source": "tmdb",
            "category": "all",
            "page": 1,
            "total_pages": 1,
            "results": [{
                "tmdb_id": 1,
                "media_type": "movie",
                "title": "Первый",
                "poster_url": "https://image.test/broken.jpg",
            }],
        }
        replacement = query.message.reply_photo.return_value
        query.message.reply_photo.side_effect = [
            self.plugin.BadRequest("bad poster"),
            replacement,
        ]

        with mock.patch.object(
            self.adapter, "_trending_payload", mock.AsyncMock(return_value=payload)
        ):
            await self.adapter._handle_callback_query(update, None)

        self.assertEqual(query.message.reply_photo.await_count, 2)
        self.assertEqual(
            query.message.reply_photo.await_args_list[1].kwargs["photo"],
            self.adapter._MEDIA_DASHBOARD_FALLBACK_PHOTO,
        )
        self.assertTrue(
            self.adapter._media_panel_has_photo(
                replacement, self.adapter._MEDIA_DASHBOARD_FALLBACK_PHOTO
            )
        )
        query.message.delete.assert_awaited_once_with()

    async def test_combined_search_never_creates_extra_messages(self):
        _update, query = callback_update("unused")
        message = query.message
        generation = self.adapter._media_panel_transition(message)
        parts = (
            self.plugin.RenderedSearchPart("Первый", ()),
            self.plugin.RenderedSearchPart(
                "Второй", (), "https://image.test/second.jpg"
            ),
            self.plugin.RenderedSearchPart(
                "Третий", (), "https://image.test/third.jpg"
            ),
        )
        combined = self.plugin.RenderedSearch("Первый", (), parts)
        source_action = self.plugin.SearchAction(
            "Карточка",
            "release-details",
            {},
            "2099-12-31T23:59:59Z",
        )
        source_search = self.plugin.RenderedSearch(
            "Источник",
            (source_action,),
            (self.plugin.RenderedSearchPart("Источник", (source_action,)),),
        )

        details = {"tmdb_id": 42, "media_type": "movie", "title": "Фильм"}

        with (
            mock.patch.object(
                self.plugin,
                "_search_media_mcp",
                mock.AsyncMock(return_value=(0, b"{}")),
            ),
            mock.patch.object(
                self.plugin, "_render_source_search", return_value=source_search
            ),
            mock.patch.object(self.plugin, "_combine_source_results", return_value=combined),
        ):
            await self.adapter._search_from_tmdb_card(
                message, details, "a", 0, generation, "mx:d:m:42:0"
            )

        message.edit_text.assert_awaited_once()
        message.reply_photo.assert_not_awaited()
        message.reply_text.assert_not_awaited()
        message.delete.assert_not_awaited()

    async def test_claimed_multipart_search_stays_in_one_editable_message(self):
        _update, query = callback_update("unused")
        message = query.message
        generation = self.adapter._media_panel_transition(message)
        expires = "2099-12-31T23:59:59Z"
        source_action = self.plugin.SearchAction("Выбрать", "noop", {}, expires)
        parts = (
            self.plugin.RenderedSearchPart("Первая", (source_action,)),
            self.plugin.RenderedSearchPart("Вторая", (source_action,)),
            self.plugin.RenderedSearchPart("Третья", (source_action,)),
        )
        rendered = self.plugin.RenderedSearch("Первая", (), parts)
        claim = self.plugin.SearchAction("Открыть", "noop", {}, expires)
        token = self.adapter._media_action_store.create(claim)
        self.adapter._media_action_store.claim(token)

        await self.adapter._present_claimed_search(
            message,
            rendered,
            token,
            self.adapter._media_action_store,
            generation,
        )

        message.edit_text.assert_awaited_once()
        message.reply_text.assert_not_awaited()
        message.reply_photo.assert_not_awaited()
        markup = message.edit_text.await_args.kwargs["reply_markup"]
        labels = [button.text for row in markup.inline_keyboard for button in row]
        self.assertEqual(labels[-3:], ["⬅️", "1/3", "➡️"])

    async def test_older_search_action_cannot_overwrite_newer_card(self):
        expires = "2099-12-31T23:59:59Z"
        old_action = self.plugin.SearchAction(
            "Старый",
            "provider-open",
            {
                "source": "rezka",
                "search_page": {"source": "rezka", "results": []},
                "season": 1,
                "episode": 1,
            },
            expires,
        )
        new_action = self.plugin.SearchAction(
            "Новый",
            "provider-open",
            {
                "source": "prowlarr",
                "search_page": {"source": "prowlarr", "results": []},
                "season": 1,
                "episode": 1,
            },
            expires,
        )
        old_token = self.adapter._media_action_store.create(old_action)
        new_token = self.adapter._media_action_store.create(new_action)
        old_update, old_query = callback_update(f"md:{old_token}")
        new_update, new_query = callback_update(f"md:{new_token}")
        new_query.message = old_query.message
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        old_ack = asyncio.Event()
        release_old = asyncio.Event()

        async def block_old(**_kwargs):
            old_ack.set()
            await release_old.wait()

        old_query.answer.side_effect = block_old

        def render(_output, source, *_args, **_kwargs):
            text = "СТАРАЯ" if source == "rezka" else "НОВАЯ"
            part = self.plugin.RenderedSearchPart(text, ())
            return self.plugin.RenderedSearch(text, (), (part,))

        with mock.patch.object(self.plugin, "_render_source_search", side_effect=render):
            old_task = asyncio.create_task(
                self.adapter._handle_callback_query(old_update, None)
            )
            await asyncio.wait_for(old_ack.wait(), timeout=1)
            await self.adapter._handle_callback_query(new_update, None)
            release_old.set()
            await old_task

        self.assertEqual(old_query.message.edit_text.await_count, 1)
        self.assertEqual(old_query.message.edit_text.await_args.args[0], "НОВАЯ")
        old_query.message.reply_text.assert_not_awaited()
        old_query.message.reply_photo.assert_not_awaited()

    async def test_all_search_back_failure_answers_once_and_edits_same_card(self):
        expires = "2099-12-31T23:59:59Z"
        action = self.plugin.SearchAction(
            "Назад",
            "all-search-back",
            {
                "query": "Hacks",
                "media_kind": "series",
                "season": 1,
                "episode": 1,
            },
            expires,
        )
        token = self.adapter._media_action_store.create(action)
        update, query = callback_update(f"md:{token}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True

        with mock.patch.object(
            self.plugin,
            "_search_media_mcp",
            mock.AsyncMock(return_value=(1, b"{}")),
        ):
            await self.adapter._handle_callback_query(update, None)

        query.answer.assert_awaited_once_with()
        self.assertIn("временно недоступны", query.message.edit_text.await_args.args[0])
        query.message.reply_text.assert_not_awaited()
        query.message.reply_photo.assert_not_awaited()

    async def test_tracking_empty_choices_edit_same_card_with_retry_and_back(self):
        update, query = callback_update(f"ms:a:{TRACKING_ID}:3:5")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        choice = json.dumps({
            "status": "ready",
            "choice_set_id": "choice-1",
            "expires_at": "2099-12-31T23:59:59Z",
            "sources": {
                "rezka": {
                    "selection_ref": "rezka-ref",
                    "expires_at": "2099-12-31T23:59:59Z",
                    "results": [],
                },
                "prowlarr": {
                    "selection_ref": "prowlarr-ref",
                    "expires_at": "2099-12-31T23:59:59Z",
                    "results": [],
                },
            },
        }).encode()

        with mock.patch.object(
            self.plugin, "_run_media", mock.AsyncMock(return_value=(0, choice))
        ):
            await self.adapter._handle_callback_query(update, None)

        query.answer.assert_awaited_once_with(text="Ищу варианты…")
        self.assertIn(
            "не вернули доступных вариантов",
            query.message.edit_caption.await_args.kwargs["caption"],
        )
        labels = [
            button.text
            for row in query.message.edit_caption.await_args.kwargs[
                "reply_markup"
            ].inline_keyboard
            for button in row
        ]
        self.assertEqual(labels, ["🔄 Повторить", "⬅️ Назад"])
        query.message.reply_text.assert_not_awaited()
        query.message.reply_photo.assert_not_awaited()

    async def test_tracking_all_sources_preserve_the_full_combined_carousel(self):
        update, query = callback_update(f"ms:a:{TRACKING_ID}:3:5")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        choice = json.dumps({
            "status": "ready",
            "choice_set_id": "choice-1",
            "expires_at": "2099-12-31T23:59:59Z",
            "sources": {
                "rezka": {
                    "selection_ref": "rezka-ref",
                    "expires_at": "2099-12-31T23:59:59Z",
                    "results": [
                        {
                            "source": "rezka",
                            "result_id": f"rezka:{index}",
                            "title": f"Rezka {index}",
                            "translations": [{"id": index, "name": "Dub"}],
                        }
                        for index in (1, 2)
                    ],
                },
                "prowlarr": {
                    "selection_ref": "prowlarr-ref",
                    "expires_at": "2099-12-31T23:59:59Z",
                    "results": [
                        {
                            "source": "prowlarr",
                            "result_id": f"prowlarr:{index}",
                            "title": f"Release {index} S03E05 WEB-DL",
                            "seeders": 10 - index,
                        }
                        for index in (1, 2)
                    ],
                },
            },
        }).encode()

        with mock.patch.object(
            self.plugin, "_run_media", mock.AsyncMock(return_value=(0, choice))
        ):
            await self.adapter._handle_callback_query(update, None)

        markup = query.message.edit_caption.await_args.kwargs["reply_markup"]
        self.assertEqual(
            [button.text for button in markup.inline_keyboard[0]],
            ["⬅️", "1/4", "➡️"],
        )

    async def test_media_panel_noop_only_answers_callback(self):
        update, query = callback_update("mp:noop")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True

        await self.adapter._handle_callback_query(update, None)

        query.answer.assert_awaited_once_with()
        query.message.edit_media.assert_not_awaited()
        query.message.edit_caption.assert_not_awaited()
        query.message.edit_text.assert_not_awaited()

    async def test_media_panel_text_message_becomes_one_editable_photo_list(self):
        update, query = callback_update("mp:best")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = json.dumps(
            {
                "structuredContent": {
                    "page": 1,
                    "total_pages": 1,
                    "results": [
                        {
                            "tmdb_id": 10,
                            "media_type": "movie",
                            "title": "Лучший фильм",
                            "poster_url": "https://image.test/best.jpg",
                        }
                    ],
                }
            }
        )
        self.plugin.HomeTelegramAdapter._media_plugin_context = ctx

        await self.adapter._handle_callback_query(update, None)

        query.message.reply_photo.assert_awaited_once()
        reply = query.message.reply_photo.await_args.kwargs
        self.assertEqual(reply["photo"], "https://image.test/best.jpg")
        self.assertEqual(reply["caption"], "🎬 Лучший фильм")
        self.assertEqual(reply["parse_mode"], "HTML")
        query.message.delete.assert_awaited_once_with()
        query.message.edit_text.assert_not_awaited()
        query.message.edit_media.assert_not_awaited()
        replacement = query.message.reply_photo.return_value
        self.assertTrue(
            self.adapter._media_panel_has_photo(
                replacement, "https://image.test/best.jpg"
            )
        )
        ctx.dispatch_tool.assert_called_once_with(
            "mcp__media_admin__media_best",
            {"media_type": "movie", "page": 1, "ranking": "top_rated"},
        )

    async def test_media_home_reuses_existing_photo_message(self):
        update, query = callback_update("mp:home")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True

        with mock.patch.object(
            self.adapter,
            "_media_dashboard_photo",
            mock.AsyncMock(return_value="https://example.test/dashboard.jpg"),
        ):
            await self.adapter._handle_callback_query(update, None)

        query.message.edit_media.assert_awaited_once()
        media = query.message.edit_media.await_args.args[0]
        self.assertEqual(media.media, "https://example.test/dashboard.jpg")
        self.assertEqual(media.caption, "🎬 <b>Медиа</b>\n\nВыберите раздел.")
        query.message.reply_text.assert_not_awaited()
        query.message.delete.assert_not_awaited()

    async def test_trending_error_keeps_retry_category_page_and_back_shell(self):
        update, query = callback_update("mt:l:t:3:0:0")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True

        with mock.patch.object(
            self.adapter, "_trending_payload", mock.AsyncMock(return_value=None)
        ):
            await self.adapter._handle_callback_query(update, None)

        markup = query.message.edit_text.await_args.kwargs["reply_markup"]
        buttons = [button for row in markup.inline_keyboard for button in row]
        self.assertEqual(
            [button.text for button in buttons],
            ["Фильмы", "✅ Сериалы", "Все", "🔄 Повторить", "⬅️ Назад"],
        )
        self.assertEqual(buttons[-2].callback_data, "mt:l:t:3:0:0")

    async def test_stale_trending_identity_keeps_retry_and_exact_list_back(self):
        update, query = callback_update("mt:d:t:3:1:99")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        payload = {
            "category": "tv",
            "page": 3,
            "total_pages": 4,
            "results": [{"tmdb_id": 42, "media_type": "tv", "title": "Другой"}],
        }
        with mock.patch.object(
            self.adapter, "_trending_payload", mock.AsyncMock(return_value=payload)
        ):
            await self.adapter._handle_callback_query(update, None)

        markup = query.message.edit_text.await_args.kwargs["reply_markup"]
        buttons = [button for row in markup.inline_keyboard for button in row]
        self.assertEqual(buttons[-2].callback_data, "mt:d:t:3:1:99")
        self.assertEqual(buttons[-1].callback_data, "mt:l:t:3:0:0")

    async def test_similar_error_keeps_retry_page_and_exact_back_shell(self):
        update, query = callback_update("mi:l:t:42:3:0:0")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True

        with mock.patch.object(
            self.adapter, "_similar_payload", mock.AsyncMock(return_value=None)
        ):
            await self.adapter._handle_callback_query(update, None)

        markup = query.message.edit_text.await_args.kwargs["reply_markup"]
        buttons = [button for row in markup.inline_keyboard for button in row]
        self.assertEqual([button.text for button in buttons], ["🔄 Повторить", "⬅️ Назад"])
        self.assertEqual(buttons[0].callback_data, "mi:l:t:42:3:0:0")
        self.assertEqual(buttons[1].callback_data, "mx:d:t:42:0")

    async def test_stale_similar_identity_keeps_retry_and_exact_list_back(self):
        update, query = callback_update("mi:d:t:42:3:1:99")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        payload = {
            "page": 3,
            "total_pages": 4,
            "results": [{"tmdb_id": 7, "media_type": "tv", "title": "Другой"}],
        }
        with mock.patch.object(
            self.adapter, "_similar_payload", mock.AsyncMock(return_value=payload)
        ):
            await self.adapter._handle_callback_query(update, None)

        markup = query.message.edit_text.await_args.kwargs["reply_markup"]
        buttons = [button for row in markup.inline_keyboard for button in row]
        self.assertEqual(buttons[0].callback_data, "mi:d:t:42:3:1:99")
        self.assertEqual(buttons[1].callback_data, "mi:l:t:42:3:0:0")

    async def test_trending_details_truncate_long_overview_at_word_boundary(self):
        update, query = callback_update("mt:d:t:1:0:2")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        payload = {
            "source": "tmdb",
            "category": "tv",
            "page": 1,
            "total_pages": 1,
            "results": [{
                "tmdb_id": 2,
                "media_type": "tv",
                "title": "Длинный сериал",
                "overview": "Очень длинное описание сериала " * 100,
            }],
        }
        details = {
            **payload["results"][0],
            "season_count": 12,
            "episode_count": 240,
        }
        with (
            mock.patch.object(
                self.adapter,
                "_trending_payload",
                mock.AsyncMock(return_value=payload),
            ),
            mock.patch.object(
                self.adapter,
                "_details_payload",
                mock.AsyncMock(return_value=details),
            ),
        ):
            await self.adapter._handle_callback_query(update, None)

        query.message.edit_media.assert_awaited_once()
        media = query.message.edit_media.await_args.args[0]
        self.assertIsInstance(media.media, FakeInputFile)
        self.assertEqual(media.media.filename, "media-menu.jpg")
        self.assertTrue(media.media.attach)
        caption = media.caption
        self.assertLessEqual(len(caption), 1024)
        self.assertEqual(media.parse_mode, "HTML")
        self.assertIn("<blockquote expandable>", caption)
        self.assertIn("\n📺 12 сезонов • 240 серий\n", caption)
        self.assertTrue(caption.endswith("</blockquote>"))
        self.assertIn("…</blockquote>", caption)
        self.assertNotIn("описани…", caption)

    def test_trending_details_escape_html_inside_expandable_description(self):
        card = self.plugin.render_direct_details({
            "tmdb_id": 7,
            "media_type": "movie",
            "title": "A & B <Final>",
            "countries": ["US & CA"],
            "overview": "One < two & three > one.",
        })

        self.assertIsNotNone(card)
        self.assertEqual(card.parse_mode, "HTML")
        self.assertIn("A &amp; B &lt;Final&gt;", card.text)
        self.assertNotIn("US &amp; CA", card.text)
        self.assertIn("One &lt; two &amp; three &gt; one.", card.text)
        self.assertTrue(card.text.endswith("</blockquote>"))

    def test_trending_details_localize_facts_and_hide_empty_values(self):
        card = self.plugin.render_direct_details({
            "tmdb_id": 7,
            "media_type": "tv",
            "title": "Дом Дракона",
            "original_title": "House of the Dragon",
            "release_date": "2022-08-21",
            "rating": 8.4,
            "countries": ["United States of America"],
            "genres": ["Drama", "НФ и Фэнтези", "Боевик и Приключения"],
            "status": "Returning Series",
            "overview": "История дома Таргариенов.",
            "trailer_url": "https://www.youtube.com/watch?v=trailer",
            "tmdb_url": "https://www.themoviedb.org/tv/94997",
            "imdb_url": "https://www.imdb.com/title/tt11198330/",
            "season_count": 3,
            "episode_count": 26,
            "next_episode": {
                "season": 3,
                "episode": 8,
                "air_date": "2026-08-11",
            },
        })

        self.assertIsNotNone(card)
        self.assertTrue(
            card.text.startswith(
                "<b>📺 Дом Дракона / House of the Dragon</b>\n"
                "📅 2022 • августа 2022\n"
                "TMDb: ⭐⭐⭐⭐ 8.4/10\n"
                "📺 3 сезона • 26 серий\n"
            )
        )
        self.assertIn(
            '🎬 <a href="https://www.youtube.com/watch?v=trailer">Трейлер</a> | '
            '⭐ <a href="https://www.themoviedb.org/tv/94997">TMDb</a> | '
            '⭐ <a href="https://www.imdb.com/title/tt11198330/">IMDb</a>',
            card.text,
        )
        self.assertIn("\n🟢 Продолжается\n", card.text)
        self.assertIn("\n🔔 Следующая серия: S03E08 · 11 августа 2026\n", card.text)
        self.assertEqual(card.text.count("S03"), 1)
        self.assertIn("<blockquote expandable>🌍 США", card.text)
        self.assertIn(
            "📺 драма • 📺 фантастика и фэнтези • 📺 боевик и приключения",
            card.text,
        )
        self.assertIn("\n\nИстория дома Таргариенов.</blockquote>", card.text)

        empty_card = self.plugin.render_direct_details({
            "tmdb_id": 8,
            "media_type": "tv",
            "title": "Новый сериал",
            "rating": 0.0,
            "countries": [],
            "season_count": 0,
            "episode_count": 0,
        })
        self.assertIsNotNone(empty_card)
        self.assertNotIn("⭐", empty_card.text)
        self.assertNotIn("🌍", empty_card.text)
        self.assertNotIn("сезон", empty_card.text.lower())
        self.assertNotIn("эпизод", empty_card.text.lower())

        unknown_card = self.plugin.render_direct_details({
            "tmdb_id": 9,
            "media_type": "tv",
            "title": "Неизвестный сериал",
            "countries": ["Unknown Republic"],
            "genres": ["Provider Experimental"],
            "status": "Provider Pending",
            "overview": "Описание остаётся.",
        })
        self.assertIsNotNone(unknown_card)
        self.assertNotIn("Unknown Republic", unknown_card.text)
        self.assertNotIn("Provider Experimental", unknown_card.text)
        self.assertNotIn("Provider Pending", unknown_card.text)
        self.assertIn("Описание остаётся.", unknown_card.text)

    def test_russian_media_count_forms_cover_1_2_5_11_and_21(self):
        expected = {
            1: ("1 вариант", "1 озвучка", "1 серия"),
            2: ("2 варианта", "2 озвучки", "2 серии"),
            5: ("5 вариантов", "5 озвучек", "5 серий"),
            11: ("11 вариантов", "11 озвучек", "11 серий"),
            21: ("21 вариант", "21 озвучка", "21 серия"),
        }

        for count, forms in expected.items():
            with self.subTest(count=count):
                self.assertEqual(self.plugin.media_search_module._variant_count(count), forms[0])
                self.assertEqual(self.plugin.media_search_module._voiceover_count(count), forms[1])
                self.assertEqual(self.plugin._episode_count_label(count), forms[2])

    async def test_photo_transition_falls_back_to_the_same_text_message(self):
        _update, query = callback_update("unused")
        query.message.edit_media.side_effect = self.plugin.BadRequest("bad poster")
        part = self.plugin.RenderedSearchPart(
            "🔎 Карточка релиза",
            (),
            "https://example.test/broken.jpg",
        )

        await self.adapter._present_search_part(
            query.message,
            part,
            self.adapter._media_action_store,
            replace=True,
        )

        query.message.edit_media.assert_awaited_once()
        query.message.edit_text.assert_awaited_once_with(
            "🔎 Карточка релиза",
            reply_markup=None,
        )
        query.message.reply_photo.assert_not_awaited()

    async def test_photo_transition_uses_local_fallback_poster(self):
        _update, query = callback_update("unused")
        query.message.photo = (object(),)
        query.message.edit_media.side_effect = [
            self.plugin.BadRequest("bad poster"),
            None,
        ]
        part = self.plugin.RenderedSearchPart(
            "🔎 Карточка релиза",
            (),
            "https://example.test/broken.jpg",
        )

        await self.adapter._present_search_part(
            query.message,
            part,
            self.adapter._media_action_store,
            replace=True,
        )

        self.assertEqual(query.message.edit_media.await_count, 2)
        fallback = query.message.edit_media.await_args_list[1].args[0]
        self.assertIsInstance(fallback.media, FakeInputFile)
        self.assertEqual(fallback.media.filename, "media-fallback.webp")
        self.assertTrue(fallback.media.attach)
        query.message.edit_caption.assert_not_awaited()

    async def test_double_photo_failure_does_not_cache_the_requested_poster(self):
        _update, query = callback_update("unused")
        query.message.photo = (object(),)
        self.adapter._remember_media_panel_photo(
            query.message, "https://example.test/current.jpg"
        )
        query.message.edit_media.side_effect = [
            self.plugin.BadRequest("bad poster"),
            self.plugin.BadRequest("bad fallback"),
        ]

        await self.adapter._edit_or_reuse_photo_card(
            query.message,
            "https://example.test/requested.jpg",
            "Карточка",
            None,
        )

        self.assertEqual(query.message.edit_media.await_count, 2)
        query.message.edit_caption.assert_awaited_once()
        self.assertFalse(
            self.adapter._media_panel_has_photo(
                query.message, "https://example.test/requested.jpg"
            )
        )
        self.assertTrue(
            self.adapter._media_panel_has_photo(
                query.message, "https://example.test/current.jpg"
            )
        )

    async def test_reused_photo_treats_not_modified_as_success(self):
        _update, query = callback_update("unused")
        query.message.photo = (object(),)
        poster = "https://example.test/current.jpg"
        self.adapter._remember_media_panel_photo(query.message, poster)
        query.message.edit_caption.side_effect = self.plugin.BadRequest(
            "Message is not modified"
        )

        await self.adapter._edit_or_reuse_photo_card(
            query.message,
            poster,
            "Та же карточка",
            None,
        )

        query.message.edit_caption.assert_awaited_once()
        query.message.edit_media.assert_not_awaited()

    async def test_discovery_acknowledges_before_tmdb_io(self):
        update, query = callback_update("mx:d:m:42:0")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        events = []
        query.answer.side_effect = lambda **_kwargs: events.append("ack")

        async def details(*_args):
            events.append("tmdb")
            return {"tmdb_id": 42, "media_type": "movie", "title": "Фильм"}

        with mock.patch.object(self.adapter, "_details_payload", side_effect=details):
            await self.adapter._handle_callback_query(update, None)

        self.assertEqual(events[:2], ["ack", "tmdb"])
        query.answer.assert_awaited_once_with()

    async def test_tracking_create_passes_resolved_identity_and_poster_for_both_scopes(self):
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        for action, scope in (("i", "personal"), ("f", "family")):
            with self.subTest(scope=scope):
                update, query = callback_update(f"mx:{action}:t:42:0")
                events = []
                query.answer.side_effect = lambda **_kwargs: events.append("ack")

                async def details(*_args):
                    events.append("tmdb")
                    return {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}

                ctx = mock.Mock()

                def dispatch(*_args, **_kwargs):
                    events.append("schedule")
                    return json.dumps({
                        "structuredContent": {
                            "status": "matched",
                            "source": "tvmaze",
                            "show": {
                                "source_id": 81228,
                                "poster_url": "https://static.tvmaze.com/poster.jpg",
                            },
                            "schedule": [{
                                "season": 1,
                                "episode": 2,
                                "air_at": "2020-01-01T00:00:00Z",
                            }],
                        }
                    })

                ctx.dispatch_tool.side_effect = dispatch
                self.adapter._media_plugin_context = ctx

                async def create(*_args, **_kwargs):
                    events.append("create")
                    return 0, b"{}"

                with (
                    mock.patch.object(
                        self.adapter, "_details_payload", side_effect=details
                    ),
                    mock.patch.object(
                        self.plugin, "_run_media", side_effect=create
                    ) as run_media,
                    mock.patch.object(
                        self.adapter, "_show_tracking_management", mock.AsyncMock()
                    ),
                ):
                    await self.adapter._handle_callback_query(update, None)

                self.assertEqual(events, ["ack", "tmdb", "schedule", "create"])
                query.answer.assert_awaited_once_with()
                run_media.assert_awaited_once_with(
                    (
                        "mcp__media_admin__media_tracking_create",
                        {
                            "provider": "rezka",
                            "title": "Сериал",
                            "translation": "release-calendar",
                            "known_episodes": [{"season": 1, "episode": 2}],
                            "scope": scope,
                            "series_ongoing": True,
                            "release_identity": {
                                "source": "tvmaze",
                                "source_id": 81228,
                            },
                            "poster_url": "https://static.tvmaze.com/poster.jpg",
                        },
                    ),
                    ctx,
                )

    async def test_tracking_setup_toggles_autodownload_in_same_card(self):
        update, query = callback_update("mx:o:t:42:0")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        details = {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}

        with mock.patch.object(
            self.adapter, "_details_payload", mock.AsyncMock(return_value=details)
        ):
            await self.adapter._handle_callback_query(update, None)

        query.answer.assert_awaited_once_with()
        edit = query.message.edit_caption.await_args.kwargs
        self.assertIn("✅ Автоскачивание", edit["caption"])
        rows = edit["reply_markup"].inline_keyboard
        self.assertEqual(rows[0][0].callback_data, "mx:n:t:42:0")
        self.assertEqual(
            [button.callback_data for button in rows[1]],
            ["mx:x:t:42:0", "mx:y:t:42:0"],
        )

    async def test_tracking_autodownload_searches_rezka_once_for_both_scopes(self):
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        output = json.dumps({
            "session_id": "00000000-0000-0000-0000-000000000111",
            "source": "rezka",
            "expires_at": "2099-07-27T12:00:00Z",
            "results": [],
        }).encode()
        for action, scope in (("x", "personal"), ("y", "family")):
            with self.subTest(scope=scope):
                update, query = callback_update(f"mx:{action}:t:42:0")
                details = {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}
                arguments = {
                    "provider": "rezka",
                    "title": "Сериал",
                    "translation": "release-calendar",
                    "known_episodes": [{"season": 2, "episode": 7}],
                    "scope": scope,
                    "series_ongoing": True,
                    "release_identity": {"source": "tvmaze", "source_id": 81228},
                }
                with (
                    mock.patch.object(
                        self.adapter, "_details_payload", mock.AsyncMock(return_value=details)
                    ),
                    mock.patch.object(
                        self.adapter,
                        "_prepare_tracking_create",
                        mock.AsyncMock(return_value=(arguments, 2, 7)),
                    ) as prepare,
                    mock.patch.object(
                        self.plugin,
                        "_search_media_mcp",
                        mock.AsyncMock(return_value=(0, output)),
                    ) as search,
                ):
                    await self.adapter._handle_callback_query(update, None)

                query.answer.assert_awaited_once_with(text="Ищу варианты…")
                prepare.assert_awaited_once_with(details, scope)
                search.assert_awaited_once_with(
                    self.adapter._media_plugin_context,
                    "rezka",
                    query="Сериал",
                    media_kind="series",
                    season=2,
                    tmdb_id=42,
                )
                self.assertIn(
                    "На Rezka пока нет подходящего релиза",
                    query.message.edit_text.await_args.args[0],
                )

    async def test_direct_tracking_create_is_exact_once_across_replay_and_restart(self):
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        path = pathlib.Path(self.temp_dir.name) / "media-business-actions.json"
        details = {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}
        prepared = ({"title": "Сериал"}, 1, 1)
        for action in ("i", "f"):
            with self.subTest(action=action):
                self.adapter._business_action_receipt_store = (
                    self.plugin.BusinessActionReceiptStore(
                        path, now=lambda: 100.0, owner=f"first-{action}"
                    )
                )
                update, query = callback_update(f"mx:{action}:t:42:0")
                with (
                    mock.patch.object(
                        self.adapter, "_details_payload", mock.AsyncMock(return_value=details)
                    ),
                    mock.patch.object(
                        self.adapter,
                        "_prepare_tracking_create",
                        mock.AsyncMock(return_value=prepared),
                    ),
                    mock.patch.object(
                        self.plugin, "_run_media", mock.AsyncMock(return_value=(0, b"{}"))
                    ) as run_media,
                    mock.patch.object(
                        self.adapter, "_show_tracking_management", mock.AsyncMock()
                    ),
                ):
                    await self.adapter._handle_callback_query(update, None)
                    await self.adapter._handle_callback_query(update, None)
                    self.adapter._business_action_receipt_store = (
                        self.plugin.BusinessActionReceiptStore(
                            path,
                            now=lambda: 100.0
                            + self.plugin._BUSINESS_ACTION_CLAIM_TTL_SECONDS,
                            owner=f"restart-{action}",
                        )
                    )
                    await self.adapter._handle_callback_query(update, None)

                run_media.assert_awaited_once()

    async def test_direct_tracking_create_concurrent_taps_dispatch_once_for_both_scopes(self):
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        details = {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}
        for action in ("i", "f"):
            with self.subTest(action=action):
                first_update, _first_query = callback_update(f"mx:{action}:t:42:0")
                second_update, _second_query = callback_update(f"mx:{action}:t:42:0")
                entered = asyncio.Event()
                finish = asyncio.Event()

                async def dispatch(*_args, **_kwargs):
                    entered.set()
                    await finish.wait()
                    return 0, b"{}"

                with (
                    mock.patch.object(
                        self.adapter, "_details_payload", mock.AsyncMock(return_value=details)
                    ),
                    mock.patch.object(
                        self.adapter,
                        "_prepare_tracking_create",
                        mock.AsyncMock(return_value=({"title": "Сериал"}, 1, 1)),
                    ),
                    mock.patch.object(self.plugin, "_run_media", side_effect=dispatch) as run_media,
                    mock.patch.object(
                        self.adapter, "_show_tracking_management", mock.AsyncMock()
                    ),
                ):
                    first = asyncio.create_task(
                        self.adapter._handle_callback_query(first_update, None)
                    )
                    await asyncio.wait_for(entered.wait(), 1)
                    await self.adapter._handle_callback_query(second_update, None)
                    finish.set()
                    await asyncio.wait_for(first, 1)

                run_media.assert_awaited_once()

    async def test_direct_tracking_create_ack_failure_releases_for_retry(self):
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        details = {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}
        for action in ("i", "f"):
            with self.subTest(action=action):
                failed_update, failed_query = callback_update(f"mx:{action}:t:42:0")
                failed_query.answer.side_effect = self.plugin.BadRequest("Query is too old")
                retry_update, _retry_query = callback_update(f"mx:{action}:t:42:0")
                with (
                    mock.patch.object(
                        self.adapter, "_details_payload", mock.AsyncMock(return_value=details)
                    ),
                    mock.patch.object(
                        self.adapter,
                        "_prepare_tracking_create",
                        mock.AsyncMock(return_value=({"title": "Сериал"}, 1, 1)),
                    ),
                    mock.patch.object(
                        self.plugin, "_run_media", mock.AsyncMock(return_value=(0, b"{}"))
                    ) as run_media,
                    mock.patch.object(
                        self.adapter, "_show_tracking_management", mock.AsyncMock()
                    ),
                ):
                    await self.adapter._handle_callback_query(failed_update, None)
                    await self.adapter._handle_callback_query(retry_update, None)

                run_media.assert_awaited_once()

    async def test_direct_tracking_create_cancel_after_dispatch_stays_consumed(self):
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        details = {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}
        for action in ("i", "f"):
            with self.subTest(action=action):
                update, _query = callback_update(f"mx:{action}:t:42:0")
                with (
                    mock.patch.object(
                        self.adapter, "_details_payload", mock.AsyncMock(return_value=details)
                    ),
                    mock.patch.object(
                        self.adapter,
                        "_prepare_tracking_create",
                        mock.AsyncMock(return_value=({"title": "Сериал"}, 1, 1)),
                    ),
                    mock.patch.object(
                        self.plugin,
                        "_run_media",
                        mock.AsyncMock(side_effect=asyncio.CancelledError),
                    ) as run_media,
                ):
                    with self.assertRaises(asyncio.CancelledError):
                        await self.adapter._handle_callback_query(update, None)
                    await self.adapter._handle_callback_query(update, None)

                run_media.assert_awaited_once()

    async def test_direct_tracking_create_cancel_before_dispatch_releases_for_retry(self):
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        details = {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}
        for action in ("i", "f"):
            with self.subTest(action=action):
                update, _query = callback_update(f"mx:{action}:t:42:0")
                prepare = mock.AsyncMock(
                    side_effect=[
                        asyncio.CancelledError,
                        ({"title": "Сериал"}, 1, 1),
                    ]
                )
                with (
                    mock.patch.object(
                        self.adapter, "_details_payload", mock.AsyncMock(return_value=details)
                    ),
                    mock.patch.object(
                        self.adapter, "_prepare_tracking_create", prepare
                    ),
                    mock.patch.object(
                        self.plugin, "_run_media", mock.AsyncMock(return_value=(0, b"{}"))
                    ) as run_media,
                    mock.patch.object(
                        self.adapter, "_show_tracking_management", mock.AsyncMock()
                    ),
                ):
                    with self.assertRaises(asyncio.CancelledError):
                        await self.adapter._handle_callback_query(update, None)
                    await self.adapter._handle_callback_query(update, None)

                run_media.assert_awaited_once()
    async def test_tracking_translation_creates_exact_download_payload(self):
        create_arguments = {
            "provider": "rezka",
            "title": "Сериал",
            "translation": "release-calendar",
            "known_episodes": [{"season": 2, "episode": 7}],
            "scope": "personal",
            "series_ongoing": True,
            "release_identity": {"source": "tvmaze", "source_id": 81228},
        }
        output = json.dumps({
            "session_id": "00000000-0000-0000-0000-000000000111",
            "source": "rezka",
            "expires_at": "2099-07-27T12:00:00Z",
            "results": [{
                "source": "rezka",
                "result_id": "rezka:90825",
                "title": "Сериал",
                "translations": [
                    {"id": 999, "name": "Premium", "premium": True},
                    {"id": 224, "name": "AniLibria", "premium": False},
                ],
            }],
        }).encode()
        rendered = self.plugin._render_source_search(
            output,
            "rezka",
            2,
            0,
            carousel=True,
            tracking_context={"create_arguments": create_arguments},
        )
        self.assertIsNotNone(rendered)
        self.assertNotIn("Premium", rendered.text)
        action = next(item for item in rendered.actions if item.kind == "tracking-create")
        self.assertEqual(action.payload["provider_media_ref"], "90825")
        self.assertEqual(action.payload["translation_id"], 224)
        token = self.adapter._media_action_store.create(action)
        update, query = callback_update(f"md:{token}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        with mock.patch.object(
            self.plugin, "_run_media", mock.AsyncMock(return_value=(0, b"{}"))
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)

        query.answer.assert_awaited_once_with()
        run_media.assert_awaited_once_with(
            (
                "mcp__media_admin__media_tracking_create",
                {
                    **create_arguments,
                    "translation": "AniLibria",
                    "download": {
                        "provider_media_ref": "90825",
                        "translation_id": 224,
                        "season": 2,
                    },
                },
            ),
            mock.ANY,
        )
        self.assertIn("Отслеживание настроено", query.message.edit_text.await_args.args[0])

    async def test_tv_tracking_state_matches_only_exact_release_identity_and_caches_pages(self):
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = json.dumps({
            "structuredContent": {
                "status": "matched",
                "source": "tvmaze",
                "show": {"source_id": 81228},
                "schedule": [],
            }
        })
        self.adapter._media_plugin_context = ctx
        items = [{
            "id": TRACKING_ID,
            "title": "Другой заголовок",
            "scope": "personal",
            "release_identity": {"source": "tvmaze", "source_id": 81228},
        }, {
            "id": "same-title-wrong-identity",
            "title": "Сериал",
            "scope": "family",
            "release_identity": {"source": "tvmaze", "source_id": 99999},
        }]
        pages = mock.AsyncMock(return_value=(
            0, json.dumps({"tracking": items}).encode()
        ))
        details = {
            "tmdb_id": 42,
            "media_type": "tv",
            "title": "Сериал",
            "original_title": "Series",
            "year": 2026,
        }

        with mock.patch.object(self.plugin, "_tracking_pages", pages):
            first = await self.adapter._tv_tracking_state(details)
            second = await self.adapter._tv_tracking_state(details)

        self.assertEqual([item["id"] for item in first["matches"]], [TRACKING_ID])
        self.assertIs(first, second)
        pages.assert_awaited_once()
        ctx.dispatch_tool.assert_called_once_with(
            "mcp__media_admin__media_release_schedule",
            {"title": "Сериал", "original_title": "Series", "year": 2026},
        )

    async def test_tv_tracking_cache_is_bounded_and_invalidated_after_mutation(self):
        self.adapter._media_plugin_context = mock.Mock()
        cache = self.adapter._tv_tracking_cache_store()
        for index in range(self.adapter._MAX_TV_TRACKING_CACHE + 1):
            cache[index] = {"matches": ()}
            cache.move_to_end(index)
            while len(cache) > self.adapter._MAX_TV_TRACKING_CACHE:
                cache.popitem(last=False)
        self.adapter._tv_tracking_items = (1, ())

        self.assertEqual(len(cache), self.adapter._MAX_TV_TRACKING_CACHE)
        self.assertNotIn(0, cache)
        self.adapter._invalidate_tv_tracking_cache()
        self.assertEqual(cache, {})
        self.assertIsNone(self.adapter._tv_tracking_items)

    async def test_inflight_tracking_lookup_cannot_repopulate_invalidated_cache(self):
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = json.dumps({
            "structuredContent": {
                "status": "matched",
                "source": "tvmaze",
                "show": {"source_id": 81228},
                "schedule": [],
            }
        })
        self.adapter._media_plugin_context = ctx

        async def invalidate_during_list(*_args, **_kwargs):
            self.adapter._invalidate_tv_tracking_cache()
            return 0, json.dumps({"tracking": []}).encode()

        with mock.patch.object(
            self.plugin, "_tracking_pages", side_effect=invalidate_during_list
        ):
            state = await self.adapter._tv_tracking_state({
                "tmdb_id": 42,
                "media_type": "tv",
                "title": "Сериал",
            })

        self.assertEqual(state["matches"], ())
        self.assertEqual(self.adapter._tv_tracking_cache_store(), {})
        self.assertIsNone(self.adapter._tv_tracking_items)

    async def test_tv_detail_tracking_button_reflects_exact_state(self):
        details = {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}
        card = self.plugin.render_direct_details(details)
        with mock.patch.object(
            self.adapter,
            "_tv_tracking_state",
            mock.AsyncMock(return_value={"matches": ({"id": TRACKING_ID},)}),
        ):
            tracked = await self.adapter._decorate_tv_tracking_card(card, details)
        with mock.patch.object(
            self.adapter,
            "_tv_tracking_state",
            mock.AsyncMock(return_value={"matches": ()}),
        ):
            untracked = await self.adapter._decorate_tv_tracking_card(card, details)

        self.assertEqual(tracked.buttons[1][0].label, "🔔 Отслеживание")
        self.assertEqual(untracked.buttons[1][0].label, "🔕 Отслеживание")
        self.assertEqual(tracked.buttons[1][0].callback_data, "mx:t:t:42:0")

    async def test_tv_detail_tracking_button_is_neutral_when_state_is_unavailable(self):
        details = {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}
        card = self.plugin.render_direct_details(details)
        with mock.patch.object(
            self.adapter,
            "_tv_tracking_state",
            mock.AsyncMock(return_value=None),
        ):
            unavailable = await self.adapter._decorate_tv_tracking_card(card, details)

        self.assertEqual(unavailable.buttons[1][0].label, "🔄 Обновить")
        self.assertEqual(unavailable.buttons[1][0].callback_data, "mx:t:t:42:0")

    async def test_tracking_configuration_continuation_persists_mode_and_exact_back(self):
        tracking_context = {
            "mode": "configure",
            "tmdb_id": 42,
            "tracking_id": TRACKING_ID,
        }
        output = json.dumps({
            "session_id": "00000000-0000-0000-0000-000000000111",
            "source": "rezka",
            "expires_at": "2099-07-27T12:00:00Z",
            "continuation": "next-rezka-page",
            "results": [{
                "source": "rezka",
                "result_id": "rezka:90825",
                "title": "Сериал",
                "translations": [{"id": 224, "name": "AniLibria"}],
            }],
        }).encode()
        back = self.plugin.SearchAction(
            "⬅️ Назад",
            "tracking-back",
            {"tmdb_id": 42, "tracking_id": TRACKING_ID},
            "2099-07-27T12:00:00Z",
        )
        rendered = self.plugin._render_source_search(
            output,
            "rezka",
            2,
            0,
            back,
            carousel=True,
            tracking_context=tracking_context,
        )

        self.assertIsNotNone(rendered)
        self.assertTrue(any(
            action.kind == "tracking-enable-download" for action in rendered.actions
        ))
        exact_back = next(
            action for action in rendered.actions if action.kind == "release-back"
        )
        self.assertEqual(exact_back.payload["source_back"]["kind"], "tracking-back")
        self.assertEqual(
            exact_back.payload["source_back"]["payload"],
            {"tmdb_id": 42, "tracking_id": TRACKING_ID},
        )
        continuation = next(
            action for action in rendered.actions if action.kind == "continue"
        )
        self.assertEqual(continuation.payload["tracking_context"], tracking_context)
        source_list = self.plugin._render_source_search(
            output,
            "rezka",
            2,
            0,
            back,
            carousel=False,
            combined_context={
                "search_pages": [],
                "failed_providers": [],
                "season": 2,
                "episode": 0,
                "tracking_context": tracking_context,
            },
            tracking_context=tracking_context,
        )
        source_continue = next(
            action for action in source_list.actions if action.kind == "continue"
        )
        self.assertEqual(source_continue.payload["tracking_context"], tracking_context)
        self.assertIsInstance(source_continue.payload["combined_context"], dict)

        token = self.adapter._media_action_store.create(continuation)
        restarted_store = self.plugin.MediaActionStore(
            pathlib.Path(self.temp_dir.name) / "media-actions.json"
        )
        persisted, consumed = restarted_store.resolve(token)
        self.assertFalse(consumed)
        self.assertEqual(persisted.payload["tracking_context"], tracking_context)
        self.adapter._media_action_store = restarted_store
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        next_output = json.dumps({
            "session_id": "00000000-0000-0000-0000-000000000222",
            "source": "rezka",
            "expires_at": "2099-07-27T12:00:00Z",
            "results": [{
                "source": "rezka",
                "result_id": "rezka:90826",
                "title": "Сериал, второй вариант",
                "translations": [{"id": 225, "name": "LostFilm"}],
            }],
        }).encode()
        update, query = callback_update(f"md:{token}")
        with mock.patch.object(
            self.plugin,
            "_search_media_mcp",
            mock.AsyncMock(return_value=(0, next_output)),
        ) as search:
            await self.adapter._handle_callback_query(update, None)

        query.answer.assert_awaited_once_with()
        search.assert_awaited_once_with(
            mock.ANY, "rezka", continuation="next-rezka-page"
        )
        markup = query.message.edit_text.await_args.kwargs["reply_markup"]
        next_actions = []
        for row in markup.inline_keyboard:
            for button in row:
                if isinstance(button.callback_data, str) and button.callback_data.startswith("md:"):
                    resolved = restarted_store.resolve(button.callback_data[3:])
                    if resolved is not None:
                        next_actions.append(resolved[0])
        enable = next(
            action for action in next_actions
            if action.kind == "tracking-enable-download"
        )
        self.assertEqual(enable.payload["tracking_context"], tracking_context)
        next_back = next(action for action in next_actions if action.kind == "release-back")
        self.assertEqual(next_back.payload["source_back"]["kind"], "tracking-back")
        self.assertEqual(
            next_back.payload["source_back"]["payload"],
            {"tmdb_id": 42, "tracking_id": TRACKING_ID},
        )

    def test_premium_translation_filter_is_fail_closed_for_tracking_and_download(self):
        translations = [
            {"id": 1, "name": "Missing flag"},
            {"id": 2, "name": "Explicit free", "premium": False},
            {"id": 3, "name": "Premium", "premium": True},
            {"id": 4, "name": "Numeric premium", "premium": 1},
            {"id": 5, "name": "String premium", "premium": "true"},
            {"id": 6, "name": "Null premium", "premium": None},
        ]
        output = json.dumps({
            "session_id": "00000000-0000-0000-0000-000000000111",
            "source": "rezka",
            "expires_at": "2099-07-27T12:00:00Z",
            "results": [{
                "source": "rezka",
                "result_id": "rezka:90825",
                "title": "Сериал",
                "translations": translations,
            }],
        }).encode()
        tracking = self.plugin._render_source_search(
            output,
            "rezka",
            2,
            0,
            carousel=True,
            tracking_context={
                "mode": "configure",
                "tmdb_id": 42,
                "tracking_id": TRACKING_ID,
            },
        )
        download = self.plugin._render_source_search(
            output, "rezka", 2, 0, carousel=True
        )

        self.assertIn("🎙 Missing flag", tracking.text)
        self.assertEqual(tracking.actions[1].label, "🎙 1/2")
        self.assertEqual(
            [action.label for action in tracking.actions
             if action.kind == "tracking-enable-download"],
            ["✅ Выбрать"],
        )
        self.assertIn("🎙 Missing flag", download.text)
        self.assertEqual(download.actions[1].label, "🎙 1/2")
        self.assertEqual(
            [action.label for action in download.actions if action.kind == "download"],
            ["⬇️ Скачать"],
        )
        for rendered in (tracking, download):
            self.assertNotIn("Premium", rendered.text)
            self.assertNotIn("Numeric premium", rendered.text)
            self.assertNotIn("String premium", rendered.text)
            self.assertNotIn("Null premium", rendered.text)

    async def test_tracking_management_back_restores_same_carousel_item(self):
        update, query = callback_update("mx:t:t:42:0")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        detail_route = "mt:d:a:7:3:42"
        self.adapter._media_navigation_reset(query.message, detail_route)
        details = {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}
        state = {"matches": (), "season": 1}
        with (
            mock.patch.object(
                self.adapter, "_details_payload", mock.AsyncMock(return_value=details)
            ),
            mock.patch.object(
                self.adapter, "_tv_tracking_state", mock.AsyncMock(return_value=state)
            ),
        ):
            await self.adapter._handle_callback_query(update, None)

        query.answer.assert_awaited_once_with()
        self.assertEqual(self.adapter._media_navigation_current(query.message), "mx:t:t:42:0")
        toggle_update, toggle_query = callback_update("mx:o:t:42:0")
        toggle_query.message = query.message
        with mock.patch.object(
            self.adapter, "_details_payload", mock.AsyncMock(return_value=details)
        ):
            await self.adapter._handle_callback_query(toggle_update, None)
        toggle_query.answer.assert_awaited_once_with()
        self.assertEqual(self.adapter._media_navigation_current(query.message), "mx:o:t:42:0")
        key = self.adapter._media_navigation_key(query.message)
        self.assertEqual(self.adapter._media_navigation_store.back(key), detail_route)
        markup = query.message.edit_text.await_args.kwargs["reply_markup"]
        self.assertEqual(markup.inline_keyboard[-1][0].callback_data, "mn:b")

    async def test_tracking_management_shows_all_matches_and_auto_download_state(self):
        _update, query = callback_update("unused")
        details = {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}
        matches = ({
            "id": "personal-one",
            "scope": "personal",
            "download": {"season": 2},
        }, {
            "id": "family-one",
            "scope": "family",
        })
        generation = self.adapter._media_panel_transition(query.message)

        await self.adapter._show_tracking_management(
            query.message,
            details,
            generation,
            state={"matches": matches, "season": 2},
        )

        markup = query.message.edit_text.await_args.kwargs["reply_markup"]
        labels = [button.text for row in markup.inline_keyboard for button in row]
        self.assertEqual(labels, [
            "👤 Личное · 1 · авто",
            "👥 Семейное · 2",
            "⬅️ Назад",
        ])
        callbacks = [
            button.callback_data for row in markup.inline_keyboard for button in row
        ]
        self.assertTrue(all(len(value.encode()) <= 64 for value in callbacks))

        query.message.edit_text.reset_mock()
        generation = self.adapter._media_panel_transition(query.message)
        await self.adapter._show_tracking_management(
            query.message,
            details,
            generation,
            selected_tracking_id="personal-one",
            state={"matches": matches, "season": 2},
        )
        text = query.message.edit_text.await_args.args[0]
        self.assertIn("👤 Личное", text)
        self.assertIn("Автоскачивание: включено", text)

    async def test_tracking_enable_download_refreshes_management_and_invalidates_cache(self):
        details = {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}
        selected = {
            "id": TRACKING_ID,
            "scope": "personal",
            "release_identity": {"source": "tvmaze", "source_id": 81228},
        }
        action = self.plugin.SearchAction(
            "AniLibria",
            "tracking-enable-download",
            {
                "tracking_context": {
                    "mode": "configure",
                    "tmdb_id": 42,
                    "tracking_id": TRACKING_ID,
                },
                "provider_media_ref": "90825",
                "translation_id": 224,
                "translation": "AniLibria",
                "season": 2,
            },
            "2099-07-27T12:00:00Z",
        )
        token = self.adapter._media_action_store.create(action)
        update, query = callback_update(f"md:{token}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.adapter._tv_tracking_cache_store()["cached"] = {"matches": ()}
        show = mock.AsyncMock()
        with (
            mock.patch.object(
                self.adapter,
                "_resolve_tracking_action",
                mock.AsyncMock(return_value=(details, {"matches": (selected,)}, selected)),
            ),
            mock.patch.object(self.plugin, "_run_media", mock.AsyncMock(return_value=(0, b"{}"))) as run_media,
            mock.patch.object(self.adapter, "_show_tracking_management", show),
        ):
            await self.adapter._handle_callback_query(update, None)

        query.answer.assert_awaited_once_with(text="Включаю автоскачивание…")
        run_media.assert_awaited_once_with((
            "mcp__media_admin__media_tracking_enable_download",
            {
                "tracking_id": TRACKING_ID,
                "translation": "AniLibria",
                "provider_media_ref": "90825",
                "translation_id": 224,
                "season": 2,
            },
        ), mock.ANY)
        self.assertEqual(self.adapter._tv_tracking_cache_store(), {})
        show.assert_awaited_once_with(
            query.message,
            details,
            mock.ANY,
            selected_tracking_id=TRACKING_ID,
        )

    async def test_tracking_create_failure_consumes_token_before_dispatch(self):
        action = self.plugin.SearchAction(
            "AniLibria",
            "tracking-create",
            {
                "tracking_context": {
                    "create_arguments": {
                        "provider": "rezka",
                        "title": "Сериал",
                        "scope": "personal",
                    },
                    "tmdb_id": 42,
                },
                "provider_media_ref": "90825",
                "translation_id": 224,
                "translation": "AniLibria",
                "season": 2,
            },
            "2099-07-27T12:00:00Z",
        )
        token = self.adapter._media_action_store.create(action)
        update, query = callback_update(f"md:{token}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True

        with mock.patch.object(
            self.plugin, "_run_media", mock.AsyncMock(return_value=(1, b"{}"))
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_awaited_once()
        callbacks = [
            button.callback_data
            for row in query.message.edit_text.await_args_list[0].kwargs[
                "reply_markup"
            ].inline_keyboard
            for button in row
        ]
        self.assertEqual(callbacks, ["mn:b"])

    async def test_tracking_create_predispatch_failure_renders_a_working_retry(self):
        action = self.plugin.SearchAction(
            "AniLibria",
            "tracking-create",
            {
                "tracking_context": {
                    "create_arguments": {
                        "provider": "rezka",
                        "title": "Сериал",
                        "scope": "personal",
                    },
                    "tmdb_id": 42,
                },
                "provider_media_ref": "90825",
                "translation_id": 224,
                "translation": "AniLibria",
                "season": 2,
            },
            "2099-07-27T12:00:00Z",
        )
        token = self.adapter._media_action_store.create(action)
        update, query = callback_update(f"md:{token}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.adapter._media_plugin_context = None

        with mock.patch.object(
            self.plugin,
            "_run_media",
            mock.AsyncMock(side_effect=[(127, b"{}"), (0, b"{}")]),
        ) as run_media:
            await self.adapter._handle_callback_query(update, None)
            first_markup = query.message.edit_text.await_args.kwargs["reply_markup"]
            retry_callback = first_markup.inline_keyboard[0][0].callback_data
            query.data = retry_callback
            self.adapter._media_plugin_context = mock.Mock()
            await self.adapter._handle_callback_query(update, None)

        self.assertTrue(retry_callback.startswith("md:"))
        self.assertEqual(run_media.await_count, 2)

    async def test_direct_tracking_create_preconsume_runtime_error_is_retryable(self):
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        update, query = callback_update("mx:i:t:42:0")
        details = {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}
        prepared = ({"title": "Сериал"}, 1, 1)

        with (
            mock.patch.object(
                self.adapter,
                "_details_payload",
                mock.AsyncMock(return_value=details),
            ),
            mock.patch.object(
                self.adapter,
                "_prepare_tracking_create",
                mock.AsyncMock(side_effect=[RuntimeError("lookup failed"), prepared]),
            ) as prepare,
            mock.patch.object(
                self.plugin,
                "_run_media",
                mock.AsyncMock(return_value=(0, b"{}")),
            ) as run_media,
            mock.patch.object(
                self.adapter, "_show_tracking_management", mock.AsyncMock()
            ),
        ):
            with self.assertRaises(RuntimeError):
                await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        self.assertEqual(prepare.await_count, 2)
        run_media.assert_awaited_once()

    async def test_direct_tracking_create_preconfirm_failure_renders_working_retry(self):
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        update, query = callback_update("mx:i:t:42:0")
        details = {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}
        self.adapter._media_plugin_context = None

        with mock.patch.object(
            self.adapter,
            "_details_payload",
            mock.AsyncMock(return_value=details),
        ):
            await self.adapter._handle_callback_query(update, None)

        first_markup = query.message.edit_text.await_args.kwargs["reply_markup"]
        callbacks = [
            button.callback_data
            for row in first_markup.inline_keyboard
            for button in row
        ]
        self.assertEqual(callbacks, ["mx:i:t:42:0", "mp:home"])

        self.adapter._media_plugin_context = mock.Mock()
        with (
            mock.patch.object(
                self.adapter,
                "_details_payload",
                mock.AsyncMock(return_value=details),
            ),
            mock.patch.object(
                self.adapter,
                "_prepare_tracking_create",
                mock.AsyncMock(return_value=({"title": "Сериал"}, 1, 1)),
            ),
            mock.patch.object(
                self.plugin,
                "_run_media",
                mock.AsyncMock(return_value=(0, b"{}")),
            ) as run_media,
            mock.patch.object(
                self.adapter, "_show_tracking_management", mock.AsyncMock()
            ),
        ):
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_awaited_once()

    async def test_direct_tracking_create_runtime_error_after_consume_stays_fenced(self):
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        update, query = callback_update("mx:i:t:42:0")
        details = {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}

        with (
            mock.patch.object(
                self.adapter,
                "_details_payload",
                mock.AsyncMock(return_value=details),
            ),
            mock.patch.object(
                self.adapter,
                "_prepare_tracking_create",
                mock.AsyncMock(return_value=({"title": "Сериал"}, 1, 1)),
            ),
            mock.patch.object(
                self.plugin,
                "_run_media",
                mock.AsyncMock(side_effect=RuntimeError("dispatch uncertain")),
            ) as run_media,
        ):
            with self.assertRaises(RuntimeError):
                await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_awaited_once()

    async def test_tracking_enable_failure_consumes_token_before_dispatch(self):
        details = {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}
        selected = {"id": TRACKING_ID, "scope": "personal"}
        action = self.plugin.SearchAction(
            "AniLibria",
            "tracking-enable-download",
            {
                "tracking_context": {
                    "mode": "configure",
                    "tmdb_id": 42,
                    "tracking_id": TRACKING_ID,
                },
                "provider_media_ref": "90825",
                "translation_id": 224,
                "translation": "AniLibria",
                "season": 2,
            },
            "2099-07-27T12:00:00Z",
        )
        token = self.adapter._media_action_store.create(action)
        update, query = callback_update(f"md:{token}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.adapter._media_plugin_context = mock.Mock()

        with (
            mock.patch.object(
                self.adapter,
                "_resolve_tracking_action",
                mock.AsyncMock(return_value=(details, {}, selected)),
            ),
            mock.patch.object(
                self.plugin, "_run_media", mock.AsyncMock(return_value=(127, b"{}"))
            ) as run_media,
        ):
            await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_awaited_once()

    async def test_tracking_enable_rc127_without_context_releases_for_retry(self):
        details = {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}
        selected = {"id": TRACKING_ID, "scope": "personal"}
        action = self.plugin.SearchAction(
            "AniLibria",
            "tracking-enable-download",
            {
                "tracking_context": {
                    "mode": "configure",
                    "tmdb_id": 42,
                    "tracking_id": TRACKING_ID,
                },
                "provider_media_ref": "90825",
                "translation_id": 224,
                "translation": "AniLibria",
                "season": 2,
            },
            "2099-07-27T12:00:00Z",
        )
        token = self.adapter._media_action_store.create(action)
        update, query = callback_update(f"md:{token}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        self.adapter._media_plugin_context = None

        with (
            mock.patch.object(
                self.adapter,
                "_resolve_tracking_action",
                mock.AsyncMock(return_value=(details, {}, selected)),
            ),
            mock.patch.object(
                self.plugin, "_run_media", mock.AsyncMock(return_value=(127, b"{}"))
            ) as run_media,
        ):
            await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        self.assertEqual(run_media.await_count, 2)

    async def test_tracking_remove_failure_consumes_token_before_dispatch(self):
        details = {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}
        selected = {"id": TRACKING_ID, "scope": "family"}
        action = self.plugin.SearchAction(
            "🗑 Отключить",
            "tracking-remove-confirm",
            {"tmdb_id": 42, "tracking_id": TRACKING_ID},
            "2099-07-27T12:00:00Z",
        )
        token = self.adapter._media_action_store.create(action)
        update, query = callback_update(f"md:{token}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True

        with (
            mock.patch.object(
                self.adapter,
                "_resolve_tracking_action",
                mock.AsyncMock(return_value=(details, {}, selected)),
            ),
            mock.patch.object(
                self.plugin, "_run_media", mock.AsyncMock(return_value=(1, b"{}"))
            ) as run_media,
        ):
            await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_awaited_once()

    async def test_tracking_remove_ack_failure_releases_token_before_dispatch(self):
        details = {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}
        selected = {"id": TRACKING_ID, "scope": "family"}
        action = self.plugin.SearchAction(
            "🗑 Отключить",
            "tracking-remove-confirm",
            {"tmdb_id": 42, "tracking_id": TRACKING_ID},
            "2099-07-27T12:00:00Z",
        )
        token = self.adapter._media_action_store.create(action)
        update, query = callback_update(f"md:{token}")
        query.answer.side_effect = [self.plugin.BadRequest("Query is too old"), None]
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True

        with (
            mock.patch.object(
                self.adapter,
                "_resolve_tracking_action",
                mock.AsyncMock(return_value=(details, {}, selected)),
            ),
            mock.patch.object(
                self.plugin, "_run_media", mock.AsyncMock(return_value=(0, b"{}"))
            ) as run_media,
            mock.patch.object(
                self.adapter, "_show_tracking_management", mock.AsyncMock()
            ),
        ):
            await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        run_media.assert_awaited_once()

    async def test_tracking_remove_requires_confirmation_and_cancel_is_safe(self):
        details = {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}
        selected = {"id": TRACKING_ID, "scope": "family"}
        state = {"matches": (selected,), "season": 1}
        prepare = self.plugin.SearchAction(
            "🗑 Отключить",
            "tracking-remove-prepare",
            {"tmdb_id": 42, "tracking_id": TRACKING_ID},
            "2099-07-27T12:00:00Z",
        )
        token = self.adapter._media_action_store.create(prepare)
        update, query = callback_update(f"md:{token}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        resolved = mock.AsyncMock(return_value=(details, state, selected))
        with mock.patch.object(self.adapter, "_resolve_tracking_action", resolved):
            await self.adapter._handle_callback_query(update, None)

        query.answer.assert_awaited_once_with()
        self.assertIn("Отключить отслеживание?", query.message.edit_text.await_args.args[0])
        markup = query.message.edit_text.await_args.kwargs["reply_markup"]
        buttons = [button for row in markup.inline_keyboard for button in row]
        self.assertEqual([button.text for button in buttons], ["🗑 Отключить", "⬅️ Назад"])

        cancel_update, cancel_query = callback_update(buttons[1].callback_data)
        cancel_query.message = query.message
        cancel_query.from_user = query.from_user
        show = mock.AsyncMock()
        with (
            mock.patch.object(self.adapter, "_resolve_tracking_action", resolved),
            mock.patch.object(self.adapter, "_show_tracking_management", show),
        ):
            await self.adapter._handle_callback_query(cancel_update, None)
        cancel_query.answer.assert_awaited_once_with()
        show.assert_awaited_once_with(
            query.message,
            details,
            mock.ANY,
            selected_tracking_id=TRACKING_ID,
            state=state,
        )

        confirm_update, confirm_query = callback_update(buttons[0].callback_data)
        confirm_query.message = query.message
        confirm_query.from_user = query.from_user
        refresh = mock.AsyncMock()
        with (
            mock.patch.object(self.adapter, "_resolve_tracking_action", resolved),
            mock.patch.object(self.plugin, "_run_media", mock.AsyncMock(return_value=(0, b"{}"))) as run_media,
            mock.patch.object(self.adapter, "_show_tracking_management", refresh),
        ):
            await self.adapter._handle_callback_query(confirm_update, None)
        confirm_query.answer.assert_awaited_once_with()
        run_media.assert_awaited_once_with((
            "mcp__media_admin__media_tracking_remove",
            {"tracking_id": TRACKING_ID},
        ), mock.ANY)
        refresh.assert_awaited_once_with(query.message, details, mock.ANY)

    async def test_tracking_manage_and_back_consume_only_after_successful_edit(self):
        details = {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}
        selected = {"id": TRACKING_ID, "scope": "personal"}
        state = {"matches": (selected,), "season": 1}
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True

        for kind in ("tracking-manage", "tracking-back"):
            with self.subTest(kind=kind):
                action = self.plugin.SearchAction(
                    "Назад",
                    kind,
                    {"tmdb_id": 42, "tracking_id": TRACKING_ID},
                    "2099-07-27T12:00:00Z",
                )
                token = self.adapter._media_action_store.create(action)
                update, query = callback_update(f"md:{token}")
                show = mock.AsyncMock(
                    side_effect=[self.plugin.BadRequest("edit failed"), True]
                )
                with (
                    mock.patch.object(
                        self.adapter,
                        "_resolve_tracking_action",
                        mock.AsyncMock(return_value=(details, state, selected)),
                    ),
                    mock.patch.object(
                        self.adapter, "_show_tracking_management", show
                    ),
                ):
                    await self.adapter._handle_callback_query(update, None)
                    await self.adapter._handle_callback_query(update, None)

                self.assertEqual(show.await_count, 2)
                resolved = self.adapter._media_action_store.resolve(token)
                self.assertIsNotNone(resolved)
                self.assertTrue(resolved[1])

    async def test_tracking_remove_prepare_consumes_only_after_successful_edit(self):
        details = {"tmdb_id": 42, "media_type": "tv", "title": "Сериал"}
        selected = {"id": TRACKING_ID, "scope": "family"}
        action = self.plugin.SearchAction(
            "Отключить",
            "tracking-remove-prepare",
            {"tmdb_id": 42, "tracking_id": TRACKING_ID},
            "2099-07-27T12:00:00Z",
        )
        token = self.adapter._media_action_store.create(action)
        update, query = callback_update(f"md:{token}")
        query.message.edit_text.side_effect = [
            self.plugin.BadRequest("edit failed"),
            None,
        ]
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True

        with mock.patch.object(
            self.adapter,
            "_resolve_tracking_action",
            mock.AsyncMock(return_value=(details, {"matches": (selected,)}, selected)),
        ):
            await self.adapter._handle_callback_query(update, None)
            await self.adapter._handle_callback_query(update, None)

        self.assertEqual(query.message.edit_text.await_count, 2)
        resolved = self.adapter._media_action_store.resolve(token)
        self.assertIsNotNone(resolved)
        self.assertTrue(resolved[1])

    def test_media_callbacks_use_only_approved_loading_toasts(self):
        source = PLUGIN.read_text(encoding="utf-8")
        self.assertEqual(source.count('_SEARCH_LOADING_TOAST = "Ищу варианты…"'), 1)
        self.assertEqual(source.count("text=_SEARCH_LOADING_TOAST"), 2)
        self.assertEqual(source.count('text="Добавляю…"'), 1)
        self.assertEqual(source.count('text="Включаю автоскачивание…"'), 1)

    async def test_business_details_acknowledges_before_io_and_edits_in_place(self):
        update, query = callback_update(f"ma:details:{JOB_ID}")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        events = []
        query.answer.side_effect = lambda **_kwargs: events.append("ack")

        async def details(*_args, **_kwargs):
            events.append("mcp")
            return 0, json.dumps({"state": "running"}).encode()

        with mock.patch.object(self.plugin, "_run_media", side_effect=details):
            await self.adapter._handle_callback_query(update, None)

        self.assertEqual(events, ["ack", "mcp"])
        query.answer.assert_awaited_once_with()
        query.message.reply_text.assert_not_awaited()
        query.message.edit_text.assert_awaited_once()
        markup = query.message.edit_text.await_args.kwargs["reply_markup"]
        self.assertEqual(markup.inline_keyboard[0][0].callback_data, f"hm:b:{JOB_ID}")

    async def test_stale_trending_item_callback_does_not_open_another_release(self):
        update, query = callback_update("mt:d:a:1:1:999")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        payload = {
            "source": "tmdb",
            "category": "all",
            "page": 1,
            "total_pages": 1,
            "results": [
                {"tmdb_id": 1, "media_type": "movie", "title": "Первый"},
                {"tmdb_id": 2, "media_type": "tv", "title": "Второй"},
            ],
        }

        with mock.patch.object(
            self.adapter,
            "_trending_payload",
            mock.AsyncMock(return_value=payload),
        ):
            await self.adapter._handle_callback_query(update, None)

        query.answer.assert_awaited_once_with()
        self.assertIn("устарела", query.message.edit_text.await_args.args[0])
        query.message.edit_caption.assert_not_awaited()
        query.message.edit_media.assert_not_awaited()

    async def test_stale_similar_item_edits_a_text_card_without_caption_error(self):
        update, query = callback_update("mi:d:m:99:1:0:999")
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        payload = {
            "source": "tmdb",
            "page": 1,
            "total_pages": 1,
            "results": [{
                "tmdb_id": 1,
                "media_type": "movie",
                "title": "Другой фильм",
            }],
        }

        with mock.patch.object(
            self.adapter,
            "_similar_payload",
            mock.AsyncMock(return_value=payload),
        ):
            await self.adapter._handle_callback_query(update, None)

        query.answer.assert_awaited_once_with()
        self.assertIn("устарела", query.message.edit_text.await_args.args[0])
        query.message.edit_caption.assert_not_awaited()

    async def test_trending_movie_download_chooses_source_then_opens_carousel(self):
        update, query = callback_update("mx:w:m:42:0")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        details = {
            "tmdb_id": 42,
            "media_type": "movie",
            "title": "Тестовый фильм",
        }

        run_media = mock.AsyncMock()
        with (
            mock.patch.object(
                self.adapter,
                "_details_payload",
                mock.AsyncMock(return_value=details),
            ),
            mock.patch.object(
                self.plugin,
                "_run_media",
                run_media,
            ) as run_media,
        ):
            await self.adapter._handle_callback_query(update, None)

        query.answer.assert_awaited_once_with()
        run_media.assert_not_awaited()
        caption = query.message.edit_caption.await_args.kwargs["caption"]
        self.assertIn("⬇️ Скачать", caption)
        self.assertIn("Выберите источник", caption)
        rows = query.message.edit_caption.await_args.kwargs[
            "reply_markup"
        ].inline_keyboard
        self.assertEqual(
            [[button.text for button in row] for row in rows],
            [["🌐 Rezka", "🧲 Prowlarr"], ["⬅️ Назад"]],
        )

        prowlarr_page = json.dumps({
            "api_version": "v1",
            "session_id": "session-prowlarr",
            "source": "prowlarr",
            "expires_at": "2099-07-27T12:00:00Z",
            "results": [
                {
                    "source": "prowlarr",
                    "result_id": "prowlarr:1",
                    "title": "Movie WEB-DL 1080p RUS",
                    "thumbnail_url": "https://image.test/movie.jpg",
                    "website_url": "https://tracker.test/release/1",
                    "size_bytes": 7_300_000_000,
                    "seeders": 11,
                    "ranking": {},
                },
                {
                    "source": "prowlarr",
                    "result_id": "prowlarr:2",
                    "title": "Movie WEB-DL 720p RUS",
                    "size_bytes": 4_300_000_000,
                    "seeders": 7,
                    "ranking": {},
                },
            ],
        }).encode()
        update, query = callback_update("mx:p:m:42:0")
        query.message.photo = (object(),)
        with (
            mock.patch.object(
                self.adapter,
                "_details_payload",
                mock.AsyncMock(return_value=details),
            ),
            mock.patch.object(
                self.plugin,
                "_run_media",
                mock.AsyncMock(return_value=(0, prowlarr_page)),
            ) as run_media,
        ):
            await self.adapter._handle_callback_query(update, None)

        query.answer.assert_awaited_once_with(text="Ищу варианты…")
        run_media.assert_awaited_once()
        edit = query.message.edit_media.await_args
        caption = edit.args[0].caption
        self.assertIn("🎬 Movie WEB-DL 1080p RUS", caption)
        self.assertIn("🧲 Prowlarr", caption)
        rows = edit.kwargs["reply_markup"].inline_keyboard
        self.assertEqual(
            [[button.text for button in row] for row in rows],
            [
                ["⬅️", "1/2", "➡️"],
                ["🌐 Сайт"],
                ["⬇️ Скачать"],
                ["⬅️ Назад"],
            ],
        )

    async def test_trending_series_download_prompts_for_season_three_per_row(self):
        update, query = callback_update("mx:w:t:77:0")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        details = {
            "tmdb_id": 77,
            "media_type": "tv",
            "title": "Сериал",
            "season_count": 5,
        }
        with mock.patch.object(
            self.adapter,
            "_details_payload",
            mock.AsyncMock(return_value=details),
        ):
            await self.adapter._handle_callback_query(update, None)

        rows = query.message.edit_caption.await_args.kwargs[
            "reply_markup"
        ].inline_keyboard
        self.assertEqual([button.text for button in rows[0]], ["S1", "S2", "S3"])
        self.assertEqual([button.text for button in rows[1]], ["S4", "S5"])

    async def test_media_navigation_back_restores_exact_previous_screen(self):
        trending = {
            "source": "tmdb",
            "category": "tv",
            "page": 3,
            "total_pages": 5,
            "results": [{
                "tmdb_id": 77,
                "media_type": "tv",
                "title": "Сериал",
            }],
        }
        details = {
            **trending["results"][0],
            "season_count": 5,
        }
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True

        with (
            mock.patch.object(
                self.adapter,
                "_trending_payload",
                mock.AsyncMock(return_value=trending),
            ),
            mock.patch.object(
                self.adapter,
                "_details_payload",
                mock.AsyncMock(return_value=details),
            ),
        ):
            for callback in (
                "mt:d:t:3:0:77",
                "mx:w:t:77:0",
                "mx:w:t:77:2",
            ):
                update, _query = callback_update(callback)
                await self.adapter._handle_callback_query(update, None)

            update, query = callback_update("mn:b")
            await self.adapter._handle_callback_query(update, None)
            self.assertIn(
                "Выберите сезон",
                query.message.edit_text.await_args.args[0],
            )

            update, query = callback_update("mn:b")
            await self.adapter._handle_callback_query(update, None)
            self.assertIn(
                "<b>📺 Сериал</b>",
                query.message.edit_text.await_args.args[0],
            )

            update, query = callback_update("mn:b")
            await self.adapter._handle_callback_query(update, None)
            self.assertTrue(
                query.message.edit_text.await_args.args[0].startswith("📺 Сериал")
            )

    async def test_empty_tmdb_search_reuses_card_without_second_callback_answer(self):
        update, query = callback_update("mx:r:m:42:0")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        details = {
            "tmdb_id": 42,
            "media_type": "movie",
            "title": "Тестовый фильм",
        }
        with (
            mock.patch.object(
                self.adapter,
                "_details_payload",
                mock.AsyncMock(return_value=details),
            ),
            mock.patch.object(
                self.plugin,
                "_run_media",
                mock.AsyncMock(return_value=(0, json.dumps({
                    "api_version": "v1",
                    "source": "rezka",
                    "session_id": "session-rezka",
                    "expires_at": "2099-12-31T23:59:59Z",
                    "results": [],
                }).encode())),
            ),
        ):
            await self.adapter._handle_callback_query(update, None)

        query.answer.assert_awaited_once_with(text="Ищу варианты…")
        caption = query.message.edit_caption.await_args.kwargs["caption"]
        self.assertIn("⚠️ Вариантов нет", caption)
        self.assertIn("🌐 Rezka", caption)
        rows = query.message.edit_caption.await_args.kwargs[
            "reply_markup"
        ].inline_keyboard
        self.assertEqual(
            [[button.text for button in row] for row in rows],
            [["🧲 Prowlarr"], ["⬅️ Назад"]],
        )

    async def test_unavailable_source_uses_compact_retry_card(self):
        update, query = callback_update("mx:r:m:42:0")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        details = {
            "tmdb_id": 42,
            "media_type": "movie",
            "title": "Миньоны и монстры",
        }
        with (
            mock.patch.object(
                self.adapter,
                "_details_payload",
                mock.AsyncMock(return_value=details),
            ),
            mock.patch.object(
                self.plugin,
                "_run_media",
                mock.AsyncMock(return_value=(1, b'{"error":{"code":"provider_failed"}}')),
            ),
        ):
            await self.adapter._handle_callback_query(update, None)

        caption = query.message.edit_caption.await_args.kwargs["caption"]
        self.assertEqual(
            caption,
            "⚠️ Rezka временно недоступен\n\n🎬 Миньоны и монстры",
        )
        rows = query.message.edit_caption.await_args.kwargs[
            "reply_markup"
        ].inline_keyboard
        self.assertEqual(
            [[button.text for button in row] for row in rows],
            [["🔄 Повторить", "🧲 Prowlarr"], ["⬅️ Назад"]],
        )
        self.assertEqual(rows[0][0].callback_data, "mx:r:m:42:0")

    async def test_all_tmdb_search_preserves_navigation_back(self):
        update, query = callback_update("mx:a:m:42:0")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        details = {
            "tmdb_id": 42,
            "media_type": "movie",
            "title": "Тестовый фильм",
        }
        expires_at = "2099-07-27T12:00:00Z"
        pages = []
        for source in ("rezka", "prowlarr"):
            result = {
                "source": source,
                "result_id": f"{source}:1",
                "title": "Тестовый фильм",
            }
            if source == "rezka":
                result["translations"] = [{"id": 7, "name": "Dub"}]
            pages.append(
                json.dumps(
                    {
                        "api_version": "v1",
                        "session_id": f"session-{source}",
                        "source": source,
                        "expires_at": expires_at,
                        "results": [result],
                    }
                ).encode()
            )
        with (
            mock.patch.object(
                self.adapter,
                "_details_payload",
                mock.AsyncMock(return_value=details),
            ),
            mock.patch.object(
                self.plugin,
                "_run_media",
                mock.AsyncMock(side_effect=[(0, pages[0]), (0, pages[1])]),
            ),
        ):
            await self.adapter._handle_callback_query(update, None)

        query.message.edit_caption.assert_awaited_once()
        markup = query.message.edit_caption.await_args.kwargs["reply_markup"]
        self.assertEqual(
            [button.text for button in markup.inline_keyboard[-1]],
            ["⬅️ Назад"],
        )

    async def test_similar_callback_edits_the_same_card(self):
        update, query = callback_update("mi:l:m:42:1:0:0")
        query.message.photo = (object(),)
        self.adapter._is_callback_user_authorized = lambda *_args, **_kwargs: True
        payload = {
            "page": 1,
            "total_pages": 1,
            "results": [{
                "tmdb_id": 9,
                "media_type": "movie",
                "title": "Похожий фильм",
                "poster_url": "https://image.tmdb.org/t/p/w780/similar.jpg",
            }],
        }
        with mock.patch.object(
            self.adapter,
            "_similar_payload",
            mock.AsyncMock(return_value=payload),
        ):
            await self.adapter._handle_callback_query(update, None)

        query.message.edit_media.assert_awaited_once()
        media = query.message.edit_media.await_args.args[0]
        self.assertIn("Похожий фильм", media.caption)

    def test_release_baselines_keep_latest_aired_episode_per_season(self):
        payload = {
            "status": "matched",
            "schedule": [
                {"season": 1, "episode": 1, "air_at": "2020-01-01T00:00:00Z"},
                {"season": 1, "episode": 12, "air_at": "2020-03-01T00:00:00Z"},
                {"season": 2, "episode": 3, "air_at": "2021-01-01T00:00:00Z"},
                {"season": 2, "episode": 4, "air_at": "2099-01-01T00:00:00Z"},
            ],
        }

        self.assertEqual(
            self.adapter._release_baselines(payload), ((1, 12), (2, 3))
        )

    def test_malformed_release_payload_is_rejected_without_exception(self):
        self.assertIsNone(
            self.plugin._render_release_details(
                {
                    "source": "rezka",
                    "result": "not-an-object",
                    "title": "Broken",
                    "session_id": "session",
                    "result_id": "result",
                    "season": 1,
                    "episode": 1,
                },
                search_page={"expires_at": "2099-01-01T00:00:00Z"},
            )
        )

    def test_watching_shortcut_renders_sessions_without_internal_ids(self):
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = json.dumps(
            {
                "structuredContent": {
                    "MediaContainer": {
                        "Metadata": [
                            {
                                "type": "episode",
                                "grandparentTitle": "Сериал",
                                "parentIndex": 2,
                                "index": 7,
                                "viewOffset": 500,
                                "duration": 1000,
                                "User": {"title": "Andrii"},
                                "Player": {"title": "TV", "state": "playing"},
                                "ratingKey": "12345",
                            }
                        ]
                    }
                }
            }
        )

        rendered = self.plugin._render_watching_command(ctx, "")

        ctx.dispatch_tool.assert_called_once_with(
            "mcp__media_admin__plex_now_playing", {}
        )
        self.assertIn("Сериал · S02E07", rendered)
        self.assertIn("Andrii · TV · воспроизведение · 50%", rendered)
        self.assertNotIn("12345", rendered)


if __name__ == "__main__":
    unittest.main()
