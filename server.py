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

import asyncio, json, threading, urllib.request, argparse, socket, base64, uuid, mimetypes
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import unquote, urlparse
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

# Carpeta raiz del proyecto. Se usa para ubicar index.html y static/.
BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

# Limites de seguridad para que un archivo grande no bloquee el chat.
MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_UPLOAD_PAYLOAD_BYTES = 30 * 1024 * 1024
MAX_WS_PAYLOAD_BYTES = 256 * 1024

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
uploads   = {}
clients  = set()
loop     = None

# ── Detectar IP propia para mostrarla al arrancar ─────────────────────────────

def get_local_ip():
    """Obtiene la IP local que otros equipos de la red pueden abrir."""
    try:
        # No envia datos reales; solo fuerza al sistema a elegir una interfaz de red.
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "localhost"

# ── Lógica de mensajes ────────────────────────────────────────────────────────

def fetch_history_from_peer():
    """Al arrancar, pide el historial al otro servidor para iniciar sincronizado."""
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
        # Si skip es el emisor, evitamos mandarle de vuelta su propio mensaje.
        if ws is skip:
            continue
        try:
            await ws.send(data)
        except Exception:
            # Si un cliente ya se desconecto, lo quitamos despues del ciclo.
            dead.add(ws)
    clients.difference_update(dead)

def push_to_peer(msg):
    """Envia un mensaje al otro servidor por HTTP para mantener ambos historiales iguales."""
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

def send_json(handler, status, payload):
    """Responde JSON desde el servidor HTTP."""
    data = json.dumps(payload).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(data)

def add_cors_headers(handler):
    """Permite que el navegador suba archivos aunque use otra IP/puerto del mismo chat."""
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")

def parse_data_url(data_url):
    """Convierte un data URL del navegador a bytes reales del archivo."""
    if not isinstance(data_url, str) or not data_url.startswith("data:") or "," not in data_url:
        return None, None

    # El formato esperado es: data:<mime>;base64,<contenido>
    header, encoded = data_url.split(",", 1)
    mime = header[5:].split(";", 1)[0] or "application/octet-stream"
    try:
        content = base64.b64decode(encoded, validate=True)
    except Exception:
        return None, None

    return mime, content

def upload_url(handler, file_id):
    """Construye la URL publica que los clientes usaran para ver o descargar el archivo."""
    host = handler.headers.get("Host") or f"{get_local_ip()}:{HTTP_PORT}"
    return f"http://{host}/files/{file_id}"

def prepare_message(raw):
    """Limpia y valida cualquier mensaje antes de guardarlo o reenviarlo."""
    if not isinstance(raw, dict):
        return None

    # Normalizamos texto, usuario y hora para evitar datos demasiado largos.
    msg = {
        "type": "message",
        "user": str(raw.get("user", "Anonimo"))[:30],
        "avatar": str(raw.get("avatar", "/static/default_pfp.webp"))[:500],
        "text": str(raw.get("text", ""))[:500],
        "time": str(raw.get("time", ""))[:20],
    }

    file_meta = raw.get("file")
    if isinstance(file_meta, dict):
        try:
            size = int(file_meta.get("size", 0))
        except (TypeError, ValueError):
            size = 0

        # El WebSocket solo acepta metadata del archivo, no el archivo completo.
        url = str(file_meta.get("url", ""))
        if 0 < size <= MAX_FILE_BYTES and url.startswith(("http://", "https://")):
            msg["file"] = {
                "id": str(file_meta.get("id", ""))[:80],
                "name": str(file_meta.get("name", "archivo"))[:120],
                "type": str(file_meta.get("type", "application/octet-stream"))[:100],
                "size": size,
                "url": url[:500],
            }

    if not msg["text"] and "file" not in msg:
        return None

    return msg

def send_static_file(handler, path):
    """Sirve archivos de la carpeta static sin permitir salir de esa carpeta."""
    relative_path = unquote(path.removeprefix("/static/"))
    file_path = (STATIC_DIR / relative_path).resolve()

    # Evita rutas como /static/../server.py.
    try:
        file_path.relative_to(STATIC_DIR.resolve())
    except ValueError:
        handler.send_response(404)
        handler.end_headers()
        return

    if not file_path.is_file():
        handler.send_response(404)
        handler.end_headers()
        return

    content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    data = file_path.read_bytes()
    handler.send_response(200)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)

