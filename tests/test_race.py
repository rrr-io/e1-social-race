import json
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import race
import storage

IG = 'instagram'
TT = 'tiktok'


def names(team):
    return {p: [c['name'] for c in team['creators'][p]] for p in (IG, TT)}


class Race(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old = storage.DB
        storage.DB = self.temp.name + '/race.sqlite3'
        storage.init()
        self.clock = patch('time.time', return_value=race.START + 3600)
        self.clock.start()
        race.mutate('team', {'name': 'Alpinoo', 'instagram': 'Creator X', 'tiktok': 'Creator X TT', 'base_points': 300000}, 'admin')
        race.mutate('event', {'name': 'Opening', 'starts': '2026-10-28T18:00', 'ends': '2026-10-28T23:00'}, 'admin')
        self.entry = {'team_id': 1, 'event_id': 1, 'url': 'https://www.instagram.com/p/ABCDE/', 'published_at': '2026-10-28T18:10'}
        race.mutate('entry', self.entry, 'admin')

    def tearDown(self):
        self.clock.stop()
        storage.DB = self.old
        self.temp.cleanup()

    def manual(self, likes=10, comments=2, **extra):
        race.mutate('manual', {'entry_id': 1, 'observed_at': '2026-10-28T18:30', 'likes': likes, 'comments': comments, 'evidence': 'Private evidence reference', **extra}, 'admin')

    def row(self, platform=IG, data=None, team_id=1):
        data = data or race.read()
        return next(r for r in data['boards'][platform] if r['team_id'] == team_id)

    def add_tiktok(self, team_id=1, event_id=1, video='1234567890123456789'):
        race.mutate('entry', {**self.entry, 'team_id': team_id, 'event_id': event_id, 'url': f'https://www.tiktok.com/@creator/video/{video}'}, 'admin')

    def test_slot_and_identity_constraints(self):
        with self.assertRaisesRegex(ValueError, 'already has a post'):
            race.mutate('entry', {**self.entry, 'url': 'https://www.instagram.com/p/XYZ/'}, 'admin')
        with self.assertRaisesRegex(ValueError, 'already an Instagram creator of Alpinoo'):
            race.mutate('team', {'name': 'Other', 'instagram': 'creator x', 'tiktok': 'Someone'}, 'admin')
        with self.assertRaisesRegex(ValueError, 'already set up'):
            race.mutate('team', {'name': 'ALPINOO', 'instagram': 'New', 'tiktok': 'New TT'}, 'admin')
        with self.assertRaisesRegex(ValueError, 'Add at least one TikTok creator'):
            race.mutate('team', {'name': 'Other', 'instagram': 'Someone', 'tiktok': ' '}, 'admin')
        # The same person may be a team's creator on both platforms.
        race.mutate('team', {'name': 'Other', 'instagram': 'Same Person', 'tiktok': 'Same Person'}, 'admin')
        with storage.connection() as c:
            self.assertEqual(c.execute('SELECT count(*) FROM posts').fetchone()[0], 1)
        self.add_tiktok()
        self.assertEqual(len(race.read()['entries']), 2)

    def test_instagram_scores_likes_tiktok_scores_views(self):
        self.manual(likes=10, comments=99)
        self.add_tiktok()
        race.mutate('manual', {'entry_id': 2, 'observed_at': '2026-10-28T18:30', 'likes': 7, 'views': 500, 'evidence': 'ref'}, 'admin')
        data = race.read()
        self.assertEqual(data['metrics'], {IG: 'likes', TT: 'views'})
        self.assertEqual((self.row(IG, data)['score'], self.row(IG, data)['creator']), (10, 'Creator X'))
        self.assertEqual((self.row(TT, data)['score'], self.row(TT, data)['creator']), (500, 'Creator X TT'))
        self.assertEqual({e['platform']: e['score'] for e in data['entries']}, {IG: 10, TT: 500})

    def test_cumulative_missing_and_privacy(self):
        self.manual()
        self.assertEqual(self.row()['score'], 10)
        self.manual(likes=20, observed_at='2026-10-28T18:45')
        self.assertEqual(self.row()['score'], 20)
        self.assertNotIn('Private evidence', json.dumps(race.read()))
        self.assertIn('Private evidence', json.dumps(race.read(admin=True)))
        # Comments do not count on Instagram, so a missing comment count changes nothing...
        self.manual(likes=25, comments=None, observed_at='2026-10-28T18:50')
        self.assertEqual(self.row()['score'], 25)
        # ...but a missing like count leaves the creator unscored.
        self.manual(likes=None, comments=3, observed_at='2026-10-28T18:55')
        self.assertIsNone(self.row()['score'])

    def test_creator_without_posts_is_listed_but_unranked(self):
        self.manual()
        tiktok = self.row(TT)
        self.assertEqual((tiktok['posts'], tiktok['score'], tiktok['rank']), (0, None, None))
        self.assertEqual(self.row(IG)['rank'], 1)

    def test_schedule_and_failed_collection_preserve_counts(self):
        self.assertEqual(race.next_check(race.START), race.timestamp('2026-10-28T19:00'))
        self.assertEqual(race.next_check(race.timestamp('2026-10-30T13:20')), race.timestamp('2026-10-30T14:00'))
        self.assertEqual(race.next_check(race.timestamp('2026-11-08T23:30')), race.END)
        self.assertGreater(race.next_check(race.END), race.END)
        self.manual()
        with storage.connection() as c:
            post = dict(c.execute('SELECT * FROM posts').fetchone())
        storage.finish(post, error='Challenge')
        self.assertEqual(self.row()['score'], 10)
        self.assertEqual(storage.rows()[0]['next_check'], race.timestamp('2026-10-28T20:00'))

    def test_final_cutoff_and_freeze(self):
        self.manual()
        with self.assertRaisesRegex(ValueError, 'closes on 8 November'):
            race.mutate('finalize', {}, 'admin')
        with patch('time.time', return_value=race.END + 600):
            with storage.connection() as c:
                c.execute('INSERT INTO snapshots(post_id,collected_at,likes,comments,views,source) VALUES(1,?,999,999,999,?)', (race.END + 1, 'test'))
            # The event closed on 28 Oct at 23:00: its saved result is what counts.
            self.assertEqual(self.row()['score'], 10)
            race.mutate('finalize', {}, 'admin')
            final = race.read()
            self.assertEqual(final['state'], 'Final')
            self.assertEqual(final['current_scope'], 'total')
            self.assertEqual(self.row(IG, final)['score'], 10)
            self.assertEqual(self.row(IG, final)['bonus_points'], 6000)
            self.assertEqual(final['teams'][0]['bonus_points_total'], 6000)
            with self.assertRaises(ValueError):
                self.manual()
            storage.init()
            self.assertEqual(race.read(), final)

    def test_separate_podiums_add_up(self):
        race.mutate('team', {'name': 'Second', 'instagram': 'Creator Y', 'tiktok': 'Creator Y TT', 'base_points': 100000}, 'admin')
        race.mutate('entry', {**self.entry, 'team_id': 2, 'url': 'https://www.instagram.com/p/SECOND/'}, 'admin')
        self.add_tiktok(team_id=1, video='1111111111111111111')
        self.add_tiktok(team_id=2, video='2222222222222222222')
        observe = lambda entry, **counts: race.mutate('manual', {'entry_id': entry, 'observed_at': '2026-10-28T18:30', 'evidence': 'ref', **counts}, 'admin')
        observe(1, likes=50); observe(2, likes=80)      # Instagram: Second leads
        observe(3, views=9000); observe(4, views=1000)  # TikTok: Alpinoo leads
        data = race.read()
        self.assertEqual([r['team'] for r in data['boards'][IG]], ['Second', 'Alpinoo'])
        self.assertEqual([r['team'] for r in data['boards'][TT]], ['Alpinoo', 'Second'])
        self.assertEqual((self.row(IG, data, 2)['bonus_percent'], self.row(TT, data, 2)['bonus_percent']), (2, 1))
        totals = {t['name']: t['bonus_points_total'] for t in data['teams']}
        self.assertEqual(totals, {'Alpinoo': 300000 * 0.01 + 300000 * 0.02, 'Second': 100000 * 0.02 + 100000 * 0.01})

    def test_dates_and_unsupported_platform(self):
        for change in ({'published_at': '2026-10-29T18:00'}, {'url': 'https://youtu.be/abcdefghijk'}):
            with self.assertRaises(ValueError):
                race.mutate('entry', {**self.entry, **change}, 'admin')
        with self.assertRaises(ValueError):
            self.manual(observed_at='2026-10-28T17:00')
        with self.assertRaises(ValueError):
            self.manual(likes=-1)

    def test_podium_tie_blocks_freezing(self):
        race.mutate('team', {'name': 'Second', 'instagram': 'Creator Y', 'tiktok': 'Creator Y TT'}, 'admin')
        race.mutate('entry', {**self.entry, 'team_id': 2, 'url': 'https://www.instagram.com/p/SECOND/'}, 'admin')
        self.manual(); self.manual(entry_id=2)
        with patch('time.time', return_value=race.END + 600):
            self.assertEqual([r['rank'] for r in race.read()['boards'][IG]], [1, 1])
            with self.assertRaisesRegex(ValueError, 'tie'):
                race.mutate('finalize', {}, 'admin')

    def test_score_sums_posts_not_snapshots(self):
        self.manual()
        race.mutate('event', {'name': 'Second lap', 'starts': '2026-10-28T18:00', 'ends': '2026-10-28T23:00'}, 'admin')
        race.mutate('entry', {**self.entry, 'event_id': 2, 'url': 'https://www.instagram.com/p/LAP2/'}, 'admin')
        self.manual(entry_id=2, likes=20)
        self.assertEqual(self.row()['score'], 30)
        self.manual(entry_id=2, likes=30, observed_at='2026-10-28T18:40')
        self.assertEqual(self.row()['score'], 40)

    def test_post_needs_a_creator_on_its_platform(self):
        with storage.connection() as c:
            c.execute("DELETE FROM race_creators WHERE platform='tiktok'")
        with self.assertRaisesRegex(ValueError, 'no TikTok creator'):
            self.add_tiktok()

    def test_event_edit_preserves_assignments_and_audits(self):
        race.mutate('event-update', {'event_id': 1, 'name': 'Opening revised', 'starts': '2026-10-28T18:00', 'ends': '2026-10-29T23:00'}, 'editor')
        data = race.read(admin=True)
        self.assertEqual(data['available_events'][0]['name'], 'Opening revised')
        self.assertEqual(data['available_events'][0]['post_count'], 1)
        self.assertEqual(data['entries'][0]['event_id'], 1)
        audit = data['audit'][0]
        self.assertEqual(audit['actor'], 'editor')
        detail = json.loads(audit['details'])
        self.assertEqual(detail['before']['name'], 'Opening')
        self.assertEqual(detail['after']['name'], 'Opening revised')
        self.assertNotIn('available_events', race.read())

    def test_event_edit_cannot_exclude_posts(self):
        with self.assertRaisesRegex(ValueError, 'exclude 1'):
            race.mutate('event-update', {'event_id': 1, 'name': 'Invalid', 'starts': '2026-10-28T18:30', 'ends': '2026-10-28T23:00'}, 'admin')
        self.assertEqual(race.read()['events'][0]['name'], 'Opening')

    def test_event_edit_unknown_duplicate_and_frozen(self):
        edit = {'event_id': 999, 'name': 'Changed', 'starts': '2026-10-28T18:00', 'ends': '2026-10-28T23:00'}
        with self.assertRaisesRegex(ValueError, 'not found'):
            race.mutate('event-update', edit, 'admin')
        race.mutate('event', {'name': 'Second', 'starts': '2026-10-29T18:00', 'ends': '2026-10-29T23:00'}, 'admin')
        with self.assertRaisesRegex(ValueError, 'name already exists'):
            race.mutate('event-update', {**edit, 'event_id': 1, 'name': 'Second'}, 'admin')
        with storage.connection() as c:
            c.execute("UPDATE race_config SET frozen='{}'")
        with self.assertRaisesRegex(ValueError, 'frozen'):
            race.mutate('event-update', {**edit, 'event_id': 1}, 'admin')

    def test_register_existing_post_keeps_history(self):
        with storage.connection() as c:
            pid = c.execute("INSERT INTO posts(platform,remote_id,url,label,created_at) VALUES('tiktok','1234567890123456789','https://www.tiktok.com/@creator/video/1234567890123456789','Jay post',?)", (race.START,)).lastrowid
            c.execute("INSERT INTO snapshots(post_id,collected_at,likes,comments,views,source) VALUES(?,?,10,2,100,'test')", (pid, race.START + 1800))
        payload = {'post_id': pid, 'team_id': 1, 'event_id': 1, 'published_at': '2026-10-28T18:10'}
        race.mutate('register-post', payload, 'admin')
        with storage.connection() as c:
            self.assertEqual(c.execute('SELECT count(*) FROM posts').fetchone()[0], 2)
            self.assertEqual(c.execute('SELECT count(*) FROM snapshots WHERE post_id=?', (pid,)).fetchone()[0], 1)
        post = next(p for p in race.read(admin=True)['tracked_posts'] if p['id'] == pid)
        self.assertEqual((post['assigned_team'], post['assigned_creator'], post['assigned_event']), ('Alpinoo', 'Creator X TT', 'Opening'))
        self.assertEqual(self.row(TT)['score'], 100)
        with self.assertRaises(ValueError):
            race.mutate('register-post', payload, 'admin')
        with self.assertRaisesRegex(ValueError, 'Tracked post not found'):
            race.mutate('register-post', {**payload, 'post_id': 999}, 'admin')
        self.assertNotIn('tracked_posts', race.read())


class Schedule(unittest.TestCase):
    setUp = Race.setUp
    tearDown = Race.tearDown

    def test_old_daily_schedule_is_brought_forward_on_startup(self):
        with storage.connection() as c:
            c.execute('UPDATE posts SET next_check=?', (race.timestamp('2026-10-29T22:00'),))
        storage.init()
        self.assertEqual(storage.rows()[0]['next_check'], race.timestamp('2026-10-28T20:00'))

    def test_interval_is_configurable(self):
        with patch.object(race, 'CHECK_MINUTES', 30):
            self.assertEqual(race.next_check(race.timestamp('2026-10-30T13:10')), race.timestamp('2026-10-30T13:30'))
        with patch.object(race, 'CHECK_MINUTES', 360):
            self.assertEqual(race.next_check(race.timestamp('2026-10-30T13:10')), race.timestamp('2026-10-30T18:00'))


class Events(unittest.TestCase):
    """Each event has its own standings, saved when its window closes."""
    setUp = Race.setUp
    tearDown = Race.tearDown
    row = Race.row

    def scope(self, data, key):
        return next(s for s in data['scopes'] if s['key'] == key)

    def snap(self, post_id, at, likes):
        with storage.connection() as c:
            c.execute("INSERT INTO snapshots(post_id,collected_at,likes,comments,views,source) VALUES(?,?,?,0,0,'test')", (post_id, race.timestamp(at), likes))

    def test_event_result_saved_at_close_and_rankings_restart(self):
        race.mutate('event', {'name': 'Lap 2', 'starts': '2026-10-29T00:00', 'ends': '2026-10-30T23:59'}, 'admin')
        self.snap(1, '2026-10-28T22:00', 100)
        data = race.read()
        self.assertEqual(data['current_scope'], 'event-1')
        self.assertEqual(self.scope(data, 'event-1')['status'], 'live')
        # After the close, later engagement no longer counts and the result is saved.
        self.snap(1, '2026-10-29T10:00', 5000)
        with patch('time.time', return_value=race.timestamp('2026-10-29T12:00')):
            race.mutate('entry', {**self.entry, 'event_id': 2, 'url': 'https://www.instagram.com/p/LAP2/', 'published_at': '2026-10-29T09:00'}, 'admin')
            self.snap(2, '2026-10-29T11:00', 40)
            data = race.read()
            lap1, lap2 = self.scope(data, 'event-1'), self.scope(data, 'event-2')
            self.assertEqual((lap1['status'], lap2['status']), ('closed', 'live'))
            self.assertIsNotNone(lap1['saved_at'])
            self.assertEqual(lap1['boards'][IG][0]['score'], 100)
            self.assertEqual(lap2['boards'][IG][0]['score'], 40)       # restarts from this event's posts
            self.assertEqual(data['current_scope'], 'event-2')
            self.assertEqual(self.row(IG, data)['score'], 140)          # Grand Prix total = sum of events
            self.assertIsNone(lap1['boards'][IG][0]['bonus_percent'])   # bonus only on the total
            with storage.connection() as c:
                saved = json.loads(c.execute('SELECT data FROM race_event_results WHERE event_id=1').fetchone()[0])
                audit = c.execute("SELECT count(*) FROM race_audit WHERE action='event-close'").fetchone()[0]
            self.assertEqual(saved['1']['score'], 100)
            self.assertEqual(audit, 1)
            race.read()  # saving happens once
            with storage.connection() as c:
                self.assertEqual(c.execute("SELECT count(*) FROM race_audit WHERE action='event-close'").fetchone()[0], 1)

    def test_manual_correction_updates_saved_result(self):
        self.snap(1, '2026-10-28T22:00', 100)
        with patch('time.time', return_value=race.timestamp('2026-10-29T12:00')):
            race.read()
            race.mutate('manual', {'entry_id': 1, 'observed_at': '2026-10-28T22:55', 'likes': 150, 'evidence': 'screenshot'}, 'admin')
            self.assertEqual(self.scope(race.read(), 'event-1')['boards'][IG][0]['score'], 150)

    def test_schedule_stops_after_close_and_checks_before_it(self):
        with storage.connection() as c:
            self.assertEqual(race.post_next_check(c, 1, race.timestamp('2026-10-28T22:30')), race.timestamp('2026-10-28T22:50'))
            self.assertEqual(race.post_next_check(c, 1, race.timestamp('2026-10-28T23:00')), race.NEVER)
            self.assertIsNone(race.post_next_check(c, 999, race.START))
        with patch('time.time', return_value=race.timestamp('2026-10-29T12:00')):
            with self.assertRaisesRegex(ValueError, 'No open event'):
                race.mutate('refresh-all', {}, 'admin')
            storage.init()
        self.assertEqual(storage.rows()[0]['next_check'], race.NEVER)

    def test_changing_a_closed_window_recalculates(self):
        self.snap(1, '2026-10-28T22:00', 100)
        self.snap(1, '2026-10-28T23:30', 300)
        with patch('time.time', return_value=race.timestamp('2026-10-29T12:00')):
            self.assertEqual(self.scope(race.read(), 'event-1')['boards'][IG][0]['score'], 100)
            race.mutate('event-update', {'event_id': 1, 'name': 'Opening', 'starts': '2026-10-28T18:00', 'ends': '2026-10-29T00:00'}, 'admin')
            self.assertEqual(self.scope(race.read(), 'event-1')['boards'][IG][0]['score'], 300)


class RefreshAll(unittest.TestCase):
    setUp = Race.setUp
    tearDown = Race.tearDown

    def test_queues_registered_posts_skips_recent_and_paused(self):
        race.mutate('event', {'name': 'Lap 2', 'starts': '2026-10-28T18:00', 'ends': '2026-10-28T23:00'}, 'admin')
        race.mutate('entry', {**self.entry, 'event_id': 2, 'url': 'https://www.instagram.com/p/LAP2/'}, 'admin')
        race.mutate('entry', {**self.entry, 'url': 'https://www.tiktok.com/@c/video/1234567890123456789'}, 'admin')
        now = race.START + 3600
        with storage.connection() as c:
            c.execute("UPDATE posts SET status='ok', last_attempt=? WHERE id=1", (now - 60,))     # fresh
            c.execute("UPDATE posts SET status='ok', last_attempt=? WHERE id=2", (now - 3600,))   # stale
            c.execute("UPDATE posts SET paused=1 WHERE id=3")
            # A tracked post that is not in the race is never touched.
            c.execute("INSERT INTO posts(platform,remote_id,url,created_at,next_check,status) VALUES('youtube','abcdefghijk','https://youtu.be/abcdefghijk',0,9999999999,'ok')")
        result = race.mutate('refresh-all', {}, 'admin')
        self.assertEqual([q['id'] for q in result['queued']], [2])
        self.assertEqual(result['queued'][0]['last_attempt'], now - 3600)
        self.assertEqual((result['recent'], result['paused']), ([1], [3]))
        with storage.connection() as c:
            rows = {r['id']: (r['next_check'], r['status']) for r in c.execute('SELECT id,next_check,status FROM posts')}
        self.assertEqual(rows[2], (0, 'queued'))
        self.assertNotEqual(rows[1][0], 0)
        self.assertEqual(rows[4], (9999999999, 'ok'))
        self.assertEqual(storage.claim()['id'], 2)

    def test_nothing_to_refresh(self):
        with storage.connection() as c:
            c.execute('UPDATE posts SET paused=1')
        with self.assertRaisesRegex(ValueError, 'paused'):
            race.mutate('refresh-all', {}, 'admin')


class Management(unittest.TestCase):
    """Editing and deleting teams/creators and events from the admin."""
    setUp = Race.setUp
    tearDown = Race.tearDown

    def test_team_update_changes_creators_and_points(self):
        race.mutate('team-update', {'team_id': 1, 'name': 'TEAM ALPINOO', 'instagram': 'New IG', 'tiktok': 'New TT', 'base_points': '1200'}, 'admin')
        team = race.read(admin=True)['available_teams'][0]
        self.assertEqual((team['name'], names(team), team['base_points']), ('TEAM ALPINOO', {IG: ['New IG'], TT: ['New TT']}, 1200))
        audit = json.loads(race.read(admin=True)['audit'][0]['details'])
        self.assertEqual(audit['before']['creators'], {IG: ['Creator X'], TT: ['Creator X TT']})

    def test_team_update_rejects_taken_names(self):
        race.mutate('team', {'name': 'TEAM HOONRARI', 'instagram': 'Someone', 'tiktok': 'Someone TT'}, 'admin')
        with self.assertRaisesRegex(ValueError, 'already a TikTok creator of TEAM HOONRARI'):
            race.mutate('team-update', {'team_id': 1, 'name': 'Alpinoo', 'instagram': 'Creator X', 'tiktok': 'someone tt'}, 'admin')
        with self.assertRaisesRegex(ValueError, 'already set up'):
            race.mutate('team-update', {'team_id': 1, 'name': 'team hoonrari', 'instagram': 'Creator X', 'tiktok': 'Creator X TT'}, 'admin')
        # Keeping your own creators is not a conflict.
        race.mutate('team-update', {'team_id': 1, 'name': 'Alpinoo', 'instagram': 'creator x', 'tiktok': 'Creator X TT'}, 'admin')

    def test_delete_unregisters_posts_but_keeps_tracking(self):
        for action, key in (('event-delete', 'event_id'), ('team-delete', 'team_id')):
            with self.subTest(action=action):
                self.tearDown(); self.setUp()
                race.mutate('manual', {'entry_id': 1, 'observed_at': '2026-10-28T18:30', 'likes': 3, 'evidence': 'ref'}, 'admin')
                race.mutate(action, {key: 1}, 'admin')
                data = race.read(admin=True)
                self.assertEqual(data['entries'], [])
                with storage.connection() as c:
                    self.assertEqual(c.execute('SELECT count(*) FROM posts').fetchone()[0], 1)
                    self.assertEqual(c.execute('SELECT count(*) FROM race_manual').fetchone()[0], 0)
                    creators = c.execute('SELECT count(*) FROM race_creators').fetchone()[0]
                    audit = json.loads(c.execute('SELECT details FROM race_audit ORDER BY id DESC LIMIT 1').fetchone()[0])
                self.assertEqual(creators, 0 if action == 'team-delete' else 2)
                self.assertEqual(audit['unregistered_posts'], 1)
                with self.assertRaisesRegex(ValueError, 'Already deleted'):
                    race.mutate(action, {key: 1}, 'admin')


class Migration(unittest.TestCase):
    """Databases from before per-platform creators keep their teams, entries and history."""

    def test_representative_becomes_creator_on_both_platforms(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = tmp + '/old.sqlite3'
            con = sqlite3.connect(path)
            con.executescript('''
            CREATE TABLE posts(id INTEGER PRIMARY KEY, platform TEXT NOT NULL, remote_id TEXT NOT NULL, url TEXT NOT NULL,
              label TEXT NOT NULL DEFAULT '', team TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL,
              paused INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, next_check REAL NOT NULL DEFAULT 0,
              last_attempt REAL, status TEXT NOT NULL DEFAULT 'queued', error TEXT, UNIQUE(platform,remote_id));
            CREATE TABLE race_config(id INTEGER PRIMARY KEY CHECK(id=1), weights TEXT, frozen TEXT);
            INSERT INTO race_config(id, weights) VALUES(1, '{"likes": 1, "comments": 0, "views": 0}');
            CREATE TABLE race_teams(id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
              representative TEXT NOT NULL COLLATE NOCASE UNIQUE, base_points INTEGER);
            CREATE TABLE race_events(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, starts REAL NOT NULL, ends REAL NOT NULL);
            CREATE TABLE race_entries(id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES race_teams(id),
              event_id INTEGER NOT NULL REFERENCES race_events(id), post_id INTEGER NOT NULL UNIQUE REFERENCES posts(id),
              platform TEXT NOT NULL, published_at REAL NOT NULL, UNIQUE(team_id,event_id,platform));
            INSERT INTO race_teams VALUES(3, 'TEAM ALPINOO', 'sunoo.sunshine', 1300);
            INSERT INTO race_events VALUES(1, 'Opening', 1793178000, 1793350000);
            INSERT INTO posts(id,platform,remote_id,url,created_at) VALUES(7,'instagram','ABC','https://www.instagram.com/p/ABC/',0);
            INSERT INTO race_entries VALUES(1, 3, 1, 7, 'instagram', 1793178600);
            ''')
            con.commit(); con.close()
            old = storage.DB
            storage.DB = path
            try:
                storage.init()
                storage.init()  # idempotent
                with patch('time.time', return_value=race.START + 3600):
                    data = race.read(admin=True)
                team = data['available_teams'][0]
                self.assertEqual((team['id'], team['name'], team['base_points']), (3, 'TEAM ALPINOO', 1300))
                self.assertEqual(names(team), {IG: ['sunoo.sunshine'], TT: ['sunoo.sunshine']})
                self.assertEqual(data['entries'][0]['team_id'], 3)
                self.assertEqual(data['entries'][0]['creator'], 'sunoo.sunshine')
                self.assertEqual(data['tracked_posts'][0]['assigned_creator'], 'sunoo.sunshine')
                with storage.connection() as c:
                    self.assertEqual(c.execute('PRAGMA foreign_key_check').fetchall(), [])
                    columns = [r[1] for r in c.execute('PRAGMA table_info(race_teams)')]
                self.assertNotIn('representative', columns)
            finally:
                storage.DB = old


class MultiCreators(unittest.TestCase):
    """Several creators per team and platform; each creator is a row and can reach the podium."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old = storage.DB
        storage.DB = self.temp.name + '/race.sqlite3'
        storage.init()
        self.clock = patch('time.time', return_value=race.START + 3600)
        self.clock.start()
        race.mutate('team', {'name': 'ALPINOO', 'creators': {IG: [{'name': 'a1'}, {'name': 'a2'}, {'name': 'a3'}], TT: [{'name': 'at'}]}, 'base_points': 1000}, 'admin')
        race.mutate('team', {'name': 'HOONRARI', 'creators': {IG: ['h1'], TT: ['ht']}, 'base_points': 1000}, 'admin')
        race.mutate('event', {'name': 'Opening', 'starts': '2026-10-28T18:00', 'ends': '2026-10-28T23:00'}, 'admin')
        self.ids = {c['name']: c['id'] for t in race.read(admin=True)['available_teams'] for p in (IG, TT) for c in t['creators'][p]}

    def tearDown(self):
        self.clock.stop()
        storage.DB = self.old
        self.temp.cleanup()

    def register(self, creator, code, event=1):
        race.mutate('entry', {'creator_id': self.ids[creator], 'event_id': event, 'url': f'https://www.instagram.com/p/{code}/', 'published_at': '2026-10-28T18:10'}, 'admin')

    def likes(self, entry_id, likes):
        race.mutate('manual', {'entry_id': entry_id, 'observed_at': '2026-10-28T18:30', 'likes': likes, 'evidence': 'screenshot'}, 'admin')

    def test_one_row_per_creator_and_same_team_podium(self):
        for i, (creator, likes) in enumerate([('a1', 50), ('a2', 40), ('a3', 30), ('h1', 20)], 1):
            self.register(creator, f'P{i}')
            self.likes(i, likes)
        rows = race.read()['boards'][IG]
        self.assertEqual([(r['rank'], r['team'], r['creator']) for r in rows],
                         [(1, 'ALPINOO', 'a1'), (2, 'ALPINOO', 'a2'), (3, 'ALPINOO', 'a3'), (4, 'HOONRARI', 'h1')])
        self.assertEqual([r['bonus_percent'] for r in rows], [2, 1, 1, 0])
        team = next(t for t in race.read()['teams'] if t['name'] == 'ALPINOO')
        self.assertEqual(team['bonus_points_total'], 40)

    def test_one_post_per_creator_and_event(self):
        self.register('a1', 'ONE')
        self.register('a2', 'TWO')  # another creator of the same team is fine
        with self.assertRaisesRegex(ValueError, 'a1 already has a post'):
            self.register('a1', 'THREE')

    def test_team_id_needs_a_creator_when_ambiguous(self):
        with self.assertRaisesRegex(ValueError, 'several Instagram creators'):
            race.mutate('entry', {'team_id': 1, 'event_id': 1, 'url': 'https://www.instagram.com/p/AMB/', 'published_at': '2026-10-28T18:10'}, 'admin')
        race.mutate('entry', {'team_id': 2, 'event_id': 1, 'url': 'https://www.instagram.com/p/HOO/', 'published_at': '2026-10-28T18:10'}, 'admin')
        with self.assertRaisesRegex(ValueError, 'at is a TikTok creator, but this is an Instagram post'):
            race.mutate('entry', {'creator_id': self.ids['at'], 'event_id': 1, 'url': 'https://www.instagram.com/p/WRONG/', 'published_at': '2026-10-28T18:10'}, 'admin')

    def test_edit_renames_adds_and_removes_creators(self):
        self.register('a2', 'KEEP')
        self.register('a3', 'GONE')
        race.mutate('team-update', {'team_id': 1, 'name': 'ALPINOO', 'base_points': 1000, 'creators': {
            IG: [{'id': self.ids['a1'], 'name': 'a1 renamed'}, {'id': self.ids['a2'], 'name': 'a2'}, {'name': 'a4'}],
            TT: [{'id': self.ids['at'], 'name': 'at'}]}}, 'admin')
        data = race.read(admin=True)
        team = next(t for t in data['available_teams'] if t['id'] == 1)
        self.assertEqual(names(team)[IG], ['a1 renamed', 'a2', 'a4'])
        self.assertEqual([e['creator'] for e in data['entries']], ['a2'])  # a3 removed, its post unregistered
        self.assertEqual(json.loads(data['audit'][0]['details'])['removed_creators'], ['a3'])

    def test_creator_names_unique_per_platform(self):
        with self.assertRaisesRegex(ValueError, 'listed twice'):
            race.mutate('team-update', {'team_id': 1, 'name': 'ALPINOO', 'creators': {IG: ['x', 'X'], TT: ['at']}}, 'admin')
        with self.assertRaisesRegex(ValueError, 'already an Instagram creator of ALPINOO'):
            race.mutate('team-update', {'team_id': 2, 'name': 'HOONRARI', 'creators': {IG: ['h1', 'a2'], TT: ['ht']}}, 'admin')
        with self.assertRaisesRegex(ValueError, 'at least one TikTok'):
            race.mutate('team-update', {'team_id': 2, 'name': 'HOONRARI', 'creators': {IG: ['h1'], TT: []}}, 'admin')
        # Swapping two names inside the team works.
        race.mutate('team-update', {'team_id': 1, 'name': 'ALPINOO', 'creators': {
            IG: [{'id': self.ids['a1'], 'name': 'a2'}, {'id': self.ids['a2'], 'name': 'a1'}, {'id': self.ids['a3'], 'name': 'a3'}], TT: ['at']}}, 'admin')

    def test_instagram_creators_are_optional(self):
        race.mutate('team', {'name': 'MEOWCEDES', 'creators': {IG: [], TT: ['mt']}}, 'admin')
        data = race.read()
        self.assertNotIn('MEOWCEDES', [r['team'] for r in data['boards'][IG]])
        self.assertIn('MEOWCEDES', [r['team'] for r in data['boards'][TT]])
        with self.assertRaisesRegex(ValueError, 'has no Instagram creator'):
            race.mutate('entry', {'team_id': 3, 'event_id': 1, 'url': 'https://www.instagram.com/p/MEOW/', 'published_at': '2026-10-28T18:10'}, 'admin')
