"""Pull the text out of the curriculum PDFs, into a few small files to upload.

The PDFs themselves are big (hundreds of MB). Their text is small, and it is all
the finder needs to search inside the documents (example problems, wording). Run
this on the computer that has them:

    python -m pip install pymupdf
    python extract_text.py "Curriculum PDFs.zip"        (or a folder of PDFs)

It writes curriculum_text_1.jsonl.gz (and _2, _3 ... when needed), each under
9 MB, next to the zip. These are curriculum too: keep them out of the repo
(.gitignore does). One line per PDF:

    {"file": "PK-0001-00_Sample_Worksheet.pdf", "path": "<folder in the zip>/...",
     "code": "PK-0001-00", "pages": 12, "text": ["page 1 text", "page 2 text", ...]}

Nothing is sent anywhere by this script, and the zip is not changed.
"""
from __future__ import annotations

import gzip
import io
import json
import re
import sys
import zipfile
from collections import Counter
from pathlib import Path, PurePosixPath

PART_LIMIT = 9 * 1024 * 1024          # each output file stays under 9 MB
CODE = re.compile(r'^([A-Z]{2,3}-[A-Z0-9]{3,4}-[A-Z0-9]{2,3})')
SPACES = re.compile(r'[ \t ]+')
BLANK_LINES = re.compile(r'\n\s*\n+')


def tidy(text: str) -> str:
    """Page text with runs of spaces and blank lines squeezed out."""
    lines = (SPACES.sub(' ', line).strip() for line in text.replace('\r', '\n').split('\n'))
    return BLANK_LINES.sub('\n', '\n'.join(lines)).strip()


def pdf_pages(data: bytes) -> list[str]:
    import pymupdf
    with pymupdf.open(stream=data, filetype='pdf') as doc:
        return [tidy(page.get_text('text')) for page in doc]


def sources(target: Path):
    """(path inside, file name, bytes) for every file in the zip or folder."""
    if target.is_dir():
        for path in sorted(p for p in target.rglob('*') if p.is_file()):
            yield str(path.relative_to(target)).replace('\\', '/'), path.name, path.read_bytes
    else:
        with zipfile.ZipFile(target) as zf:
            for info in sorted(zf.infolist(), key=lambda i: i.filename):
                if info.is_dir() or '__MACOSX' in info.filename:
                    continue
                yield info.filename, PurePosixPath(info.filename).name, (lambda i=info: zf.read(i))


class Parts:
    """Gzipped JSON lines, starting a new file before one would pass PART_LIMIT."""
    def __init__(self, folder: Path):
        self.folder, self.number, self.raw, self.gz, self.made = folder, 0, None, None, []

    def _next(self):
        self.close()
        self.number += 1
        path = self.folder / f'curriculum_text_{self.number}.jsonl.gz'
        self.raw = open(path, 'wb')
        self.gz = gzip.GzipFile(fileobj=self.raw, mode='wb', compresslevel=9)
        self.made.append(path)

    def write(self, record: dict):
        line = (json.dumps(record, ensure_ascii=False) + '\n').encode('utf-8')
        if self.gz is None or self.raw.tell() + len(gzip.compress(line)) > PART_LIMIT:
            self._next()
        self.gz.write(line)
        self.gz.flush()   # so the size check above sees what is written

    def close(self):
        if self.gz:
            self.gz.close()
            self.raw.close()
            self.gz = self.raw = None


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    target = Path(argv[1]).expanduser().resolve()
    if not target.exists():
        print(f'Not found: {target}')
        return 2
    try:
        import pymupdf  # noqa: F401
    except ImportError:
        print('First run:  python -m pip install pymupdf')
        return 2
    out = Parts(target.parent if target.is_file() else target)
    counts, others, empty, failed, pages = Counter(), Counter(), [], [], 0
    try:
        for inside, name, read in sources(target):
            if not name.lower().endswith('.pdf'):
                others[PurePosixPath(name).suffix.lower() or '(none)'] += 1
                continue
            counts['pdf'] += 1
            try:
                text = pdf_pages(read())
            except Exception as exc:          # a damaged or locked PDF: noted, then skipped
                failed.append(f'{inside} ({type(exc).__name__})')
                continue
            pages += len(text)
            if not any(text):
                empty.append(inside)          # pictures only: no text to read without OCR
            match = CODE.match(name)
            out.write({'file': name, 'path': inside, 'code': match.group(1) if match else '',
                       'pages': len(text), 'text': text})
            if counts['pdf'] % 100 == 0:
                print(f'{counts["pdf"]} PDFs read...', flush=True)
    finally:
        out.close()
    print(f'\nRead {counts["pdf"]} PDFs ({pages} pages).')
    if empty:
        print(f'{len(empty)} have no text (scanned pictures), for example: {", ".join(empty[:5])}')
    if failed:
        print(f'{len(failed)} could not be opened: {", ".join(failed[:10])}')
    if others:
        print('Other files skipped: ' + ', '.join(f'{n} {ext}' for ext, n in others.most_common()))
    print('\nMade:')
    for path in out.made:
        print(f'  {path}  ({path.stat().st_size / 1024 / 1024:.1f} MB)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
