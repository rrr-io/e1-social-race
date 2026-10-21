"""Check authenticated HTTP availability without printing credentials or data."""
import base64
import os
import sys
import urllib.request

try:
    token = base64.b64encode(
        f"{os.getenv('ADMIN_USER', 'admin')}:{os.environ['ADMIN_PASSWORD']}".encode()
    ).decode()
    request = urllib.request.Request(
        'http://127.0.0.1:8000/admin', headers={'Authorization': 'Basic ' + token}
    )
    with urllib.request.urlopen(request, timeout=3) as response:
        healthy = response.status == 200
except Exception:
    healthy = False
sys.exit(0 if healthy else 1)
