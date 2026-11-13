"""Prepare public Auxílio Emergencial exports for the offline benchmark."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from contextlib import contextmanager
import csv
import gzip
import hmac
import io
import json
import re
from functools import lru_cache
from pathlib import Path
from secrets import token_bytes
from unicodedata import normalize
from uuid import uuid4
from zipfile import ZipFile
from zlib import crc32


DATA_DIR = Path(__file__).resolve().parent / "data" / "auxilio_emergencial"
SOURCE_URL = "https://portaldatransparencia.gov.br/download-de-dados/auxilio-emergencial"
PAYMENT_FIELDS = ("record_id", "beneficiary_id", "month", "installment", "cohort", "amount")
OUTCOME_FIELDS = ("record_id", "status")
HEADER_ALIASES = {
    "month": ("mes_disponibilizacao", "ano_mes", "month"),
    "nis": ("nis_beneficiario", "beneficiary_nis", "nis"),
    "cpf": ("cpf_beneficiario", "beneficiary_cpf", "cpf"),
    "installment": ("parcela", "installment"),
    "cohort": ("enquadramento", "cohort"),
    "amount": ("valor_beneficio", "valor", "amount"),
    "observation": ("observacao", "observation"),
}
MONTH = re.compile(r"[0-9]{4}(0[1-9]|1[0-2])")
INSTALLMENT = re.compile(r"([0-9]+)(?:[ªº°]|\.0)?(?:\s+parcela)?")
IDENTIFIER = re.compile(r"[0-9]{11}")
IDENTIFIER_PUNCTUATION = str.maketrans("", "", ".- ")
BRL_AMOUNT = re.compile(r"-?(?:[0-9]+|[0-9]{1,3}(?:\.[0-9]{3})+),[0-9]{2}")
DECIMAL_AMOUNT = re.compile(r"-?[0-9]+(?:\.[0-9]{1,2})?")
RETURNED = {"valor devolvido a uniao", "devolvido", "returned"}
HELD = {"retido avaliacao por divergencias cadastrais", "retido", "held"}
CONFLICTING_STATUS = "conflicting"


def normalized(value: str) -> str:
    plain = normalize("NFKD", value).encode("ascii", "ignore").decode("ascii").lower()
    return " ".join(re.findall(r"[a-z0-9]+", plain))


def header_indices(header: list[str]) -> dict[str, int]:
    columns = {normalized(value).replace(" ", "_"): index for index, value in enumerate(header)}
    indices = {}
    for field, aliases in HEADER_ALIASES.items():
        for alias in aliases:
            if alias in columns:
                indices[field] = columns[alias]
                break
    missing = HEADER_ALIASES.keys() - {"cpf", "nis", "installment"} - indices.keys()
    if missing:
        raise ValueError(f"Missing Auxílio Emergencial columns: {', '.join(sorted(missing))}")
    if not {"cpf", "nis"} & indices.keys():
        raise ValueError("Expected a beneficiary NIS or CPF column")
    return indices


@contextmanager
def open_export(path: Path):
    """Read a CSV stream without extracting the complete archive."""
    if path.suffix.lower() == ".zip":
        with ZipFile(path) as archive:
            members = [entry for entry in archive.infolist() if entry.filename.lower().endswith(".csv")]
            if len(members) != 1:
                raise ValueError(f"{path.name}: expected exactly one CSV in the archive")
            with archive.open(members[0]) as stream:
                yield stream
    else:
        opener = gzip.open if path.suffix.lower() == ".gz" else open
        with opener(path, "rb") as stream:
            yield stream


def normalized_identifier(value: str) -> str | None:
    digits = value.strip().translate(IDENTIFIER_PUNCTUATION)
    if IDENTIFIER.fullmatch(digits) and digits != digits[0] * 11:
        return digits
    return None


def beneficiary_key(row: list[str], indices: dict[str, int]) -> str | None:
    for field in ("nis", "cpf"):
        if field in indices and (identifier := normalized_identifier(row[indices[field]])):
            return f"{field}:{identifier}"
    return None


def amount_in_cents(value: str) -> int | None:
    value = value.strip()
    if BRL_AMOUNT.fullmatch(value):
        return int(value.replace(".", "").replace(",", ""))
    if DECIMAL_AMOUNT.fullmatch(value):
        sign = -1 if value.startswith("-") else 1
        whole, _, fractional = value.lstrip("-").partition(".")
        return sign * (int(whole) * 100 + int(fractional.ljust(2, "0")))
    return None


@lru_cache(maxsize=64)
def parse_actual_installment(value: str) -> int | None:
    match = INSTALLMENT.fullmatch(value.strip().lower())
    if not match:
        return None
    try:
        installment = int(match[1])
    except ValueError:
        return None
    return installment if installment > 0 else None


@lru_cache(maxsize=64)
def administrative_status(value: str) -> str:
    status = normalized(value)
    if status in RETURNED:
        return "returned"
    if status in HELD:
        return "held"
    return "unknown"


@lru_cache(maxsize=64)
def payment_cohort(value: str) -> str:
    cohort = normalized(value)
    if cohort in {"extra cad", "extra cadun", "extracad"} or cohort.startswith("nao inscrito"):
        return "extra_cad"
    if cohort in {"cadun", "cadun nao bolsa", "cadun nao pbf"} or "nao bolsa familia" in cohort:
        return "cad_unico"
    if cohort in {"bolsa", "cadun bolsa", "pbf"} or "bolsa familia" in cohort:
        return "bolsa_familia"
    if "cadunico" in cohort or "cadastro unico" in cohort:
        return "cad_unico"
    return "unknown"


def pseudonym_key(output_dir: Path) -> bytes:
    key_path = output_dir / ".pseudonym_key"
    if not key_path.exists():
        try:
            with key_path.open("xb") as stream:
                stream.write(token_bytes(32))
        except FileExistsError:
            pass
    key = key_path.read_bytes()
    if len(key) != 32:
        raise ValueError("Expected a 32-byte local .pseudonym_key")
    return key


def read_payments(path: Path, key: bytes, sample_limit: int, payments: dict, *, source_index: int = 0) -> dict:
    counts: Counter = Counter()
    source_statuses: Counter = Counter()
    missing_key_statuses: Counter = Counter()
    nonpositive_statuses: Counter = Counter()
    source_months: Counter = Counter()
    with open_export(path) as binary:
        header_bytes = binary.readline()
        if not header_bytes:
            raise ValueError(f"{path.name}: empty export")
        try:
            header_line = header_bytes.decode("utf-8-sig")
            encoding = "utf-8-sig"
        except UnicodeDecodeError:
            encoding = "latin-1"
            header_line = header_bytes.decode(encoding)
        with io.TextIOWrapper(binary, encoding=encoding, newline="") as stream:
            delimiter = csv.Sniffer().sniff(header_line, delimiters=";,\t").delimiter
            header = next(csv.reader([header_line], delimiter=delimiter))
            indices = header_indices(header)
            official_layout = all(
                normalized(header[indices[field]]).replace(" ", "_") == HEADER_ALIASES[field][0]
                for field in ("month", "cohort", "amount", "observation")
            )
            installment_column = indices.get("installment")
            for row_number, row in enumerate(csv.reader(stream, delimiter=delimiter), start=2):
                counts["source_rows"] += 1
                if len(row) != len(header):
                    counts["malformed_rows"] += 1
                    continue
                month = row[indices["month"]].strip()
                if not MONTH.fullmatch(month):
                    counts["invalid_month"] += 1
                    continue
                source_months[month] += 1
                status = administrative_status(row[indices["observation"]])
                source_statuses[status] += 1
                identity = beneficiary_key(row, indices)
                if identity is None:
                    counts["missing_beneficiary_key"] += 1
                    missing_key_statuses[status] += 1
                    continue
                identity_bytes = identity.encode("ascii")
                if crc32(identity_bytes) >= sample_limit:
                    counts["outside_sample"] += 1
                    continue
                raw_installment = row[installment_column].strip() if installment_column is not None else ""
                installment = parse_actual_installment(raw_installment)
                if installment is None:
                    counts["invalid_installment" if raw_installment else "missing_installment"] += 1
                cents = amount_in_cents(row[indices["amount"]])
                if cents is None:
                    counts["invalid_amount"] += 1
                    continue
                if cents <= 0:
                    counts["nonpositive_amount"] += 1
                    nonpositive_statuses[status] += 1
                    continue
                beneficiary_id = hmac.digest(key, identity_bytes, "sha256").hex()[:32]
                cohort = payment_cohort(row[indices["cohort"]])
                payment = (beneficiary_id, month, installment, cohort, cents)
                if installment is None:
                    # There is no installment key to establish a duplicate.
                    payment += (source_index, row_number)
                counts["sampled_eligible_rows"] += 1
                if payment in payments:
                    counts["same_features_repeated"] += 1
                    if payments[payment] != status:
                        payments[payment] = CONFLICTING_STATUS
                else:
                    payments[payment] = status
    return {
        "file": path.name,
        "official_layout": official_layout,
        "counts": dict(counts),
        "source_rows_by_month": dict(sorted(source_months.items())),
        "source_rows_by_status": dict(source_statuses),
        "missing_beneficiary_key_by_status": dict(missing_key_statuses),
        "nonpositive_amount_by_status": dict(nonpositive_statuses),
    }


@contextmanager
def staged_outputs(output_dir: Path, filenames: tuple[str, ...]):
    staging = output_dir / f".prepare-{uuid4().hex}"
    staging.mkdir()
    try:
        yield staging
        for name in filenames:
            (staging / name).replace(output_dir / name)
    finally:
        for name in filenames:
            (staging / name).unlink(missing_ok=True)
        staging.rmdir()


def prepare(sources: list[Path], output_dir: Path = DATA_DIR, sample_rate: float = 0.01) -> dict:
    """Write one row per distinguishable installment and its retrospective status."""
    if not sources or not 0 < sample_rate <= 1:
        raise ValueError("Provide at least one export and a sample rate in (0, 1]")
    output_dir.mkdir(parents=True, exist_ok=True)
    key = pseudonym_key(output_dir)
    payments = {}
    sample_limit = round(sample_rate * (1 << 32))
    source_reports = [
        read_payments(path, key, sample_limit, payments, source_index=index)
        for index, path in enumerate(sources)
    ]
    if not payments:
        raise ValueError("No eligible payments were sampled")

    monthly = defaultdict(Counter)
    repeated = Counter(payment[:3] for payment in payments if payment[2] is not None)
    status_counts: Counter = Counter()
    with staged_outputs(output_dir, ("payments.csv", "outcomes.csv", "preparation.json")) as staging:
        with (
            (staging / "payments.csv").open("w", newline="", encoding="utf-8") as payment_file,
            (staging / "outcomes.csv").open("w", newline="", encoding="utf-8") as outcome_file,
        ):
            payment_writer = csv.writer(payment_file)
            outcome_writer = csv.writer(outcome_file)
            payment_writer.writerow(PAYMENT_FIELDS)
            outcome_writer.writerow(OUTCOME_FIELDS)
            for payment, observed_status in payments.items():
                beneficiary, month, installment, cohort, cents = payment[:5]
                encoded = json.dumps(payment, separators=(",", ":")).encode("ascii")
                record_id = hmac.digest(key, b"installment:" + encoded, "sha256").hex()[:32]
                amount = f"{cents // 100}.{cents % 100:02d}"
                conflicting = observed_status == CONFLICTING_STATUS
                status = "unknown" if conflicting else observed_status
                payment_writer.writerow((record_id, beneficiary, month, installment, cohort, amount))
                outcome_writer.writerow((record_id, status))
                status_counts[status] += 1
                monthly[month][status] += 1
                monthly[month]["rows"] += 1
                if conflicting:
                    monthly[month]["conflicting_status_rows"] += 1
                if repeated[payment[:3]] > 1:
                    monthly[month]["possible_repeated_installment_rows"] += 1
        report = {
            "source_url": SOURCE_URL,
            "sources": source_reports,
            "sample_rate": sample_rate,
            "sample_unit": "Stable beneficiary key (NIS, with full CPF fallback)",
            "duplicate_policy": (
                "Identical scoring fields collapse to one row. Conflicting statuses become unknown. "
                "Distinct same-month installments are retained and counted as possible repetitions. "
                "Rows without an installment are kept separately."
            ),
            "rows": len(payments),
            "statuses": dict(status_counts),
            "months": {month: dict(counts) for month, counts in sorted(monthly.items())},
        }
        (staging / "preparation.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sources", type=Path, nargs="+", help="Public CSV, CSV.GZ, or single-CSV ZIP exports")
    parser.add_argument("--output-dir", type=Path, default=DATA_DIR)
    parser.add_argument("--sample-rate", type=float, default=0.01, help="Fraction of beneficiaries to retain")
    args = parser.parse_args()
    report = prepare(args.sources, args.output_dir, args.sample_rate)
    print(f"Prepared {report['rows']:,} records across {len(report['months'])} months")


if __name__ == "__main__":
    main()
