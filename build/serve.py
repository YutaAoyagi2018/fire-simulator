"""web/ をキャッシュなしで配信する（古いファイルが残って画面が崩れるのを防ぐ）。

  python build/serve.py [port]
"""
import functools
import http.server
import sys
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
    handler = functools.partial(NoCache, directory=str(WEB))
    print(f"http://127.0.0.1:{port}/ で配信中（Ctrl+C で終了）")
    http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
