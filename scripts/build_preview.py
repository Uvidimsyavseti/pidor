from pathlib import Path
import json
import re

dist = Path('client/dist')
html = (dist / 'index.html').read_text(encoding='utf-8')
js_path = next((dist / 'assets').glob('*.js'))
css_path = next((dist / 'assets').glob('*.css'))
js = js_path.read_text(encoding='utf-8')
css = css_path.read_text(encoding='utf-8')
html = re.sub(r'<script type="module"[^>]*src="[^"]+"[^>]*></script>', '<script type="module" src="/app.js"></script>', html)
html = re.sub(r'<link rel="stylesheet"[^>]*href="[^"]+"[^>]*>', '<link rel="stylesheet" href="/style.css">', html)
# Preview worker runs the UI without modifying existing production Worker or secrets.
origin = 'https://pidor.uvidimsyamd.workers.dev'
worker = f'''const HTML = {json.dumps(html, ensure_ascii=False)};
const JS = {json.dumps(js, ensure_ascii=False)};
const CSS = {json.dumps(css, ensure_ascii=False)};
const ORIGIN = {json.dumps(origin)};
export default {{
  async fetch(request) {{
    const url = new URL(request.url);
    if (url.pathname === '/app.js') return new Response(JS, {{ headers: {{ 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' }} }});
    if (url.pathname === '/style.css') return new Response(CSS, {{ headers: {{ 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' }} }});
    if (url.pathname.startsWith('/cards/') || url.pathname.startsWith('/api/') || url.pathname.startsWith('/telegram/') || url.pathname === '/ws' || url.pathname === '/health') {{
      return fetch(new Request(ORIGIN + url.pathname + url.search, request));
    }}
    return new Response(HTML, {{ headers: {{ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' }} }});
  }}
}};
'''
target = Path('preview/worker.mjs')
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(worker, encoding='utf-8')
print('Built frontend preview Worker:', target, len(worker), 'bytes')
