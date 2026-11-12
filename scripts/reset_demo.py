"""Start the demo from a clean state: back up the current database, create a fresh one,
and load the shared sample (data/samples/requests.csv) through the normal ingest pipeline.

With DATABASE_URL set (Postgres) the tables are emptied instead: there is no file to back up,
so it asks for confirmation first. Neon can still restore an earlier point in time.

  python scripts/reset_demo.py              # sample only
  python scripts/reset_demo.py --no-sample  # empty database

Stop the backend first (or restart it afterwards). Nothing on chain is touched: old Testnet
transactions stay, and reconciliation will list them as "on chain, not in our records".

The on-chain registry remembers every (programme, batch, person) ever paid, so re-paying the
sample after a reset would be refused as "already paid". Each reset therefore writes a new
PROGRAM_ID to .env, which gives the registry a clean namespace (the contract itself stays).
"""
from __future__ import annotations

import os
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app import config, db  # noqa: E402
from backend.app.services import ingest  # noqa: E402

SAMPLE = ROOT / "data" / "samples" / "requests.csv"


def set_env(key: str, value: str) -> None:
    env = config.ROOT / ".env"
    lines = [ln for ln in env.read_text().splitlines() if not ln.startswith(f"{key}=")] if env.exists() else []
    lines.append(f"{key}={value}")
    env.write_text("\n".join(lines) + "\n")
    os.environ[key] = value


def main() -> None:
    if config.DATABASE_URL:
        answer = input("This deletes every request and audit event in the Postgres database. Type 'reset': ")
        if answer.strip() != "reset":
            sys.exit("cancelled; nothing changed")
    program = f"AIDFLOW-DEMO-{datetime.now():%m%d-%H%M}"
    set_env("PROGRAM_ID", program)
    print(f"new programme id {program}: the on-chain registry starts clean for this run")
    if config.DATABASE_URL:
        print(f"  set PROGRAM_ID={program} on the deployed backend too, or it keeps the old namespace")
        conn = db.connect()
        conn.execute("TRUNCATE requests, events RESTART IDENTITY")
        conn.commit()
        print("emptied the Postgres tables")
    else:
        path = config.DB_PATH
        if path.exists():
            backup = path.with_name(f"{path.name}.bak-{datetime.now():%Y%m%d%H%M%S}")
            shutil.move(path, backup)
            print(f"backed up {path.name} -> {backup.name}")
        conn = db.connect()
    if "--no-sample" not in sys.argv:
        rep = ingest.ingest_csv(conn, SAMPLE.read_text())
        print(f"loaded {SAMPLE.relative_to(ROOT)}: {rep['accepted']} accepted, {len(rep['flagged'])} flagged, "
              f"{rep['invalid_stored']} invalid, {len(rep['rejected']) - rep['invalid_stored']} duplicate refs rejected")
    conn.close()
    where = "Postgres (DATABASE_URL)" if config.DATABASE_URL else config.DB_PATH.relative_to(ROOT)
    print(f"fresh database at {where}. Restart the backend if it is running.")


if __name__ == "__main__":
    main()
