import json
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import race
import storage


class Race(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old = storage.DB
        storage.DB = self.temp.name + '/race.sqlite3'
        storage.init()
        self.clock = patch('time.time', return_value=race.START + 3600)
        self.clock.start()
        race.mutate('team', {'name': 'Alpinoo', 'representative': 'Creator X', 'base_points': 300000}, 'admin')
        race.mutate('event', {'name': 'Opening', 'starts': '2026-10-28T18:00', 'ends': '2026-10-28T23:00'}, 'admin')
        self.entry = {'team_id': 1, 'event_id': 1, 'url': 'https://www.instagram.com/p/ABCDE/', 'published_at': '2026-10-28T18:10'}
        race.mutate('entry', self.entry, 'admin')

    def tearDown(self):
        self.clock.stop()
        storage.DB = self.old
        self.temp.cleanup()

    def weights(self):
        race.mutate('weights', {'likes': 1, 'comments': 2, 'views': 0}, 'admin')

    def manual(self, likes=10, comments=2, **extra):
        race.mutate('manual', {'entry_id': 1, 'observed_at': '2026-10-28T18:30', 'likes': likes, 'comments': comments, 'evidence': 'Private evidence reference', **extra}, 'admin')

    def test_slot_and_identity_constraints(self):
        with self.assertRaises(sqlite3.IntegrityError):
            race.mutate('entry', {**self.entry, 'url': 'https://www.instagram.com/p/XYZ/'}, 'admin')
        with self.assertRaises(sqlite3.IntegrityError):
            race.mutate('team', {'name': 'Other', 'representative': 'creator x'}, 'admin')
        with storage.connection() as c:
            self.assertEqual(c.execute('SELECT count(*) FROM posts').fetchone()[0], 1)
        race.mutate('entry', {**self.entry, 'url': 'https://www.tiktok.com/@creator/video/1234567890123456789'}, 'admin')
        self.assertEqual(len(race.read()['entries']), 2)

    def test_cumulative_missing_and_privacy(self):
        self.manual()
        self.assertIsNone(race.read()['teams'][0]['score'])
        self.weights()
        self.assertEqual(race.read()['teams'][0]['score'], 14)
        self.manual(likes=20, observed_at='2026-10-28T18:45')
        self.assertEqual(race.read()['teams'][0]['score'], 24)
        self.assertNotIn('Private evidence', json.dumps(race.read()))
        self.assertIn('Private evidence', json.dumps(race.read(admin=True)))
        self.manual(comments=None, observed_at='2026-10-28T18:50')
        self.assertIsNone(race.read()['teams'][0]['score'])
        with self.assertRaises(ValueError):
            self.weights()

    def test_schedule_and_failed_collection_preserve_counts(self):
        self.assertEqual(race.next_check(race.START), race.timestamp('2026-10-28T22:00'))
        self.assertEqual(race.next_check(race.timestamp('2026-11-08T22:01')), race.END)
        self.assertGreater(race.next_check(race.END), race.END)
        self.weights(); self.manual()
        with storage.connection() as c:
            post = dict(c.execute('SELECT * FROM posts').fetchone())
        storage.finish(post, error='Challenge')
        self.assertEqual(race.read()['teams'][0]['score'], 14)
        self.assertEqual(storage.rows()[0]['next_check'], race.timestamp('2026-10-28T22:00'))

    def test_final_cutoff_and_freeze(self):
        self.weights(); self.manual()
        with self.assertRaises(ValueError):
            race.mutate('finalize', {}, 'admin')
        with patch('time.time', return_value=race.END + 600):
            with storage.connection() as c:
                c.execute('INSERT INTO snapshots(post_id,collected_at,likes,comments,views,source) VALUES(1,?,999,999,999,?)', (race.END + 1, 'test'))
            self.assertEqual(race.read()['teams'][0]['score'], 14)
            with self.assertRaises(ValueError):
                race.mutate('finalize', {}, 'admin')
            self.manual(likes=100, comments=5, observed_at='2026-11-08T23:59', final=True)
            race.mutate('finalize', {}, 'admin')
            final = race.read()
            self.assertEqual(final['state'], 'Final')
            self.assertEqual(final['teams'][0]['score'], 110)
            self.assertEqual(final['teams'][0]['bonus_points'], 6000)
            with self.assertRaises(ValueError):
                self.manual()
            storage.init()
            self.assertEqual(race.read(), final)

    def test_dates_and_unsupported_platform(self):
        for change in ({'published_at': '2026-10-29T18:00'}, {'url': 'https://youtu.be/abcdefghijk'}):
            with self.assertRaises(ValueError):
                race.mutate('entry', {**self.entry, **change}, 'admin')
        with self.assertRaises(ValueError):
            self.manual(observed_at='2026-10-28T17:00')
        with self.assertRaises(ValueError):
            self.manual(likes=-1)

    def test_podium_tie_blocks_freezing(self):
        self.weights()
        race.mutate('team', {'name': 'Second', 'representative': 'Creator Y'}, 'admin')
        race.mutate('entry', {**self.entry, 'team_id': 2, 'url': 'https://www.instagram.com/p/SECOND/'}, 'admin')
        with patch('time.time', return_value=race.END + 600):
            self.manual(final=True, observed_at='2026-11-08T23:59')
            self.manual(entry_id=2, final=True, observed_at='2026-11-08T23:59')
            self.assertEqual([t['rank'] for t in race.read()['teams']], [1, 1])
            with self.assertRaisesRegex(ValueError, 'tie'):
                race.mutate('finalize', {}, 'admin')

    def test_team_score_sums_posts_not_snapshots(self):
        self.weights(); self.manual()
        race.mutate('entry', {**self.entry, 'url': 'https://www.tiktok.com/@creator/video/1234567890123456789'}, 'admin')
        self.manual(entry_id=2, likes=20)
        self.assertEqual(race.read()['teams'][0]['score'], 38)
        self.manual(entry_id=2, likes=30, observed_at='2026-10-28T18:40')
        self.assertEqual(race.read()['teams'][0]['score'], 48)
