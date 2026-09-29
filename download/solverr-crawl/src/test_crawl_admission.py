"""Exercise the real HTTP boundary without launching browsers."""
import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from types import SimpleNamespace
from dtos import V1RequestBase

from webtest import TestApp

import flaresolverr
import flaresolverr_service as service
from dtos import V1ResponseBase
from sessions import SessionStore


class CrawlAdmission(unittest.TestCase):
    def test_busy_request_is_rejected_and_health_stays_responsive(self):
        entered, release = threading.Event(), threading.Event()
        calls = []

        def browser(req):
            calls.append(req.session)
            if len(calls) == 1:
                entered.set()
                self.assertTrue(release.wait(5))
            return V1ResponseBase({"status": "ok"})

        with patch.dict(os.environ, BROWSER_SERIAL_MODE="true"), \
                patch.object(service, "_controller_v1_handler", browser), \
                ThreadPoolExecutor(1) as pool:
            first = pool.submit(TestApp(flaresolverr.app).post_json, "/v1",
                                {"cmd": "request.get", "session": "one"})
            try:
                self.assertTrue(entered.wait(2))
                second = TestApp(flaresolverr.app).post_json(
                    "/v1", {"cmd": "request.get", "session": "two"}, expect_errors=True)
                self.assertEqual(second.status_int, 503)
                self.assertEqual(second.headers["Retry-After"], "5")
                self.assertEqual(calls, ["one"])
                self.assertEqual(TestApp(flaresolverr.app).get("/health").json,
                                 {"status": "ok"})
            finally:
                release.set()
            self.assertEqual(first.result().status_int, 200)
            self.assertEqual(TestApp(flaresolverr.app).post_json(
                "/v1", {"cmd": "request.get", "session": "two"}).status_int, 200)

    def test_failure_releases_admission(self):
        with patch.dict(os.environ, BROWSER_SERIAL_MODE="true"), \
                patch.object(service, "_controller_v1_handler",
                             side_effect=[RuntimeError("failed"), V1ResponseBase({"status": "ok"})]):
            app = TestApp(flaresolverr.app)
            self.assertEqual(app.post_json("/v1", {"cmd": "request.get"},
                                          expect_errors=True).status_int, 500)
            self.assertEqual(app.post_json("/v1", {"cmd": "request.get"}).status_int, 200)

    def test_switching_host_retires_previous_retained_browser(self):
        closed = []
        store = SessionStore(build=lambda proxy=None: object(), teardown=closed.append)
        store.create("old-host")
        with patch.dict(os.environ, BROWSER_SERIAL_MODE="true"), \
                patch.object(service, "SESSIONS_STORAGE", store), \
                patch.object(service, "STEALTH_ENGINE", None):
            app = TestApp(flaresolverr.app)
            app.post_json("/v1", {"cmd": "sessions.create", "session": "new-host"})
            self.assertEqual(store.session_ids(), ["new-host"])
            self.assertEqual(len(closed), 1)
            app.post_json("/v1", {"cmd": "sessions.create", "session": "new-host"})
            self.assertEqual(len(closed), 1)

    def test_invalid_request_does_not_evict_existing_session(self):
        invalid_requests = [
            {"cmd": "request.get", "session": "new-host"},
            {"cmd": "request.get", "session": "new-host", "url": "file:///etc/hosts"},
            {"cmd": "request.get", "session": "new-host", "url": "https://example.test/", "postData": "x=1"},
            {"cmd": "request.get", "session": "new-host", "url": "https://example.test/", "engine": "typo"},
            {"cmd": "request.post", "session": "new-host", "url": "https://example.test/"},
            {"cmd": "sessions.create", "session": "new-host", "engine": "typo"},
            {"cmd": "sessions.create", "session": "new-host", "engine": "stealth"},
        ]
        for request in invalid_requests:
            with self.subTest(request=request):
                closed = []
                store = SessionStore(build=lambda proxy=None: object(), teardown=closed.append)
                store.create("valid-host")
                with patch.dict(os.environ, BROWSER_SERIAL_MODE="true"), \
                        patch.object(service, "SESSIONS_STORAGE", store), \
                        patch.object(service, "STEALTH_ENGINE", None):
                    response = TestApp(flaresolverr.app).post_json("/v1", request, expect_errors=True)
                    self.assertEqual(response.status_int, 500)
                    self.assertEqual(store.session_ids(), ["valid-host"])
                    self.assertEqual(closed, [])

    def test_default_mode_keeps_other_hosts(self):
        closed = []
        store = SessionStore(build=lambda proxy=None: object(), teardown=closed.append)
        store.create("old-host")
        with patch.dict(os.environ, BROWSER_SERIAL_MODE="false"), \
                patch.object(service, "SESSIONS_STORAGE", store), \
                patch.object(service, "STEALTH_ENGINE", None):
            TestApp(flaresolverr.app).post_json("/v1", {"cmd": "sessions.create", "session": "new-host"})
            self.assertCountEqual(store.session_ids(), ["old-host", "new-host"])
            self.assertEqual(closed, [])

    def test_cross_engine_retirement_preserves_current_id_and_evicted_proxy(self):
        closed_chrome, closed_stealth = [], []
        chrome = SessionStore(build=lambda proxy=None: object(), teardown=closed_chrome.append)
        stealth = SessionStore(build=lambda proxy=None: object(), teardown=closed_stealth.append)
        proxy = {"url": "http://proxy.test:8080"}
        for store in (chrome, stealth):
            store.create("old-host", proxy=proxy)
            store.create("current-host")
        stealth_engine = SimpleNamespace(session_ids=stealth.session_ids,
                                         discard_session=stealth.discard,
                                         exists=stealth.exists)
        with patch.dict(os.environ, BROWSER_SERIAL_MODE="true"), \
                patch.object(service, "SESSIONS_STORAGE", chrome), \
                patch.object(service, "STEALTH_ENGINE", stealth_engine):
            service._retire_other_sessions(V1RequestBase({"cmd": "request.get", "session": "current-host"}))
            for store in (chrome, stealth):
                self.assertEqual(store.session_ids(), ["current-host"])
                rebuilt, fresh = store.get("old-host", proxy={"url": "http://wrong.test:8080"})
                self.assertTrue(fresh)
                self.assertEqual(rebuilt.proxy, proxy)
                store.end_use(rebuilt)
            self.assertEqual(len(closed_chrome), 1)
            self.assertEqual(len(closed_stealth), 1)


if __name__ == "__main__":
    unittest.main()
