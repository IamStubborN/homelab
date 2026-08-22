from __future__ import annotations

import argparse
from pathlib import Path

from health_mcp.ingest.run import private_report, public_report, run_ingest


def main() -> None:
    parser = argparse.ArgumentParser(
        description="One-shot Здоровье ingest using WikiStore (via=system)."
    )
    parser.add_argument("--wiki-root", type=Path, required=True, help="Path to shared/health")
    parser.add_argument("--export-dir", type=Path, default=Path("/tmp/zdorovie-export"))
    parser.add_argument(
        "--xlsx",
        type=Path,
        default=Path("/tmp/zdorovie-xlsx/Дневник показателей здоровья.xlsx"),
    )
    parser.add_argument(
        "--raw-src",
        type=Path,
        required=True,
        help="Local directory with Drive binaries already copied (do not write to Здоровье/)",
    )
    parser.add_argument("--report", type=Path, help="Counts-only markdown report")
    parser.add_argument("--report-private", type=Path, help="Private report with skip quotes")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    stats = run_ingest(
        health_root=args.wiki_root,
        export_dir=args.export_dir,
        xlsx_path=args.xlsx,
        raw_src=args.raw_src,
        force=args.force,
    )
    public = public_report(stats)
    print(public)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(public, encoding="utf-8")
    if args.report_private:
        args.report_private.parent.mkdir(parents=True, exist_ok=True)
        args.report_private.write_text(private_report(stats, args.wiki_root.resolve()), encoding="utf-8")


if __name__ == "__main__":
    main()
