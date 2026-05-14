"""
Tecos Chat - Servidor
Uso:
    python server.py --peer-ip <IP_DEL_OTRO_SERVER>

Opciones:
    --peer-ip   IP de la otra máquina              (requerido)
    --http      Puerto HTTP de este servidor        (default: 8000)
    --ws        Puerto WebSocket de este servidor   (default: 9000)
    --peer-http Puerto HTTP del peer                (default: 8000)

Ejemplo en Máquina A (192.168.1.10):
    python server.py --peer-ip 192.168.1.20

Ejemplo en Máquina B (192.168.1.20):
    python server.py --peer-ip 192.168.1.10
"""

import asyncio, json, threading, urllib.request, argparse, socket
from http.server import HTTPServer, BaseHTTPRequestHandler
import websockets

# ── Argumentos ────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser(description="Tecos Chat Server")
parser.add_argument("--peer-ip",   default=None,        help="IP del otro servidor (opcional)")
parser.add_argument("--http",      type=int, default=8000, help="Puerto HTTP (default 8000)")
parser.add_argument("--ws",        type=int, default=9000, help="Puerto WebSocket (default 9000)")
parser.add_argument("--peer-http", type=int, default=8000, help="Puerto HTTP del peer (default 8000)")
parser.add_argument("--peer-ws",   type=int, default=9000, help="Puerto WS del peer (default 9000)")
args = parser.parse_args()

HTTP_PORT = args.http
WS_PORT   = args.ws
def _is_self(ip, port):
    """Devuelve True si la IP:puerto apuntan a este mismo proceso."""
    import socket as _socket
    if ip in ("localhost", "127.0.0.1") and port == args.http:
        return True
    try:
        # Obtener todas las IPs locales
        hostname = _socket.gethostname()
        local_ips = set(_socket.gethostbyname_ex(hostname)[2])
        local_ips.add("127.0.0.1")
        return ip in local_ips and port == args.http
    except Exception:
        return False

PEER_HTTP = (
    f"http://{args.peer_ip}:{args.peer_http}"
    if args.peer_ip and not _is_self(args.peer_ip, args.peer_http)
    else None
)

messages = []
clients  = set()
loop     = None

# ── Detectar IP propia para mostrarla al arrancar ─────────────────────────────

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "localhost"

# ── Lógica de mensajes ────────────────────────────────────────────────────────

def fetch_history_from_peer():
    if not PEER_HTTP:
        print("[·] Sin peer configurado, arrancando solo")
        return
    try:
        res = urllib.request.urlopen(f"{PEER_HTTP}/messages", timeout=3)
        peer_msgs = json.loads(res.read())
        messages.extend(peer_msgs)
        print(f"[✓] Historial sincronizado desde peer ({len(peer_msgs)} mensajes)")
    except Exception:
        print("[·] Peer no disponible al arrancar, empezando limpio")

async def broadcast(data, skip=None):
    """Manda data a todos los clientes WS, opcionalmente saltando a skip."""
    dead = set()
    for ws in list(clients):
        if ws is skip:
            continue
        try:
            await ws.send(data)
        except Exception:
            dead.add(ws)
    clients.difference_update(dead)

def push_to_peer(msg):
    if not PEER_HTTP:
        return
    try:
        body = json.dumps(msg).encode()
        req  = urllib.request.Request(
            f"{PEER_HTTP}/sync", data=body,
            headers={"Content-Type": "application/json"}, method="POST"
        )
        urllib.request.urlopen(req, timeout=2)
    except Exception:
        pass  # peer offline, sin problema

# ── HTTP server ───────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            try:
                with open("index.html", "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(data)
            except FileNotFoundError:
                self.send_response(404); self.end_headers()

        elif self.path == "/messages":
            data = json.dumps(messages).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)

        else:
            self.send_response(404); self.end_headers()

    def do_POST(self):
        if self.path == "/sync":
            length = int(self.headers.get("Content-Length", 0))
            msg = json.loads(self.rfile.read(length))
            messages.append(msg)
            # Broadcast a todos los clientes de este servidor
            if loop:
                asyncio.run_coroutine_threadsafe(
                    broadcast(json.dumps(msg)), loop
                )
            self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
        else:
            self.send_response(404); self.end_headers()

# ── WebSocket server ──────────────────────────────────────────────────────────

async def ws_handler(ws):
    clients.add(ws)
    await ws.send(json.dumps({"type": "history", "messages": messages}))
    try:
        async for raw in ws:
            msg = json.loads(raw)
            msg["type"] = "message"
            messages.append(msg)
            # Broadcast a todos MENOS al emisor
            await broadcast(json.dumps(msg), skip=ws)
            # Sincronizar al peer
            threading.Thread(target=push_to_peer, args=(msg,), daemon=True).start()
    except Exception:
        pass
    finally:
        clients.discard(ws)

# ── Main ──────────────────────────────────────────────────────────────────────

async def main():
    global loop
    loop = asyncio.get_running_loop()

    fetch_history_from_peer()

    threading.Thread(
        target=lambda: HTTPServer(("0.0.0.0", HTTP_PORT), Handler).serve_forever(),
        daemon=True
    ).start()

    mi_ip = get_local_ip()
    print(f"")
    print(f"  ══════════════════════════════════════")
    print(f"       TECOS CHAT · UAG  🦅")
    print(f"  ══════════════════════════════════════")
    print(f"  HTTP  →  http://{mi_ip}:{HTTP_PORT}")
    print(f"  WS    →  ws://{mi_ip}:{WS_PORT}")
    print(f"  Peer  →  {PEER_HTTP or 'ninguno (modo solo)'}")
    print(f"")
    print(f"  Clientes: abre el navegador en")
    peer_display = args.peer_ip or mi_ip
    print(f"  http://{mi_ip}:{HTTP_PORT}?s1={mi_ip}&s2={peer_display}")
    print(f"  ══════════════════════════════════════")
    print(f"")

    async with websockets.serve(ws_handler, "0.0.0.0", WS_PORT):
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())