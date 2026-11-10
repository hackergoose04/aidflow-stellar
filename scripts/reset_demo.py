"""Start the demo from a clean state: back up the current database, create a fresh one,
and load the shared sample (data/samples/requests.csv) through the normal ingest pipeline.

  python scripts/reset_demo.py              # sample only
  python scripts/reset_demo.py --no-sample  # empty database

Stop the backend first (or restart it afterwards). Nothing on chain is touched: old Testnet
transactions stay, and reconciliation will list them as "on chain, not in our records".
"""
from __future__ import annotations

import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app import config, db  # noqa: E402
from backend.app.services import ingest  # noqa: E402

SAMPLE = ROOT / "data" / "samples" / "requests.csv"


def main() -> None:
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
    print(f"fresh database at {path.relative_to(ROOT)}. Restart the backend if it is running.")


if __name__ == "__main__":
    main()
