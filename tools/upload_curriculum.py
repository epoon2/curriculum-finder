"""Upload the curriculum to the finder's private R2 bucket: library.json and the PDFs.

The finder reads both from the bucket, never from the repo:
  library.json         -> library.json    (built by build_library.py; uploaded when it changed)
  each PDF             -> pdf/<code>.pdf  (for example pdf/PK-NF01-00.pdf)

A PDF's code comes from its file name, written the way the library writes it:
"001_PK-NF01-00_Sample_Title_v01.pdf" is PK-NF01-00, "Pk_3102_Sample_Title_v01.pdf"
is PK-3102-00. When a code has several files (_v01, _v02), the highest version goes up.
Files already in the bucket are skipped, so it's safe to run again after a break, or
after adding a few PDFs.

On the computer with the curriculum, with library.json next to this file:

    python -m pip install boto3
    python upload_curriculum.py "D:\\Curriculum PDFs" --dry-run

The dry run needs no key and uploads nothing. It writes upload_report.csv next to
the PDF folder: every file, the code it was read as and what will happen, plus the
library's PKs that have no PDF. Then, with an R2 API token for the bucket (Object
Read & Write, that bucket only), in the same PowerShell window:

    $env:R2_ACCOUNT_ID = "..."; $env:R2_ACCESS_KEY_ID = "..."; $env:R2_SECRET_ACCESS_KEY = "..."
    $env:R2_BUCKET = "your-bucket-name"
    python upload_curriculum.py "D:\\Curriculum PDFs"

Only the library changed? Leave out the folder:  python upload_curriculum.py

The keys are read from the environment only; they're never saved, printed or written
to the report, and they're gone when the window closes.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

LIBRARY_KEY = 'library.json'
# PK-NF01-00, PK_NF21-00, Pk_3102 (no ending: -00), PK 186 (three digits: 0186).
# After a "-" any ending counts (-00, -TP, -HS); after "_" or a space only numbers and
# the library's letter endings do, so "Pk_3192_Box_Plots" is PK-3192-00, not -BOX.
CODE = re.compile(r'(?<![A-Z0-9])(PK|FO|GF)[-_ ]?([A-Z0-9]{3,4})(?:([-_ ])([A-Z0-9]{2,3}))?(?![A-Z0-9])')
WORD_ENDINGS = {'TP', 'HS', 'EP', 'CA'}
VERSION = re.compile(r'_V(\d+)(?![A-Z0-9])')
HERE = Path(__file__).resolve().parent
LIBRARY = next((p for p in (HERE / 'library.json', HERE.parent / 'library.json') if p.is_file()),
               HERE / 'library.json')


def code_of(name: str) -> str:
    stem = name[:-4] if name.lower().endswith('.pdf') else name
    match = CODE.search(stem.upper())
    if not match:
        return ''
    kind, number, separator, ending = match.groups()
    if number.isdigit() and len(number) == 3:
        number = '0' + number
    if ending and ending.startswith('V') and ending[1:].isdigit():   # Pk_3102_v01: a version, not an ending
        ending = None
    if ending and separator != '-' and not ending.isdigit() and ending not in WORD_ENDINGS:
        ending = None
    return f'{kind}-{number}-{ending or "00"}'


def fit(code: str, library) -> str:
    """The library's code for it, when the library has exactly one with that number."""
    if not library or code in library:
        return code
    base = code.rsplit('-', 1)[0] + '-'
    same = [c for c in library if c.startswith(base)]
    return same[0] if len(same) == 1 else code


def read_library(path):
    """(library.json's bytes, {code: type}), or (None, None) if there isn't a usable one."""
    if not path or not Path(path).is_file():
        return None, None
    data = Path(path).read_bytes()
    try:
        docs = json.loads(data.decode('utf-8'))['documents']
        codes = {d['code']: d['type'] for d in docs}
    except (ValueError, KeyError, TypeError) as exc:
        raise SystemExit(f'{path} is not a library.json from build_library.py ({type(exc).__name__}).')
    if not codes:
        raise SystemExit(f'{path} has no documents in it.')
    return data, codes


def version_of(name: str) -> int:
    match = VERSION.search(Path(name).stem.upper())
    return int(match.group(1)) if match else 0


def plan(folder: Path, library=None):
    """(chosen {code: path}, other files with a taken code [(code, path, kept)], no code [path])."""
    by_code: dict[str, list[Path]] = {}
    no_code = []
    for path in sorted(folder.rglob('*')):
        if not path.is_file() or path.suffix.lower() != '.pdf':
            continue
        code = code_of(path.name)
        code = fit(code, library) if code else code
        (by_code.setdefault(code, []) if code else no_code).append(path)
    chosen, older = {}, []
    for code, paths in by_code.items():
        paths.sort(key=lambda p: (version_of(p.name), -len(str(p))), reverse=True)
        chosen[code] = paths[0]
        older += [(code, p, paths[0]) for p in paths[1:]]
    return chosen, older, no_code


def r2_client():
    import boto3
    from botocore.config import Config
    missing = [k for k in ('R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY') if not os.environ.get(k)]
    if missing:
        raise SystemExit('Set these first (see the top of this file): ' + ', '.join(missing))
    try:   # newer boto3 adds checksums R2 may refuse; send them only when required
        config = Config(retries={'max_attempts': 5, 'mode': 'standard'},
                        request_checksum_calculation='when_required', response_checksum_validation='when_required')
    except TypeError:
        config = Config(retries={'max_attempts': 5, 'mode': 'standard'})
    return boto3.client('s3', endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
                        aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
                        region_name='auto', config=config)


