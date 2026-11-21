import importlib.util
import json
from pathlib import Path
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import ANY, mock_open, patch

spec = importlib.util.spec_from_file_location('lampa_ai_adapter', Path(__file__).with_name('app.py'))
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


class SearchFallbackTests(unittest.TestCase):
    def request_search(self, query='example'):
        server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        thread.start()
        try:
            path = '/ai/search/' + urllib.parse.quote(query, safe='')
            with urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}{path}') as response:
                return response.status, json.load(response)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_tmdb_unavailable_reaches_lampac_fallback(self):
        candidates = '[{"title":"Example", "type":"movie"}]'
        fallback = {'results': [{'id': 42, 'title': 'Fallback title'}]}
        with patch.object(app, 'completion', return_value=candidates), patch.object(
            app, 'tmdb', side_effect=urllib.error.URLError('synthetic unavailable')
        ), patch.object(app, 'http_json', return_value=fallback) as backend:
            self.assertEqual(self.request_search(), (200, fallback))
            backend.assert_called_once_with(app.LAMPAC_FALLBACK_BASE + '/ai/search/example', timeout=5)

    def test_valid_empty_tmdb_result_does_not_call_fallback(self):
        candidates = '[{"title":"Example", "type":"movie"}]'
        with patch.object(app, 'completion', return_value=candidates), patch.object(
            app, 'tmdb', return_value={'results': []}
        ), patch.object(app, 'web_candidates', return_value=[]), patch.object(app, 'http_json') as backend:
            self.assertEqual(self.request_search(), (200, {'results': []}))
            backend.assert_not_called()

    def test_empty_ai_answer_finds_a_title_in_the_catalog(self):
        card = {'id': 42, 'name': 'Шальной последний босс явился!', 'media_type': 'tv'}
        with patch.object(app, 'completion', return_value='[]'), patch.object(
            app, 'tmdb', return_value={'results': [card]}
        ) as catalog:
            self.assertEqual(self.request_search('последний босс явился'), (200, {'results': [card]}))
            catalog.assert_called_once_with('/search/multi', query='последний босс явился', language='ru-RU', include_adult='false', timeout=ANY)

    def test_catalog_title_with_one_extra_word_beats_an_unrelated_ai_card(self):
        card = {'id': 42, 'name': 'Шальной последний босс явился!', 'media_type': 'tv'}
        unrelated = {'id': 43, 'name': 'Другой сериал', 'media_type': 'tv'}

        def catalog(path, *, query, **params):
            return {'results': {
                'последний босс явился': [unrelated, card],
                'Другой сериал': [unrelated],
            }.get(query, [])}

        with patch.object(app, 'completion', return_value='[{"title":"Другой сериал","type":"tv"}]'), patch.object(
            app, 'tmdb', side_effect=catalog
        ):
            self.assertEqual(self.request_search('последний босс подземелья явился'), (200, {'results': [card]}))

    def test_catalog_retry_preserves_a_search_exclusion(self):
        plan = {'intent': 'identify', 'exclude': [], 'web_query': 'Назад в будущее',
                'candidates': [{'title': 'Назад в будущее', 'type': 'movie'}]}
        with patch.object(app, 'completion', return_value=json.dumps(plan)), patch.object(
            app, 'tmdb'
        ) as catalog, patch.object(app, 'web_candidates') as web:
            self.assertEqual(self.request_search('исключи назад в будущее'), (200, {'results': []}))
            catalog.assert_not_called()
            web.assert_not_called()

    def test_clear_catalog_match_uses_explicit_type_and_year_without_web(self):
        lookup = [
            {'id': 1, 'title': 'Beacon', 'media_type': 'movie', 'release_date': '2001-01-01'},
            {'id': 2, 'name': 'Beacon', 'media_type': 'tv', 'first_air_date': '2020-01-01'},
            {'id': 3, 'title': 'Beacon', 'media_type': 'movie', 'release_date': '2020-01-01'},
        ]
        plan = {'intent': 'identify', 'type': 'movie', 'year': 2020}
        with patch.object(app, 'completion', return_value=json.dumps(plan)), patch.object(
            app, 'tmdb', return_value={'results': lookup}
        ), patch.object(app, 'web_candidates') as web:
            self.assertEqual(self.request_search('фильм Beacon 2020'), (200, {'results': [lookup[2]]}))
            web.assert_not_called()

    def test_weak_plot_match_uses_web_once_and_checks_imdb_id_in_tmdb(self):
        plan = {'intent': 'identify', 'type': 'movie', 'year': 2020, 'web_query': 'film lighthouse moving through time'}
        card = {'id': 42, 'title': 'Beacon', 'release_date': '2020-01-01'}

        def catalog(path, **params):
            if path == '/find/tt1234567':
                self.assertEqual(params['external_source'], 'imdb_id')
                return {'movie_results': [card]}
            return {'results': []}

        with patch.object(app, 'completion', return_value=json.dumps(plan)), patch.object(
            app, 'tmdb', side_effect=catalog
        ), patch.object(app, 'web_candidates', return_value=[{'imdb_id': 'tt1234567'}]) as web:
            self.assertEqual(self.request_search('фильм где маяк перемещается во времени'), (200, {'results': [{**card, 'media_type': 'movie'}]}))
            web.assert_called_once_with(plan['web_query'], ANY)

    def test_web_failure_keeps_the_catalog_card_from_the_model(self):
        plan = {'intent': 'identify', 'candidates': [{'title': 'Beacon', 'type': 'movie'}]}
        card = {'id': 42, 'title': 'Beacon', 'media_type': 'movie'}

        def catalog(path, *, query, **params):
            return {'results': [card] if query == 'Beacon' else []}

        with patch.object(app, 'completion', return_value=json.dumps(plan)), patch.object(
            app, 'tmdb', side_effect=catalog
        ), patch.object(app, 'web_candidates', side_effect=TimeoutError):
            self.assertEqual(self.request_search('фильм где маяк перемещается во времени'), (200, {'results': [card]}))

    def test_recommendation_filters_explicit_excluded_titles_locally(self):
        first = {'id': 42, 'title': 'Beacon', 'media_type': 'movie'}
        excluded = {'id': 43, 'title': 'Календарь', 'original_title': 'The Calendar', 'media_type': 'movie'}
        plan = {'intent': 'recommend', 'type': 'movie', 'exclude': ['The Calendar'],
                'candidates': [{'title': 'Beacon'}, {'title': 'Календарь'}]}

        def catalog(path, *, query, **params):
            return {'results': [first if query == 'Beacon' else excluded]}

        with patch.object(app, 'completion', return_value=json.dumps(plan)), patch.object(
            app, 'tmdb', side_effect=catalog
        ), patch.object(app, 'web_candidates') as web:
            self.assertEqual(self.request_search('фильмы про время кроме Календаря'), (200, {'results': [first]}))
            web.assert_not_called()

    def test_tavily_uses_one_bounded_search_and_reads_ids_from_catalog_links(self):
        hits = {'results': [
            {'url': 5},
            {'url': 'https://www.imdb.com/title/tt1234567/?example=1', 'title': 'Example'},
            {'url': 'https://www.themoviedb.org/tv/42-beacon', 'title': 'Beacon'},
            {'url': 'https://example.test/title/tt7654321/', 'title': 'Beacon (2020 film) | Test Site'},
        ]}
        with patch('builtins.open', mock_open(read_data='test-key\n')), patch.object(app, 'http_json', return_value=hits) as http:
            self.assertEqual(app.web_candidates('clue', 3), [
                {'imdb_id': 'tt1234567'}, {'type': 'tv', 'tmdb_id': 42}, {'title': 'Beacon', 'year': 2020},
            ])
            http.assert_called_once_with(
                'https://api.tavily.com/search', method='POST', timeout=3,
                headers={'Authorization': 'Bearer test-key'},
                payload={'query': 'clue', 'search_depth': 'basic', 'max_results': 5,
                         'include_answer': False, 'include_raw_content': False},
            )

    def test_model_cannot_make_catalog_id_requests(self):
        with patch.object(app, 'tmdb') as catalog:
            self.assertEqual(app.resolve_candidates([{'imdb_id': 'tt1234567'}, {'tmdb_id': 1, 'type': 'tv'}]), [])
            catalog.assert_not_called()

    def test_invalid_web_tmdb_response_keeps_the_catalog_card_from_the_model(self):
        plan = {'intent': 'identify', 'candidates': [{'title': 'Beacon', 'type': 'movie'}]}
        card = {'id': 42, 'title': 'Beacon', 'media_type': 'movie'}

        def catalog(path, **params):
            if path == '/find/tt1234567':
                return []
            return {'results': [card] if params['query'] == 'Beacon' else []}

        with patch.object(app, 'completion', return_value=json.dumps(plan)), patch.object(
            app, 'tmdb', side_effect=catalog
        ), patch.object(app, 'web_candidates', return_value=[{'imdb_id': 'tt1234567'}]):
            self.assertEqual(self.request_search('фильм где маяк перемещается во времени'), (200, {'results': [card]}))
