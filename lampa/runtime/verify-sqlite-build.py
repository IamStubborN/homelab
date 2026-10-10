#!/usr/bin/env python3
"""Reject SQLite replacements that change source or advertised capabilities."""

import ctypes
from pathlib import Path
import sys


def identity(path):
    library = ctypes.CDLL(str(Path(path).resolve()), mode=ctypes.RTLD_LOCAL)
    library.sqlite3_sourceid.restype = ctypes.c_char_p
    library.sqlite3_compileoption_get.argtypes = [ctypes.c_int]
    library.sqlite3_compileoption_get.restype = ctypes.c_char_p
    options = set()
    index = 0
    while option := library.sqlite3_compileoption_get(index):
        value = option.decode()
        if not value.startswith("COMPILER="):
            options.add(value)
        index += 1
    return library.sqlite3_sourceid().decode(), options


if __name__ == "__main__":
    original_source, original_options = identity(sys.argv[1])
    fixed_source, fixed_options = identity(sys.argv[2])
    if original_source != fixed_source:
        sys.exit("SQLite source changed; review the pinned amalgamation before updating.")
    if original_options != fixed_options:
        sys.exit(f"SQLite options changed: removed={sorted(original_options - fixed_options)}, "
                 f"added={sorted(fixed_options - original_options)}")
    print("SQLite source and compile options match the original runtime.")
