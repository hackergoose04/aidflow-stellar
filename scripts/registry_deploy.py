"""Deploy the AidRegistry contract (Plan B: hash registry) to Testnet. Run after testnet_setup.py.

  1. Build:  cd contracts/aid_registry && cargo build --target wasm32v1-none --release
  2. python scripts/registry_deploy.py

Uploads the wasm, creates the registry with admin = DISTRIBUTION, and saves
REGISTRY_CONTRACT_ID, REGISTRY_SECRET (the HMAC key, generated once and kept) and
PROGRAM_ID to .env. From then on the backend registers every payout on chain.
"""
from __future__ import annotations

import os
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from stellar_sdk import scval  # noqa: E402

from backend.app import config, soroban, stellar_client as sc  # noqa: E402

WASM = ROOT / "contracts/aid_registry/target/wasm32v1-none/release/aid_registry.wasm"


def set_env(key: str, value: str) -> None:
    path = config.ROOT / ".env"
    lines = [ln for ln in path.read_text().splitlines() if not ln.startswith(f"{key}=")]
    lines.append(f"{key}={value}")
    path.write_text("\n".join(lines) + "\n")
    os.environ[key] = value


def main() -> None:
    if not WASM.exists():
        raise SystemExit(f"missing {WASM.relative_to(ROOT)}; build the contract first")
    dist = sc.distribution_keypair()

    print(f"1/2 uploading wasm ({WASM.stat().st_size} bytes)...")
    wasm = WASM.read_bytes()
    status, h, ret = soroban.submit(dist, lambda b: b.append_upload_contract_wasm_op(wasm))
    if status != "SUCCESS":
        raise SystemExit(f"    upload failed: {sc.explorer_link(h)}")
    wasm_hash = ret.bytes.sc_bytes
    print(f"    wasm hash {wasm_hash.hex()}  {sc.explorer_link(h)}")

    print("2/2 creating the registry (admin = DISTRIBUTION)...")
    status, h, ret = soroban.submit(dist, lambda b: b.append_create_contract_op(
        wasm_id=wasm_hash, address=dist.public_key,
        constructor_args=[scval.to_address(dist.public_key)]))
    if status != "SUCCESS":
        raise SystemExit(f"    create failed: {sc.explorer_link(h)}")
    cid = soroban.address_of(ret)
    print(f"    registry {cid}  {sc.explorer_link(h)}")

    set_env("REGISTRY_CONTRACT_ID", cid)
    if not os.getenv("REGISTRY_SECRET"):
        set_env("REGISTRY_SECRET", secrets.token_hex(32))
        print("    generated REGISTRY_SECRET (HMAC key; keep it, and never commit .env)")
    if not os.getenv("PROGRAM_ID"):
        set_env("PROGRAM_ID", "AIDFLOW-DEMO")
    print(f"\ncontract: https://stellar.expert/explorer/testnet/contract/{cid}")
    print("saved to .env. Restart the backend so payouts use the registry.")


if __name__ == "__main__":
    main()
