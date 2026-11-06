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


def stretched(data, widen=1.07, shift=(8, 0)):
    """The same certificate with every thumbnail a little wider and moved, as some devices and app versions draw it."""
    im = Image.open(io.BytesIO(data)).convert('RGB')
    out = Image.new('RGB', im.size, (240, 240, 255))
    for box in SLOT_BOXES:
        piece = im.crop(box)
        w = round((box[2] - box[0]) * widen)
        piece = piece.resize((w, box[3] - box[1]), Image.LANCZOS)
        out.paste(piece, (round((box[0] + box[2]) / 2 - w / 2) + shift[0], box[1] + shift[1]))
    buf = io.BytesIO()
    out.save(buf, 'PNG')
    return buf.getvalue()


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
        both = self.send(certificate(1, extra=10), 'b', ids=('CCCCCCCCCCCCCCCC', 'CCCCCCCCCCCCCCCK'))  # C and K are not look-alikes
        self.assertEqual((both['status'], both['cert_id']), ('manual', 'CCCCCCCCCCCCCCCC'))
        self.assertEqual(self.send(b'not an image', 'c')['status'], 'manual')
        self.assertEqual(collab.queue(0, 10)['total'], 3)

    def test_unsure_id_is_accepted_when_nothing_similar_is_counted(self):
        # look-alike disagreement (O/0): accepted, nothing similar counted
        first = self.send(certificate(1), 'a', ids=('61105JDXSVKA6VX0', '61105JDXSVKA6VXO', '61105JDXSVKA6VX0'))
        self.assertEqual((first['status'], first['cert_id']), ('valid', '61105JDXSVKA6VX0'))
        # a single reading is accepted too
        single = self.send(certificate(1, extra=2), 'b', ids=('7777777777777777', None))
        self.assertEqual(single['status'], 'valid')
        # the same certificate read the other way is held for a person, never counted twice
        twin = self.send(certificate(1, extra=3), 'c', ids=('61105JDXSVKA6VXO', '61105JDXSVKA6VX0'))
        self.assertEqual(twin['status'], 'manual')
        self.assertIn('61105JDXSVKA6VX0', twin['reason'])
        # a variant of an ID that is counted, read with another look-alike in a different place, is held as well
        other = self.send(certificate(1, extra=4), 'd', ids=('B1105JDXSVKA6VX0', 'B1105JDXSVKA6VXO', 'B1105JDXSVKA6VXO'))
        self.assertEqual(other['status'], 'valid')
        held = self.send(certificate(1, extra=5), 'e', ids=('8110SJDXSVKA6VXO', '8110SJDXSVKA6VX0'))
        self.assertEqual(held['status'], 'manual')
        self.assertEqual(collab.summary()['submissions'][0]['valid'], 3)

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
            results.append(collab.process(f'Fandom {i % 3}', f'p{i}.png', f'p{i}', certificate(1, extra=i + 1), 'admin')['status'])
        threads = [threading.Thread(target=go, args=(i,)) for i in range(8)]
        with patch.object(collab, 'ocr_ids', return_value=('FFFFFFFFFFFFFFFF',) * 2):  # patched once, outside the threads
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

    def test_review_lists_over_http(self):
        with patch.object(collab, 'ocr_ids', return_value=('AAAAAAAAAAAAAAAA',) * 2):
            self.call('/api/collab/upload?fandom=Fandom%20A&name=x.png&key=k9', certificate(2, extra=6), raw=True)
        status, body = self.call('/api/collab/queue?kind=groups')
        self.assertEqual((status, json.loads(body)['total']), (200, 1))
        self.assertEqual(self.call('/api/collab/queue?kind=nonsense')[0], 400)
        proof = json.loads(body)['items'][0]['id']
        self.assertEqual(self.call(f'/api/collab/proofs/{proof}/keep', {})[0], 200)
        self.assertEqual(json.loads(self.call('/api/collab/reprocess')[1])['running'], False)

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


