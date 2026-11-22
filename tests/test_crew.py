import base64
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import app
import crew
import storage

CSV = '''username,team,level,role,donor
jake9226,McJakey,Grand Prix Legend,Team Captain,yes
el,Hoonrari,E1 Immortal,
el,Independent Crew,E1 Elite,
Lily,Meowcedes,Hyperdrive Elite,
lily,Meowcedes,All-Star,
racerriki,Rikston Drift,All-Star,
racerriki,Rikston Drift,Hall of Fame,
@elle,Alpinoo,E1 Immortal,
rio,EMGP Admin,,Circuit Operations,
creo,McJakey,,Social Media Creator,
duo,McJakey,,Co-Team Captain; Social Media Creator,
giver,Alpinoo,,,yes
nobody,Alpinoo,,,
Rio,McJakey,All-Star,
ghost,Nowhere,All-Star,
'''
EXPORT = '''"E1 username","Social link","Crew Licence level","Team"
"Jaybird","https://x.com/jay ; https://x.com/Jaybird_X?s=21 ; https://x.com/ENMamaGrandPrix","E1 Titan","Team JAY"
"nini","","Hall of Fame","Team NI-KI"
'''


class Crew(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old = storage.DB, app.PASSWORD, os.environ.pop('CREW_CSV', None)
        storage.DB = self.temp.name + '/test.sqlite3'
        app.PASSWORD = 'test-password-only'
        storage.init()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        storage.DB, app.PASSWORD, csv_path = self.old
        if csv_path:
            os.environ['CREW_CSV'] = csv_path
        self.temp.cleanup()

    def call(self, path, body=None, auth=True):
        headers = {'Content-Type': 'text/csv'} if body is not None else {}
        if auth:
            headers['Authorization'] = 'Basic ' + base64.b64encode(f'{app.USERNAME}:{app.PASSWORD}'.encode()).decode()
        req = urllib.request.Request(self.base + path, data=None if body is None else body.encode(), headers=headers)
        try:
            response = urllib.request.urlopen(req)
        except urllib.error.HTTPError as e:
            response = e
        with response:
            return response.status, json.loads(response.read() or b'null')

    def test_empty_upload_search_and_lookup(self):
        self.assertEqual(self.call('/api/crew', auth=False), (200, {'loaded': False, 'results': []}))
        self.assertEqual(self.call('/api/crew', CSV, auth=False)[0], 401)
        status, result = self.call('/api/crew', CSV)
        self.assertEqual(status, 200)
        self.assertEqual((result['count'], result['roles'], result['skipped_lines']), (12, 4, [14, 16]))
        self.assertTrue(self.call('/api/crew', auth=False)[1]['loaded'])

        found = self.call('/api/crew?q=%40JAKE', auth=False)[1]['results']
        self.assertEqual([(e['username'], e['team'], e['level'], e['role']) for e in found], [('jake9226', 'mcjakey', 12, 'Team Captain')])
        self.assertNotIn('note', found[0])
        self.assertNotIn('donor', found[0])
        self.assertTrue(self.call(f'/api/crew?id={found[0]["id"]}', auth=False)[1]['donor'])
        self.assertFalse(self.call(f'/api/crew?id={self.call("/api/crew?q=racerriki", auth=False)[1]["results"][0]["id"]}', auth=False)[1]['donor'])
        # Same name in two teams: the team tells them apart; same team too: the level as well.
        el = self.call('/api/crew?q=el', auth=False)[1]['results']
        self.assertEqual([e['username'] for e in el][:2], ['el', 'el'])  # exact matches first
        self.assertEqual({e.get('note') for e in el if e['username'] == 'el'}, {'Hoonrari', 'Independent Crew'})
        lily = self.call('/api/crew?q=lily', auth=False)[1]['results']
        self.assertEqual(sorted(e['note'] for e in lily), ['Meowcedes · All-Star', 'Meowcedes · Hyperdrive Elite'])
        self.assertEqual(len({e['id'] for e in lily}), 2)
        # The same crew member twice: one entry with the higher licence.
        riki = self.call('/api/crew?q=racerriki', auth=False)[1]['results']
        self.assertEqual([e['level'] for e in riki], [11])
        self.assertEqual(self.call(f'/api/crew?id={riki[0]["id"]}', auth=False)[1]['username'], 'racerriki')
        self.assertEqual(self.call('/api/crew?id=nope', auth=False)[0], 404)
        # Staff: no team, no level; the same name as a crew member shows "EMGP Staff".
        rio = {e['team']: e for e in self.call('/api/crew?q=rio', auth=False)[1]['results']}
        self.assertEqual((rio['staff']['level'], rio['staff']['role'], rio['staff']['note']), (0, 'Circuit Operations', 'EMGP Admin'))
        self.assertEqual(rio['mcjakey']['note'], 'McJakey')
        # Creators and donors who did not race: in the list without a level.
        creo = self.call('/api/crew?q=creo', auth=False)[1]['results'][0]
        self.assertEqual((creo['team'], creo['level'], creo['role']), ('mcjakey', 0, 'Social Media Creator'))
        self.assertEqual(self.call('/api/crew?q=giver', auth=False)[1]['results'][0]['level'], 0)
        self.assertEqual(self.call('/api/crew?q=duo', auth=False)[1]['results'][0]['role'], 'Co-Team Captain; Social Media Creator')

    def test_export_format_and_bad_files(self):
        self.assertEqual(self.call('/api/crew', 'a,b\n1,2\n')[0], 400)
        self.assertEqual(self.call('/api/crew', EXPORT)[1]['count'], 2)
        found = self.call('/api/crew?q=jaybird', auth=False)[1]['results'][0]
        self.assertEqual(found['team'], 'jaybull')
        self.assertNotIn('x', found)  # handles only with the single entry
        # X handles from the links: no typo-short handle, no project account.
        self.assertEqual(self.call(f'/api/crew?id={found["id"]}', auth=False)[1]['x'], ['Jaybird_X'])
        # The search also finds the X handle, and says which one matched.
        via = self.call('/api/crew?q=%40jaybird_x', auth=False)[1]['results']
        self.assertEqual([(e['username'], e.get('via')) for e in via], [('Jaybird', 'Jaybird_X')])
        self.assertEqual(self.call('/api/crew', 'username,team,level\nx,Nowhere,All-Star\n')[0], 400)
        self.assertEqual(self.call('/api/crew?q=nini', auth=False)[1]['results'][0]['team'], 'rikston')  # old list kept
        # Italian spreadsheets: semicolons.
        status, result = self.call('/api/crew', 'username;team;level;role;x;donor\nzed;McJakey;All-Star;;;sì\n')
        self.assertEqual((status, result['count'], result['donors'], result['columns'][-1]), (200, 1, 1, 'donor'))

    def test_certificate_pages(self):
        for path in ('/crew-license', '/crew-license/embed', '/license.js', '/license.css'):
            self.assertEqual(urllib.request.urlopen(self.base + path).status, 200)


if __name__ == '__main__':
    unittest.main()
