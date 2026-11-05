import base64
import io
import json
import random
import shutil
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from PIL import Image, ImageDraw, ImageFont

import app
import collab
import storage

SLOT_BOXES = [(81, 443, 321, 683), (345, 443, 585, 683), (609, 443, 849, 683)]


def certificate(last_seed=1, size=(930, 1410), text=None, extra=0, first_seed=10, second_seed=11):
    """A synthetic certificate: three textured thumbnails, optionally an ID line."""
    im = Image.new('RGB', size, (240, 240, 255))
    draw = ImageDraw.Draw(im)
    sx, sy = size[0] / 930, size[1] / 1410
    for seed, box in zip((first_seed, second_seed, last_seed), SLOT_BOXES):
        rng = random.Random(seed)
        left, top, right, bottom = (round(box[0] * sx), round(box[1] * sy), round(box[2] * sx), round(box[3] * sy))
        step = max(6, (right - left) // 16)
        for x in range(left, right, step):
            for y in range(top, bottom, step):
                draw.rectangle([x, y, x + step, y + step], fill=tuple(rng.randrange(256) for _ in range(3)))
    if extra:
        draw.rectangle([5, 5, 5 + extra, 25], fill=(0, 0, 0))  # makes otherwise identical files differ
    if text:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 30)
        draw.text((0.14 * size[0], 0.91 * size[1]), text, fill=(90, 90, 100), font=font)
    out = io.BytesIO()
    im.save(out, 'PNG')
    return out.getvalue()


