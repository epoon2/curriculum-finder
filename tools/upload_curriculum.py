"""Upload the curriculum to the finder's private R2 bucket: library.json and the PDFs.

The finder reads them from the bucket, never from the repo:
  library.json         -> library.json    (built by build_library.py; uploaded when it changed)
  each PDF             -> pdf/<code>.pdf  (for example pdf/PK-NF01-00.pdf)
  the PDFs' text       -> text.json.gz    (from extract_text.py; uploaded when it changed)

A PDF's code comes from its file name, written the way the library writes it:
"001_PK-NF01-00_Sample_Title_v01.pdf" is PK-NF01-00, "Pk_3102_Sample_Title_v01.pdf"
is PK-3102-00. Workout Books (WOB / WCH) mostly have no code in their names, so a
file whose name starts with WOB, WCH or Workout is found by its name in the library
("WOB_7_Chapter_3.pdf" is the library document with that file name), unless its name
has a WOB or WCH code in it. When a code has several files (_v01, _v02), the highest
version goes up.
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

The PDFs' text (for searching inside them, and opening a PDF at the page that
matched): run extract_text.py first. Its curriculum_text_*.jsonl.gz files are found
in the PDF folder or next to it and go up with everything else; or name them:

    python upload_curriculum.py --text "D:\\Curriculum PDFs\\curriculum_text_1.jsonl.gz"

Each text is filed under its document's code, read from its file name exactly as for
the PDFs (the newest version when a code has several), so the text always belongs to
the PDF the finder opens. Texts with no code, or a code the library doesn't have, are
left out (and counted).

The keys are read from the environment only; they're never saved, printed or written
to the report, and they're gone when the window closes.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

LIBRARY_KEY = 'library.json'
TEXT_KEY = 'text.json.gz'
TEXT_FILES = 'curriculum_text_*.jsonl.gz'      # what extract_text.py writes
# PK-NF01-00, PK_NF21-00, Pk_3102 (no ending: -00), PK 186 (three digits: 0186).
# After a "-" any ending counts (-00, -TP, -HS); after "_" or a space only numbers and
# the library's letter endings do, so "Pk_3192_Box_Plots" is PK-3192-00, not -BOX.
CODE = re.compile(r'(?<![A-Z0-9])(PK|FO|GF)[-_ ]?([A-Z0-9]{3,4})(?:([-_ ])([A-Z0-9]{2,3}))?(?![A-Z0-9])')
WORD_ENDINGS = {'TP', 'HS', 'EP', 'CA'}
# Workout Book codes, always with hyphens: WOB-007-000 (whole book), WCH-007-003 (a chapter),
# WOB-NF29-000, WOB-0TP-004A.
WOB_CODE = re.compile(r'(?<![A-Z0-9])(WOB|WCH)-([A-Z0-9]{3,4})-([A-Z0-9]{3,4})(?![A-Z0-9])')
WOB_NAME = re.compile(r'\s*(WOB|WCH|WORKOUT)', re.I)
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


def name_key(name: str, drop_version: bool = False) -> str:
    """A file name reduced for matching: no .pdf, no case, no spaces or punctuation."""
    stem = re.sub(r'\.pdf$', '', str(name or '').strip(), flags=re.I)
    if drop_version:
        stem = re.sub(r'[ _-]v\d+$', '', stem, flags=re.I)
    return re.sub(r'[^a-z0-9]', '', stem.lower())


def by_file_name(docs) -> dict:
    """{name_key: code} for the library's file names that belong to one document only
    (with and without a _v01 ending), plus {('part', book, part, chapter): code} for
    Workout Book chapters whose titles number them within a part ("WOB B Part 2
    Chapter 1"); chapter 'DT' is that part's DeskTools."""
    found: dict = {}
    for d in docs:
        for drop in (False, True):
            key = name_key(d.get('file', ''), drop)
            if key:
                found.setdefault(key, set()).add(d['code'])
        book = re.match(r'WCH-([A-Z0-9]{3})-', d.get('code', ''))
        part = re.search(r'\bPart (\d+)\b', d.get('title', ''), re.I)
        if book and part:
            chapter = re.search(r'\bChapter (\d+)\b', d['title'], re.I)
            if re.search(r'desk ?tools', d['title'], re.I):
                found.setdefault(('part', book.group(1), int(part.group(1)), 'DT'), set()).add(d['code'])
            elif chapter:
                found.setdefault(('part', book.group(1), int(part.group(1)), int(chapter.group(1))),
                                 set()).add(d['code'])
    return {key: codes.pop() for key, codes in found.items() if len(codes) == 1}


# Short Workout Book chapter names, as saved on the center's computer:
# WOB_7_Ch3_v21, WOB_M2_Ch4_v07, WOB_A_Ch1, WOB_Alg_Chapter_1, WOB_B_Part_2_Ch_3,
# WOB_B_Part_2_DT, WOB_D_L1_Pt2, WOB_NF_Ch_1, WOB_PK1_Ch1, WOB_SAT_Basic_Skills_Ch_1.
SHORT_WOB = re.compile(r"""^WOB[ _-]+
    (?P<book>\d{1,2}|M\d{1,2}|ALG(?:EBRA)?|GEO(?:METRY)?|NF|PK\d?|SAT(?:[ _-]+BASIC[ _-]+SKILLS)?|[A-Z])
    (?:[ _-]+L(?:EVEL)?[ _-]*(?P<level>\d))?
    (?:[ _-]+(?:PART|PT)[ _-]*(?P<part>\d)(?=[ _-]+(?:CH|DT|DESK)))?
    [ _-]+(?:(?:CHAPTER|CH|PART|PT)[ _-]*(?P<chapter>\d{1,2})|(?P<desk>DT|DESK[ _-]?TOOLS))$""", re.X)


def book_segment(book: str, level) -> str:
    """The middle of a WCH code: 7 -> 007, A -> 00A, M2 -> N02, D level 1 -> 0D1,
    Algebra -> 010, Geometry -> 011, NF -> 0NF, PK -> 0PK, SAT -> SAT."""
    if book.isdigit():
        return f'{int(book):03d}'
    if re.fullmatch(r'M\d{1,2}', book):
        return f'N{int(book[1:]):02d}'
    if book == 'D' and level:
        return f'0D{level}'
    if len(book) == 1:
        return f'00{book}'
    return {'ALG': '010', 'GEO': '011', 'NF': '0NF', 'PK': '0PK', 'SAT': 'SAT'}.get(book[:3].rstrip('0123456789'), '')


def short_wob_code(name: str, files) -> str:
    """The WCH code for a short Workout Book chapter name, or ''."""
    stem = re.sub(r'\.PDF$', '', name.strip().upper())
    stem = re.sub(r'_{2,}MIXED.*$', '', stem)              # WOB_3_Ch3_v06__MIXED_v06_v07
    stem = re.sub(r'[ _-]V\d+$', '', stem)
    match = SHORT_WOB.match(stem)
    if not match:
        return ''
    book = book_segment(re.split(r'[ _-]', match['book'])[0], match['level'])
    if not book:
        return ''
    if match['part']:
        return files.get(('part', book, int(match['part']), 'DT' if match['desk'] else int(match['chapter'])), '')
    return f'WCH-{book}-{int(match["chapter"]):03d}' if match['chapter'] else ''


def code_for(name: str, library=None, files=None) -> str:
    """The library code for a PDF's file name ('' when none is found).

    Workout Book files (names starting WOB, WCH or Workout): a WOB/WCH code in the
    name, else the library document with that file name, else a short chapter name
    (WOB_7_Ch3_v21 is WCH-007-003) when the library has that code; a "PK" in such a
    name is never read as a PK code. Everything else: the code in the name, else (no
    code) the library document with that file name."""
    files = files or {}
    named = files.get(name_key(name)) or files.get(name_key(name, drop_version=True)) or ''
    if WOB_NAME.match(name):
        match = WOB_CODE.search(name.upper())
        if match:
            return fit('-'.join(match.groups()), library)
        if named:
            return named
        short = short_wob_code(name, files)
        return short if short and (library is None or short in library) else ''
    code = code_of(name)
    return fit(code, library) if code else named


def fit(code: str, library) -> str:
    """The library's code for it, when the library has exactly one with that number."""
    if not library or code in library:
        return code
    base = code.rsplit('-', 1)[0] + '-'
    same = [c for c in library if c.startswith(base)]
    return same[0] if len(same) == 1 else code


def read_library(path, with_files=False):
    """(library.json's bytes, {code: type}), or (None, None) if there isn't a usable one.
    With ``with_files``, a third item: by_file_name() of its documents."""
    if not path or not Path(path).is_file():
        return (None, None, {}) if with_files else (None, None)
    data = Path(path).read_bytes()
    try:
        docs = json.loads(data.decode('utf-8'))['documents']
        codes = {d['code']: d['type'] for d in docs}
    except (ValueError, KeyError, TypeError) as exc:
        raise SystemExit(f'{path} is not a library.json from build_library.py ({type(exc).__name__}).')
    if not codes:
        raise SystemExit(f'{path} has no documents in it.')
    return (data, codes, by_file_name(docs)) if with_files else (data, codes)


def pdf_key(code: str) -> str:
    """Where a code's PDF goes in the bucket. Upper case, as the finder asks for it."""
    return f'pdf/{code.upper()}.pdf'


def version_of(name: str) -> int:
    match = VERSION.search(Path(name).stem.upper())
    return int(match.group(1)) if match else 0


def plan(folder: Path, library=None, files=None):
    """(chosen {code: path}, other files with a taken code [(code, path, kept)], no code [path])."""
    by_code: dict[str, list[Path]] = {}
    no_code = []
    for path in sorted(folder.rglob('*')):
        if not path.is_file() or path.suffix.lower() != '.pdf':
            continue
        code = code_for(path.name, library, files)
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


def upload_whole(client, bucket: str, key: str, data: bytes, content_type: str) -> str:
    """Skipped when the bucket's copy has the same MD5 (R2's etag for a one-part upload)."""
    md5 = hashlib.md5(data).hexdigest()
    try:
        if client.head_object(Bucket=bucket, Key=key).get('ETag', '').strip('"') == md5:
            return 'already there'
    except Exception:
        pass   # not there yet; a real problem shows up in the upload just below
    client.put_object(Bucket=bucket, Key=key, Body=data, ContentType=content_type)
    return 'uploaded'


def upload_library(client, bucket: str, data: bytes) -> str:
    return upload_whole(client, bucket, LIBRARY_KEY, data, 'application/json; charset=utf-8')


def text_files(folder, given) -> list:
    """The extract_text.py files to use: the ones named with --text, else any in the
    PDF folder or the folder that holds it."""
    if given:
        found = [Path(p).expanduser().resolve() for p in given]
    else:
        found = [p for where in ((folder, folder.parent) if folder else ())
                 for p in sorted(where.glob(TEXT_FILES))]
    return list(dict.fromkeys(found))


def build_text(paths, library, files):
    """(text.json.gz bytes, counts) from extract_text.py's files: {"documents": {code:
    [page 1 text, page 2 text, ...]}}, one entry per library code, from that code's
    newest file (the version the PDF upload picks). Compressed the same way every
    time, so an unchanged text is not uploaded again."""
    best, counts = {}, {'read': 0, 'no_code': [], 'unknown': [], 'older': 0, 'unreadable': 0}
    for path in paths:
        with gzip.open(path, 'rt', encoding='utf-8') as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                    name, pages = str(record['file']), [str(p) for p in record['text']]
                except (ValueError, KeyError, TypeError):
                    counts['unreadable'] += 1
                    continue
                counts['read'] += 1
                code = code_for(name, library, files)
                if not code:
                    counts['no_code'].append(name)
                    continue
                if library is not None and code not in library:
                    counts['unknown'].append(name)
                    continue
                rank = (version_of(name), -len(str(record.get('path') or name)))
                if code in best:
                    counts['older'] += 1
                    if best[code][0] >= rank:
                        continue
                best[code] = (rank, pages)
    documents = {code: pages for code, (_, pages) in sorted(best.items())}
    counts['documents'] = len(documents)
    counts['pages'] = sum(len(p) for p in documents.values())
    raw = json.dumps({'documents': documents}, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return gzip.compress(raw, compresslevel=9, mtime=0), counts


def upload_one(client, bucket: str, code: str, path: Path, folder: Path) -> str:
    key, size = pdf_key(code), path.stat().st_size
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
    parser.add_argument('--text', action='append', metavar='FILE',
                        help="extract_text.py's curriculum_text_N.jsonl.gz (repeat for each); "
                             'by default any in the PDF folder or next to it')
    parser.add_argument('--dry-run', action='store_true', help='list what would happen; upload nothing')
    args = parser.parse_args(argv)

    folder = Path(args.folder).expanduser().resolve() if args.folder else None
    if folder and not folder.is_dir():
        print(f'Not a folder: {folder}')
        return 2
    if not args.dry_run and not args.bucket:
        print('Which bucket? Set $env:R2_BUCKET (or give --bucket NAME).')
        return 2
    texts = text_files(folder, args.text)
    missing_text = [p for p in texts if not p.is_file()]
    if missing_text:
        print('Not found: ' + ', '.join(str(p) for p in missing_text))
        return 2
    data, library, files = read_library(args.library, with_files=True)
    if data is None:
        print(f'No library.json at {args.library}: the finder needs one. Build it with build_library.py,'
              ' or point to it with --library.')
        if not folder:
            return 2

    rows = []
    if data is not None:
        rows.append(['', LIBRARY_KEY, Path(args.library).name, len(data), 'to upload'])
        print(f'library.json: {len(library)} document codes.')
    text, text_row = None, None
    if texts and data is None:
        print('The PDF text needs library.json too (to file each text under its code); left out.')
    elif texts:
        text, counts = build_text(texts, library, files)
        text_row = ['', TEXT_KEY, ', '.join(p.name for p in texts), len(text), 'to upload']
        rows.append(text_row)
        print(f"PDF text: {counts['documents']} documents ({counts['pages']} pages) from {counts['read']} PDFs'"
              f" text in {len(texts)} file(s); left out: {len(counts['no_code'])} with no code,"
              f" {len(counts['unknown'])} not in the library, {counts['older']} older versions"
              + (f", {counts['unreadable']} unreadable lines" if counts['unreadable'] else '') + '.')
        rows += [['', '', name, '', 'text: no code in the name, and no library document with this file name']
                 for name in counts['no_code']]
        rows += [['', '', name, '', 'text: its code is not in the library (left out)'] for name in counts['unknown']]
    chosen, older, no_code, unknown = {}, [], [], []
    if folder:
        chosen, older, no_code = plan(folder, library, files)
        print(f'{len(chosen)} PDFs to upload as pdf/<code>.pdf; {len(older)} more files with a code already taken'
              f' (older versions, left out); {len(no_code)} PDFs with no code in their name and no'
              ' match in the library (left out).')
        unknown = sorted(c for c in chosen if library is not None and c not in library)
        rows += [[code, pdf_key(code), str(p.relative_to(folder)), p.stat().st_size,
                  'to upload' + (' (not in the library: check the name)' if code in unknown else '')]
                 for code, p in sorted(chosen.items())]
        rows += [[code, '', str(p.relative_to(folder)), p.stat().st_size,
                  f'{"older version of" if version_of(p.name) < version_of(kept.name) else "same code as"} {kept.name} (left out)']
                 for code, p, kept in older]
        rows += [['', '', str(p.relative_to(folder)), p.stat().st_size,
                  'no code in the name, and no library document with this file name'] for p in no_code]
        if library is not None:
            missing = sorted(c for c, t in library.items() if t == 'PK' and c not in chosen)
            rows += [[c, '', '', '', 'library PK with no PDF found'] for c in missing]
            wobs = [c for c, t in library.items() if t.upper().startswith('WOB')]
            missing_wobs = sorted(c for c in wobs if c not in chosen)
            rows += [[c, '', '', '', 'library WOB with no PDF found'] for c in missing_wobs]
            print(f'Library check: {len(unknown)} codes not in the library; '
                  f'{len(missing)} of its {sum(t == "PK" for t in library.values())} PKs and '
                  f'{len(missing_wobs)} of its {len(wobs)} Workout Book files have no PDF here.')

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
        if text is not None:
            try:
                status = upload_whole(client, args.bucket, TEXT_KEY, text, 'application/gzip')
            except Exception as exc:
                status, failed = f'failed: {type(exc).__name__}', True
            text_row[4] = status
            print(f'{TEXT_KEY}: {status}.')
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
        print(f'  no code in the name and no library match: {p.name}')
    for code in unknown[:5]:
        print(f'  not in the library: {code} ({chosen[code].name})')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
