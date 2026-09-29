import importlib.util
import json
from pathlib import Path
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('lampa_ai_adapter', Path(__file__).with_name('app.py'))
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


class SearchFallbackTests(unittest.TestCase):
    def request_search(self):
        server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}/ai/search/example') as response:
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
            backend.assert_called_once_with(app.LAMPAC_FALLBACK_BASE + '/ai/search/example')

    def test_valid_empty_tmdb_result_does_not_call_fallback(self):
        candidates = '[{"title":"Example", "type":"movie"}]'
        with patch.object(app, 'completion', return_value=candidates), patch.object(
            app, 'tmdb', return_value={'results': []}
        ), patch.object(app, 'http_json') as backend:
            self.assertEqual(self.request_search(), (200, {'results': []}))
            backend.assert_not_called()