def upload_library(client, bucket: str, data: bytes) -> str:
    """Skipped when the bucket's copy has the same MD5 (R2's etag for a one-part upload)."""
    md5 = hashlib.md5(data).hexdigest()
    try:
        if client.head_object(Bucket=bucket, Key=LIBRARY_KEY).get('ETag', '').strip('"') == md5:
            return 'already there'
    except Exception:
        pass   # not there yet; a real problem shows up in the upload just below
    client.put_object(Bucket=bucket, Key=LIBRARY_KEY, Body=data, ContentType='application/json; charset=utf-8')
    return 'uploaded'


def upload_one(client, bucket: str, code: str, path: Path, folder: Path) -> str:
    key, size = f'pdf/{code}.pdf', path.stat().st_size
    try:
        if client.head_object(Bucket=bucket, Key=key).get('ContentLength') == size:
            return 'already there'
    except Exception:
        pass
    with open(path, 'rb') as body:
        client.put_object(Bucket=bucket, Key=key, Body=body, ContentType='application/pdf',
                          Metadata={'source': str(path.relative_to(folder)).replace('\\', '/')[:1000].encode('ascii', 'replace').decode()})
    return 'uploaded'


def main(argv=None, client=None) -> int:
    parser = argparse.ArgumentParser(description='Upload library.json and the PDFs to the private R2 bucket.')
    parser.add_argument('folder', nargs='?', help='the folder with the PDFs (subfolders included); leave out to upload only the library')
    parser.add_argument('--bucket', default=os.environ.get('R2_BUCKET', ''), help='the bucket (or set R2_BUCKET)')
    parser.add_argument('--library', default=str(LIBRARY), help='library.json from build_library.py')
    parser.add_argument('--dry-run', action='store_true', help='list what would happen; upload nothing')
    args = parser.parse_args(argv)

    folder = Path(args.folder).expanduser().resolve() if args.folder else None
    if folder and not folder.is_dir():
        print(f'Not a folder: {folder}')
        return 2
    if not args.dry_run and not args.bucket:
        print('Which bucket? Set $env:R2_BUCKET (or give --bucket NAME).')
        return 2
    data, library = read_library(args.library)
    if data is None:
        print(f'No library.json at {args.library}: the finder needs one. Build it with build_library.py,'
              ' or point to it with --library.')
        if not folder:
            return 2

    rows = []
    if data is not None:
        rows.append(['', LIBRARY_KEY, Path(args.library).name, len(data), 'to upload'])
        print(f'library.json: {len(library)} document codes.')
    chosen, older, no_code, unknown = {}, [], [], []
    if folder:
        chosen, older, no_code = plan(folder, library)
        print(f'{len(chosen)} PDFs to upload as pdf/<code>.pdf; {len(older)} more files with a code already taken'
              f' (older versions, left out); {len(no_code)} PDFs with no code in their name (left out).')
        unknown = sorted(c for c in chosen if library is not None and c not in library)
        rows += [[code, f'pdf/{code}.pdf', str(p.relative_to(folder)), p.stat().st_size,
                  'to upload' + (' (not in the library: check the name)' if code in unknown else '')]
                 for code, p in sorted(chosen.items())]
        rows += [[code, '', str(p.relative_to(folder)), p.stat().st_size,
                  f'{"older version of" if version_of(p.name) < version_of(kept.name) else "same code as"} {kept.name} (left out)']
                 for code, p, kept in older]
        rows += [['', '', str(p.relative_to(folder)), p.stat().st_size, 'no code in the name'] for p in no_code]
        if library is not None:
            missing = sorted(c for c, t in library.items() if t == 'PK' and c not in chosen)
            rows += [[c, '', '', '', 'library PK with no PDF found'] for c in missing]
            print(f'Library check: {len(unknown)} codes not in the library; '
                  f'{len(missing)} of its {sum(t == "PK" for t in library.values())} PKs have no PDF here.')

    failed = False
    if not args.dry_run:
        client = client or r2_client()
        if data is not None:
            try:
                status = upload_library(client, args.bucket, data)
            except Exception as exc:
                status, failed = f'failed: {type(exc).__name__}', True
            rows[0][4] = status
            print(f'library.json: {status}.')
        if chosen:
            done = {'uploaded': 0, 'already there': 0, 'failed': 0}
            def work(item):
                code, path = item
                try:
                    return code, upload_one(client, args.bucket, code, path, folder)
                except Exception as exc:
                    return code, f'failed: {type(exc).__name__}'
            results = {}
            with ThreadPoolExecutor(max_workers=8) as pool:
                for i, (code, status) in enumerate(pool.map(work, sorted(chosen.items())), 1):
                    results[code] = status
                    done['failed' if status.startswith('failed') else status] += 1
                    if i % 100 == 0:
                        print(f'{i} of {len(chosen)}...', flush=True)
            for row in rows:
                if row[1].startswith('pdf/') and row[0] in results and row[4].startswith('to upload'):
                    row[4] = results[row[0]] + row[4][len('to upload'):]
            failed = failed or done['failed'] > 0
            print(f"PDFs: uploaded {done['uploaded']}, already there {done['already there']}, failed {done['failed']}.")

    report = (folder.parent if folder else Path.cwd()) / 'upload_report.csv'
    with open(report, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['code', 'key', 'file', 'bytes', 'status'])
        writer.writerows(rows)
    print(f'Report: {report}')
    for code, p, kept in older[:5]:
        print(f'  left out: {p.name} (same code, kept {kept.name})')
    for p in no_code[:5]:
        print(f'  no code in the name: {p.name}')
    for code in unknown[:5]:
        print(f'  not in the library: {code} ({chosen[code].name})')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