# ── HTTP server ───────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    """Manejador HTTP: entrega la pagina, archivos estaticos, uploads y sincronizacion."""

    # Silenciamos el log default para que la consola solo muestre mensajes utiles del chat.
    def log_message(self, *_): pass

    def do_OPTIONS(self):
        """Responde preflight CORS usado por fetch antes de subir archivos."""
        self.send_response(204)
        add_cors_headers(self)
        self.end_headers()

    def do_GET(self):
        """Atiende lecturas HTTP: HTML, CSS, historial y archivos subidos."""
        path = urlparse(self.path).path

        if path in ("/", "/index.html"):
            try:
                # Entrega la interfaz principal del chat.
                with open(BASE_DIR / "index.html", "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(data)
            except FileNotFoundError:
                self.send_response(404); self.end_headers()

        elif path.startswith("/static/"):
            # Entrega CSS u otros assets publicos guardados en static/.
            send_static_file(self, path)

        elif path == "/messages":
            # Devuelve el historial completo cuando un servidor arranca o un cliente entra.
            data = json.dumps(messages).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            add_cors_headers(self)
            self.end_headers()
            self.wfile.write(data)

        elif path.startswith("/files/"):
            # Entrega un archivo subido previamente por /upload.
            file_id = unquote(path.removeprefix("/files/"))
            file_data = uploads.get(file_id)
            if not file_data:
                self.send_response(404); self.end_headers(); return

            # Sanitizamos el nombre para usarlo dentro del header Content-Disposition.
            safe_name = file_data["name"].replace("\\", "_").replace('"', "'")
            self.send_response(200)
            self.send_header("Content-Type", file_data["type"])
            self.send_header("Content-Length", str(file_data["size"]))
            self.send_header("Content-Disposition", f'inline; filename="{safe_name}"')
            add_cors_headers(self)
            self.end_headers()
            self.wfile.write(file_data["content"])

        else:
            self.send_response(404); self.end_headers()

    def do_POST(self):
        """Atiende escrituras HTTP: subida de archivos y sincronizacion entre servidores."""
        path = urlparse(self.path).path

        if path == "/upload":
            # El navegador envia aqui el archivo en base64 antes de mandar el mensaje WS.
            length = int(self.headers.get("Content-Length", 0))
            if length > MAX_UPLOAD_PAYLOAD_BYTES:
                send_json(self, 413, {"error": "Archivo demasiado grande"}); return

            try:
                # Leemos el JSON con name, type y data.
                payload = json.loads(self.rfile.read(length))
            except Exception:
                send_json(self, 400, {"error": "JSON invalido"}); return

            # Convertimos el data URL a bytes y validamos que no pase de 20 MB.
            mime, content = parse_data_url(payload.get("data"))
            if not content:
                send_json(self, 400, {"error": "Archivo invalido"}); return
            if len(content) > MAX_FILE_BYTES:
                send_json(self, 413, {"error": "El archivo supera 20 MB"}); return

            # Guardamos el archivo en memoria con un id unico.
            file_id = uuid.uuid4().hex
            uploads[file_id] = {
                "content": content,
                "name": str(payload.get("name", "archivo"))[:120],
                "type": str(payload.get("type") or mime)[:100],
                "size": len(content),
            }
            # Respondemos solo metadata; el mensaje de chat usara esta URL.
            send_json(self, 200, {
                "id": file_id,
                "name": uploads[file_id]["name"],
                "type": uploads[file_id]["type"],
                "size": uploads[file_id]["size"],
                "url": upload_url(self, file_id),
            })

        elif path == "/sync":
            # Otro servidor envia aqui mensajes para mantener el historial replicado.
            length = int(self.headers.get("Content-Length", 0))
            if length > MAX_WS_PAYLOAD_BYTES:
                self.send_response(413); self.end_headers(); return
            try:
                # Validamos el mensaje recibido antes de guardarlo.
                msg = prepare_message(json.loads(self.rfile.read(length)))
            except Exception:
                self.send_response(400); self.end_headers(); return
            if not msg:
                self.send_response(400); self.end_headers(); return
            messages.append(msg)
            # Avisamos a todos los clientes conectados a este servidor.
            if loop:
                asyncio.run_coroutine_threadsafe(
                    broadcast(json.dumps(msg)), loop
                )
            self.send_response(200)
            add_cors_headers(self)
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_response(404); self.end_headers()

# ── WebSocket server ──────────────────────────────────────────────────────────

async def ws_handler(ws):
    """Maneja una conexion WebSocket de un navegador."""
    # Guardamos el cliente para poder enviarle mensajes futuros.
    clients.add(ws)

    # Apenas se conecta, recibe todo el historial acumulado.
    await ws.send(json.dumps({"type": "history", "messages": messages}))
    try:
        async for raw in ws:
            # Cada mensaje entrante debe ser JSON y pasar por prepare_message.
            msg = prepare_message(json.loads(raw))
            if not msg:
                continue

            # Se guarda localmente, se manda a otros clientes y se replica al peer.
            messages.append(msg)
            await broadcast(json.dumps(msg), skip=ws)
            threading.Thread(target=push_to_peer, args=(msg,), daemon=True).start()
    except Exception:
        # Si el navegador se cierra o manda algo invalido, cerramos la conexion sin tumbar el server.
        pass
    finally:
        # Al salir, quitamos el cliente para no intentar escribirle despues.
        clients.discard(ws)

# ── Main ──────────────────────────────────────────────────────────────────────

async def main():
    global loop

    # Guardamos el loop principal para que el hilo HTTP pueda programar broadcasts WS.
    loop = asyncio.get_running_loop()

    # Antes de aceptar clientes, intentamos copiar el historial del peer.
    fetch_history_from_peer()

    # El servidor HTTP corre en un hilo separado; ThreadingHTTPServer crea hilos por request.
    threading.Thread(
        target=lambda: ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), Handler).serve_forever(),
        daemon=True
    ).start()

    # Mostramos datos utiles para abrir el chat desde otros dispositivos.
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
    print(
        f"  http://{mi_ip}:{HTTP_PORT}"
        f"?s1={mi_ip}&s2={peer_display}"
        f"&p1={WS_PORT}&p2={args.peer_ws}"
        f"&h1={HTTP_PORT}&h2={args.peer_http}"
    )
    print(f"  ══════════════════════════════════════")
    print(f"")

    # El servidor WebSocket queda escuchando mensajes livianos, no archivos completos.
    async with websockets.serve(
        ws_handler, "0.0.0.0", WS_PORT, max_size=MAX_WS_PAYLOAD_BYTES
    ):
        # Future vacio para mantener vivo el proceso indefinidamente.
        await asyncio.Future()

if __name__ == "__main__":
    # Punto de entrada cuando se ejecuta: python server.py
    asyncio.run(main())
