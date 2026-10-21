import os
import tempfile
import time
import unittest
from unittest.mock import patch
import collectors
import storage


class Collectors(unittest.TestCase):
    def test_canonical_youtube(self):
        a = collectors.normalize_url('https://youtu.be/abcdefghijk?si=tracking')
        b = collectors.normalize_url('https://www.youtube.com/shorts/abcdefghijk')
        self.assertEqual(a, b)

    def test_tiktok_and_instagram(self):
        self.assertEqual(collectors.normalize_url('https://www.tiktok.com/@someone/video/1234567890123456789?x=1').remote_id, '1234567890123456789')
        self.assertEqual(collectors.normalize_url('https://www.instagram.com/reel/Ab_cd-12/?igsh=abc').url, 'https://www.instagram.com/reel/Ab_cd-12/')

    def test_unsafe_or_unsupported_links(self):
        for url in ['http://www.youtube.com/watch?v=abcdefghijk', 'https://youtube.com.evil.test/watch?v=abcdefghijk', 'https://user@youtube.com/watch?v=abcdefghijk', 'https://127.0.0.1/', 'https://www.youtube.com:8080/watch?v=abcdefghijk', 'https://vm.tiktok.com/abc/', 'https://www.instagram.com/someone/', 'https://www.youtube.com/playlist?list=123']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                collectors.normalize_url(url)

    def test_missing_counts_are_not_zero(self):
        m = collectors.metrics({'like_count': 0, 'view_count': '123'}, 'test')
        self.assertEqual(m['likes'], 0)
        self.assertEqual(m['views'], 123)
        self.assertIsNone(m['comments'])
        with self.assertRaises(collectors.CollectionError):
            collectors.metrics({}, 'test')

    def test_no_carousel_summing(self):
        with self.assertRaises(collectors.CollectionError):
            collectors.metrics({'entries': [{'like_count': 20}, {'like_count': 20}]}, 'test')

    def test_timeout_becomes_collector_error(self):
        import subprocess
        with patch.dict(os.environ, {'YOUTUBE_API_KEY': ''}), patch('collectors.subprocess.run', side_effect=subprocess.TimeoutExpired('test', 90)):
            with self.assertRaises(collectors.CollectionError):
                collectors.collect(collectors.normalize_url('https://youtu.be/abcdefghijk'))


class Storage(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old = storage.DB
        storage.DB = self.temp.name + '/test.sqlite3'
        storage.init()
        with storage.connection() as c:
            c.execute("INSERT INTO posts(platform,remote_id,url,created_at) VALUES('youtube','abcdefghijk','https://www.youtube.com/watch?v=abcdefghijk',?)", (time.time(),))

    def tearDown(self):
        storage.DB = self.old
        self.temp.cleanup()

    def test_failure_preserves_last_snapshot_and_backoff(self):
        post = storage.claim()
        storage.finish(post, data={'title':'Test', 'likes':0, 'views':12, 'comments':None, 'source':'test'})
        row = storage.rows()[0]
        self.assertEqual(row['status'], 'partial')
        with storage.connection() as c:
            c.execute('UPDATE posts SET next_check=0')
        post = storage.claim()
        storage.finish(post, error='Blocked')
        row = storage.rows()[0]
        self.assertEqual(row['latest']['views'], 12)
        self.assertEqual(row['status'], 'error')
        self.assertGreater(row['next_check'], time.time())
        self.assertIsNone(storage.claim())

    def test_no_overlapping_claim_and_pause(self):
        self.assertIsNotNone(storage.claim())
        self.assertIsNone(storage.claim())
        with storage.connection() as c:
            c.execute("UPDATE posts SET paused=1,status='queued'")
        self.assertIsNone(storage.claim())

    def test_delete_during_collection(self):
        post = storage.claim()
        with storage.connection() as c:
            c.execute('DELETE FROM posts')
        storage.finish(post, data={'title':'Test','views':1,'likes':2,'comments':3,'source':'test'})
        self.assertEqual(storage.rows(), [])


if __name__ == '__main__':
    unittest.main()