class IdReading(unittest.TestCase):
    def test_parse_accepts_the_no_prefix_in_its_forms(self):
        for text in ('61101EL66DVW4LYL', 'NO61101EL66DVW4LYL', 'N061101EL66DVW4LYL', 'N61101EL66DVW4LYL\n'):
            self.assertEqual(collab.parse_id(text), '61101EL66DVW4LYL', text)
        for text in ('61101EL66DVWA4LYL', 'N61101EL66DVWA4LYL', '61101EL66DVW4LY', ''):   # an inserted or missing character
            self.assertIsNone(collab.parse_id(text), text)

    def test_consensus_needs_agreement_and_a_margin(self):
        a, b = '61101EL66DVW4LYL', '61101EL66DVWALYL'
        self.assertEqual(collab.consensus([a, a]), a)
        self.assertEqual(collab.consensus([a, None, a, None, a]), a)
        self.assertEqual(collab.consensus([a, a, a, b]), a)          # clear majority
        self.assertIsNone(collab.consensus([a, b]))                   # disagreement
        self.assertIsNone(collab.consensus([a, a, b, b]))
        self.assertIsNone(collab.consensus([a, a, b]))                # only a margin of one
        self.assertIsNone(collab.consensus([a, None, None]))          # a single reading is never enough


class InsertedCharacters(unittest.TestCase):
    def test_stray_characters_and_prefix_are_voted_away(self):
        # real readings of 61101BRL9IMZRU9F: "No." glued in front, characters inserted or replaced
        raw = ['N61101BRL9IMZRU9SF', 'N61101BRL9IMZRU9F', 'N61101BRL9OIMZRUSF', 'N61101BRL9IMZRU9OF',
               'N61101BRL9IMZRU9F', 'N61101BRL9IMZRUSF', None, 'N61101BRL9OIMZRU9F']
        self.assertEqual(collab.consensus(raw), '61101BRL9IMZRU9F')
        self.assertEqual(collab.consensus(['N61105JDXSVKA6VXC'] * 3), '61105JDXSVKA6VXC')

    def test_nine_and_zero_are_look_alikes(self):
        self.assertEqual(collab.unsure_guess(['61105JDXSVKA6VX0', '61105JDXSVKA6VX9']), '61105JDXSVKA6VX0')
        self.assertEqual(collab.unsure_guess(['61105JDXSVKA6VX9', '61105JDXSVKA6VXS']), '61105JDXSVKA6VX9')
        self.assertIsNone(collab.unsure_guess(['61105JDXSVKA6VXK', '61105JDXSVKA6VX9']))

    def test_weak_readings_give_a_guess_only_with_a_leader(self):
        self.assertEqual(collab.unsure_guess(['N61101BRL9IMZRU9F', None, 'N61101BRL9IMZRUSF', 'N61101BRL9IMZRU9F']), '61101BRL9IMZRU9F')
        self.assertIsNone(collab.unsure_guess(['CCCCCCCCCCCCCCCC', 'CCCCCCCCCCCCCCCK']))   # a tie between different IDs
        self.assertIsNone(collab.unsure_guess([None, None]))


class Realigned(Base):
    def test_thumbnails_drawn_wider_or_moved_are_still_recognised(self):
        wide = stretched(certificate(1), 1.08, (10, 0))
        standard = collab.open_image(wide)
        ref = collab.slot_vector(Image.open(io.BytesIO(certificate(1))).convert('RGB'), 2)
        self.assertLess(collab.correlation(collab.slot_vector(standard, 2), ref), collab.T_OK)   # the fixed slot misses it
        self.assertEqual(self.send(wide, 'wide', ids=('1010101010101010',) * 2)['status'], 'valid')
        other = self.send(stretched(certificate(2), 1.08, (10, 0)), 'other-group')
        self.assertEqual(other['status'], 'not_enhypen')                                           # a different image is not found by the search

    def test_wrongly_rejected_proofs_can_be_checked_again(self):
        wide = stretched(certificate(1, extra=3), 1.08, (10, 0))
        with patch.object(collab, 'align', return_value=-1.0):                                    # the old checker
            self.assertEqual(self.send(wide, 'a', ids=('2020202020202020',) * 2)['status'], 'not_enhypen')
        self.assertEqual(collab.queue(0, 10, 'groups')['retry_pending'], 1)
        self.assertEqual(collab.queue(0, 10, 'partner')['retry_pending'], 0)
        with patch.object(collab, 'ocr_ids', return_value=('2020202020202020',) * 2):
            counted = collab.reprocess_review(apply=True, kind='groups')
        self.assertEqual((counted['eligible'], counted['valid']), (1, 1))
        self.assertEqual(collab.queue(0, 10, 'groups')['total'], 0)
        self.assertEqual(collab.summary()['submissions'][0]['valid'], 1)

    def test_images_now_right_but_id_unreadable_moves_to_verify(self):
        wide = stretched(certificate(1, extra=4), 1.08, (10, 0))
        with patch.object(collab, 'align', return_value=-1.0):
            self.send(wide, 'b')
        with patch.object(collab, 'ocr_ids', return_value=(None, None)):
            result = collab.reprocess_review(apply=True, kind='groups')
        self.assertEqual((result['review'], result['valid']), (1, 0))
        self.assertEqual(collab.queue(0, 10, 'manual')['total'], 1)
        self.assertEqual(collab.queue(0, 10, 'groups')['total'], 0)


