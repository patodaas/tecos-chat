# Tecos Chat · UAG 🦅

Chat grupal distribuido. El mismo `server.py` sirve para todos los casos.

## Instalación

```bash
pip install websockets
```

Necesitas `server.py` e `index.html` en la misma carpeta.

---

## Caso 1 — Un solo servidor, una sola máquina

La forma más simple. Todo corre en tu máquina y cualquiera en tu red puede entrar.

```bash
python server.py
```

Comparte esta URL con los demás:
```
http://192.168.1.3:8000
```

---

## Caso 2 — Dos servidores en máquinas diferentes

Copia `server.py` e `index.html` en **ambas máquinas** y corre en cada una:

**Máquina A** (ej. 192.168.1.3):
```bash
python server.py --peer-ip 192.168.1.20
```

**Máquina B** (ej. 192.168.1.20):
```bash
python server.py --peer-ip 192.168.1.3
```

Al arrancar, cada servidor imprime la URL lista para compartir:
```
http://192.168.1.3:8000?s1=192.168.1.3&s2=192.168.1.20
```

Cualquiera que abra esa URL se conecta a uno de los dos servidores al azar.
Si ese servidor se cae, el browser brinca al otro automáticamente.

> **Tip:** el orden de arranque no importa. Si el peer no está disponible al
> iniciar, el servidor arranca solo y sincroniza cuando el peer se conecte.

---

## Opciones disponibles

| Argumento     | Default | Descripción                       |
|---------------|---------|-----------------------------------|
| `--peer-ip`   | ninguno | IP de la otra máquina             |
| `--http`      | 8000    | Puerto HTTP de este servidor      |
| `--ws`        | 9000    | Puerto WebSocket de este servidor |
| `--peer-http` | 8000    | Puerto HTTP del peer              |
| `--peer-ws`   | 9000    | Puerto WS del peer                |

Ejemplo con puertos personalizados:
```bash
# Máquina A
python server.py --peer-ip 192.168.1.20 --http 8080 --ws 9090

# Máquina B
python server.py --peer-ip 192.168.1.3 --http 8080 --ws 9090 --peer-http 8080 --peer-ws 9090
```

---

## Cómo funciona por dentro

```
Cualquier dispositivo en la red
          │
          │  Abre http://IP:8000
          │  El servidor entrega el index.html
          │
          │  El browser elige servidor al azar (S1 o S2)
          │  y abre conexión WebSocket
          ▼
   ┌─────────────┐            ┌─────────────┐
   │  Servidor A  │            │  Servidor B  │
   │  :8000/:9000 │◄─ /sync ──►│  :8000/:9000 │
   └─────────────┘            └─────────────┘
```

- Cuando un usuario manda un mensaje, su servidor lo guarda y lo reenvía
  al peer via `POST /sync`.
- El peer lo recibe, lo guarda y se lo manda a sus clientes conectados.
- Si un servidor se cae, el browser detecta la desconexión y en 2 segundos
  intenta conectarse al otro. Si ese también falla, reintenta cada 3s.
- Al arrancar, cada servidor le pide el historial completo al peer via
  `GET /messages` para que ambos estén sincronizados desde el inicio.
