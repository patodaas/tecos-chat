# Tecos Chat · UAG 🦅

Chat grupal distribuido. El mismo `server.py` sirve para todos los casos.

## Instalación

```bash
pip install websockets
```

Necesitas `server.py`, `index.html` y la carpeta `static/` en la misma carpeta.
El archivo `static/styles.css` contiene los estilos del chat y `static/app.js`
contiene la lógica del navegador.
La imagen `static/default_pfp.webp` se usa como foto de perfil default.
El navegador guarda la cuenta en `localStorage`, así que si abres otra pestaña
se reutilizan automáticamente el mismo nombre y la misma foto de perfil.
La cuenta usa un ID generado en el navegador; el nombre es solo visible y puede
cambiar sin confundirse con otra persona que use el mismo nombre.
Desde el header puedes editar el perfil; los cambios se comparten con la lista
de usuarios conectados.

El subtítulo del chat muestra los usuarios conectados. Cada navegador avisa su
presencia por WebSocket y los servidores intercambian esa lista por HTTP.

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

## Enviar archivos

Desde el chat puedes presionar el icono de clip para adjuntar un archivo de
hasta 20 MB. Las imágenes se muestran como vista previa y cualquier archivo se
puede descargar desde la burbuja del mensaje.

La subida del archivo se hace por HTTP con `POST /upload`, atendido por un
servidor HTTP con hilos independientes. El WebSocket solo manda el mensaje con
la metadata y el enlace de descarga, así el envío de mensajes no carga los 20 MB.

Los archivos se sirven desde `GET /files/<id>`. Si usas puertos personalizados,
la URL que imprime el servidor incluye `h1`, `h2`, `p1` y `p2` para que el
navegador sepa a qué puerto HTTP subir archivos y a qué puerto WS conectarse.
Cada archivo subido se replica al peer con `POST /sync-file`, así ambos
servidores pueden servir una copia local del adjunto.

También puedes grabar notas de voz desde el botón de micrófono. El navegador
las sube como archivo de audio y el chat las muestra con un reproductor.
Por seguridad del navegador, el micrófono solo funciona en `localhost`,
`127.0.0.1` o usando HTTPS. Si abres el chat desde otra computadora con una IP
tipo `http://192.168.x.x:8000`, el navegador puede bloquear el micrófono.

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