class LookAlikes(Base):
    def test_the_same_certificate_read_two_ways_is_not_counted_twice(self):
        self.assertEqual(self.send(certificate(1), 'a', ids=('61105DUI8D06BAN1',) * 2)['status'], 'valid')
        # two look-alike differences (8/S and 0/O): not one character away, yet the same certificate
        twin = self.send(certificate(1, extra=2), 'b', ids=('61105DUISDO6BAN1',) * 2)
        self.assertEqual(twin['status'], 'manual')
        self.assertIn('61105DUI8D06BAN1', twin['reason'])
        self.assertEqual(self.send(certificate(1, extra=3), 'c', ids=('61105DUI9D06BANK',) * 2)['status'], 'valid')   # a different ID

    def test_look_alike_keys_are_added_to_the_ids_already_counted(self):
        self.send(certificate(1), 'a', ids=('61105DUI8D06BAN1',) * 2)
        with storage.connection() as c:
            c.execute("DELETE FROM collab_mask WHERE k LIKE 'F:%'")
            c.execute("DELETE FROM collab_meta WHERE k='fold_index'")
        storage.init()
        with storage.connection() as c:
            self.assertEqual(c.execute("SELECT count(*) FROM collab_mask WHERE k=?", (collab.fold_key('61105DUI8D06BAN1'),)).fetchone()[0], 1)
        storage.init()                                                                      # and only once
        with storage.connection() as c:
            self.assertEqual(c.execute("SELECT count(*) FROM collab_mask WHERE k LIKE 'F:%'").fetchone()[0], 1)


class Reprocess(Base):
    def test_ocr_review_items_are_read_again(self):
        a, b, c, d = 'AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB', 'AAAAAAAAAAAAAAAC', 'EEEEEEEEEEEEEEEE'
        self.send(certificate(1, extra=1), 'counted', ids=(a, a))                     # already valid
        self.assertEqual(self.send(certificate(1, extra=2), 'new', ids=(None, None))['status'], 'manual')
        self.send(certificate(1, extra=3), 'dup', ids=(None, None))
        self.send(certificate(1, extra=4), 'near', ids=(None, None))
        self.send(certificate(1, extra=5), 'stuck', ids=(None, None))
        self.assertEqual(collab.reprocess_review()['eligible'], 4)                      # without apply nothing changes
        reads = iter([(b, b), (a, a), (c, c), (None, None)])
        with patch.object(collab, 'ocr_ids', side_effect=lambda im: next(reads)):
            result = collab.reprocess_review(apply=True)
        self.assertEqual(result, {'eligible': 4, 'valid': 1, 'duplicate': 1, 'near': 1, 'review': 0, 'unchanged': 1})
        with storage.connection() as conn:
            status = {r['file_name']: (r['status'], r['cert_id']) for r in conn.execute('SELECT file_name,status,cert_id FROM collab_proofs')}
        self.assertEqual(status['new.png'], ('valid', b))
        self.assertEqual(status['dup.png'][0], 'duplicate')
        self.assertEqual(status['near.png'], ('manual', c))                              # one character from a counted ID: a human decides
        self.assertEqual(status['stuck.png'][0], 'manual')
        self.assertEqual(collab.queue(0, 20)['total'], 2)
        with patch.object(collab, 'ocr_ids', return_value=(d, d)):                        # running it twice never counts anything twice
            again = collab.reprocess_review(apply=True)
        self.assertEqual((again['valid'], again['duplicate']), (1, 0))                    # the "stuck" one is now readable; "near" is not eligible any more


class ReprocessUnsure(Base):
    def test_unsure_readings_are_accepted_when_re_read(self):
        for i in range(2):
            self.send(certificate(1, extra=i + 1), f'p{i}', ids=(None, None))
        reads = iter([('2222222222222222', '2222222222222222'.replace('2', 'Z', 1)), ('3333333333333333', None)])
        with patch.object(collab, 'ocr_ids', side_effect=lambda im: next(reads)):
            result = collab.reprocess_review(apply=True)
        self.assertEqual((result['valid'], result['unchanged']), (2, 0))
        self.assertEqual(collab.queue(0, 10)['total'], 0)


