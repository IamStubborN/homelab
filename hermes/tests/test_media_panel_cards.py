import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "shared/plugins/telegram-home"


if "telegram" not in sys.modules:
    telegram = types.ModuleType("telegram")

    class InlineKeyboardButton:
        def __init__(self, text, callback_data=None):
            self.text = text
            self.callback_data = callback_data

    class InlineKeyboardMarkup:
        def __init__(self, inline_keyboard):
            self.inline_keyboard = inline_keyboard

    telegram.InlineKeyboardButton = InlineKeyboardButton
    telegram.InlineKeyboardMarkup = InlineKeyboardMarkup
    sys.modules["telegram"] = telegram


def _load_module():
    package = "media_panel_test_package"
    sys.modules.setdefault(package, types.ModuleType(package)).__path__ = [str(PLUGIN)]
    for name in ("media_commands", "media_panel"):
        full_name = f"{package}.{name}"
        spec = importlib.util.spec_from_file_location(full_name, PLUGIN / f"{name}.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[full_name] = module
        spec.loader.exec_module(module)
    return sys.modules[f"{package}.media_panel"]


panel = _load_module()


def envelope(payload):
    return json.dumps({"structuredContent": payload})


class MediaPanelCardsTest(unittest.TestCase):
    def test_retry_state_allowlist_matches_backend_contract(self):
        self.assertEqual(
            panel._RETRYABLE_JOB_STATES,
            {"blocked_storage", "partial", "failed", "needs_action"},
        )
        self.assertIn("blocked_storage", panel._CANCELLABLE_JOB_STATES)
        self.assertIn("needs_action", panel._CANCELLABLE_JOB_STATES)

    def test_shared_browser_shell_keeps_navigation_actions_and_one_bottom_back(self):
        button = panel.MediaPanelButton
        rows = panel.media_browser_rows(
            navigation=panel.media_page_navigation(
                2,
                4,
                make_button=button,
                callback_for=lambda page: f"page:{page}",
                noop_callback="noop",
            ),
            controls=((button("Фильтр", "filter"),),),
            actions=(button("A", "a"), button("B", "b"), button("C", "c")),
            action_width=2,
            back=button("⬅️ Назад", "back"),
        )

        self.assertEqual(
            [[value.label for value in row] for row in rows],
            [["⬅️", "2/4", "➡️"], ["Фильтр"], ["A", "B"], ["C"], ["⬅️ Назад"]],
        )
        self.assertEqual(
            sum("Назад" in value.label for row in rows for value in row), 1
        )

    def test_job_and_tracking_lists_collect_every_cursor_page(self):
        ctx = mock.Mock()

        def dispatch(tool, arguments):
            cursor = arguments.get("cursor")
            key = "jobs" if tool.endswith("media_jobs_list") else "tracking"
            if cursor is None:
                return envelope(
                    {
                        key: [{"id": f"{key}-{index}"} for index in range(50)],
                        "next_cursor": "v1:50",
                    }
                )
            self.assertEqual(cursor, "v1:50")
            return envelope({key: [{"id": f"{key}-50"}]})

        ctx.dispatch_tool.side_effect = dispatch

        self.assertEqual(len(panel._jobs_payload(ctx)), 51)
        self.assertEqual(len(panel._tracking_payload(ctx)), 51)
        self.assertEqual(ctx.dispatch_tool.call_count, 4)

    def test_paged_list_rejects_a_cyclic_cursor(self):
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = envelope(
            {"jobs": [], "next_cursor": "v1:50"}
        )

        with self.assertRaisesRegex(ValueError, "cyclic cursor"):
            panel._jobs_payload(ctx)

    def test_models_are_immutable_and_home_layout_is_compact(self):
        card = panel.render_media_panel_card(mock.Mock(), "home")
        self.assertEqual(card.parse_mode, "HTML")
        self.assertTrue(all(len(row) <= 3 for row in card.buttons))
        self.assertEqual(
            [[button.label for button in row] for row in card.buttons],
            [
                ["🔥 Тренды", "⭐ Лучшее"],
                ["📅 Премьеры", "🎭 По жанрам"],
                ["🔔 Подписки", "⬇️ Загрузки"],
                ["📺 Plex"],
            ],
        )
        with self.assertRaises(Exception):
            card.text = "changed"

    def test_plex_hub_reaches_every_browser_screen_with_exact_back_chain(self):
        hub = panel.render_media_panel_card(mock.Mock(), "plex")
        self.assertEqual(
            [button.callback_data for row in hub.buttons for button in row],
            ["mp:watching", "mp:recent", "mp:library", "mp:storage", "mp:home"],
        )

        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = envelope({})
        for route in ("watching", "recent", "library", "storage"):
            card = panel.render_media_panel_card(ctx, route)
            self.assertEqual(card.buttons[-1][0].callback_data, "mp:plex")

    def test_route_failures_preserve_retry_and_exact_parent(self):
        ctx = mock.Mock()
        ctx.dispatch_tool.side_effect = RuntimeError("offline")
        job_id = "00000000-0000-0000-0000-000000000001"
        cases = {
            "downloads-m-p:2": "mp:home",
            f"job:{job_id}:2:m": "mp:downloads-m-p:2",
            "library-section:7:3": "mp:library",
            "library-key:7:42:3": "mp:library-section:7:3",
        }
        for route, parent in cases.items():
            card = panel.render_media_panel_card(ctx, route)
            callbacks = [button.callback_data for row in card.buttons for button in row]
            self.assertEqual(callbacks, [f"mp:{route}", parent])

    def test_direct_tracking_detail_locates_the_target_page_globally(self):
        items = [
            {
                "id": f"00000000-0000-0000-0000-{index:012d}",
                "title": f"Show {index}",
                "scope": "initiator",
                "check_status": "never",
                "known_episodes": [],
            }
            for index in range(1, 12)
        ]
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = envelope({"tracking": items})

        card = panel.render_media_panel_card(ctx, f"tracking:{items[10]['id']}:1")

        self.assertIn("Show 11", card.text)
        self.assertEqual(
            [button.callback_data for button in card.buttons[0]],
            ["mp:noop", "mp:noop", "mp:noop"],
        )
        self.assertEqual(card.buttons[-1][0].callback_data, "mp:tracking-p:2")

    def test_single_page_list_hides_pagination_but_card_shows_disabled_position(self):
        rows = panel._list_buttons("watching", 1, 1, "watching-key:42:1")
        self.assertEqual(
            [button.label for row in rows for button in row],
            ["🖼 Карточки", "⬅️ Назад"],
        )

        carousel = panel._carousel_buttons(["watching-key:42:1"], 0, "watching-p:1")
        self.assertEqual(
            [button.label for row in carousel for button in row],
            ["⬅️", "1/1", "➡️", "⬅️ Назад"],
        )
        self.assertEqual(
            [button.callback_data for button in carousel[0]],
            ["mp:noop", "mp:noop", "mp:noop"],
        )

    def test_download_and_tracking_page_arrows_are_noop_at_edges(self):
        first = panel._list_buttons("downloads", 1, 3, "job:first:1")
        last = panel._list_buttons("tracking", 3, 3, "tracking:last:3")

        self.assertEqual(first[0][0].callback_data, "mp:noop")
        self.assertEqual(first[0][1].callback_data, "mp:noop")
        self.assertEqual(first[0][2].callback_data, "mp:downloads-p:2")
        self.assertEqual(last[0][0].callback_data, "mp:tracking-p:2")
        self.assertEqual(last[0][1].callback_data, "mp:noop")
        self.assertEqual(last[0][2].callback_data, "mp:noop")

    def test_download_and_tracking_callbacks_accept_pages_beyond_ninety_nine(self):
        rows = panel._list_buttons("downloads", 99, 100, "job:first:99")

        self.assertEqual(rows[0][2].callback_data, "mp:downloads-p:100")
        for callback in (
            "mp:downloads-p:100",
            "mp:tracking-p:100",
            "mp:job:11111111-2222-3333-4444-555555555555:100",
            "mp:tracking:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:100",
            "mp:tracking-check:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:100",
        ):
            with self.subTest(callback=callback):
                self.assertIsNotNone(panel._MEDIA_PANEL_CALLBACK_RE.fullmatch(callback))

    def test_card_carousel_arrows_are_noop_at_edges_and_back_is_exact(self):
        routes = ["job:first:2", "job:second:2"]
        first = panel._carousel_buttons(routes, 0, "downloads-p:2")
        last = panel._carousel_buttons(routes, 1, "downloads-p:2")

        self.assertEqual(
            [button.callback_data for button in first[0]],
            ["mp:noop", "mp:noop", "mp:job:second:2"],
        )
        self.assertEqual(
            [button.callback_data for button in last[0]],
            ["mp:job:first:2", "mp:noop", "mp:noop"],
        )
        self.assertEqual(last[-1][0].callback_data, "mp:downloads-p:2")

    def test_discovery_routes_use_exact_mcp_contract_and_restore_filters(self):
        ctx = mock.Mock()

        def dispatch(tool, arguments):
            if tool.endswith("media_details"):
                return envelope(
                    {
                        "tmdb_id": 20,
                        "media_type": arguments["media_type"],
                        "title": "Detailed",
                        "overview": "Overview",
                    }
                )
            return envelope(
                {
                    "page": arguments["page"],
                    "total_pages": 3,
                    "results": [
                        {
                            "tmdb_id": 20,
                            "media_type": arguments["media_type"],
                            "title": "Release",
                            "poster_url": "https://image.test/release.jpg",
                        }
                    ],
                }
            )

        ctx.dispatch_tool.side_effect = dispatch
        best = panel.render_media_panel_card(ctx, "best:t:p:2")
        best_detail = panel.render_media_panel_card(ctx, "best-key:t:p:2:0:20")
        premieres = panel.render_media_panel_card(ctx, "prem:t:a:3")
        premiere_detail = panel.render_media_panel_card(ctx, "prem-key:t:a:3:0:20")

        expected = [
            mock.call(
                "mcp__media_admin__media_best",
                {"media_type": "tv", "page": 2, "ranking": "popular"},
            ),
            mock.call(
                "mcp__media_admin__media_best",
                {"media_type": "tv", "page": 2, "ranking": "popular"},
            ),
            mock.call(
                "mcp__media_admin__media_details",
                {"media_type": "tv", "tmdb_id": 20},
            ),
            mock.call(
                "mcp__media_admin__media_premieres",
                {"media_type": "tv", "page": 3, "feed": "airing_today"},
            ),
            mock.call(
                "mcp__media_admin__media_premieres",
                {"media_type": "tv", "page": 3, "feed": "airing_today"},
            ),
            mock.call(
                "mcp__media_admin__media_details",
                {"media_type": "tv", "tmdb_id": 20},
            ),
        ]
        self.assertEqual(ctx.dispatch_tool.call_args_list, expected)
        self.assertEqual(best.photo_url, "https://image.test/release.jpg")
        self.assertEqual(premieres.photo_url, "https://image.test/release.jpg")
        self.assertEqual(best.buttons[0][0].callback_data, "mp:best:t:p:1")
        self.assertEqual(best.buttons[0][2].callback_data, "mp:best:t:p:3")
        self.assertEqual(best.buttons[1][1].callback_data, "mp:noop")
        self.assertEqual(best.buttons[2][1].callback_data, "mp:noop")
        self.assertEqual(premieres.buttons[1][1].callback_data, "mp:noop")
        self.assertEqual(premieres.buttons[2][1].callback_data, "mp:noop")
        self.assertEqual(best_detail.buttons[-1][0].callback_data, "mp:best:t:p:2")
        self.assertEqual(
            premiere_detail.buttons[-1][0].callback_data, "mp:prem:t:a:3"
        )
        self.assertEqual(
            sum("Назад" in button.label for row in best_detail.buttons for button in row),
            1,
        )

    def test_genres_and_discover_keep_media_type_genre_and_page(self):
        ctx = mock.Mock()

        def dispatch(tool, arguments):
            if tool.endswith("media_genres"):
                return envelope({"genres": [{"id": 28, "name": "Action"}]})
            if tool.endswith("media_details"):
                return envelope(
                    {"tmdb_id": 7, "media_type": "movie", "title": "Action movie"}
                )
            return envelope(
                {
                    "page": 2,
                    "total_pages": 2,
                    "results": [
                        {
                            "tmdb_id": 7,
                            "media_type": "movie",
                            "title": "Action movie",
                        }
                    ],
                }
            )

        ctx.dispatch_tool.side_effect = dispatch
        genres = panel.render_media_panel_card(ctx, "genres:m")
        listing = panel.render_media_panel_card(ctx, "discover:m:28:2")
        detail = panel.render_media_panel_card(ctx, "discover-key:m:28:2:0:7")

        self.assertEqual(
            ctx.dispatch_tool.call_args_list,
            [
                mock.call("mcp__media_admin__media_genres", {"media_type": "movie"}),
                mock.call(
                    "mcp__media_admin__media_discover",
                    {"media_type": "movie", "page": 2, "genre_id": 28},
                ),
                mock.call(
                    "mcp__media_admin__media_discover",
                    {"media_type": "movie", "page": 2, "genre_id": 28},
                ),
                mock.call(
                    "mcp__media_admin__media_details",
                    {"media_type": "movie", "tmdb_id": 7},
                ),
            ],
        )
        self.assertIn(
            "mp:discover:m:28:1",
            [button.callback_data for row in genres.buttons for button in row],
        )
        self.assertEqual(genres.buttons[0][0].callback_data, "mp:noop")
        self.assertEqual(listing.buttons[0][2].callback_data, "mp:noop")
        self.assertEqual(detail.buttons[-1][0].callback_data, "mp:discover:m:28:2")
        self.assertNotIn("28", listing.text + detail.text)

    def test_recent_list_and_details_escape_html_hide_ids_and_paths(self):
        ctx = mock.Mock()
        recent = {
            "MediaContainer": {
                "Metadata": [
                    {
                        "type": "episode",
                        "grandparentTitle": "Show <unsafe>",
                        "title": "Episode & title",
                        "parentIndex": 2,
                        "index": 3,
                        "ratingKey": "314",
                        "path": "/private/media/file.mkv",
                    }
                ]
            }
        }
        detail = {
            "MediaContainer": {
                "Metadata": [
                    {
                        "type": "episode",
                        "grandparentTitle": "Show <unsafe>",
                        "title": "Episode & title",
                        "parentIndex": 2,
                        "index": 3,
                        "ratingKey": "314",
                        "summary": "A <strong>summary</strong>",
                        "year": 2026,
                        "rating": 8.5,
                        "duration": 3_600_000,
                        "Genre": [{"tag": "Drama & comedy"}],
                        "path": "/private/media/file.mkv",
                    }
                ]
            }
        }
        enriched_recent = {
            "MediaContainer": {"Metadata": [detail["MediaContainer"]["Metadata"][0]]}
        }
        ctx.dispatch_tool.side_effect = [
            envelope(enriched_recent),
            envelope(enriched_recent),
        ]

        listing = panel.render_media_panel_card(ctx, "recent")
        details = panel.render_media_panel_card(ctx, "recent-key:314")

        self.assertIn("Show &lt;unsafe&gt;", listing.text)
        callbacks = [
            button.callback_data for row in listing.buttons for button in row
        ]
        self.assertIn("mp:recent-key:314:1", callbacks)
        self.assertIn("<blockquote expandable>", details.text)
        self.assertIn("A &lt;strong&gt;summary&lt;/strong&gt;", details.text)
        self.assertIn(
            "mp:recent-p:1",
            [button.callback_data for row in details.buttons for button in row],
        )
        combined = listing.text + details.text
        self.assertNotIn("314", combined)
        self.assertNotIn("/private/", combined)
        self.assertLessEqual(len(details.text), 4096)

    def test_plex_details_without_tmdb_id_hide_similar_and_download(self):
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = envelope({
            "items": [{
                "ratingKey": "7",
                "type": "movie",
                "title": "Local only",
            }]
        })

        card = panel.render_media_panel_card(ctx, "recent-key:7:1")
        labels = [button.label for row in card.buttons for button in row]

        self.assertNotIn("🎭 Похожие", labels)
        self.assertNotIn("⬇️ Скачать", labels)

    def test_library_uses_list_then_detail_cards_with_browser_navigation(self):
        ctx = mock.Mock()
        summary = {
            "sections": [
                {
                    "section_key": 2,
                    "title": "Movies",
                    "type": "movie",
                    "item_count": 11,
                }
            ]
        }
        item = {
            "type": "movie",
            "title": "Example movie",
            "originalTitle": "Original movie",
            "ratingKey": "42",
            "year": 2026,
            "rating": 8.2,
            "summary": "Example summary",
        }
        page = {
            "MediaContainer": {
                "totalSize": 11,
                "Metadata": [item],
            }
        }
        ctx.dispatch_tool.side_effect = [
            envelope(summary),
            envelope(page),
            envelope(page),
        ]

        sections = panel.render_media_panel_card(ctx, "library")
        listing = panel.render_media_panel_card(ctx, "library-section:2:1")
        detail = panel.render_media_panel_card(ctx, "library-key:2:42:1")

        self.assertIn("🎬 Фильмы: <b>11</b>", sections.text)
        self.assertIn(
            "mp:library-section:2:1",
            [button.callback_data for row in sections.buttons for button in row],
        )
        self.assertIn("🎬 Example movie (2026) ⭐8.2", listing.text)
        listing_callbacks = [
            button.callback_data for row in listing.buttons for button in row
        ]
        self.assertIn("mp:library-key:2:42:1", listing_callbacks)
        self.assertIn("mp:library", listing_callbacks)
        self.assertIn("<b>🎬 Example movie / Original movie</b>", detail.text)
        self.assertIn("<blockquote expandable>", detail.text)
        detail_callbacks = [
            button.callback_data for row in detail.buttons for button in row
        ]
        self.assertIn("mp:library-section:2:1", detail_callbacks)
        self.assertNotIn("42", detail.text)

    def test_downloads_show_five_jobs_per_page_and_open_one_card_carousel(self):
        ctx = mock.Mock()
        jobs = [
            {"id": f"00000000-0000-0000-0000-{index:012d}", "provider": "rezka", "state": "queued"}
            for index in range(12)
        ]
        full_title = "Аватар Аанг: Последний маг воздуха / Легенда об Аанге"
        jobs[0]["title"] = full_title
        ctx.dispatch_tool.side_effect = [
            envelope({"queued": 12, "active": True}),
            envelope({"jobs": jobs}),
        ]
        card = panel.render_media_panel_card(ctx, "downloads")
        labels = [button.label for row in card.buttons for button in row]
        callbacks = [button.callback_data for row in card.buttons for button in row]
        self.assertEqual(labels[:3], ["⬅️", "1/3", "➡️"])
        self.assertIn("🖼 Карточки", labels)
        self.assertIn(f"mp:job:{jobs[0]['id']}:1", callbacks)
        self.assertNotIn("1", labels)
        self.assertEqual(card.text.count("🕒 🎬"), 5)
        self.assertIn(full_title, card.text)
        self.assertNotIn("Последний маг воздуха…", card.text)
        self.assertNotIn(jobs[0]["id"], card.text)

    def test_ten_html_heavy_downloads_and_tracking_items_fit_photo_caption(self):
        long_title = "<&>" * 100
        jobs = [
            {
                "id": f"00000000-0000-0000-0000-{index:012d}",
                "provider": "rezka",
                "state": "running",
                "title": long_title,
            }
            for index in range(10)
        ]
        tracking = [
            {
                "id": f"10000000-0000-0000-0000-{index:012d}",
                "title": long_title,
                "scope": "family",
                "download": {"season": 1},
            }
            for index in range(10)
        ]
        ctx = mock.Mock()
        ctx.dispatch_tool.side_effect = [
            envelope({"queued": 10, "active": True}),
            envelope({"jobs": jobs}),
            envelope({"tracking": tracking}),
        ]

        downloads = panel.render_media_panel_card(ctx, "downloads")
        subscriptions = panel.render_media_panel_card(ctx, "tracking")

        self.assertLessEqual(len(downloads.text), 1024)
        self.assertLessEqual(len(subscriptions.text), 1024)
        self.assertEqual(downloads.text.count("🌐 Rezka"), 5)
        self.assertNotIn("<i>", downloads.text)
        self.assertEqual(subscriptions.text.count("⬇️ <b>"), 10)
        self.assertNotIn(long_title, downloads.text + subscriptions.text)

    def test_downloads_keep_history_newest_first_and_do_not_count_attention_as_live(self):
        blocked_id = "00000000-0000-0000-0000-000000000001"
        completed_id = "00000000-0000-0000-0000-000000000002"
        ctx = mock.Mock()
        ctx.dispatch_tool.side_effect = [
            envelope({"queued": 0, "active": False}),
            envelope(
                {
                    "jobs": [
                        {
                            "id": completed_id,
                            "provider": "prowlarr",
                            "state": "completed",
                            "title": "Newest release",
                            "season": 2,
                        },
                        {
                            "id": blocked_id,
                            "provider": "rezka",
                            "state": "blocked_storage",
                            "title": "Old blocked release",
                        },
                    ]
                }
            ),
        ]

        card = panel.render_media_panel_card(ctx, "downloads")

        self.assertIn("🟢 <b>Готов</b> · ▶️ 0 · 🕒 0", card.text)
        self.assertLess(card.text.index("Newest release"), card.text.index("Old blocked release"))
        self.assertIn(
            "✅ 📺 Newest release\n"
            "🧲 Prowlarr · 🎙 Озвучки в релизе · 📺 S2",
            card.text,
        )
        self.assertIn(
            "💾 🎬 Old blocked release\n🌐 Rezka",
            card.text,
        )
        self.assertIn(
            "🧲 Prowlarr · 🎙 Озвучки в релизе · 📺 S2\n\n"
            "💾 🎬 Old blocked release",
            card.text,
        )
        self.assertNotIn("· готово", card.text)
        self.assertNotIn("· не хватает места", card.text)

    def test_download_list_line_keeps_the_full_title_and_selected_translation(self):
        line = panel._job_list_line({
            "provider": "rezka",
            "state": "cancelled",
            "title": "Аватар Аанг: Последний маг воздуха / Легенда об Аанге",
            "translation": "AniLibria",
        })

        self.assertEqual(
            line,
            "⏹️ 🎬 Аватар Аанг: Последний маг воздуха / Легенда об Аанге\n"
            "🌐 Rezka · 🎙 AniLibria",
        )

    def test_download_metadata_uses_semantic_plain_segments(self):
        generic = panel._job_list_line({
            "provider": "prowlarr",
            "state": "running",
            "title": "Release",
            "season": 4,
            "episode": 17,
            "progress": {"progress_percent": 63},
        })
        translated = panel._job_list_line({
            "provider": "prowlarr",
            "state": "running",
            "title": "Release",
            "translation": "LostFilm",
        })

        self.assertEqual(
            generic,
            "⬇️ 📺 Release\n"
            "🧲 Prowlarr · 🎙 Озвучки в релизе · 📺 S04E17 · 📊 63%",
        )
        self.assertEqual(
            translated,
            "⬇️ 🎬 Release\n🧲 Prowlarr · 🎙 LostFilm",
        )
        self.assertNotIn("<i>", generic + translated)

    def test_job_title_removes_only_a_repeated_alias_subtitle(self):
        title = (
            "Аватар Аанг: Последний маг воздуха / "
            "Легенда об Аанге: Последний маг воздуха"
        )
        expected = (
            "Легенда об Аанге: Последний маг воздуха"
        )
        job = {
            "id": "00000000-0000-0000-0000-000000000001",
            "provider": "rezka",
            "state": "completed",
            "title": title,
        }

        listing = panel._job_list_line(job)
        detail = panel._render_job_payload(
            None, job, job["id"], 1
        )

        self.assertEqual(panel._job_title(job), expected)
        self.assertIn(expected, listing)
        self.assertIn(expected, detail.text)
        self.assertEqual(listing.count("Последний маг воздуха"), 1)

        source_backed = {
            **job,
            "library_title": "Каноническое название",
        }
        source_backed_listing = panel._job_list_line(source_backed)
        source_backed_detail = panel._render_job_payload(
            None, source_backed, job["id"], 1
        )
        self.assertEqual(panel._job_title(source_backed), "Каноническое название")
        self.assertIn("Каноническое название", source_backed_listing)
        self.assertIn("Каноническое название", source_backed_detail.text)
        self.assertNotIn("Легенда об Аанге", source_backed_listing)

    def test_job_title_preserves_distinct_alias_subtitles_and_html_escaping(self):
        distinct = (
            "Доктор Стрэндж: В мультивселенной безумия / "
            "Doctor Strange: In the Multiverse of Madness"
        )
        html_title = "Rock & Roll: Финал / R&B: Финал"

        self.assertEqual(panel._job_title({"title": distinct}), distinct)
        self.assertEqual(
            panel._job_title({
                "title": "Первый: Финал / Второй: Финал / Третий: Начало"
            }),
            "Первый: Финал / Второй: Финал / Третий: Начало",
        )
        self.assertEqual(
            panel._job_title({
                "provider": "rezka",
                "title": "Первый: Финал / Второй: финал / Третий: Финал"
            }),
            "Третий: Финал",
        )
        prowlarr = "Первый: Финал / Второй: финал / Третий: Финал"
        self.assertEqual(
            panel._job_title({"provider": "prowlarr", "title": prowlarr}),
            prowlarr,
        )
        self.assertEqual(
            panel._job_title({"title": "Первый: Финал/Второй: Финал"}),
            "Первый: Финал/Второй: Финал",
        )
        self.assertEqual(
            panel._job_list_line({
                "provider": "rezka",
                "state": "completed",
                "title": html_title,
            }).splitlines()[0],
            "✅ 🎬 R&amp;B: Финал",
        )

    def test_download_filters_preserve_page_through_card_and_confirmation(self):
        jobs = [
            {
                "id": f"00000000-0000-0000-0000-{index:012d}",
                "provider": "rezka",
                "state": "queued",
                "media_kind": "movie",
                "title": f"Movie {index}",
            }
            for index in range(6)
        ] + [
            {
                "id": "10000000-0000-0000-0000-000000000001",
                "provider": "rezka",
                "state": "queued",
                "media_kind": "series",
                "title": "Series",
                "season": 2,
                "episode": 3,
            }
        ]
        selected = jobs[5]
        ctx = mock.Mock()

        def dispatch(tool, _arguments):
            if tool.endswith("media_queue_status"):
                return envelope({"queued": 0, "active": False})
            if tool.endswith("media_job_get"):
                return envelope(selected)
            return envelope({"jobs": jobs})

        ctx.dispatch_tool.side_effect = dispatch

        listing = panel.render_media_panel_card(ctx, "downloads-m-p:2")
        detail = panel.render_media_panel_card(
            ctx, f"job:{selected['id']}:2:m"
        )
        confirmation = panel.render_media_panel_card(
            ctx, f"job-cancel:{selected['id']}:2:m"
        )

        self.assertIn("Movie 5", listing.text)
        self.assertNotIn("Series", listing.text)
        self.assertEqual(
            [button.callback_data for button in listing.buttons[0]],
            ["mp:downloads-m-p:1", "mp:noop", "mp:noop"],
        )
        filter_row = listing.buttons[1]
        self.assertEqual(
            [(button.label, button.callback_data) for button in filter_row],
            [
                ("Все", "mp:downloads-p:1"),
                ("✅ 🎬 Фильмы", "mp:noop"),
                ("📺 Сериалы", "mp:downloads-t-p:1"),
            ],
        )
        self.assertIn(
            f"mp:job:{selected['id']}:2:m",
            [button.callback_data for row in listing.buttons for button in row],
        )
        self.assertEqual(
            detail.buttons[-1][0].callback_data, "mp:downloads-m-p:2"
        )
        self.assertIn(
            f"mp:job-cancel:{selected['id']}:2:m",
            [button.callback_data for row in detail.buttons for button in row],
        )
        self.assertIn(
            f"mp:job:{selected['id']}:2:m",
            [button.callback_data for row in confirmation.buttons for button in row],
        )
        self.assertEqual(
            confirmation.buttons[-1][0].callback_data,
            "mp:downloads-m-p:2",
        )
        self.assertTrue(
            all(
                len(button.callback_data.encode("utf-8")) <= 64
                for card in (listing, detail, confirmation)
                for row in card.buttons
                for button in row
            )
        )
        for callback in (
            "mp:downloads-m-p:2",
            f"mp:job:{selected['id']}:2:m",
            f"mp:job-cancel:{selected['id']}:2:m",
        ):
            self.assertIsNotNone(panel._MEDIA_PANEL_CALLBACK_RE.fullmatch(callback))

    def test_download_filter_keeps_the_global_queue_summary(self):
        jobs = [
            {
                "id": "00000000-0000-0000-0000-000000000001",
                "provider": "rezka",
                "state": "completed",
                "media_kind": "movie",
                "title": "Finished movie",
            },
            {
                "id": "00000000-0000-0000-0000-000000000002",
                "provider": "rezka",
                "state": "running",
                "media_kind": "series",
                "title": "Running series",
                "season": 1,
            },
        ]
        ctx = mock.Mock()

        def dispatch(tool, _arguments):
            if tool.endswith("media_queue_status"):
                return envelope({"queued": 2, "active": True})
            return envelope({"jobs": jobs})

        ctx.dispatch_tool.side_effect = dispatch

        movies = panel.render_media_panel_card(ctx, "downloads-m-p:1")

        self.assertIn("🟡 <b>Занят</b> · ▶️ 1 · 🕒 2", movies.text)
        self.assertIn("Finished movie", movies.text)
        self.assertNotIn("Running series", movies.text)

    def test_empty_active_download_filter_has_filter_specific_copy(self):
        ctx = mock.Mock()

        def dispatch(tool, _arguments):
            if tool.endswith("media_queue_status"):
                return envelope({"queued": 1, "active": True})
            return envelope({
                "jobs": [{
                    "id": "00000000-0000-0000-0000-000000000001",
                    "provider": "rezka",
                    "state": "running",
                    "media_kind": "series",
                    "title": "Series",
                }]
            })

        ctx.dispatch_tool.side_effect = dispatch
        card = panel.render_media_panel_card(ctx, "downloads-m-p:1")

        self.assertIn("▶️ 1 · 🕒 1", card.text)
        self.assertIn("В этом фильтре задач нет.", card.text)

    def test_download_list_line_uses_explicit_media_kind_before_fallback(self):
        movie = panel._job_list_line({
            "provider": "rezka",
            "state": "completed",
            "media_kind": "movie",
            "season": 2,
            "title": "Movie",
        })
        series = panel._job_list_line({
            "provider": "prowlarr",
            "state": "completed",
            "media_kind": "series",
            "title": "Series",
        })

        self.assertTrue(movie.startswith("✅ 🎬 Movie\n"))
        self.assertTrue(series.startswith("✅ 📺 Series\n"))

    def test_job_details_render_progress_and_state_actions_without_visible_id(self):
        job_id = "11111111-2222-3333-4444-555555555555"
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = envelope(
            {
                "id": job_id,
                "provider": "prowlarr",
                "state": "running",
                "current_stage": "downloading",
                "progress": {
                    "progress_percent": 42,
                    "downloaded_bytes": 1024**3,
                    "total_bytes": 2 * 1024**3,
                    "download_speed_bps": 5 * 1024**2,
                    "eta_seconds": 91,
                    "seeds": 7,
                },
            }
        )
        card = panel.render_media_panel_card(ctx, f"job:{job_id}")
        callbacks = [button.callback_data for row in card.buttons for button in row]
        self.assertIn("42%", card.text)
        self.assertIn("5 МиБ/с", card.text)
        self.assertIn("1 мин 31 сек", card.text)
        self.assertIn("7", card.text)
        self.assertNotIn(job_id, card.text)
        self.assertIn(f"mp:job-cancel:{job_id}:1", callbacks)
        self.assertNotIn(f"ma:retry:{job_id}", callbacks)

        ctx.dispatch_tool.return_value = envelope(
            {
                "id": job_id,
                "provider": "prowlarr",
                "state": "running",
                "title": "Example season",
                "poster_url": "https://image.test/example-season.jpg",
                "current_stage": "downloading",
                "progress": {"progress_percent": 42},
            }
        )
        confirmation = panel.render_media_panel_card(ctx, f"job-cancel:{job_id}")
        confirmation_callbacks = [
            button.callback_data for row in confirmation.buttons for button in row
        ]
        self.assertIn(f"ma:cancel:{job_id}", confirmation_callbacks)
        self.assertIn(f"mp:job:{job_id}:1", confirmation_callbacks)
        self.assertIn("Example season", confirmation.text)
        self.assertIn("Прогресс: <b>42%</b>", confirmation.text)
        self.assertEqual(
            [button.label for button in confirmation.buttons[0]],
            ["⬅️", "1/1", "➡️"],
        )
        self.assertEqual(
            confirmation.photo_url, "https://image.test/example-season.jpg"
        )
        self.assertEqual(
            [button.label for button in confirmation.buttons[1]],
            ["↩️ К задаче", "✖️ Отменить"],
        )
        self.assertEqual(
            confirmation.buttons[-1][0].callback_data,
            "mp:downloads-p:1",
        )

    def test_stale_cancel_confirmation_keeps_the_authoritative_job_shell(self):
        job_id = "11111111-2222-3333-4444-555555555555"
        job = {
            "id": job_id,
            "provider": "rezka",
            "state": "completed",
            "title": "Already finished",
            "poster_url": "https://image.test/finished.jpg",
            "progress": {"progress_percent": 100},
        }
        ctx = mock.Mock()
        ctx.dispatch_tool.side_effect = [
            envelope(job),
            envelope({"jobs": [job]}),
        ]

        card = panel.render_media_panel_card(ctx, f"job-cancel:{job_id}:1")

        self.assertIn("Отмена уже недоступна", card.text)
        self.assertIn("Already finished", card.text)
        self.assertIn("Прогресс: <b>100%</b>", card.text)
        self.assertEqual(card.photo_url, "https://image.test/finished.jpg")
        self.assertEqual(
            [button.label for button in card.buttons[0]],
            ["⬅️", "1/1", "➡️"],
        )
        self.assertEqual(card.buttons[-1][0].callback_data, "mp:downloads-p:1")

    def test_stale_retry_confirmation_has_no_false_confirm_action(self):
        job_id = "11111111-2222-3333-4444-555555555555"
        job = {
            "id": job_id,
            "provider": "rezka",
            "state": "running",
            "title": "Already running",
            "progress": {"progress_percent": 20},
        }
        ctx = mock.Mock()
        ctx.dispatch_tool.side_effect = [
            envelope(job),
            envelope({"jobs": [job]}),
        ]

        card = panel.render_media_panel_card(ctx, f"job-retry:{job_id}:1")
        callbacks = [button.callback_data for row in card.buttons for button in row]

        self.assertIn("Повтор уже недоступен", card.text)
        self.assertIn("Already running", card.text)
        self.assertNotIn(f"ma:retry:{job_id}", callbacks)
        self.assertEqual(card.buttons[-1][0].callback_data, "mp:downloads-p:1")

    def test_business_action_callbacks_are_scoped_to_job_lifecycle(self):
        job_id = "11111111-2222-3333-4444-555555555555"

        first = panel._business_action_callback(
            "resume-storage", job_id, {"revision": 7, "lifecycle_cycle": 2}
        )
        replay = panel._business_action_callback(
            "resume-storage", job_id, {"revision": 7, "lifecycle_cycle": 2}
        )
        later = panel._business_action_callback(
            "resume-storage", job_id, {"revision": 8, "lifecycle_cycle": 2}
        )
        next_lifecycle = panel._business_action_callback(
            "resume-storage", job_id, {"lifecycle_cycle": 3}
        )

        self.assertEqual(first, replay)
        self.assertEqual(first, later)
        self.assertNotEqual(first, next_lifecycle)
        self.assertEqual(first, f"ma:resume-storage:{job_id}:0baf780f")
        self.assertRegex(first, rf"^ma:resume-storage:{job_id}:[0-9a-f]{{8}}$")
        self.assertLess(len(first.encode("utf-8")), 64)

    def test_job_confirmation_uses_versioned_business_callback_when_available(self):
        job_id = "11111111-2222-3333-4444-555555555555"
        job = {
            "id": job_id,
            "provider": "rezka",
            "result_ref": "rezka:job:1",
            "state": "failed",
            "lifecycle_cycle": 3,
            "notify_scope": "initiator",
        }
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = envelope(job)

        card = panel.render_media_panel_card(ctx, f"job-retry:{job_id}")
        callbacks = [button.callback_data for row in card.buttons for button in row]
        retry = next(value for value in callbacks if value.startswith("ma:retry:"))

        self.assertRegex(retry, rf"^ma:retry:{job_id}:[0-9a-f]{{8}}$")
        self.assertLess(len(retry.encode("utf-8")), 64)

    def test_job_and_storage_counts_use_russian_plural_forms(self):
        self.assertEqual(
            panel._job_media_label({"season": 2, "episode_count": 1}),
            "Сезон 2 · 1 серия",
        )
        self.assertEqual(
            panel._job_media_label({"season": 2, "episode_count": 21}),
            "Сезон 2 · 21 серия",
        )
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = envelope({
            "roots": [
                {
                    "path": f"/media/catalog-{index}",
                    "total_bytes": 100,
                    "available_bytes": 50,
                }
                for index in range(5)
            ]
        })

        storage = panel.render_media_panel_card(ctx, "storage")

        self.assertIn("5 каталогов", storage.text)

    def test_download_list_keeps_single_episode_count(self):
        self.assertEqual(
            panel._job_list_media_label({"season": 2, "episode_count": 1}),
            "S2 · 1 эп.",
        )

    def test_recent_and_library_navigation_never_wraps_and_center_is_noop(self):
        recent_items = [
            {"type": "movie", "title": "One", "ratingKey": "1"},
            {"type": "movie", "title": "Two", "ratingKey": "2"},
        ]
        library_page = {
            "MediaContainer": {"totalSize": 11, "Metadata": recent_items}
        }
        ctx = mock.Mock()
        ctx.dispatch_tool.side_effect = [
            envelope({"MediaContainer": {"Metadata": recent_items}}),
            envelope(library_page),
            envelope(library_page),
        ]

        recent = panel.render_media_panel_card(ctx, "recent-key:1:1")
        library_list = panel.render_media_panel_card(ctx, "library-section:2:1")
        library_detail = panel.render_media_panel_card(ctx, "library-key:2:1:1")

        self.assertEqual(
            [button.callback_data for button in recent.buttons[0]],
            ["mp:noop", "mp:noop", "mp:recent-key:2:1"],
        )
        self.assertEqual(
            [button.callback_data for button in library_list.buttons[0]],
            ["mp:noop", "mp:noop", "mp:library-section:2:2"],
        )
        self.assertEqual(
            [button.callback_data for button in library_detail.buttons[0]],
            ["mp:noop", "mp:noop", "mp:library-key:2:2:1"],
        )

    def test_failed_job_has_retry_not_cancel(self):
        job_id = "11111111-2222-3333-4444-555555555555"
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = envelope(
            {"id": job_id, "provider": "rezka", "state": "failed"}
        )
        card = panel.render_media_panel_card(ctx, f"job:{job_id}")
        callbacks = [button.callback_data for row in card.buttons for button in row]
        self.assertIn(f"mp:job-retry:{job_id}:1", callbacks)
        self.assertIsNotNone(
            panel._MEDIA_PANEL_CALLBACK_RE.fullmatch(
                f"mp:job-retry:{job_id}:1"
            )
        )
        self.assertNotIn(f"ma:retry:{job_id}", callbacks)
        self.assertNotIn(f"ma:cancel:{job_id}", callbacks)

        confirmation = panel.render_media_panel_card(ctx, f"job-retry:{job_id}")
        confirmation_callbacks = [
            button.callback_data for row in confirmation.buttons for button in row
        ]
        self.assertIn(f"ma:retry:{job_id}", confirmation_callbacks)
        self.assertIn(f"mp:job:{job_id}:1", confirmation_callbacks)
        self.assertIn("Повторить загрузку?", confirmation.text)

    def test_torrent_stage_labels_are_user_friendly(self):
        job_id = "11111111-2222-3333-4444-555555555555"
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = envelope(
            {
                "id": job_id,
                "provider": "prowlarr",
                "state": "failed",
                "current_stage": "torrent_submit",
            }
        )

        card = panel.render_media_panel_card(ctx, f"job:{job_id}")

        self.assertIn("передача торрента в загрузчик", card.text)
        self.assertNotIn("torrent_submit", card.text)

    def test_tracking_list_and_detail_are_read_only_and_hide_id(self):
        tracking_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        item = {
            "id": tracking_id,
            "provider": "rezka",
            "title": "Series <name>",
            "translation": "Studio & Dub",
            "scope": "family",
            "known_episodes": [{"season": 3, "episode": 6}],
            "download": {"season": 3},
            "check_status": "no_new_episode",
            "next_check_at": "2026-08-05T12:00:00Z",
            "poster_url": "https://image.test/tracking.jpg",
        }
        ctx = mock.Mock()
        ctx.dispatch_tool.side_effect = [envelope({"tracking": [item]}), envelope({"tracking": [item]})]
        listing = panel.render_media_panel_card(ctx, "tracking")
        detail = panel.render_media_panel_card(ctx, f"tracking:{tracking_id}")
        self.assertIn("Series &lt;name&gt;", detail.text)
        self.assertIn("S03E06", detail.text)
        self.assertIn("семейная", detail.text)
        self.assertIn("скачивать новые серии", detail.text)
        self.assertIn("Studio &amp; Dub", detail.text)
        self.assertIn("05.08.2026, 12:00 UTC", detail.text)
        self.assertNotIn("2026-08-05T12:00:00Z", detail.text)
        self.assertNotIn(tracking_id, listing.text + detail.text)
        callbacks = [button.callback_data for row in detail.buttons for button in row]
        self.assertFalse(any("delete" in value or "remove" in value for value in callbacks))
        check_callback = next(value for value in callbacks if value.startswith("mp:tc:"))
        self.assertRegex(
            check_callback,
            rf"^mp:tc:{tracking_id}:1:[0-9a-f]{{8}}$",
        )
        self.assertLessEqual(len(check_callback.encode("utf-8")), 64)
        self.assertIn("⬇️ <b>Series &lt;name&gt;</b> · S03E06 · авто · семейная", listing.text)
        self.assertNotIn("1.", listing.text)
        self.assertEqual(listing.photo_url, "https://image.test/tracking.jpg")
        self.assertEqual(detail.photo_url, "https://image.test/tracking.jpg")

    def test_tracking_scheduled_card_is_honest_and_disables_check(self):
        tracking_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        item = {
            "id": tracking_id,
            "title": "Checked series",
            "check_status": "no_new_episode",
        }
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = envelope({"tracking": [item]})

        card = panel.render_tracking_scheduled_card(ctx, tracking_id, 7)

        self.assertEqual(
            ctx.dispatch_tool.call_args_list,
            [
                mock.call(
                    "mcp__media_admin__media_tracking_list",
                    {"limit": 50, "view": "card"},
                ),
            ],
        )
        callbacks = [button.callback_data for row in card.buttons for button in row]
        self.assertIn("mp:noop", callbacks)
        self.assertIn("mp:tracking-p:1", callbacks)
        self.assertIn("проверка запланирована", card.text)
        self.assertFalse(any("remove" in callback for callback in callbacks))

    def test_tracking_check_failure_has_retry_and_exact_back(self):
        tracking_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        retry = f"mp:tc:{tracking_id}:7:deadbeef"

        card = panel.render_tracking_check_failure_card(tracking_id, 7, retry)

        callbacks = [button.callback_data for row in card.buttons for button in row]
        self.assertEqual(callbacks, [retry, "mp:tracking-p:7"])

    def test_tracking_check_revision_changes_only_after_a_completed_check(self):
        tracking_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

        def callback_for(item):
            ctx = mock.Mock()
            ctx.dispatch_tool.return_value = envelope({"tracking": [item]})
            card = panel.render_media_panel_card(ctx, f"tracking:{tracking_id}:1")
            return next(
                button.callback_data
                for row in card.buttons
                for button in row
                if button.callback_data.startswith("mp:tc:")
            )

        initial = {
            "id": tracking_id,
            "title": "Stable revision",
            "last_checked_at": "2026-08-10T10:00:00Z",
            "next_check_at": "2026-08-10T12:00:00Z",
            "check_status": "no_new_episode",
            "known_episodes": [{"season": 1, "episode": 4}],
        }
        merely_scheduled = {
            **initial,
            "next_check_at": "2026-08-10T10:05:00Z",
            "known_episodes": [{"season": 1, "episode": 5}],
        }
        completed = {
            **merely_scheduled,
            "last_checked_at": "2026-08-10T10:06:00Z",
        }

        initial_callback = callback_for(initial)
        self.assertEqual(callback_for(merely_scheduled), initial_callback)
        self.assertNotEqual(callback_for(completed), initial_callback)
        self.assertLessEqual(len(initial_callback.encode("utf-8")), 64)

    def test_download_list_and_detail_use_first_available_poster(self):
        job_id = "11111111-2222-3333-4444-555555555555"
        job = {
            "id": job_id,
            "provider": "rezka",
            "state": "running",
            "title": "Poster job",
            "poster_url": "https://image.test/job.jpg",
        }
        ctx = mock.Mock()
        ctx.dispatch_tool.side_effect = [
            envelope({"queued": 0, "active": True}),
            envelope({"jobs": [job]}),
            envelope(job),
            envelope({"jobs": [job]}),
        ]

        listing = panel.render_media_panel_card(ctx, "downloads")
        detail = panel.render_media_panel_card(ctx, f"job:{job_id}:1")

        self.assertEqual(listing.photo_url, "https://image.test/job.jpg")
        self.assertEqual(detail.photo_url, "https://image.test/job.jpg")
        self.assertEqual(detail.buttons[-1][0].callback_data, "mp:downloads-p:1")
        self.assertEqual(
            sum("Назад" in button.label for row in detail.buttons for button in row),
            1,
        )

    def test_tracking_detail_formats_postgres_timezone_offset(self):
        tracking_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        item = {
            "id": tracking_id,
            "provider": "rezka",
            "title": "Series",
            "known_episodes": [{"season": 1, "episode": 2}],
            "check_status": "no_new_episode",
            "next_check_at": "2026-08-05 1:42:18.144879 +00:00:00",
        }
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = envelope({"tracking": [item]})

        detail = panel.render_media_panel_card(ctx, f"tracking:{tracking_id}")

        self.assertIn("05.08.2026, 01:42 UTC", detail.text)
        self.assertNotIn("+00:00:00", detail.text)

    def test_unknown_tracking_status_is_neutral_and_keeps_refresh_navigation(self):
        tracking_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        item = {
            "id": tracking_id,
            "title": "Series",
            "scope": "personal",
            "check_status": "future_status",
        }
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = envelope({"tracking": [item]})

        detail = panel.render_media_panel_card(ctx, f"tracking:{tracking_id}:3")
        callbacks = [button.callback_data for row in detail.buttons for button in row]

        self.assertIn("⚠️ Проверка: <b>статус недоступен</b>", detail.text)
        self.assertIn("mp:tracking-p:1", callbacks)
        self.assertTrue(any(value.startswith("mp:tc:") for value in callbacks))

    def test_storage_has_ten_character_bar_and_never_shows_path(self):
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = envelope(
            {
                "roots": [
                    {
                        "path": "/secret/root",
                        "total_bytes": 1000,
                        "available_bytes": 250,
                    }
                ]
            }
        )
        card = panel.render_media_panel_card(ctx, "storage")
        bar = card.text.split("<code>", 1)[1].split("</code>", 1)[0]
        self.assertEqual(len(bar), 10)
        self.assertNotIn("/secret/root", card.text)

    def test_storage_distinguishes_internal_and_usb_without_exposing_paths(self):
        ctx = mock.Mock()
        ctx.dispatch_tool.return_value = envelope(
            {
                "roots": [
                    {
                        "path": "/mnt/internal/torrents/tv",
                        "total_bytes": 1000,
                        "available_bytes": 400,
                    },
                    {
                        "path": "/mnt/usb_drive/torrents/tv",
                        "total_bytes": 2000,
                        "available_bytes": 500,
                    },
                ]
            }
        )

        card = panel.render_media_panel_card(ctx, "storage")

        self.assertIn("Внутреннее хранилище", card.text)
        self.assertIn("USB-архив", card.text)
        self.assertNotIn("/mnt/", card.text)

    def test_every_media_panel_screen_has_compact_navigation_and_hides_internal_ids(self):
        job_id = "11111111-2222-3333-4444-555555555555"
        tracking_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        plex_item = {
            "type": "movie",
            "title": "Example movie",
            "ratingKey": "42",
            "year": 2026,
            "summary": "Example summary",
        }
        job = {
            "id": job_id,
            "provider": "prowlarr",
            "state": "running",
            "title": "Example download",
            "season": 1,
        }
        tracking = {
            "id": tracking_id,
            "title": "Example series",
            "scope": "personal",
            "provider": "rezka",
            "translation": "release-calendar",
            "known_episodes": [{"season": 1, "episode": 3}],
            "check_status": "no_new_episode",
        }

        def dispatch(tool, _arguments):
            payloads = {
                "mcp__media_admin__plex_now_playing": {
                    "MediaContainer": {"Metadata": [plex_item]}
                },
                "mcp__media_admin__plex_recent": {
                    "MediaContainer": {"Metadata": [plex_item]}
                },
                "mcp__media_admin__plex_library_summary": {
                    "sections": [{"section_key": 1, "title": "Movies", "type": "movie", "item_count": 1}]
                },
                "mcp__media_admin__plex_library_items": {
                    "MediaContainer": {"totalSize": 1, "Metadata": [plex_item]}
                },
                "mcp__media_admin__media_storage_status": {
                    "roots": [{"path": "/mnt/internal", "total_bytes": 1000, "available_bytes": 500}]
                },
                "mcp__media_admin__media_queue_status": {"queued": 0, "active": True},
                "mcp__media_admin__media_jobs_list": {"jobs": [job]},
                "mcp__media_admin__media_job_get": job,
                "mcp__media_admin__media_tracking_list": {"tracking": [tracking]},
            }
            return envelope(payloads[tool])

        ctx = mock.Mock()
        ctx.dispatch_tool.side_effect = dispatch
        routes = (
            "home",
            "watching",
            "watching-key:42",
            "recent",
            "recent-key:42",
            "library",
            "library-section:1:1",
            "library-key:1:42:1",
            "storage",
            "downloads",
            f"job:{job_id}",
            f"job-cancel:{job_id}",
            "tracking",
            f"tracking:{tracking_id}",
        )

        for route in routes:
            with self.subTest(route=route):
                card = panel.render_media_panel_card(ctx, route)
                labels = [button.label for row in card.buttons for button in row]
                self.assertTrue(all(1 <= len(row) <= 3 for row in card.buttons))
                self.assertLessEqual(len(card.text), 4096)
                self.assertNotIn(job_id, card.text)
                self.assertNotIn(tracking_id, card.text)
                self.assertNotIn("/mnt/", card.text)
                if route != "home":
                    self.assertEqual(sum("Назад" in label for label in labels), 1)

    def test_plex_player_name_hides_internal_dns_suffix(self):
        self.assertEqual(
            panel._plex_player_name("Mac.local.iamstubborn.dev"),
            "Mac",
        )
        self.assertEqual(panel._plex_player_name("Living Room TV"), "Living Room TV")


if __name__ == "__main__":
    unittest.main()
