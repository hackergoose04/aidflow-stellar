"""Vercel entrypoint for the API: Vercel looks for a FastAPI `app` in a root index.py.
Locally, keep running  uvicorn backend.app.main:app --reload"""
from backend.app.main import app  # noqa: F401
