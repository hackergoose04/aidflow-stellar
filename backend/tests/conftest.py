"""Every test gets an empty database of its own.

SQLite (a temporary file) by default. Set TEST_DATABASE_URL to run the same tests on Postgres:

    TEST_DATABASE_URL=postgresql://localhost/aidflow_test pytest backend/tests

That database is wiped before each test, so never point it at one you care about. DATABASE_URL
from .env is ignored here for the same reason."""
from __future__ import annotations

import os

import pytest

from backend.app import config, db

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL") or None


@pytest.fixture(autouse=True)
def database(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATABASE_URL", TEST_DATABASE_URL)
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "aidflow.db")
    if TEST_DATABASE_URL:
        import psycopg

        with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as conn:
            conn.execute("DROP TABLE IF EXISTS requests, events")
        db._migrated.discard(TEST_DATABASE_URL)  # the next connect() creates the schema again
    yield


postgres_only = pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs TEST_DATABASE_URL (Postgres)")
sqlite_only = pytest.mark.skipif(bool(TEST_DATABASE_URL), reason="exercises SQLite file migrations")
