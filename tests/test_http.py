import base64
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
import app
import storage


class HTTP(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_db = storage.DB
        self.old_password = app.PASSWORD
        storage.DB = self.temp.name + '/test.sqlite3'
        app.PASSWORD = 'test-password-only'
        storage.init()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        storage.DB = self.old_db
        app.PASSWORD = self.old_password
        self.temp.cleanup()

    def request(self, path, data=None, auth=True, origin=None):
        headers = {}
        if auth:
            headers['Authorization'] = 'Basic ' + base64.b64encode(f'{app.USERNAME}:{app.PASSWORD}'.encode()).decode()
        if data is not None:
            headers['Content-Type'] = 'application/json'
        if origin:
            headers['Origin'] = origin
        req = urllib.request.Request(self.base + path, data=None if data is None else json.dumps(data).encode(), headers=headers)
        try:
            response = urllib.request.urlopen(req)
        except urllib.error.HTTPError as e:
            response = e
        with response:
            return response.status, response.read()

    def test_auth_and_origin(self):
        self.assertEqual(self.request('/api/posts', auth=False)[0], 401)
        self.assertEqual(self.request('/api/posts', {'url':'https://youtu.be/abcdefghijk'}, origin='https://evil.test')[0], 403)
        self.assertEqual(self.request('/')[0], 200)
        self.assertEqual(self.request('/app.js')[0], 200)

    def test_lifecycle_export_duplicate_delete(self):
        data = {'url': 'https://youtu.be/abcdefghijk', 'label':'Creator', 'team':'Team'}
        status, raw = self.request('/api/posts', data)
        self.assertEqual(status, 201)
        pid = json.loads(raw)['id']
        self.assertEqual(self.request('/api/posts', data)[0], 409)
        post = storage.claim()
        storage.finish(post, data={'title':'Test', 'views':10, 'likes':0, 'comments':None, 'source':'test'})
        history = json.loads(self.request(f'/api/posts/{pid}/history')[1])
        self.assertEqual(history[0]['likes'], 0)
        self.assertIsNone(history[0]['comments'])
        self.assertIn(b',10,0,,test', self.request(f'/api/posts/{pid}/export')[1])
        self.assertEqual(self.request(f'/api/posts/{pid}/refresh', {})[0], 429)
        self.assertEqual(self.request(f'/api/posts/{pid}/pause', {})[0], 200)
        self.assertTrue(storage.rows()[0]['paused'])
        self.assertEqual(self.request(f'/api/posts/{pid}/delete', {})[0], 200)
        self.assertEqual(self.request(f'/api/posts/{pid}/history')[0], 404)
        self.assertEqual(storage.rows(), [])

    def test_public_race_and_private_administration(self):
        self.assertEqual(self.request('/race', auth=False)[0], 200)
        self.assertEqual(self.request('/race.js', auth=False)[0], 200)
        self.assertEqual(self.request('/race-admin', auth=False)[0], 401)
        self.assertEqual(self.request('/api/race/admin', auth=False)[0], 401)
        self.assertEqual(self.request('/api/race/team', {'name':'Team','representative':'Person'}, auth=False)[0], 401)
        self.assertEqual(self.request('/api/race/team', {'name':'Team','representative':'Person'}, origin='https://evil.test')[0], 403)
        self.assertEqual(self.request('/api/race/team', {'name':'Team','representative':'Person'})[0], 200)
        public = json.loads(self.request('/api/race', auth=False)[1])
        self.assertNotIn('audit', public)
        self.assertEqual(public['teams'][0]['representative'], 'Person')

    def test_two_pages_and_legacy_redirects(self):
        import http.client
        public = self.request('/', auth=False)
        self.assertEqual(public[0], 200)
        self.assertNotIn(b'data-action="manual"', public[1])
        self.assertEqual(self.request('/admin', auth=False)[0], 401)
        status, body = self.request('/admin')
        self.assertEqual(status, 200)
        self.assertIn(b'id="monitoring-panel"', body)
        self.assertIn(b'id="race-panel"', body)
        self.assertIn(b'data-action="manual"', body)
        self.assertEqual(self.request('/admin.js', auth=False)[0], 401)
        for path, target in [('/race', '/'), ('/race-admin', '/admin#race')]:
            connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
            connection.request('GET', path)
            response = connection.getresponse()
            self.assertEqual(response.status, 302)
            self.assertEqual(response.getheader('Location'), target)
            response.read()
            connection.close()