def screenshot(cert, size=(1080, 2280), card_width=804, top=650, colored_ad=False, bare=False):
    """A phone screenshot of a certificate: status bar, ad banner, the card, a save button."""
    page = Image.new('RGB', size, (255, 255, 255))
    draw = ImageDraw.Draw(page)
    draw.rectangle([0, 0, size[0], 90], fill=(245, 245, 245))                   # status bar
    if not bare:
        draw.rectangle([0, 250, size[0], 590], fill=(255, 120, 60) if colored_ad else (225, 225, 225))  # ad banner
    # Phones draw the visible card slightly inside the exported frame (measured on a real screenshot:
    # 804x1224 visible against a 812x1232 frame, starting 7 px lower).
    frame = Image.open(io.BytesIO(cert)).convert('RGB')
    scale = card_width / 804
    frame = frame.resize((round(812 * scale), round(1232 * scale)), Image.LANCZOS)
    left, up = round(4 * scale), round(7 * scale)
    card = frame.crop((left, up, left + card_width, up + round(1224 * scale)))
    page.paste(card, ((size[0] - card_width) // 2, top))
    draw.rounded_rectangle([300, 2000, 780, 2090], 20, fill=(20, 20, 20))       # "Save image"
    out = io.BytesIO()
    page.save(out, 'PNG')
    return out.getvalue()


class Base(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_db = storage.DB
        storage.DB = self.temp.name + '/test.sqlite3'
        storage.init()
        collab.add_reference('ENHYPEN', certificate(1))
        for name in ('Fandom A', 'Fandom B', 'Fandom 0', 'Fandom 1', 'Fandom 2', 'Taeyeon fandom'):
            collab.create_collab(name, [])  # ENHYPEN only

    def tearDown(self):
        storage.DB = self.old_db
        self.temp.cleanup()

    def send(self, data, key, ids=('AAAAAAAAAAAAAAAA',) * 2, fandom='Fandom A'):
        with patch.object(collab, 'ocr_ids', return_value=ids):
            return collab.process(fandom, key + '.png', key, data, 'admin')


class Verification(Base):
    def test_valid_then_duplicates(self):
        first = self.send(certificate(1), 'one')
        self.assertEqual(first['status'], 'valid')
        same_id = self.send(certificate(1, extra=30), 'two', fandom='Fandom B')
        self.assertEqual(same_id['status'], 'duplicate')
        self.assertIn('Fandom A', same_id['reason'])
        same_file = self.send(certificate(1), 'three', ids=('BBBBBBBBBBBBBBBB',) * 2, fandom='Fandom B')
        self.assertEqual(same_file['status'], 'duplicate')  # identical file bytes under another name
        counts = {r['fandom']: r['valid'] for r in collab.summary()['submissions']}
        self.assertEqual(counts, {'Fandom A': 1, 'Fandom B': 0})

    def test_retry_of_same_file_is_idempotent(self):
        self.send(certificate(1), 'one')
        again = self.send(certificate(1), 'one')
        self.assertTrue(again['repeat'])
        self.assertEqual(collab.summary()['submissions'][0]['files'], 1)

    def test_last_image_must_be_enhypen(self):
        result = self.send(certificate(2), 'other')
        self.assertEqual(result['status'], 'not_enhypen')
        self.assertEqual(collab.summary()['submissions'][0]['valid'], 0)

    def test_enhypen_in_wrong_position_is_reported(self):
        # ENHYPEN pattern (seed 1) in the first slot instead of the last.
        im = Image.open(io.BytesIO(certificate(2)))
        ref = Image.open(io.BytesIO(certificate(1)))
        im.paste(ref.crop(SLOT_BOXES[2]), SLOT_BOXES[0][:2])
        out = io.BytesIO(); im.save(out, 'PNG')
        result = self.send(out.getvalue(), 'wrongpos')
        self.assertEqual(result['status'], 'not_enhypen')
        self.assertEqual(result['reason'], 'ENHYPEN is not the last image')

    def test_cropped_screenshot_goes_to_manual_review(self):
        result = self.send(certificate(2, size=(930, 1000)), 'cropped')
        self.assertEqual(result['status'], 'manual')

    def test_unreadable_or_disagreeing_ocr_needs_a_human(self):
        self.assertEqual(self.send(certificate(1), 'a', ids=(None, None))['status'], 'manual')
        both = self.send(certificate(1, extra=10), 'b', ids=('CCCCCCCCCCCCCCCC', 'CCCCCCCCCCCCCCCO'))
        self.assertEqual((both['status'], both['cert_id']), ('manual', 'CCCCCCCCCCCCCCCC'))
        self.assertEqual(self.send(b'not an image', 'c')['status'], 'manual')
        self.assertEqual(collab.queue(0, 10)['total'], 3)

    def test_one_character_difference_is_not_counted_automatically(self):
        self.assertEqual(self.send(certificate(1), 'a', ids=('61105JDXSVKA6VXC',) * 2)['status'], 'valid')
        near = self.send(certificate(1, extra=10), 'b', ids=('61105JDXSVKA6VXO',) * 2)
        self.assertEqual(near['status'], 'manual')
        self.assertIn('61105JDXSVKA6VXC', near['reason'])
        first = collab.approve(near['id'], '61105JDXSVKA6VXO', False, 'admin')
        self.assertTrue(first['needs_confirmation'])
        self.assertEqual(collab.approve(near['id'], '61105JDXSVKA6VXO', True, 'admin'), {'ok': True})
        self.assertEqual(collab.summary()['submissions'][0]['valid'], 2)

    def test_manual_approval_checks_duplicates_and_format(self):
        self.send(certificate(1), 'a', ids=('DDDDDDDDDDDDDDDD',) * 2)
        pending = self.send(certificate(1, extra=10), 'b', ids=(None, None))
        with self.assertRaises(ValueError):
            collab.approve(pending['id'], 'SHORT', False, 'admin')
        with self.assertRaises(ValueError):
            collab.approve(pending['id'], 'DDDDDDDDDDDDDDDD', False, 'admin')
        self.assertEqual(collab.approve(pending['id'], 'EEEEEEEEEEEEEEE1', False, 'admin'), {'ok': True})
        with self.assertRaises(ValueError):
            collab.approve(pending['id'], 'EEEEEEEEEEEEEEE2', False, 'admin')  # already reviewed

    def test_reject_and_known_keys(self):
        pending = self.send(certificate(1), 'a', ids=(None, None))
        self.assertEqual(collab.reject(pending['id'], 'admin'), {'ok': True})
        self.assertEqual(collab.summary()['submissions'][0]['rejected'], 1)
        self.assertEqual(collab.known(['a', 'missing']), ['a'])

    def test_requires_a_reference(self):
        with storage.connection() as c:
            c.execute('DELETE FROM collab_refs')
        with self.assertRaises(ValueError):
            self.send(certificate(1), 'a')

    def test_parallel_uploads_of_one_certificate_count_once(self):
        results = []

        def go(i):
            results.append(self.send(certificate(1, extra=i + 1), f'p{i}', ids=('FFFFFFFFFFFFFFFF',) * 2, fandom=f'Fandom {i % 3}')['status'])
        threads = [threading.Thread(target=go, args=(i,)) for i in range(8)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(sorted(results).count('valid'), 1)
        self.assertEqual(sum(r['valid'] for r in collab.summary()['submissions']), 1)

    def test_csv_exports(self):
        self.send(certificate(1), 'a')
        self.assertTrue(collab.export_csv('summary').startswith('Fandom collab,Valid proofs,Date\r\nFandom A,1,'))
        self.assertIn('AAAAAAAAAAAAAAAA', collab.export_csv('full'))


class Partners(Base):
    LINGSHOT, TAEYEON = 20, 30

    def setUp(self):
        super().setUp()
        self.lingshot = collab.create_collab('Lingshot', [0])['id']      # partner image first
        self.taeyeon = collab.create_collab('Taeyeon', [0, 1])['id']     # first or second
        collab.add_reference('Lingshot', certificate(1, first_seed=self.LINGSHOT), self.lingshot, 0)
        collab.add_reference('Taeyeon', certificate(1, second_seed=self.TAEYEON), self.taeyeon, 1)

    def test_partner_image_in_the_right_position_is_valid(self):
        self.assertEqual(self.send(certificate(1, first_seed=self.LINGSHOT), 'l1', fandom='Lingshot')['status'], 'valid')
        self.assertEqual(self.send(certificate(1, first_seed=self.TAEYEON, extra=3), 't1', ids=('BBBBBBBBBBBBBBBB',) * 2, fandom='Taeyeon')['status'], 'valid')   # first slot
        self.assertEqual(self.send(certificate(1, second_seed=self.TAEYEON, extra=4), 't2', ids=('CCCCCCCCCCCCCCCC',) * 2, fandom='Taeyeon')['status'], 'valid')  # second slot

    def test_wrong_collab_certificate_is_rejected_with_a_reason(self):
        taeyeon_cert_in_lingshot_batch = self.send(certificate(1, first_seed=self.TAEYEON), 'x', fandom='Lingshot')
        self.assertEqual(taeyeon_cert_in_lingshot_batch['status'], 'not_partner')
        self.assertEqual(taeyeon_cert_in_lingshot_batch['reason'], 'The Lingshot image is not in the first position')
        self.assertEqual(self.send(certificate(1), 'y', ids=('DDDDDDDDDDDDDDDD',) * 2, fandom='Taeyeon')['status'], 'not_partner')
        # Lingshot image in the second position is not accepted for a first-position collab.
        self.assertEqual(self.send(certificate(1, second_seed=self.LINGSHOT), 'z', ids=('EEEEEEEEEEEEEEEE',) * 2, fandom='Lingshot')['status'], 'not_partner')
        rows = {r['fandom']: r for r in collab.summary()['submissions']}
        self.assertEqual((rows['Lingshot']['not_partner'], rows['Lingshot']['valid']), (2, 0))

    def test_enhypen_is_still_required(self):
        self.assertEqual(self.send(certificate(2, first_seed=self.LINGSHOT), 'n', fandom='Lingshot')['status'], 'not_enhypen')

    def test_a_certificate_counts_once_across_collabs(self):
        self.assertEqual(self.send(certificate(1, first_seed=self.LINGSHOT), 'a', fandom='Lingshot')['status'], 'valid')
        again = self.send(certificate(1, first_seed=self.TAEYEON, extra=5), 'b', fandom='Taeyeon')
        self.assertEqual(again['status'], 'duplicate')
        self.assertIn('Lingshot', again['reason'])

    def test_configuration_errors_are_explained(self):
        with self.assertRaisesRegex(ValueError, 'not a defined collab'):
            self.send(certificate(1), 'u', fandom='Unknown fandom')
        empty = collab.create_collab('No sample yet', [0])['id']
        with self.assertRaisesRegex(ValueError, 'partner reference'):
            self.send(certificate(1), 'v', fandom='No sample yet')
        with self.assertRaises(ValueError):
            collab.add_reference('x', certificate(1), empty, 1)       # position not allowed for this collab
        with self.assertRaises(ValueError):
            collab.create_collab('lingshot', [0])                      # names are unique, case-insensitive
        with self.assertRaises(ValueError):
            collab.create_collab('Bad', [2])

    def test_collab_with_proofs_cannot_be_removed(self):
        self.send(certificate(1, first_seed=self.LINGSHOT), 'a', fandom='Lingshot')
        with self.assertRaises(ValueError):
            collab.delete_collab(self.lingshot)
        spare = collab.create_collab('Spare', [])['id']
        self.assertEqual(collab.delete_collab(spare), {'ok': True})
        listed = {c['name']: c for c in collab.summary()['collabs']}
        self.assertEqual(listed['Lingshot']['slots'], [0])
        self.assertEqual(len(listed['Lingshot']['refs']), 1)


class HTTP(Base):
    def setUp(self):
        super().setUp()
        self.old_password = app.PASSWORD
        app.PASSWORD = 'test-password-only'
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        app.PASSWORD = self.old_password
        super().tearDown()

    def call(self, path, body=None, auth=True, raw=False):
        headers = {}
        if auth:
            headers['Authorization'] = 'Basic ' + base64.b64encode(f'{app.USERNAME}:{app.PASSWORD}'.encode()).decode()
        if body is not None:
            headers['Content-Type'] = 'application/octet-stream' if raw else 'application/json'
            body = body if raw else json.dumps(body).encode()
        try:
            response = urllib.request.urlopen(urllib.request.Request(self.base + path, data=body, headers=headers))
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.read()

    def test_export_download_has_dated_filename(self):
        with urllib.request.urlopen(urllib.request.Request(self.base + '/api/collab/export.csv?kind=summary&day=2026-11-01', headers={
                'Authorization': 'Basic ' + base64.b64encode(f'{app.USERNAME}:{app.PASSWORD}'.encode()).decode()})) as r:
            self.assertIn('mama-valid-proofs-2026-11-01.csv', r.headers['Content-Disposition'])

    def test_requires_authentication(self):
        for path in ('/collab-verify', '/api/collab/summary', '/api/collab/proofs/1/image'):
            self.assertEqual(self.call(path, auth=False)[0], 401)
        self.assertEqual(self.call('/api/collab/upload?fandom=A&name=x&key=x', b'x', auth=False, raw=True)[0], 401)

    def test_page_and_full_review_flow(self):
        self.assertEqual(self.call('/collab-verify')[0], 200)
        self.assertEqual(self.call('/collab.js')[0], 200)
        with patch.object(collab, 'ocr_ids', return_value=(None, None)):
            status, body = self.call('/api/collab/upload?fandom=Taeyeon%20fandom&name=a.png&key=k1', certificate(1, extra=5), raw=True)
        self.assertEqual((status, json.loads(body)['status']), (200, 'manual'))
        queue = json.loads(self.call('/api/collab/queue?offset=0&limit=10')[1])
        self.assertEqual(queue['total'], 1)
        proof = queue['items'][0]
        status, image = self.call(f"/api/collab/proofs/{proof['id']}/image")
        self.assertEqual((status, image[:2]), (200, b'\xff\xd8'))
        status, body = self.call(f"/api/collab/proofs/{proof['id']}/approve", {'cert_id': '1234567890ABCDEF'})
        self.assertEqual((status, json.loads(body)), (200, {'ok': True}))
        summary = json.loads(self.call('/api/collab/summary')[1])
        self.assertEqual(summary['submissions'][0]['valid'], 1)
        self.assertEqual(json.loads(self.call('/api/collab/known', {'keys': ['k1', 'k2']})[1]), {'known': ['k1']})
        status, body = self.call('/api/collab/export.csv?kind=summary')
        self.assertIn(b'Taeyeon fandom,1,', body)

    def test_collab_setup_over_http(self):
        status, body = self.call('/api/collab/collabs/create', {'name': 'Lingshot', 'slots': [0]})
        self.assertEqual(status, 200)
        collab_id = json.loads(body)['id']
        status, body = self.call(f'/api/collab/ref?collab={collab_id}&slot=0', certificate(1, first_seed=20), raw=True)
        self.assertEqual(status, 200)
        with patch.object(collab, 'ocr_ids', return_value=('1234567890ABCDEF',) * 2):
            ok = json.loads(self.call('/api/collab/upload?fandom=Lingshot&name=a.png&key=a', certificate(1, first_seed=20), raw=True)[1])
            wrong = json.loads(self.call('/api/collab/upload?fandom=Lingshot&name=b.png&key=b', certificate(1, first_seed=99), raw=True)[1])
        self.assertEqual((ok['status'], wrong['status']), ('valid', 'not_partner'))
        listed = json.loads(self.call('/api/collab/summary')[1])['collabs']
        self.assertEqual([c['name'] for c in listed if c['slots'] == [0]], ['Lingshot'])
        self.assertEqual(self.call(f'/api/collab/collabs/{collab_id}/delete', {})[0], 400)

    def test_errors_are_readable(self):
        status, body = self.call('/api/collab/upload?fandom=&name=a&key=k', certificate(1), raw=True)
        self.assertEqual(status, 400)
        self.assertIn('Fandom collab name', json.loads(body)['error'])
        status, body = self.call('/api/collab/upload?fandom=Nobody&name=a&key=k', certificate(1), raw=True)
        self.assertEqual(status, 400)
        self.assertIn('not a defined collab', json.loads(body)['error'])
        self.assertEqual(self.call('/api/collab/proofs/999/approve', {'cert_id': '1234567890ABCDEF'})[0], 400)


class Screenshots(Base):
    LINGSHOT = 20

    def test_a_screenshot_counts_like_a_certificate(self):
        self.assertEqual(self.send(screenshot(certificate(1)), 's1')['status'], 'valid')
        again = self.send(certificate(1, extra=9), 'c1', fandom='Fandom B')   # same ID as a real certificate
        self.assertEqual(again['status'], 'duplicate')

    def test_screenshot_with_another_last_image_is_rejected(self):
        self.assertEqual(self.send(screenshot(certificate(2)), 's2')['status'], 'not_enhypen')

    def test_other_phones_and_a_colourful_ad(self):
        for i, kwargs in enumerate([dict(size=(720, 1560), card_width=536, top=430), dict(size=(1440, 3120), card_width=1100, top=900),
                                    dict(colored_ad=True), dict(bare=True)]):
            ids = (['AAAAAAAAAAAAAAAA', 'BCDEFGHJKLMNPQRS', 'KLMNPQRSTUVWXYZ2', 'Z9Y8X7W6V5U4T3S2'][i],) * 2  # unrelated IDs: no near-duplicates
            self.assertEqual(self.send(screenshot(certificate(1), **kwargs), f's{i}', ids=ids)['status'], 'valid', kwargs)

    def test_partner_image_is_checked_in_screenshots_too(self):
        lingshot = collab.create_collab('Lingshot', [0])['id']
        collab.add_reference('Lingshot', screenshot(certificate(1, first_seed=self.LINGSHOT)), lingshot, 0)   # a screenshot works as a sample
        self.assertEqual(self.send(screenshot(certificate(1, first_seed=self.LINGSHOT)), 'a', fandom='Lingshot')['status'], 'valid')
        self.assertEqual(self.send(certificate(1, first_seed=self.LINGSHOT, extra=4), 'b', ids=('BBBBBBBBBBBBBBBB',) * 2, fandom='Lingshot')['status'], 'valid')
        self.assertEqual(self.send(screenshot(certificate(1, first_seed=77)), 'c', ids=('CCCCCCCCCCCCCCCC',) * 2, fandom='Lingshot')['status'], 'not_partner')

    def test_screenshot_without_the_card_goes_to_manual_review(self):
        page = Image.new('RGB', (1080, 2280), (255, 255, 255))
        out = io.BytesIO()
        page.save(out, 'PNG')
        result = self.send(out.getvalue(), 'blank')
        self.assertEqual(result['status'], 'manual')
        self.assertIn('Non-standard layout', result['reason'])

    def test_card_is_located(self):
        im = Image.open(io.BytesIO(screenshot(certificate(1))))
        x0, y0, x1, y1 = collab.find_card(im)
        self.assertTrue(abs(x0 - 138) <= 4 and abs(x1 - 942) <= 4 and abs(y0 - 650) <= 4, (x0, y0, x1, y1))
        self.assertIsNone(collab.find_card(Image.new('RGB', (1080, 2280), (255, 255, 255))))
        self.assertFalse(collab.normalise(Image.open(io.BytesIO(certificate(1))).convert('RGB'))[1])  # real certificates pass through


class Cleanup(Base):
    def test_reset_proofs_keeps_collabs_and_references(self):
        self.send(certificate(1, extra=3), 'a')
        self.assertEqual(collab.summary()['submissions'][0]['valid'], 1)
        self.assertEqual(collab.reset_proofs(), 1)
        info = collab.summary()
        self.assertEqual(info['submissions'], [])
        self.assertEqual(len(info['collabs']), 6)
        self.assertEqual(len(info['refs']), 1)
        self.assertEqual(self.send(certificate(1, extra=3), 'b')['status'], 'valid')

    def test_legacy_tables_are_upgraded_and_test_proofs_removed(self):
        self.send(certificate(1, extra=3), 'a')
        with storage.connection() as c:
            c.execute("DELETE FROM collab_meta WHERE k='schema'")  # looks like a pre-versioning database
            collab.init(c)
            self.assertEqual(c.execute('SELECT count(*) FROM collab_proofs').fetchone()[0], 0)
            self.assertEqual(c.execute('SELECT count(*) FROM collab_collabs').fetchone()[0], 6)
            self.assertEqual(c.execute('SELECT count(*) FROM collab_refs').fetchone()[0], 1)
        self.assertEqual(self.send(certificate(1, extra=4), 'b')['status'], 'valid')
        with storage.connection() as c:
            collab.init(c)  # a normal restart must not delete anything
            self.assertEqual(c.execute('SELECT count(*) FROM collab_proofs').fetchone()[0], 1)

    def test_proofs_day(self):
        self.assertEqual(collab.proofs_day(''), collab.today())
        self.assertEqual(collab.proofs_day('2026-11-01'), '2026-11-01')
        for bad in ('2026-13-40', 'yesterday', '2999-01-01'):
            with self.assertRaises(ValueError):
                collab.proofs_day(bad)

    def test_exports_filter_by_day(self):
        with patch.object(collab, 'ocr_ids', return_value=('BBBBBBBBBBBBBBBB',) * 2):
            collab.process('Fandom A', 'a.png', 'k1', certificate(1, extra=3), 'admin', '2026-11-01')
        with patch.object(collab, 'ocr_ids', return_value=('CCCCCCCCCCCCCCCC',) * 2):
            collab.process('Fandom A', 'b.png', 'k2', certificate(1, extra=4), 'admin', '2026-11-02')
        self.assertEqual(collab.export_csv('summary', '2026-11-01').strip().splitlines(), ['Fandom collab,Valid proofs,Date', 'Fandom A,1,2026-11-01'])
        self.assertEqual(len(collab.export_csv('summary').strip().splitlines()), 3)
        self.assertEqual(collab.export_name('summary', '2026-11-01'), 'mama-valid-proofs-2026-11-01.csv')
        self.assertTrue(collab.export_name('full', '').startswith('mama-proofs-report-all-as-of-'))


@unittest.skipUnless(shutil.which('tesseract') and __import__('os').path.exists('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'), 'tesseract or font not available')
class RealOCR(Base):
    def test_reads_the_id_line(self):
        result = collab.process('Fandom A', 'x.png', 'x', certificate(1, text='61105JDXSVKA6VXC'), 'admin')
        self.assertEqual((result['status'], result['cert_id']), ('valid', '61105JDXSVKA6VXC'))

    def test_reads_the_id_line_of_a_screenshot(self):
        result = collab.process('Fandom A', 'x.png', 'x', screenshot(certificate(1, text='61101HZSLUIHCBOR')), 'admin')
        self.assertEqual((result['status'], result['cert_id']), ('valid', '61101HZSLUIHCBOR'))


if __name__ == '__main__':
    unittest.main()
