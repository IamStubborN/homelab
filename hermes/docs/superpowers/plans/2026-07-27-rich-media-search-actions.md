# Rich Media Search Actions Implementation Plan

1. Add failing tests for full Rezka translation details, Prowlarr details,
   download and continuation actions, callback persistence, and consumption.
2. Introduce typed search-card and action-record models in the Telegram plugin.
3. Add an atomic bounded action store in the Hermes profile volume.
4. Render rich provider sections and inline keyboards from direct search JSON.
5. Handle download and pagination callbacks without an LLM.
6. Add a complete structured media-card action matrix regression test.
7. Run the full Hermes test suite and syntax checks.
8. Commit and push `main`.
9. Deploy only Hermes profiles and notifiers.
10. Verify through Web Telegram and cancel the test job immediately.
