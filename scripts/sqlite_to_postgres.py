"""Copy the local SQLite database into Postgres, once, when moving to a shared database.

  DATABASE_URL=postgresql://... python scripts/sqlite_to_postgres.py [path/to/aidflow.db]

Reads data/aidflow.db (or AIDFLOW_DB, or the path given) and writes every request and audit
event to DATABASE_URL. Refuses if the Postgres tables already hold data, so it can't double up.
Audit events keep their order; their ids are renumbered by Postgres.
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app import config, db  # noqa: E402


def main() -> None:
    if not config.DATABASE_URL:
        sys.exit("set DATABASE_URL to the Postgres database to copy into")
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else config.DB_PATH
    if not source.exists():
        sys.exit(f"no SQLite database at {source}")

    url = config.DATABASE_URL
    config.DATABASE_URL = None
    config.DB_PATH = source
    src = db.connect()  # brings an older file up to the current columns first
    config.DATABASE_URL = url
    dst = db.connect()

    held = {t: dst.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("requests", "events")}
    if any(held.values()):
        sys.exit(f"Postgres already has data ({held}); empty it first, nothing copied")

    requests = src.execute("SELECT * FROM requests ORDER BY created_at, request_ref").fetchall()
    for row in requests:
        cols = list(row.keys())
        dst.execute(f"INSERT INTO requests ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                    [row[c] for c in cols])
    events = src.execute("SELECT request_ref, kind, detail, at FROM events ORDER BY id").fetchall()
    for e in events:
        dst.execute("INSERT INTO events (request_ref, kind, detail, at) VALUES (?, ?, ?, ?)", tuple(e))
    dst.commit()
    src.close()
    dst.close()
    print(f"copied {len(requests)} requests and {len(events)} audit events from {source} to Postgres")


if __name__ == "__main__":
    main()