class FlaggedReview(Base):
    def setUp(self):
        super().setUp()
        self.partner = collab.create_collab('Lingshot', [0])['id']
        collab.add_reference('Lingshot', certificate(1, first_seed=20), self.partner, 0)

    def test_rejected_proofs_can_be_reviewed(self):
        self.send(certificate(2, extra=1), 'other-group')                                      # last image is not ENHYPEN
        self.send(certificate(1, first_seed=77, extra=2), 'wrong-partner', fandom='Lingshot')  # not Lingshot
        self.send(certificate(1, extra=3), 'unreadable', ids=(None, None))
        q = {k: collab.queue(0, 10, k) for k in ('manual', 'groups', 'partner')}
        self.assertEqual(q['manual']['counts'], {'manual': 1, 'groups': 1, 'partner': 1})
        self.assertEqual([i['file_name'] for i in q['groups']['items']], ['other-group.png'])
        self.assertEqual([(i['file_name'], i['status']) for i in q['partner']['items']], [('wrong-partner.png', 'not_partner')])
        with self.assertRaises(ValueError):
            collab.queue(0, 10, 'nonsense')
        # confirming one takes it out of its list and leaves its status alone
        collab.keep(q['groups']['items'][0]['id'], 'admin')
        self.assertEqual(collab.queue(0, 10, 'groups')['total'], 0)
        with self.assertRaises(ValueError):
            collab.keep(q['groups']['items'][0]['id'], 'admin')
        # a false rejection can be accepted with the ID
        proof = q['partner']['items'][0]['id']
        self.assertEqual(collab.approve(proof, 'ZZZZZZZZZZZZZZZZ', False, 'admin'), {'ok': True})
        rows = {r['fandom']: r for r in collab.summary()['submissions']}
        self.assertEqual((rows['Lingshot']['valid'], rows['Lingshot']['not_partner']), (1, 0))
        with self.assertRaises(ValueError):
            collab.approve(proof, 'YYYYYYYYYYYYYYYY', False, 'admin')                           # already reviewed

    def test_id_is_read_from_the_stored_preview(self):
        self.send(certificate(2, extra=1), 'other-group')
        proof = collab.queue(0, 10, 'groups')['items'][0]['id']
        with patch.object(collab, 'ocr_ids', return_value=('QQQQQQQQQQQQQQQQ',) * 2):
            self.assertEqual(collab.read_proof_id(proof), {'cert_id': 'QQQQQQQQQQQQQQQQ', 'confident': True})
        with patch.object(collab, 'ocr_ids', return_value=('QQQQQQQQQQQQQQQQ', 'QQQQQQQQQQQQQQQR')):
            self.assertEqual(collab.read_proof_id(proof), {'cert_id': 'QQQQQQQQQQQQQQQQ', 'confident': False})

    def test_reprocessing_runs_in_the_background(self):
        import time
        self.send(certificate(1, extra=1), 'a', ids=(None, None))
        self.send(certificate(1, extra=2), 'b', ids=(None, None))
        self.assertEqual(collab.queue(0, 10)['retry_pending'], 2)
        reads = iter([('AAAAAAAAAAAAAAAA',) * 2, (None, None)])
        with patch.object(collab, 'ocr_ids', side_effect=lambda im: next(reads)):
            collab.reprocess_start()
            for _ in range(100):
                if not collab.reprocess_status()['running']:
                    break
                time.sleep(0.05)
        state = collab.reprocess_status()
        self.assertFalse(state['running'])
        self.assertEqual((state['done'], state['total'], state['error']), (2, 2, None))
        self.assertEqual((state['result']['valid'], state['result']['unchanged']), (1, 1))
        self.assertEqual(collab.queue(0, 10)['retry_pending'], 1)


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

    def test_reads_the_whole_no_line(self):
        for width in (930, 640):
            im = Image.open(io.BytesIO(certificate(1, text='No. 61105JDXSVKA6VXC')))
            im = im.resize((width, round(width * 1410 / 930)), Image.LANCZOS)
            out = io.BytesIO()
            im.save(out, 'PNG')
            data = out.getvalue()
            result = collab.process('Fandom A', f'n{width}.png', f'n{width}', data, 'admin')
            self.assertEqual((result['status'], result['cert_id']), ('valid', '61105JDXSVKA6VXC'), width)
            collab.reset_proofs()

    def test_reads_the_id_line_of_a_screenshot(self):
        result = collab.process('Fandom A', 'x.png', 'x', screenshot(certificate(1, text='61101HZSLUIHCBOR')), 'admin')
        self.assertEqual((result['status'], result['cert_id']), ('valid', '61101HZSLUIHCBOR'))


if __name__ == '__main__':
    unittest.main()
