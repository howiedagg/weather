"""Local-only field selection UI. Serves only public/, never the project root."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from datetime import datetime, timezone
import argparse
import json
import sys
import urllib.error
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parent
PLANNING_ROOT = ROOT.parent
PROJECT_ROOT = PLANNING_ROOT.parent
PUBLIC = ROOT / 'public'
RESULT = ROOT / '選擇結果.json'
sys.path.insert(0, str(PLANNING_ROOT / '中央氣象署'))
from shared_catalog import load_catalog, resolve_sections, validate_selection, sync_documents, WRITE_LOCK


def read_selection():
    path = RESULT if RESULT.exists() else ROOT / 'initial-selection.json'
    return json.loads(path.read_text(encoding='utf-8-sig'))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def reply(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route = self.path.split('?')[0]
        if route == '/api/catalog':
            try:
                catalog = load_catalog()
                self.reply(200, {'revision': catalog['revision'], 'updatedAt': catalog['updatedAt'], 'snapshot': catalog['snapshot'], 'verificationAudit': catalog.get('verificationAudit', {}), 'sections': resolve_sections(catalog)})
            except (OSError, ValueError, TypeError, KeyError):
                self.reply(500, {'error': '共用資料目錄不正確，請先核對；既有勾選不會被覆蓋'})
            return
        if route == '/api/plan':
            path = ROOT / '畫面資料規劃.md'
            if not path.exists():
                self.reply(404, {'error': '請先儲存選擇，產出規劃文件'})
                return
            content = path.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'text/markdown; charset=utf-8')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            return
        if self.path.split('?')[0] == '/api/selection':
            try:
                data = read_selection()
                clean = validate_selection(data, load_catalog())
                self.reply(200, {'selection': clean, 'savedAt': data.get('savedAt')})
            except (OSError, ValueError, TypeError, KeyError):
                self.reply(500, {'error': '無法讀取已儲存的選擇；可能有共用欄位被移除，原檔仍保留'})
            return
        super().do_GET()

    def do_POST(self):
        if self.path not in {'/api/selection', '/api/sync-documents'}:
            self.reply(404, {'error': '找不到此功能'})
            return
        host = self.headers.get('Host', '')
        origin = self.headers.get('Origin')
        if host not in {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'} or (origin and origin not in {f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}'}):
            self.reply(403, {'error': '請從本機選擇頁儲存'})
            return
        try:
            if self.path == '/api/sync-documents':
                with WRITE_LOCK:
                    catalog = load_catalog()
                    sync_documents(read_selection(), catalog)
                self.reply(200, {'revision': catalog['revision'], 'planUrl': '/api/plan'})
                return
            size = int(self.headers.get('Content-Length', '0'))
            if size <= 0 or size > 256000:
                raise ValueError('資料大小不正確')
            received = json.loads(self.rfile.read(size).decode('utf-8'))
            with WRITE_LOCK:
                catalog = load_catalog()
                data = validate_selection(received, catalog)
                data['savedAt'] = datetime.now(timezone.utc).isoformat()
                sync_documents(data, catalog, save_selection=True)
            outputs = [ROOT / '選擇結果.json', ROOT / '畫面資料規劃.md',
                       PLANNING_ROOT / '中央氣象署/鄉鎮市GT.md', PLANNING_ROOT / '中央氣象署/未來整包.md',
                       PLANNING_ROOT / '中央氣象署/官方意思核對紀錄.md']
            self.reply(200, {'savedAt': data['savedAt'], 'catalogRevision': catalog['revision'], 'planUrl': '/api/plan', 'outputs': [path.relative_to(PROJECT_ROOT).as_posix() for path in outputs]})
        except (ValueError, TypeError, UnicodeError, KeyError):
            self.reply(400, {'error': '無法儲存，請檢查共用目錄、欄位及備註；原選擇與備註仍保留'})
        except OSError:
            self.reply(500, {'error': '檔案寫入失敗，請稍後重試'})


def picker_is_running(url):
    try:
        with urllib.request.urlopen(url + 'api/catalog', timeout=2) as response:
            data = json.load(response)
        return [section['id'] for section in data['sections']] == ['now', 'hourly', 'week']
    except (OSError, ValueError, TypeError, KeyError):
        return False


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--open-browser', action='store_true', help='開啟瀏覽器；選擇頁已啟動時沿用原服務')
    args = parser.parse_args(argv)
    url = f'http://127.0.0.1:{args.port}/'
    if args.open_browser and picker_is_running(url):
        print('選擇頁已經開著，正在開啟瀏覽器。', flush=True)
        webbrowser.open(url)
        return
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    try:
        sync_documents(read_selection(), load_catalog())
        url = f'http://127.0.0.1:{server.server_port}/'
        print(f'Local: {url}', flush=True)
        if args.open_browser:
            print('請保留這個視窗；關閉視窗或按 Ctrl+C 就會停止服務。', flush=True)
            webbrowser.open(url)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
