import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import collectors

TIKTOK_TARGET = collectors.normalize_url('https://www.tiktok.com/@someone/video/1234567890123456789')
TIKTOK_COOKIE = '# Netscape HTTP Cookie File\n.tiktok.com\tTRUE\t/\tTRUE\t2000000000\tsessionid\tFAKE_TEST_VALUE\n.example.com\tTRUE\t/\tTRUE\t2000000000\tother\tUNRELATED\n'
INSTAGRAM_TARGET = collectors.normalize_url('https://www.instagram.com/reel/ABCDEFGHIJK/')
INSTAGRAM_COOKIE = '# Netscape HTTP Cookie File\n.instagram.com\tTRUE\t/\tTRUE\t2000000000\tsessionid\tFAKE_TEST_VALUE\n.example.com\tTRUE\t/\tTRUE\t2000000000\tother\tUNRELATED\n'

PLATFORMS = [
    ('tiktok', 'TIKTOK_COOKIES_FILE', TIKTOK_TARGET, TIKTOK_COOKIE),
    ('instagram', 'INSTAGRAM_COOKIES_FILE', INSTAGRAM_TARGET, INSTAGRAM_COOKIE),
]

class Cookies(unittest.TestCase):
    def test_private_copy_filters_domains_and_cleans_up(self):
        for platform, env_var, target, cookie in PLATFORMS:
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory:
                source = Path(directory)/'session.txt'; source.write_text(cookie)
                with patch.dict(os.environ, {env_var:str(source)}):
                    with collectors.platform_cookie_copy(target) as temporary:
                        copied=Path(temporary)
                        self.assertNotEqual(copied,source)
                        self.assertIn('FAKE_TEST_VALUE',copied.read_text())
                        self.assertNotIn('UNRELATED',copied.read_text())
                        self.assertEqual(copied.stat().st_mode & 0o777,0o600)
                    self.assertFalse(copied.exists())
                    self.assertEqual(source.read_text(),cookie)

    def test_no_cookies_on_other_platforms(self):
        with patch.dict(os.environ, {'TIKTOK_COOKIES_FILE':'/missing', 'INSTAGRAM_COOKIES_FILE':'/missing'}):
            with collectors.platform_cookie_copy(collectors.normalize_url('https://youtu.be/abcdefghijk')) as value:
                self.assertIsNone(value)

    def test_tiktok_cookies_not_used_for_instagram_and_vice_versa(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)/'session.txt'; source.write_text(TIKTOK_COOKIE)
            with patch.dict(os.environ, {'TIKTOK_COOKIES_FILE':str(source), 'INSTAGRAM_COOKIES_FILE':''}):
                with collectors.platform_cookie_copy(INSTAGRAM_TARGET) as value:
                    self.assertIsNone(value)

    def test_missing_cookie_file_has_safe_error(self):
        for platform, env_var, target, _ in PLATFORMS:
            with self.subTest(platform=platform), patch.dict(os.environ, {env_var:'/private/SECRET-path'}):
                with self.assertRaises(collectors.CollectionError) as result:
                    with collectors.platform_cookie_copy(target): pass
                self.assertNotIn('SECRET',str(result.exception))

    def test_cookie_option_and_cleanup_on_timeout(self):
        for platform, env_var, target, cookie in PLATFORMS:
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory:
                source=Path(directory)/'cookies.txt';source.write_text(cookie)
                paths=[]
                def fake_run(command,**kwargs):
                    cookie_path=Path(command[command.index('--cookies')+1]);paths.append(cookie_path)
                    self.assertTrue(cookie_path.exists())
                    self.assertEqual(command[-2:],['--',target.url])
                    raise subprocess.TimeoutExpired('yt-dlp',90)
                with patch.dict(os.environ, {env_var:str(source)}), patch('collectors.subprocess.run', side_effect=fake_run):
                    with self.assertRaises(collectors.CollectionError): collectors.collect(target)
                self.assertFalse(paths[0].exists())

    def test_errors_are_distinguished(self):
        for message,expected in [('HTTP Error 429','rate limit'),('HTTP Error 403','does not confirm'),('CAPTCHA challenge','bot challenge'),('Login required','signed-in session')]:
            with self.subTest(message=message), patch.dict(os.environ, {'TIKTOK_COOKIES_FILE':'', 'INSTAGRAM_COOKIES_FILE':''}), patch('collectors.subprocess.run',return_value=subprocess.CompletedProcess([],1,'',message)):
                with self.assertRaises(collectors.CollectionError) as result: collectors.collect(TIKTOK_TARGET)
                self.assertIn(expected,str(result.exception))

    def test_real_ytdlp_errors_are_explained(self):
        ig = collectors.normalize_url('https://www.instagram.com/p/ABCDE/')
        cases = [
            (TIKTOK_TARGET, 'ERROR: [TikTok] 1234567890123456789: Your IP address is blocked from accessing this post', 'blocking the server'),
            (TIKTOK_TARGET, 'ERROR: [TikTok] 1234567890123456789: Video not available, status code 10231', 'seems to be unavailable'),
            (TIKTOK_TARGET, 'ERROR: [TikTok] 1234567890123456789: Unable to extract universal data for rehydration; please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template. Confirm you are on the latest version using  yt-dlp -U', 'needs updating'),
            (ig, 'ERROR: [Instagram] ABCDE: Instagram sent an empty media response. Check if this post is accessible in your browser without being logged-in. If it is not, then use --cookies-from-browser or --cookies for the authentication.', 'no data for this post to an anonymous visitor'),
            (ig, 'ERROR: [Instagram] ABCDE: Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution> (caused by URLError)', 'Network error'),
            (ig, 'ERROR: [Instagram] ABCDE: Something new and strange happened', 'yt-dlp: Something new and strange happened'),
        ]
        for target, stderr, expected in cases:
            with self.subTest(stderr=stderr[:40]), patch.dict(os.environ, {'TIKTOK_COOKIES_FILE':'', 'INSTAGRAM_COOKIES_FILE':''}), patch('collectors.subprocess.run', return_value=subprocess.CompletedProcess([],1,'',stderr)):
                with self.assertLogs(level='WARNING'), self.assertRaises(collectors.CollectionError) as result:
                    collectors.collect(target)
                self.assertIn(expected, str(result.exception))
                self.assertNotIn('github.com', str(result.exception))
                self.assertNotIn('please report', str(result.exception))

    def test_photo_posts_do_not_fail_for_missing_video(self):
        captured = {}
        def fake_run(command, **kwargs):
            captured['command'] = command
            return subprocess.CompletedProcess(command, 0, '{"id": "ABCDE", "like_count": 12, "comment_count": 3}', '')
        with patch.dict(os.environ, {'INSTAGRAM_COOKIES_FILE':''}), patch('collectors.subprocess.run', side_effect=fake_run):
            data = collectors.collect(collectors.normalize_url('https://www.instagram.com/p/ABCDE/'))
        self.assertIn('--ignore-no-formats-error', captured['command'])
        self.assertEqual((data['likes'], data['comments'], data['views']), (12, 3, None))

    def _instagram_session(self, outcomes):
        """Run collect() for Instagram with a cookie file; outcomes are (returncode, stdout, stderr) per call."""
        calls = []
        def fake_run(command, **kwargs):
            calls.append('--cookies' in command)
            code, out, err = outcomes[len(calls) - 1]
            return subprocess.CompletedProcess(command, code, out, err)
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        source = Path(directory.name)/'session.txt'; source.write_text(INSTAGRAM_COOKIE)
        with patch.dict(os.environ, {'INSTAGRAM_COOKIES_FILE': str(source)}), patch('collectors.subprocess.run', side_effect=fake_run), self.assertLogs(level='WARNING'):
            try:
                return collectors.collect(INSTAGRAM_TARGET), calls
            except collectors.CollectionError as exc:
                return exc, calls

    EMPTY_JSON = 'ERROR: [Instagram] ABCDEFGHIJK: ABCDEFGHIJK: Failed to parse JSON (caused by JSONDecodeError("Expecting value in \'\': line 1 column 1 (char 0)"))'

    def test_broken_instagram_session_falls_back_to_anonymous(self):
        data, calls = self._instagram_session([(1, '', self.EMPTY_JSON), (0, '{"id": "ABCDEFGHIJK", "like_count": 5, "comment_count": 1}', '')])
        self.assertEqual(calls, [True, False])
        self.assertEqual((data['likes'], data['source']), (5, 'yt-dlp (no session)'))

    def test_broken_session_and_failed_fallback_explain_the_session(self):
        error, calls = self._instagram_session([(1, '', self.EMPTY_JSON), (1, '', 'ERROR: [Instagram] ABCDEFGHIJK: Instagram sent an empty media response. Check if this post is accessible in your browser without being logged-in.')])
        self.assertEqual(calls, [True, False])
        self.assertIn('saved Instagram session no longer works', str(error))
        self.assertIn('anonymous visitor', str(error))

    def test_empty_json_without_session_is_a_temporary_block(self):
        with patch.dict(os.environ, {'INSTAGRAM_COOKIES_FILE': ''}), patch('collectors.subprocess.run', return_value=subprocess.CompletedProcess([], 1, '', self.EMPTY_JSON)), self.assertLogs(level='WARNING'):
            with self.assertRaises(collectors.CollectionError) as result:
                collectors.collect(INSTAGRAM_TARGET)
        self.assertIn('empty or non-JSON response', str(result.exception))
