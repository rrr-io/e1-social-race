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
        for message,expected in [('HTTP Error 429','rate limit'),('HTTP Error 403','does not confirm'),('CAPTCHA challenge','bot challenge'),('Login required','session requirement')]:
            with self.subTest(message=message), patch.dict(os.environ, {'TIKTOK_COOKIES_FILE':'', 'INSTAGRAM_COOKIES_FILE':''}), patch('collectors.subprocess.run',return_value=subprocess.CompletedProcess([],1,'',message)):
                with self.assertRaises(collectors.CollectionError) as result: collectors.collect(TIKTOK_TARGET)
                self.assertIn(expected,str(result.exception))
