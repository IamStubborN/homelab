#!/usr/bin/env python3
"""Exercise native SQLite WAL callbacks after a conflicting global library load."""

import argparse
import ctypes
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import tempfile


def exercise(args):
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if args.system and not args.inspect and not args.system_late:
        ctypes.CDLL(args.system, mode=os.RTLD_NOW | os.RTLD_GLOBAL)
    # ctypes normally forces RTLD_NOW. Preserve lazy ELF binding so a later
    # native dependency can override a not-yet-used WAL hook, as in Lampac.
    loader = ctypes.CDLL(None)
    loader.dlopen.argtypes = [ctypes.c_char_p, ctypes.c_int]
    loader.dlopen.restype = ctypes.c_void_p
    handle = loader.dlopen(os.fsencode(args.bundled), os.RTLD_LAZY | os.RTLD_LOCAL)
    if not handle:
        raise RuntimeError("Cannot load bundled SQLite")
    sqlite = ctypes.CDLL(args.bundled, handle=handle)
    sqlite.sqlite3_libversion.restype = ctypes.c_char_p
    sqlite.sqlite3_sourceid.restype = ctypes.c_char_p
    sqlite.sqlite3_compileoption_get.argtypes = [ctypes.c_int]
    sqlite.sqlite3_compileoption_get.restype = ctypes.c_char_p
    if args.inspect:
        options = []
        for index in range(500):
            option = sqlite.sqlite3_compileoption_get(index)
            if option is None:
                break
            options.append(option.decode())
        print(json.dumps({"version": sqlite.sqlite3_libversion().decode(),
                          "sourceid": sqlite.sqlite3_sourceid().decode(),
                          "compile_options": options}), flush=True)
        return

    sqlite.sqlite3_open.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
    sqlite.sqlite3_open.restype = ctypes.c_int
    sqlite.sqlite3_exec.argtypes = [ctypes.c_void_p, ctypes.c_char_p,
                                  ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    sqlite.sqlite3_exec.restype = ctypes.c_int
    sqlite.sqlite3_close.argtypes = [ctypes.c_void_p]
    sqlite.sqlite3_close.restype = ctypes.c_int
    sqlite.sqlite3_wal_checkpoint.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    sqlite.sqlite3_wal_checkpoint.restype = ctypes.c_int

    def execute(sql):
        result = sqlite.sqlite3_exec(db, sql.encode(), None, None, None)
        if result:
            raise RuntimeError(f"SQLite execution returned {result}")

    with tempfile.TemporaryDirectory(prefix="sqlite-wal-") as directory:
        db = ctypes.c_void_p()
        print("stage=open", flush=True)
        result = sqlite.sqlite3_open(os.fsencode(Path(directory) / "check.db"), ctypes.byref(db))
        if result:
            raise RuntimeError(f"SQLite open returned {result}")
        try:
            print("stage=wal-setup", flush=True)
            execute("PRAGMA journal_mode=WAL;")
            execute("PRAGMA wal_autocheckpoint=1000;")
            execute("PRAGMA synchronous=OFF;")
            execute("CREATE TABLE samples(payload BLOB);")
            if args.system and args.system_late:
                print("stage=late-global-load", flush=True)
                ctypes.CDLL(args.system, mode=os.RTLD_NOW | os.RTLD_GLOBAL)
            print("stage=wal-commit", flush=True)
            # Over 1,000 WAL pages triggers the same default hook as playback writes.
            execute("BEGIN; WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL "
                    "SELECT x+1 FROM n WHERE x<1100) "
                    "INSERT INTO samples SELECT zeroblob(8192) FROM n; COMMIT;")
            print("stage=explicit-checkpoint", flush=True)
            result = sqlite.sqlite3_wal_checkpoint(db, None)
            if result:
                raise RuntimeError(f"SQLite checkpoint returned {result}")
            print("stage=complete", flush=True)
        finally:
            sqlite.sqlite3_close(db)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundled", required=True)
    parser.add_argument("--system", help="System SQLite to load globally before the bundled library")
    parser.add_argument("--system-late", action="store_true",
                        help="Load the conflicting library after database setup, before WAL checkpoint")
    parser.add_argument("--expect", choices=("pass", "crash"), default="pass")
    parser.add_argument("--inspect", action="store_true")
    parser.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.child:
        exercise(args)
        return 0
    result = subprocess.run([sys.executable, __file__, *sys.argv[1:], "--child"],
                            capture_output=True, text=True, timeout=60)
    print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, file=sys.stderr, end="")
    expected = -11 if args.expect == "crash" and not args.inspect else 0
    print(json.dumps({"returncode": result.returncode, "expected": expected,
                      "passed": result.returncode == expected}))
    return 0 if result.returncode == expected else 1


if __name__ == "__main__":
    sys.exit(main())
