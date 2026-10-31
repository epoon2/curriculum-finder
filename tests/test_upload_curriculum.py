"""tools/upload_curriculum.py with a stand-in bucket:  python3 -m unittest discover tests"""
import csv
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
        self.assertEqual(status['notes.pdf'], 'no code in the name')
        self.assertIn('not in the library', status['004_PK-9999-99_Not_A_Real_One.pdf'])
        self.assertTrue(any(r['status'] == 'library PK with no PDF found' for r in rows))

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
