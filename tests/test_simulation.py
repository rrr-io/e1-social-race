import os
import tempfile
import unittest
from unittest.mock import patch

import race
import storage


class Simulation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = storage.DB
        storage.DB = self.tmp.name + '/test.sqlite3'
        storage.init()
        self.clock = patch('time.time', return_value=race.timestamp('2026-10-26T19:00'))
        self.clock.start()
        self.env = patch.dict(os.environ, {'RACE_SIMULATION': 'true'})
        self.env.start()
        self.event = {'name': 'Test', 'starts': '2026-10-25T00:00', 'ends': '2026-10-27T23:59'}

    def tearDown(self):
        self.env.stop(); self.clock.stop()
        storage.DB = self.db
        self.tmp.cleanup()

    def test_opt_in_and_automatic_expiry(self):
        with patch.dict(os.environ, {'RACE_SIMULATION': 'false'}):
            with self.assertRaises(ValueError):
                race.mutate('event', self.event, 'admin')
        with patch('time.time', return_value=race.START):
            self.assertFalse(race.simulation_enabled())
            with self.assertRaises(ValueError):
                race.mutate('event', self.event, 'admin')
        with self.assertRaises(ValueError):
            race.mutate('event', {**self.event, 'ends': '2026-10-29T00:00'}, 'admin')

    def test_tracking_now_and_exclusion_when_disabled(self):
        race.mutate('team', {'name': 'Test team', 'instagram': 'Test creator', 'tiktok': 'Test TT'}, 'admin')
        race.mutate('event', self.event, 'admin')
        entry = {'team_id': 1, 'event_id': 1, 'url': 'https://www.instagram.com/p/TEST/', 'published_at': '2026-10-26T18:00'}
        race.mutate('entry', entry, 'admin')
        post = storage.claim()
        self.assertIsNotNone(post)
        storage.finish(post, data={'likes': 10, 'comments': 2, 'views': None, 'title': 'Test', 'source': 'test collector'})
        board = race.read()
        self.assertTrue(board['simulation'])
        self.assertEqual(board['boards']['instagram'][0]['score'], 10)
        self.assertEqual(storage.rows()[0]['next_check'], race.timestamp('2026-10-26T20:00'))
        with patch.dict(os.environ, {'RACE_SIMULATION': 'false'}):
            board = race.read()
            self.assertFalse(board['simulation'])
            self.assertEqual(board['entries'], [])
            self.assertEqual(board['events'], [])
            self.assertEqual(board['teams'], [])
            self.assertEqual(board['boards'], {'instagram': [], 'tiktok': []})
            self.assertEqual(len(race.read(admin=True)['available_teams']), 1)
            self.assertEqual(len(storage.rows()), 1)
            with self.assertRaisesRegex(ValueError, 'simulation event'):
                race.mutate('entry', entry, 'admin')
        with patch('time.time', return_value=race.START):
            self.assertEqual(race.read()['entries'], [])

    def test_simulation_event_widening_and_no_conversion(self):
        race.mutate('team', {'name': 'Jay', 'instagram': 'Min', 'tiktok': 'Min TT'}, 'admin')
        race.mutate('event', {'name': 'Short test', 'starts': '2026-10-26T18:50', 'ends': '2026-10-26T18:51'}, 'admin')
        race.mutate('entry', {'team_id': 1, 'event_id': 1, 'url': 'https://www.instagram.com/p/TEST/', 'published_at': '2026-10-26T18:51'}, 'admin')
        race.mutate('event-update', {'event_id': 1, 'name': 'Longer test', 'starts': '2026-10-25T00:00', 'ends': '2026-10-27T23:59'}, 'admin')
        self.assertEqual(race.read()['events'][0]['ends'], race.timestamp('2026-10-27T23:59'))
        with self.assertRaisesRegex(ValueError, 'cannot switch'):
            race.mutate('event-update', {'event_id': 1, 'name': 'Official', 'starts': '2026-10-28T18:00', 'ends': '2026-10-29T23:59'}, 'admin')
        with patch.dict(os.environ, {'RACE_SIMULATION': 'false'}):
            self.assertEqual(len(race.read(admin=True)['available_events']), 1)
            self.assertEqual(race.read()['events'], [])
