"""Build library.json from the curriculum system's Curriculum Library export (.xlsx).

    python3 build_library.py "Curriculum_Library_Export (10_19_2026).xlsx" \
        --center "Your Center" --platform "Your curriculum system"

Keeps only the columns the finder searches and shows, and writes library.json next
to the export (or --out). Then tools/upload_curriculum.py puts it in the private
bucket, where the finder reads it. The library is licensed curriculum: neither the
export nor library.json ever goes in the repo (see .gitignore).

--center and --platform are the names the page shows ("<center> · 1,785 documents",
"Look up PK-0186-00 in <platform>"). --doc-url is an optional https link pattern
with {id} for a document's Document Id, for an "Open in <platform>" link. All three
are kept inside library.json, so they stay as private as the library.

Prints counts only.
"""
from __future__ import annotations

import argparse
import json
import re
import unicodedata
from collections import Counter
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET

M = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
REQUIRED = ('Document Id', 'Title', 'Description', 'Barcode', 'Type', 'Tags', 'Level',
            'Critical Skills +', 'Keywords', 'Pages', 'Last Modified Date')


def read_rows(path: Path) -> list[list[str]]:
    """First worksheet as text (standard library only, so no install is needed)."""
    with ZipFile(path) as z:
        names = z.namelist()
        shared = []
        if 'xl/sharedStrings.xml' in names:
            for si in ET.fromstring(z.read('xl/sharedStrings.xml')).iter(M + 'si'):
                shared.append(''.join(t.text or '' for t in si.iter(M + 't')))
        sheet = 'xl/worksheets/sheet1.xml' if 'xl/worksheets/sheet1.xml' in names else \
            next(n for n in names if re.match(r'^xl/worksheets/.*\.xml$', n))
        root = ET.fromstring(z.read(sheet))
    rows = []
    for row in root.iter(M + 'row'):
        cells = {}
        for i, c in enumerate(row.iter(M + 'c')):
            ref = c.get('r') or ''
            col = 0
            for ch in ref:
                if not ch.isalpha():
                    break
                col = col * 26 + ord(ch.upper()) - 64
            col = col - 1 if col else i
            kind = c.get('t')
            if kind == 'inlineStr':
                value = ''.join(t.text or '' for t in c.iter(M + 't'))
            else:
                v = c.find(M + 'v')
                raw = v.text if v is not None and v.text else ''
                value = shared[int(raw)] if kind == 's' and raw else raw
            cells[col] = value
        width = max(cells) + 1 if cells else 0
        rows.append([cells.get(i, '') for i in range(width)])
    return rows


def clean(text) -> str:
    """Normal spaces, one space between words."""
    text = unicodedata.normalize('NFKC', str(text or '')).replace('\xa0', ' ')
    return re.sub(r'\s+', ' ', text).strip()


def split_list(text) -> list[str]:
    seen, out = set(), []
    for part in clean(text).split(','):
        part = part.strip()
        if part and part.lower() not in seen:
            seen.add(part.lower())
            out.append(part)
    return out


def number(text):
    text = clean(text)
    try:
        value = float(text)
    except ValueError:
        return None
    return int(value) if value.is_integer() else value


def build(rows: list[list[str]]) -> list[dict]:
    headers = [clean(h) for h in rows[0]]
    missing = [h for h in REQUIRED if h not in headers]
    if missing:
        raise SystemExit(f'The export is missing column(s): {", ".join(missing)}')
    col = {h: headers.index(h) for h in REQUIRED}
    docs = []
    for row in rows[1:]:
        get = lambda name: row[col[name]] if col[name] < len(row) else ''
        code = clean(get('Barcode'))
        if not code:
            continue
        level = clean(get('Level'))
        docs.append({
            'id': number(get('Document Id')),
            'code': code,
            'title': clean(get('Description')) or clean(get('Title')),
            'file': clean(get('Title')),
            'type': clean(get('Type')),
            'tags': split_list(get('Tags')),
            'level': level,
            'skills': clean(get('Critical Skills +')),
            'keywords': split_list(get('Keywords')),
            'pages': number(get('Pages')),
            'modified': clean(get('Last Modified Date')),
        })
    docs.sort(key=lambda d: d['code'])
    return docs


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='Build library.json from the Curriculum Library export.')
    parser.add_argument('export', help='the .xlsx export')
    parser.add_argument('--center', default='', help='the name shown at the top of the page')
    parser.add_argument('--platform', default='', help='what the curriculum system is called')
    parser.add_argument('--doc-url', default='', help='https://... link pattern with {id}, optional')
    parser.add_argument('--out', help='where to write library.json (default: next to the export)')
    args = parser.parse_args(argv)
    if args.doc_url and not (args.doc_url.startswith('https://') and '{id}' in args.doc_url):
        raise SystemExit('--doc-url must start with https:// and contain {id}')
    export = Path(args.export)
    out = Path(args.out) if args.out else export.resolve().parent / 'library.json'
    docs = build(read_rows(export))
    library = {'source': export.name, 'documents': docs}
    library.update({k: v.strip() for k, v in (('center', args.center), ('platform', args.platform),
                                              ('docUrl', args.doc_url)) if v.strip()})
    out.write_text(json.dumps(library, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    types = Counter(d['type'] for d in docs)
    codes = Counter(d['code'] for d in docs)
    print(f'{len(docs)} documents -> {out} ({out.stat().st_size // 1024} KB)')
    print('by type:', ', '.join(f'{t} {n}' for t, n in types.most_common()))
    print('without tags:', sum(not d['tags'] for d in docs),
          '| without critical skills:', sum(not d['skills'] for d in docs),
          '| without keywords:', sum(not d['keywords'] for d in docs))
    repeated = [c for c, n in codes.items() if n > 1]
    if repeated:
        print('codes used more than once:', ', '.join(repeated))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
