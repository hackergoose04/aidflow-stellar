"""Prepare pseudonymized samples from the official monthly cash assistance exports.

The samples use YYYYMM for the actual entitlement (reference_month) and payroll
(payroll_month). When importing a reference month into AidFlow, convert YYYYMM
to YYYY-MM. The export does not provide the authorized expected month.
"""
import argparse
from collections import Counter, defaultdict
import csv
import hashlib
import hmac
from pathlib import Path
import re
import secrets


ROOT = Path(__file__).resolve().parent / "data" / "official_cash_assistance"
TARGET = 10_000
PROGRAM_MONTH_COLUMNS = {
    "AuxilioBrasil": ("MÊS COMPETÊNCIA", "MÊS REFERÊNCIA"),
    "NovoBolsaFamilia": ("MÊS REFERÊNCIA", "MÊS COMPETÊNCIA"),
}
FIELDS = ("beneficiary_id", "reference_month", "payroll_month", "amount_brl", "state")
EXPECTED = ("MÊS COMPETÊNCIA", "MÊS REFERÊNCIA", "UF", "CÓDIGO MUNICÍPIO SIAFI",
            "NOME MUNICÍPIO", "CPF FAVORECIDO", "NIS FAVORECIDO", "NOME FAVORECIDO",
            "VALOR PARCELA")
MONTH = re.compile(r"[0-9]{4}(?:0[1-9]|1[0-2])")
AMOUNT = re.compile(r"[0-9]+,[0-9]{2}")


def sample(source: Path, program: str, *, target: int = TARGET) -> dict:
    reference_column, payroll_column = PROGRAM_MONTH_COLUMNS[program]
    token_key = secrets.token_bytes(32)
    counts = Counter({
        "source_rows": 0,
        "source_prior_reference_rows": 0,
        "source_same_reference_rows": 0,
        "source_later_reference_rows": 0,
        "source_invalid_month_rows": 0,
        "malformed_rows": 0,
    })
    groups = defaultdict(list)
    with source.open(encoding="latin-1", newline="") as stream:
        reader = csv.reader(stream, delimiter=";")
        header = tuple(next(reader, ()))
        if header != EXPECTED:
            raise ValueError(f"Unexpected columns in {source.name}")
        reference_index = header.index(reference_column)
        payroll_index = header.index(payroll_column)
        for row in reader:
            counts["source_rows"] += 1
            if len(row) != len(EXPECTED):
                counts["malformed_rows"] += 1
                continue
            reference, payroll = row[reference_index].strip(), row[payroll_index].strip()
            valid_months = MONTH.fullmatch(reference) and MONTH.fullmatch(payroll)
            if valid_months:
                if reference < payroll:
                    counts["source_prior_reference_rows"] += 1
                elif reference > payroll:
                    counts["source_later_reference_rows"] += 1
                else:
                    counts["source_same_reference_rows"] += 1
            else:
                counts["source_invalid_month_rows"] += 1
            nis = row[6].strip()
            if len(nis) != 11 or not nis.isascii() or not nis.isdecimal() or nis == "00000000000":
                counts["missing_or_invalid_nis"] += 1
                continue
            # Keep the same candidates for every row of a beneficiary without storing the full file.
            number = int(nis)
            if (number ^ (number >> 16)) & 511:
                continue
            amount = row[8].strip().replace(".", "")
            if not valid_months:
                counts["candidate_invalid_month"] += 1
                continue
            if not AMOUNT.fullmatch(amount) or not int(amount.replace(",", "")):
                counts["candidate_nonpositive_or_invalid_amount"] += 1
                continue
            groups[nis].append((reference, payroll, amount.replace(",", "."), row[2]))

    if len(groups) < target:
        raise ValueError(f"Insufficient eligible beneficiary groups in {source.name}")
    selected = sorted(groups, key=lambda nis: hashlib.sha256(f"aidflow-sample-v1:{nis}".encode()).digest())[:target]
    output = source.with_name(f"{source.stem}_clean_sample.csv")
    temporary = output.with_suffix(".part")
    with temporary.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(FIELDS)
        for nis in selected:
            token = "B-" + hmac.new(token_key, nis.encode(), "sha256").hexdigest()[:24]
            writer.writerows((token, *payment) for payment in sorted(groups[nis]))
    temporary.replace(output)

    with output.open(encoding="utf-8", newline="") as stream:
        reader = csv.DictReader(stream)
        assert tuple(reader.fieldnames) == FIELDS
        rows = list(reader)
    assert len({row["beneficiary_id"] for row in rows}) == target
    assert len(rows) == sum(len(groups[nis]) for nis in selected)
    counts["sample_rows"] = len(rows)
    counts["sample_beneficiaries"] = target
    counts["sample_states"] = len({row["state"] for row in rows})
    counts["sample_reference_months"] = len({row["reference_month"] for row in rows})
    counts["sample_prior_reference_rows"] = sum(row["reference_month"] < row["payroll_month"] for row in rows)
    counts["sample_same_reference_rows"] = sum(row["reference_month"] == row["payroll_month"] for row in rows)
    counts["sample_later_reference_rows"] = sum(row["reference_month"] > row["payroll_month"] for row in rows)
    counts["sample_repeated_beneficiary_period_groups"] = sum(
        count > 1 for count in Counter((row["beneficiary_id"], row["reference_month"]) for row in rows).values()
    )
    return dict(counts)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("stem", help="Official export filename without .csv")
    parser.add_argument("--data-dir", type=Path, default=ROOT)
    args = parser.parse_args()
    month, separator, program = args.stem.partition("_")
    if not separator or not MONTH.fullmatch(month) or program not in PROGRAM_MONTH_COLUMNS:
        parser.error("Use the official YYYYMM_AuxilioBrasil or YYYYMM_NovoBolsaFamilia file stem")
    print(args.stem, sample(args.data_dir / f"{args.stem}.csv", program), flush=True)


if __name__ == "__main__":
    main()
