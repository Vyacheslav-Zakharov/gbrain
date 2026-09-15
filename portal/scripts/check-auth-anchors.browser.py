"""Exact-dist synthetic auth/anchor races; no real auth, server or database.
Run with a Python environment containing Playwright, after building the Portal.
"""
import argparse
import hashlib
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--chromium')
args = parser.parse_args()
args.out.mkdir(parents=True, exist_ok=True)
text = '[First](#first) [Second](#second)\n\n' + 'Reading paragraph.\n\n' * 60 + '## First\n\n' + 'Reading paragraph.\n\n' * 60 + '## Second\n\n' + 'Reading paragraph.\n\n' * 60
results = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=args.chromium, headless=True)
    try:
        for width, height in [(1440, 1000), (1000, 800), (390, 844)]:
            page = browser.new_page(viewport={'width': width, 'height': height})
            page.set_default_timeout(6000)
            held = []
            control = {'hold': 'guide.md'}
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            def handler(route):
                u = urlsplit(route.request.url)
                assert u.netloc == 'isolated.invalid', 'No external requests allowed'
                assert route.request.method == 'GET', 'No writes allowed'
                path = parse_qs(u.query).get('path', [''])[0]
                summary = {'sections': 0, 'documents': 2, 'complete': True}
                data = {
                    '/portal/api/session': {'email': 'reader@example.test', 'canReview': False},
                    '/portal/api/sources': {'sources': [{'id': 'example', 'name': 'Synthetic fixture'}]},
                    '/portal/api/tree': {'entries': [{'name': 'other.md', 'path': 'other.md', 'type': 'file', 'markdown': True, 'size': 10}], 'summary': summary, 'sourceSummary': summary},
                    '/portal/api/context': {'backlinks': [], 'meetings': []},
                    '/portal/api/file': {'source': 'example', 'sourceName': 'Synthetic fixture', 'path': path, 'name': path, 'title': 'Guide', 'content': text, 'size': len(text), 'tags': []},
                }
                if u.path == '/portal/api/file' and control['hold'] == path:
                    held.append((route, data[u.path]))
                    return
                if u.path in data:
                    route.fulfill(json=data[u.path])
                elif u.path.startswith('/portal/assets/'):
                    asset = args.root / 'portal/dist/assets' / Path(u.path).name
                    route.fulfill(content_type='text/css' if asset.suffix == '.css' else 'application/javascript', body=asset.read_bytes())
                elif u.path == '/portal':
                    route.fulfill(content_type='text/html', body=(args.root / 'portal/dist/index.html').read_bytes())
                else:
                    route.fulfill(status=404)
            page.route('**/*', handler)
            href = '/portal?source=example&path=guide.md#first'
            page.add_init_script("sessionStorage.setItem('gbrain.portal.authReadingPosition', JSON.stringify({href:location.pathname+location.search+location.hash,top:777,left:0,savedAt:Date.now()}));")
            page.goto('http://isolated.invalid' + href)
            page.wait_for_selector('.document-skeleton')
            def barrier():
                for _ in range(100):
                    if held:
                        return
                    page.wait_for_timeout(20)
                raise AssertionError('Delayed file barrier not reached')
            def release(status=200):
                barrier()
                route, data = held.pop(0)
                control['hold'] = None
                route.fulfill(status=status, json=data if status == 200 else {'error': 'Synthetic unavailable'})
                page.wait_for_selector('.markdown-body h2')
                page.wait_for_timeout(200)
            def top():
                return page.locator('.document-scroll').evaluate('(el)=>el.scrollTop')
            def aligned(which):
                offset = page.locator('.markdown-body h2').nth(which).evaluate('(el)=>el.getBoundingClientRect().top-document.querySelector(".document-scroll").getBoundingClientRect().top')
                assert abs(offset - 16) <= 8 and top() > 100, offset
            release()
            assert top() == 777, ('auth restoration must beat hash after delayed commit', top())
            assert page.evaluate("sessionStorage.getItem('gbrain.portal.authReadingPosition')") is None
            results.append({'width': width, 'case': 'delayed_auth_return_beats_hash', 'top': top(), 'passed': True})
            # A held document request collapses content; Back must apply the hash
            # after remount, not try to find a heading in the loading skeleton.
            control['hold'] = 'other.md'
            page.evaluate("()=>{history.pushState({}, '', '/portal?source=example&path=other.md');dispatchEvent(new PopStateEvent('popstate'));}")
            barrier()
            page.wait_for_selector('.document-skeleton')
            page.evaluate('history.back()')
            page.wait_for_selector('.markdown-body h2')
            page.wait_for_timeout(150)
            aligned(0)
            release()
            aligned(0)
            results.append({'width': width, 'case': 'back_hash_after_loading_skeleton', 'passed': True})
            # A failed in-app fetch keeps the committed document at the exact
            # manually selected reading offset rather than resetting its hash.
            page.locator('.document-scroll').evaluate('(el)=>{el.scrollTop=820;el.dispatchEvent(new Event("scroll",{bubbles:true}));}')
            control['hold'] = 'other.md'
            if width <= 900:
                page.get_by_role('button', name='Открыть проводник').click()
            page.locator('.tree-row').filter(has_text='other.md').click()
            barrier()
            page.wait_for_selector('.document-skeleton')
            release(500)
            assert top() == 820, ('failed fetch reset committed reading position', top())
            results.append({'width': width, 'case': 'failed_fetch_keeps_manual_offset', 'top': top(), 'passed': True})
            assert not errors, errors
            page.screenshot(path=str(args.out / f'auth-anchors-{width}.png'))
            page.close()
    finally:
        browser.close()
report = {'scope': 'synthetic exact-built Portal; NOT real SSO', 'indexSha256': hashlib.sha256((args.root / 'portal/dist/index.html').read_bytes()).hexdigest(), 'results': results}
(args.out / 'results.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
