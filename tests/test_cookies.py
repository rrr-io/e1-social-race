import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import collectors

TARGET = collectors.normalize_url('https://www.tiktok.com/@someone/video/1234567890123456789')
COOKIE = '# Netscape HTTP Cookie File\n.tiktok.com\tTRUE\t/\tTRUE\t2000000000\tsessionid\tFAKE_TEST_VALUE\n.example.com\tTRUE\t/\tTRUE\t2000000000\tother\tUNRELATED\n'

class Cookies(unittest.TestCase):
    def test_private_copy_filters_domains_and_cleans_up(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)/'session.txt'; source.write_text(COOKIE)
            with patch.dict(os.environ, {'TIKTOK_COOKIES_FILE':str(source)}):
                with collectors.tiktok_cookie_copy(TARGET) as temporary:
                    copied=Path(temporary)
                    self.assertNotEqual(copied,source)
                    self.assertIn('FAKE_TEST_VALUE',copied.read_text())
                    self.assertNotIn('UNRELATED',copied.read_text())
                    self.assertEqual(copied.stat().st_mode & 0o777,0o600)
                self.assertFalse(copied.exists())
                self.assertEqual(source.read_text(),COOKIE)

    def test_no_cookies_on_other_platforms(self):
        with patch.dict(os.environ, {'TIKTOK_COOKIES_FILE':'/missing'}):
            with collectors.tiktok_cookie_copy(collectors.normalize_url('https://youtu.be/abcdefghijk')) as value:
                self.assertIsNone(value)

    def test_missing_cookie_file_has_safe_error(self):
        with patch.dict(os.environ, {'TIKTOK_COOKIES_FILE':'/private/SECRET-path'}):
            with self.assertRaises(collectors.CollectionError) as result:
                with collectors.tiktok_cookie_copy(TARGET): pass
            self.assertNotIn('SECRET',str(result.exception))

    def test_cookie_option_and_cleanup_on_timeout(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'cookies.txt';source.write_text(COOKIE)
            paths=[]
            def fake_run(command,**kwargs):
                cookie=Path(command[command.index('--cookies')+1]);paths.append(cookie)
                self.assertTrue(cookie.exists())
                self.assertEqual(command[-2:],['--',TARGET.url])
                raise subprocess.TimeoutExpired('yt-dlp',90)
            with patch.dict(os.environ, {'TIKTOK_COOKIES_FILE':str(source)}), patch('collectors.subprocess.run', side_effect=fake_run):
                with self.assertRaises(collectors.CollectionError): collectors.collect(TARGET)
            self.assertFalse(paths[0].exists())

    def test_errors_are_distinguished(self):
        for message,expected in [('HTTP Error 429','rate limit'),('HTTP Error 403','does not confirm'),('CAPTCHA challenge','bot challenge'),('Login required','session requirement')]:
            with self.subTest(message=message), patch.dict(os.environ, {'TIKTOK_COOKIES_FILE':''}), patch('collectors.subprocess.run',return_value=subprocess.CompletedProcess([],1,'',message)):
                with self.assertRaises(collectors.CollectionError) as result: collectors.collect(TARGET)
                self.assertIn(expected,str(result.exception))
