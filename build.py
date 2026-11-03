#!/usr/bin/env python3
"""
build.py — produce the deployable bundles under dist/.

  dist/sender.html    everything the air-gapped machine needs: copy this ONE file over
                      (USB stick, CD, whatever) and open it in any browser. No install.
  dist/receiver.html  the phone app as a single file (no offline/install support).
  dist/app/           the phone app as an installable PWA folder: index.html (self-contained),
                      manifest, service worker, icons. Upload this folder to any static HTTPS
                      host (GitHub Pages, Netlify, S3, Cloudflare Pages) and open it on the phone.

Standard library only.
"""
import os, re, shutil

ROOT = os.path.dirname(os.path.abspath(__file__))

def inline(html_path):
    base = os.path.dirname(html_path)
    with open(html_path, encoding='utf-8') as f:
        html = f.read()
    def repl(m):
        src = m.group(1)
        if src.startswith('http'):
            return m.group(0)
        with open(os.path.normpath(os.path.join(base, src)), encoding='utf-8') as f:
            js = f.read().replace('</script', '<\\/script')
        return f'<script>/* inlined: {src} */\n{js}\n</script>'
    return re.sub(r'<script src="([^"]+)"></script>', repl, html)

def write(rel, text):
    path = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    print(f'wrote {rel}  ({len(text.encode()) / 1024:.1f} KB)')

def main():
    write('dist/sender.html', inline(os.path.join(ROOT, 'sender/index.html')))
    receiver = inline(os.path.join(ROOT, 'receiver/index.html'))
    write('dist/receiver.html', receiver)
    # PWA folder
    write('dist/app/index.html', receiver)
    for name in ('manifest.webmanifest', 'icon-192.png', 'icon-512.png'):
        shutil.copy(os.path.join(ROOT, 'receiver', name), os.path.join(ROOT, 'dist/app', name))
    with open(os.path.join(ROOT, 'receiver/sw.js'), encoding='utf-8') as f:
        sw = f.read().replace("'../shared/qrx-protocol.js', ", '').replace("'./qr-decoder.js'", "'./index.html'")  # inlined in the PWA build
    write('dist/app/sw.js', sw)
    print('copied icons + manifest -> dist/app/')

if __name__ == '__main__':
    main()
