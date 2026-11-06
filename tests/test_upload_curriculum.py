"""tools/upload_curriculum.py with a stand-in bucket:  python3 -m unittest discover tests"""
import csv
import gzip
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import upload_curriculum as u  # noqa: E402

SAMPLE = ROOT / 'tests' / 'sample_library.json'
REAL = ROOT / 'library.json'   # never committed; these checks are skipped without it


class FakeBucket:
    def __init__(self):
        self.objects, self.puts = {}, []

    def head_object(self, Bucket, Key):
        if Key not in self.objects:
            raise Exception('404 Not Found')
        data = self.objects[Key][0]
        return {'ContentLength': len(data), 'ETag': '"' + hashlib.md5(data).hexdigest() + '"'}

    def put_object(self, Bucket, Key, Body, ContentType, Metadata=None):
        assert Bucket == 'test-bucket'
        data = Body if isinstance(Body, bytes) else Body.read()
        self.objects[Key] = (data, ContentType, Metadata or {})
        self.puts.append(Key)


class CodeTest(unittest.TestCase):
    def test_codes_are_written_the_way_the_library_writes_them(self):
        for name, code in [
            ('001_PK-NF01-00_Sample_Title_v01.pdf', 'PK-NF01-00'),
            ('PK_NF21-00_Doubling_Numbers', 'PK-NF21-00'),
            ('Pk_3187_Mean_and_Range_v01', 'PK-3187-00'),
            ('Pk_3192_Box_Plots.pdf', 'PK-3192-00'),
            ('PK 186 fractions.pdf', 'PK-0186-00'),
            ('pk-0186-tp_x_v02.pdf', 'PK-0186-TP'),
            ('FO-0090-TP_Test_Prep.pdf', 'FO-0090-TP'),
            ('Pk_3102_to_the_Grid.pdf', 'PK-3102-00'),
            ('Two-Step-Equations_notes.pdf', ''),
        ]:
            self.assertEqual(u.code_of(name), code, name)

    def test_a_code_is_matched_to_the_library_when_only_one_fits(self):
        library = {'FO-0922-00': 'FO', 'PK-0186-00': 'PK', 'PK-0186-TP': 'PK'}
        self.assertEqual(u.fit('FO-0922-CA', library), 'FO-0922-00')
        self.assertEqual(u.fit('PK-0186-HS', library), 'PK-0186-HS', 'two candidates: left as read')
        self.assertEqual(u.fit('PK-0186-TP', library), 'PK-0186-TP')

    def test_workout_books_are_found_by_their_library_file_name(self):
        docs = [{'code': 'WCH-007-003', 'type': 'WOB - Chapters', 'file': 'WOB_7_Chapter_3.pdf'},
                {'code': 'WOB-NF29-000', 'type': 'WOB - Complete',
                 'file': 'Workout Book Sample Facts Review'},
                {'code': 'WOB-0PK-000', 'type': 'WOB - Complete', 'file': 'WOB_PK_Sample_Concepts.pdf'},
                {'code': 'WOB-0TP-004A', 'type': 'WOB - Complete', 'file': 'WOB_Test_Prep_Level_4.pdf'},
                {'code': 'PK-0186-00', 'type': 'PK', 'file': 'PK-0186-00_Adding_Fractions.pdf'}]
        library = {d['code']: d['type'] for d in docs}
        files = u.by_file_name(docs)
        for name, code in [
            ('WOB_7_Chapter_3.pdf', 'WCH-007-003'),
            ('wob 7 chapter 3.PDF', 'WCH-007-003'),                    # case and spaces don't matter
            ('WOB_7_Chapter_3_v02.pdf', 'WCH-007-003'),                # nor a version ending
            ('Workout Book Sample Facts Review.pdf', 'WOB-NF29-000'),
            ('WOB_PK_Sample_Concepts.pdf', 'WOB-0PK-000'),         # never read as PK-PRE-00
            ('WCH-007-003_anything.pdf', 'WCH-007-003'),               # a code in the name wins
            ('WOB-0TP-004A.pdf', 'WOB-0TP-004A'),
            ('WOB_7_Chapter_9.pdf', ''),                                # not in the library: left out
            ('PK-0186-00_Adding_Fractions_v02.pdf', 'PK-0186-00'),     # PKs as before
            ('Adding_Fractions.pdf', ''),
        ]:
            self.assertEqual(u.code_for(name, library, files), code, name)
        self.assertEqual(u.pdf_key('WOB_PK_Sample_Supplement'),
                         'pdf/WOB_PK_SAMPLE_SUPPLEMENT.pdf')

    def test_short_workout_book_chapter_names(self):
        docs = [{'code': c, 'type': 'WOB - Chapters', 'file': f, 'title': t} for c, f, t in [
            ('WCH-007-003', 'WOB_7_Chapter_3.pdf', 'WOB 7 Chapter 3 - Sample'),
            ('WCH-00A-001', 'WOB_A_Chapter_1.pdf', 'WOB A Chapter 1 - Sample'),
            ('WCH-N02-004', 'WCH-N02-004_WOB_M2_Chapter_4', 'WOB M2 Chapter 4 - Sample'),
            ('WCH-010-002', 'WOB_Algebra_Chapter_2', 'WOB Algebra Chapter 2'),
            ('WCH-00B-002', 'WOB_B_Part_1_Chapter_2.pdf', 'WOB B Part 1 Chapter 2 - Sample'),
            ('WCH-00B-006', 'WOB_B_Part_2_Chapter_2.pdf', 'WOB B Part 2 Chapter 2 - Sample'),
            ('WCH-00B-012', 'WOB_B_Part_2_DeskTools.pdf', 'WOB B Part 2 Chapter 8 - Sample - Desktools'),
            ('WCH-0D1-002', 'WOB_D-Level_1_Chapter_2.pdf', 'WOB D Level 1 Chapter 2 - Sample'),
            ('WCH-0NF-001', 'WOB_Numerical_Fluency_Chapter_1', 'Numerical Fluency Workout Book Chapter 1'),
            ('WCH-0PK-003', 'WCH-0PK-003_Preschool_Chapter_3.pdf', 'Preschool Workout Book - Chapter 3'),
            ('WCH-SAT-005', 'WOB SAT Chapter 5', 'Workout Book SAT Basic Skills Ch 5'),
            ('PK-0186-00', 'PK-0186-00_Adding_Fractions.pdf', 'Adding Fractions')]]
        library = {d['code']: d['type'] for d in docs}
        files = u.by_file_name(docs)
        for name, code in [
            ('WOB_7_Ch3_v21.pdf', 'WCH-007-003'),
            ('WOB_A_Ch1_v04.pdf', 'WCH-00A-001'),
            ('WOB_M2_Ch4_v07__MIXED_v07_v08.pdf', 'WCH-N02-004'),
            ('WOB_Alg_Chapter_2_v06.pdf', 'WCH-010-002'),
            ('WOB_B_Part_1_Ch_2_v12.pdf', 'WCH-00B-002'),
            ('WOB_B_Part_2_Ch_2_v01.pdf', 'WCH-00B-006'),     # numbered within its part
            ('WOB_B_Part_2_DT_v01.pdf', 'WCH-00B-012'),
            ('WOB_D_L1_Pt2_v01.pdf', 'WCH-0D1-002'),
            ('WOB_NF_Ch_1_v01.pdf', 'WCH-0NF-001'),
            ('WOB_PK1_Ch3_v08.pdf', 'WCH-0PK-003'),
            ('WOB_SAT_Basic_Skills_Ch_5_v04.pdf', 'WCH-SAT-005'),
            ('WOB_7_Ch9_v01.pdf', ''),                         # no such chapter in the library
            ('WOB_B_Part_3_Ch_1_v01.pdf', ''),
            ('WOB_Notes_v01.pdf', ''),
        ]:
            self.assertEqual(u.code_for(name, library, files), code, name)

    @unittest.skipUnless(REAL.is_file(), 'no library.json next to the README')
    def test_every_real_library_file_name_reads_as_its_own_code(self):
        data, library, files = u.read_library(REAL, with_files=True)
        docs = json.loads(data.decode('utf-8'))['documents']
        name = lambda f: f.replace('/', '-') + ('' if f.lower().endswith('.pdf') else '.pdf')
        wrong = [(d['code'], d['file']) for d in docs if u.code_for(name(d['file']), library, files) != d['code']]
        self.assertEqual(wrong, [])

    def test_versions(self):
        self.assertEqual(u.version_of('x_v02.pdf'), 2)
        self.assertEqual(u.version_of('x.pdf'), 0)

    @unittest.skipUnless(REAL.is_file(), 'no library.json next to the README')
    def test_real_library_file_names_read_as_their_own_codes(self):
        _, library = u.read_library(REAL)
        docs = json.loads(REAL.read_text(encoding='utf-8'))['documents']
        wrong = [(d['code'], d['file']) for d in docs if d['type'] in ('PK', 'FO', 'GF')
                 and u.fit(u.code_of(d['file'].replace('/', '-')), library) != d['code']]
        self.assertEqual(wrong, [])


class UploadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.library = root / 'library.json'
        self.library.write_bytes(SAMPLE.read_bytes())
        self.folder = root / 'pdfs'
        (self.folder / 'original1').mkdir(parents=True)
        for rel, data in {
            'original1/001_PK-0186-00_Adding_Fractions_v01.pdf': b'%PDF v01',
            'original1/002_PK-0186-00_Adding_Fractions_v02.pdf': b'%PDF v02 newer',
            'original1/003_Pk_3145_Slope_v01.pdf': b'%PDF slope',
            'original1/004_PK-9999-99_Not_A_Real_One.pdf': b'%PDF ?',
            'original1/notes.pdf': b'%PDF notes',
            'original1/readme.txt': b'not a pdf',
        }.items():
            (self.folder / rel).write_bytes(data)

    def tearDown(self):
        self.tmp.cleanup()
        os.environ.pop('R2_BUCKET', None)

    def run_main(self, *args, client=None, folder=True):
        out = io.StringIO()
        argv = ([str(self.folder)] if folder else []) + ['--library', str(self.library), *args]
        here = os.getcwd()
        os.chdir(self.tmp.name)            # a library-only run writes its report here
        try:
            with redirect_stdout(out):
                code = u.main(argv, client=client)
        finally:
            os.chdir(here)
        return code, out.getvalue()

    def report(self, where=None):
        with open((where or self.folder.parent) / 'upload_report.csv', encoding='utf-8') as f:
            return list(csv.DictReader(f))

    def test_a_dry_run_uploads_nothing_and_needs_no_keys_or_bucket(self):
        code, out = self.run_main('--dry-run')
        self.assertEqual(code, 0, out)
        self.assertIn('3 PDFs to upload', out)
        rows = self.report()
        status = {r['file'].split('/')[-1]: r['status'] for r in rows}
        self.assertEqual(rows[0]['key'], 'library.json')
        self.assertEqual(status['002_PK-0186-00_Adding_Fractions_v02.pdf'], 'to upload')
        self.assertTrue(status['001_PK-0186-00_Adding_Fractions_v01.pdf'].startswith('older version of'))
        self.assertEqual(status['notes.pdf'], 'no code in the name, and no library document with this file name')
        self.assertIn('not in the library', status['004_PK-9999-99_Not_A_Real_One.pdf'])
        self.assertTrue(any(r['status'] == 'library PK with no PDF found' for r in rows))

    def test_workout_book_files_go_up_under_their_library_codes(self):
        (self.folder / 'WOB').mkdir()
        (self.folder / 'WOB' / 'WCH-007-002_Workout_Book_7_Chapter_2_Decimals.pdf').write_bytes(b'%PDF ch2')
        (self.folder / 'WOB' / 'Workout Book 8.pdf').write_bytes(b'%PDF book 8')     # no code, no match
        lib = json.loads(self.library.read_text(encoding='utf-8'))
        for d in lib['documents']:
            if d['code'] == 'WOB-008-000':
                d['file'] = 'Workout_Book_8.pdf'          # named like the real ones: no code
        self.library.write_text(json.dumps(lib), encoding='utf-8')
        code, out = self.run_main('--dry-run')
        self.assertEqual(code, 0, out)
        rows = {r['file'].split('/')[-1]: r for r in self.report() if r['file']}
        self.assertEqual(rows['WCH-007-002_Workout_Book_7_Chapter_2_Decimals.pdf']['key'], 'pdf/WCH-007-002.pdf')
        self.assertEqual(rows['Workout Book 8.pdf']['key'], 'pdf/WOB-008-000.pdf')
        missing = [r['code'] for r in self.report() if r['status'] == 'library WOB with no PDF found']
        self.assertIn('WCH-007-001', missing)
        self.assertNotIn('WCH-007-002', missing)
        self.assertIn('Workout Book files have no PDF here', out)

    def test_a_real_run_needs_a_bucket(self):
        code, out = self.run_main(client=FakeBucket())
        self.assertEqual(code, 2)
        self.assertIn('R2_BUCKET', out)

    def test_upload_library_and_newest_versions_then_a_rerun_skips_everything(self):
        os.environ['R2_BUCKET'] = 'test-bucket'
        bucket = FakeBucket()
        code, out = self.run_main(client=bucket)
        self.assertEqual(code, 0, out)
        self.assertEqual(sorted(bucket.objects), ['library.json', 'pdf/PK-0186-00.pdf', 'pdf/PK-3145-00.pdf', 'pdf/PK-9999-99.pdf'])
        self.assertEqual(bucket.objects['library.json'][0], SAMPLE.read_bytes())
        self.assertEqual(bucket.objects['library.json'][1], 'application/json; charset=utf-8')
        self.assertEqual(bucket.objects['pdf/PK-0186-00.pdf'][0], b'%PDF v02 newer')
        self.assertEqual(bucket.objects['pdf/PK-3145-00.pdf'][2], {'source': 'original1/003_Pk_3145_Slope_v01.pdf'})
        self.assertIn('PDFs: uploaded 3, already there 0, failed 0', out)
        puts = len(bucket.puts)
        code, out = self.run_main(client=bucket)
        self.assertEqual(len(bucket.puts), puts, 'nothing new goes up')
        self.assertIn('library.json: already there', out)
        self.assertIn('already there 3', out)

    def test_a_changed_library_goes_up_again_on_its_own(self):
        bucket = FakeBucket()
        self.run_main('--bucket', 'test-bucket', client=bucket)
        lib = json.loads(self.library.read_text(encoding='utf-8'))
        lib['documents'] = lib['documents'][:-1]
        self.library.write_text(json.dumps(lib), encoding='utf-8')
        bucket.puts.clear()
        code, out = self.run_main('--bucket', 'test-bucket', client=bucket, folder=False)
        self.assertEqual(code, 0, out)
        self.assertEqual(bucket.puts, ['library.json'])

    def test_a_file_that_is_not_a_library_is_refused(self):
        self.library.write_text('{"not": "a library"}', encoding='utf-8')
        with self.assertRaises(SystemExit):
            self.run_main('--dry-run')

    def write_text(self, where, records, name='curriculum_text_1.jsonl.gz'):
        path = where / name
        with gzip.open(path, 'wt', encoding='utf-8') as f:
            for file, pages in records:
                f.write(json.dumps({'file': file, 'path': 'x/' + file, 'code': '', 'pages': len(pages), 'text': pages}) + '\n')
        return path

    TEXTS = [('001_PK-0186-00_Adding_Fractions_v01.pdf', ['old page']),
             ('002_PK-0186-00_Adding_Fractions_v02.pdf', ['page one', 'page two']),     # the newest version wins
             ('003_Pk_3145_Slope_v01.pdf', ['slope page']),
             ('004_PK-9999-99_Not_A_Real_One.pdf', ['?']),                             # not in the library
             ('notes.pdf', ['no code'])]

    def test_the_pdfs_text_is_filed_under_the_codes_the_pdfs_go_up_as(self):
        path = self.write_text(self.folder, self.TEXTS)
        _, library, files = u.read_library(self.library, with_files=True)
        data, counts = u.build_text([path], library, files)
        self.assertEqual(json.loads(gzip.decompress(data)),
                         {'documents': {'PK-0186-00': ['page one', 'page two'], 'PK-3145-00': ['slope page']}})
        self.assertEqual((counts['documents'], counts['pages'], counts['read'], counts['older']), (2, 3, 5, 1))
        self.assertEqual(counts['no_code'], ['notes.pdf'])
        self.assertEqual(counts['unknown'], ['004_PK-9999-99_Not_A_Real_One.pdf'])
        self.assertEqual(u.build_text([path], library, files)[0], data, 'the same bytes every time')

    def test_the_text_next_to_the_pdfs_goes_up_once(self):
        self.write_text(self.folder, self.TEXTS)
        code, out = self.run_main('--dry-run')
        self.assertEqual(code, 0, out)
        self.assertIn('PDF text: 2 documents (3 pages) from 5 PDFs', out)
        rows = self.report()
        self.assertEqual([r['status'] for r in rows if r['key'] == 'text.json.gz'], ['to upload'])
        self.assertTrue(any(r['file'] == 'notes.pdf' and r['status'].startswith('text: no code') for r in rows))
        bucket = FakeBucket()
        code, out = self.run_main('--bucket', 'test-bucket', client=bucket)
        self.assertEqual(code, 0, out)
        stored, kind, _ = bucket.objects['text.json.gz']
        self.assertEqual(kind, 'application/gzip')
        self.assertIn('PK-3145-00', json.loads(gzip.decompress(stored))['documents'])
        self.assertIn('text.json.gz: uploaded', out)
        bucket.puts.clear()
        code, out = self.run_main('--bucket', 'test-bucket', client=bucket)
        self.assertNotIn('text.json.gz', bucket.puts)
        self.assertIn('text.json.gz: already there', out)

    def test_text_alone_goes_up_without_the_pdfs_or_the_library(self):
        elsewhere = Path(self.tmp.name) / 'elsewhere'
        elsewhere.mkdir()
        path = self.write_text(elsewhere, self.TEXTS, 'curriculum_text_9.jsonl.gz')
        bucket = FakeBucket()
        bucket.objects['library.json'] = (b'{"documents": [{"code": "NEWER"}]}', 'application/json', {})
        code, out = self.run_main('--bucket', 'test-bucket', '--text', str(path), client=bucket, folder=False)
        self.assertEqual(code, 0, out)
        self.assertEqual(sorted(bucket.objects), ['library.json', 'text.json.gz'])
        self.assertEqual(bucket.puts, ['text.json.gz'], 'only the text: the library in the bucket is left alone')
        self.assertIn('used to file the text; not uploaded', out)
        code, out = self.run_main('--dry-run', '--text', str(elsewhere / 'missing.jsonl.gz'), folder=False)
        self.assertEqual(code, 2)
        self.assertIn('Not found', out)

    def test_the_keys_are_never_printed_or_reported(self):
        secret = 'sekret-value-1234567890'
        os.environ.update(R2_ACCOUNT_ID='acct', R2_ACCESS_KEY_ID='id-value', R2_SECRET_ACCESS_KEY=secret)
        try:
            _, out = self.run_main('--bucket', 'test-bucket', client=FakeBucket())
        finally:
            for k in ('R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'):
                os.environ.pop(k, None)
        report = (self.folder.parent / 'upload_report.csv').read_text(encoding='utf-8')
        for value in (secret, 'id-value'):
            self.assertNotIn(value, out)
            self.assertNotIn(value, report)


if __name__ == '__main__':
    unittest.main()
