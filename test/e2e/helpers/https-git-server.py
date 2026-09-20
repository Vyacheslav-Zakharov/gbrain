"""Disposable loopback-only smart Git fixture; never a production service."""
import http.server
import os
import pathlib
import ssl
import subprocess
import sys
import threading

repo, certdir = map(pathlib.Path, sys.argv[1:3])
# Explicit allowlist: no operator Git configuration, proxy or credentials.
env = {"PATH": "/usr/bin:/bin", "HOME": str(certdir),
       "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
       "GIT_CONFIG_COUNT": "0", "GIT_TERMINAL_PROMPT": "0"}

def command(args):
    subprocess.run(args, cwd=certdir, env=env, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=10)

command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
         "-subj", "/CN=Disposable Git Test CA", "-keyout", "ca.key", "-out", "ca.pem",
         "-addext", "basicConstraints=critical,CA:TRUE"])
command(["openssl", "req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost",
         "-keyout", "server.key", "-out", "server.csr"])
(certdir / "extensions").write_text("subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n")
command(["openssl", "x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key",
         "-CAcreateserial", "-days", "1", "-extfile", "extensions", "-out", "server.pem"])

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.backend()

    def do_POST(self):
        self.backend()

    def backend(self):
        self.connection.settimeout(10)
        path, _, query = self.path.partition("?")
        if (self.command, path, query) not in [
            ("GET", "/repo.git/info/refs", "service=git-upload-pack"),
            ("POST", "/repo.git/git-upload-pack", "")]:
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > 1024 * 1024 or self.headers.get("Transfer-Encoding"):
            self.send_error(413)
            return
        cgi = {**env, "GIT_PROJECT_ROOT": str(certdir), "GIT_HTTP_EXPORT_ALL": "1",
               "PATH_INFO": path, "QUERY_STRING": query, "REQUEST_METHOD": self.command,
               "CONTENT_TYPE": self.headers.get("Content-Type", ""),
               "CONTENT_LENGTH": str(length), "REMOTE_ADDR": "127.0.0.1",
               "GIT_PROTOCOL": self.headers.get("Git-Protocol", "")}
        # timeout owns backend + upload-pack process group; kill escalation is finite.
        result = subprocess.run(["timeout", "--signal=TERM", "--kill-after=1s", "10s",
                                 "git", "http-backend"], env=cgi,
                                input=self.rfile.read(length), capture_output=True, timeout=13)
        if result.returncode:
            self.send_error(502)
            return
        headers, body = result.stdout.split(b"\r\n\r\n", 1)
        pairs = [line.decode().split(":", 1) for line in headers.split(b"\r\n")]
        status = next((int(v.strip().split()[0]) for k, v in pairs if k.lower() == "status"), 200)
        self.send_response(status)
        for key, value in pairs:
            if key.lower() != "status":
                self.send_header(key, value.strip())
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

(certdir / "repo.git").symlink_to(repo, target_is_directory=True)
server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
server.timeout = 1
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.minimum_version = ssl.TLSVersion.TLSv1_2
context.load_cert_chain(certdir / "server.pem", certdir / "server.key")
server.socket = context.wrap_socket(server.socket, server_side=True)
# EOF from parent or fixed lifetime shuts down even after failed test setup.
def parent_watch():
    sys.stdin.buffer.read()
    server.shutdown()
threading.Thread(target=parent_watch, daemon=True).start()
watchdog = threading.Timer(240, server.shutdown)
watchdog.daemon = True
watchdog.start()
print(server.server_port, flush=True)
try:
    server.serve_forever(poll_interval=0.1)
finally:
    watchdog.cancel()
    server.server_close()
