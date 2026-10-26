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
        race.mutate('team', {'name': 'Test team', 'representative': 'Test creator'}, 'admin')
        race.mutate('event', self.event, 'admin')
        race.mutate('weights', {'likes': 1, 'comments': 1, 'views': 0}, 'admin')
        entry = {'team_id': 1, 'event_id': 1, 'url': 'https://www.instagram.com/p/TEST/', 'published_at': '2026-10-26T18:00'}
        race.mutate('entry', entry, 'admin')
        post = storage.claim()
        self.assertIsNotNone(post)
        storage.finish(post, data={'likes': 10, 'comments': 2, 'views': None, 'title': 'Test', 'source': 'test collector'})
        board = race.read()
        self.assertTrue(board['simulation'])
        self.assertEqual(board['teams'][0]['score'], 12)
        self.assertEqual(storage.rows()[0]['next_check'], race.timestamp('2026-10-26T22:00'))
        with patch.dict(os.environ, {'RACE_SIMULATION': 'false'}):
            board = race.read()
            self.assertFalse(board['simulation'])
            self.assertEqual(board['entries'], [])
            self.assertEqual(board['events'], [])
            self.assertEqual(board['teams'], [])
            self.assertEqual(len(race.read(admin=True)['available_teams']), 1)
            self.assertEqual(len(storage.rows()), 1)
            with self.assertRaisesRegex(ValueError, 'simulation event'):
                race.mutate('entry', entry, 'admin')
        with patch('time.time', return_value=race.START):
            self.assertEqual(race.read()['entries'], [])
