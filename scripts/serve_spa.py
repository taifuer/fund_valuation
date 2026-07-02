from __future__ import annotations

import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


class SpaRequestHandler(SimpleHTTPRequestHandler):
    directory_path = Path("dist").resolve()

    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, directory=str(self.directory_path), **kwargs)

    def do_GET(self) -> None:
        request_path = unquote(urlparse(self.path).path).lstrip("/")
        candidate = (self.directory_path / request_path).resolve()
        if candidate.is_relative_to(self.directory_path) and candidate.is_file():
            super().do_GET()
            return
        self.path = "/index.html"
        super().do_GET()


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve a production SPA build with history fallback")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5173)
    parser.add_argument("--directory", type=Path, default=Path("dist"))
    args = parser.parse_args()
    SpaRequestHandler.directory_path = args.directory.resolve()
    server = ThreadingHTTPServer((args.host, args.port), SpaRequestHandler)
    print(f"SPA preview listening on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
