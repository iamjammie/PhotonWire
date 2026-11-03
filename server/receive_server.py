#!/usr/bin/env python3
"""
receive_server.py — the optional internet-side endpoint for QRX transfers. Standard library only.

  * Serves the receiver web app at /            (so the phone can just open https://host:8443/)
  * Accepts uploads at   POST /api/upload        (raw body + X-Filename + X-SHA256 headers)
  * Lists uploads at     GET  /api/files
  * Serves uploads at    GET  /files/<name>

Why HTTPS: browsers only expose the camera on secure origins. `--tls` generates a self-signed
certificate with openssl on first run. On the phone, open the URL once, accept the certificate
warning, and the camera will work.

Usage:
  python3 server/receive_server.py                    # http://0.0.0.0:8080  (camera only on localhost)
  python3 server/receive_server.py --tls              # https://0.0.0.0:8443 (self-signed)
  python3 server/receive_server.py --tls --token s3cret   # require  Authorization: Bearer s3cret
"""
import argparse, hashlib, json, os, ssl, subprocess, sys, time, urllib.parse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RECEIVER_DIR = os.path.join(ROOT, 'receiver')
SHARED_DIR = os.path.join(ROOT, 'shared')
UPLOAD_DIR = os.path.join(ROOT, 'uploads')
MAX_BYTES = 50 * 1024 * 1024


class Handler(SimpleHTTPRequestHandler):
    token = None

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Filename, X-SHA256, Authorization')

    def _json(self, code, obj):
        body = json.dumps(obj, indent=1).encode()
        self.send_response(code)
        self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path, ctype):
        with open(path, 'rb') as f:
            body = f.read()
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        p = urllib.parse.urlparse(self.path).path
        if p in ('/', '/index.html', '/receiver', '/receiver/'):
            return self._file(os.path.join(RECEIVER_DIR, 'index.html'), 'text/html; charset=utf-8')
        if p == '/shared/qrx-protocol.js':
            return self._file(os.path.join(SHARED_DIR, 'qrx-protocol.js'), 'application/javascript')
        # the receiver's app-shell files (manifest, service worker, icons)
        name = os.path.basename(p)
        fp = os.path.join(RECEIVER_DIR, name)
        if name and os.path.isfile(fp) and name in os.listdir(RECEIVER_DIR):
            ctype = {'.js': 'application/javascript', '.webmanifest': 'application/manifest+json',
                     '.png': 'image/png', '.html': 'text/html; charset=utf-8'}.get(os.path.splitext(name)[1], 'application/octet-stream')
            return self._file(fp, ctype)
        if p == '/api/files':
            items = []
            for name in sorted(os.listdir(UPLOAD_DIR)) if os.path.isdir(UPLOAD_DIR) else []:
                fp = os.path.join(UPLOAD_DIR, name)
                if os.path.isfile(fp):
                    with open(fp, 'rb') as f:
                        digest = hashlib.sha256(f.read()).hexdigest()
                    items.append({'name': name, 'size': os.path.getsize(fp), 'sha256': digest,
                                  'mtime': time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(os.path.getmtime(fp)))})
            return self._json(200, {'files': items})
        if p.startswith('/files/'):
            name = os.path.basename(urllib.parse.unquote(p[len('/files/'):]))
            fp = os.path.join(UPLOAD_DIR, name)
            if os.path.isfile(fp):
                return self._file(fp, 'application/octet-stream')
        self._json(404, {'error': 'not found'})

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path != '/api/upload':
            return self._json(404, {'error': 'not found'})
        if self.token:
            auth = self.headers.get('Authorization', '')
            if auth != 'Bearer ' + self.token:
                return self._json(401, {'error': 'bad or missing bearer token'})
        length = int(self.headers.get('Content-Length', '0'))
        if length <= 0 or length > MAX_BYTES:
            return self._json(413 if length > MAX_BYTES else 400, {'error': 'bad Content-Length'})
        data = self.rfile.read(length)
        claimed = (self.headers.get('X-SHA256') or '').lower().strip()
        actual = hashlib.sha256(data).hexdigest()
        name = os.path.basename(urllib.parse.unquote(self.headers.get('X-Filename', '') or 'payload.bin')) or 'payload.bin'
        if claimed and claimed != actual:
            return self._json(422, {'error': 'sha256 mismatch', 'claimed': claimed, 'actual': actual})
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        stamp = time.strftime('%Y%m%d-%H%M%S')
        out = os.path.join(UPLOAD_DIR, f'{stamp}-{name}')
        with open(out, 'wb') as f:
            f.write(data)
        print(f'[upload] {out}  {length} B  sha256={actual}  verified={bool(claimed)}', flush=True)
        self._json(200, {'ok': True, 'stored_as': os.path.basename(out), 'size': length, 'sha256': actual,
                         'verified': bool(claimed), 'url': f'/files/{urllib.parse.quote(os.path.basename(out))}'})

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))


def ensure_cert(cert_dir):
    os.makedirs(cert_dir, exist_ok=True)
    crt, key = os.path.join(cert_dir, 'cert.pem'), os.path.join(cert_dir, 'key.pem')
    if not (os.path.exists(crt) and os.path.exists(key)):
        print('[tls] generating self-signed certificate with openssl …')
        subprocess.check_call(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365',
                               '-keyout', key, '-out', crt, '-subj', '/CN=glasswire-receiver',
                               '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'])
    return crt, key


def lan_ips():
    import socket
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    return sorted(ips) or ['<your-lan-ip>']


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--host', default='0.0.0.0')
    ap.add_argument('--port', type=int)
    ap.add_argument('--tls', action='store_true', help='serve HTTPS with a self-signed cert (needed for phone camera)')
    ap.add_argument('--cert-dir', default=os.path.join(ROOT, 'server', 'certs'))
    ap.add_argument('--token', help='require this bearer token on uploads')
    a = ap.parse_args()
    port = a.port or (8443 if a.tls else 8080)
    Handler.token = a.token
    httpd = ThreadingHTTPServer((a.host, port), Handler)
    scheme = 'http'
    if a.tls:
        crt, key = ensure_cert(a.cert_dir)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(crt, key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        scheme = 'https'
    print(f'GlassWire receive server on {scheme}://{a.host}:{port}')
    for ip in lan_ips():
        print(f'  open on the phone:  {scheme}://{ip}:{port}/')
        print(f'  upload endpoint:    {scheme}://{ip}:{port}/api/upload')
    print(f'  uploads land in:    {UPLOAD_DIR}')
    if a.tls:
        print('  (self-signed: accept the certificate warning on the phone once)')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
