  // Guarda la conexion WebSocket activa con el servidor elegido.
  let ws = null;

  // Nombre que escribe el usuario en la pantalla de entrada.
  let miNombre = "";

  // Timer usado cuando ambos servidores fallan y toca reintentar despues.
  let reconnectTimer = null;

  // Archivo elegido en el input tipo file, antes de subirlo por HTTP.
  let archivoSeleccionado = null;

  // Limite de archivo permitido: 20 MB.
  const MAX_FILE_BYTES = 20 * 1024 * 1024;

  // Construye las URLs WebSocket de los dos servidores.
  // Los valores salen de la URL: ?s1=IP&s2=IP&p1=PUERTO_WS&p2=PUERTO_WS.
  function buildServers() {
    const params = new URLSearchParams(window.location.search);
    const host = window.location.hostname || "192.168.1.3";
    const ip1 = params.get("s1") || host;
    const ip2 = params.get("s2") || host;
    const p1 = params.get("p1") || "9000";
    const p2 = params.get("p2") || "9000";
    return [`ws://${ip1}:${p1}`, `ws://${ip2}:${p2}`];
  }

  // Construye las URLs HTTP de los dos servidores.
  // Estas URLs se usan para subir archivos a /upload.
  function buildHttpServers() {
    const params = new URLSearchParams(window.location.search);
    const host = window.location.hostname || "192.168.1.3";
    const ip1 = params.get("s1") || host;
    const ip2 = params.get("s2") || host;
    const h1 = params.get("h1") || "8000";
    const h2 = params.get("h2") || "8000";
    return [`http://${ip1}:${h1}`, `http://${ip2}:${h2}`];
  }

  // Lista de servidores WebSocket disponibles para mensajes.
  const SERVERS = buildServers();

  // Lista de servidores HTTP disponibles para subir y descargar archivos.
  const HTTP_SERVERS = buildHttpServers();

  // Indice del servidor actual: 0 para Servidor 1, 1 para Servidor 2.
  let servidorActual = null;

  // Bandera para saber si ya intentamos cambiar al servidor alterno.
  let intentoFallback = false;

  // Elige aleatoriamente a que servidor se conectara el navegador.
  function servidorRandom() {
    return Math.random() < 0.5 ? 0 : 1;
  }

  // Entra al chat despues de validar que el usuario escribio un nombre.
  function entrar() {
    const nombre = document.getElementById("name-input").value.trim();
    if (!nombre) {
      alert("Ponle tu nombre pls 😄");
      return;
    }

    // Guardamos el nombre para identificar mensajes propios y ajenos.
    miNombre = nombre;

    // Escogemos servidor inicial al azar para repartir conexiones.
    servidorActual = servidorRandom();
    intentoFallback = false;

    // Ocultamos login y mostramos la interfaz del chat.
    document.getElementById("login-screen").style.display = "none";
    document.getElementById("chat-screen").style.display = "flex";

    // Abrimos la conexion WebSocket.
    conectar();
  }

  // Abre una conexion WebSocket contra el servidor actual.
  function conectar() {
    // Si habia una conexion anterior, la cerramos antes de abrir otra.
    if (ws) {
      try { ws.close(); } catch (_) {}
    }

    // Tomamos la URL WS y actualizamos la etiqueta visual del servidor.
    const url = SERVERS[servidorActual];
    const num = servidorActual + 1;
    document.getElementById("server-tag").textContent = `Servidor ${num}`;

    // Creamos la conexion WebSocket.
    ws = new WebSocket(url);

    // Si no conecta en 2 segundos, intentamos con el otro servidor.
    const connectionTimeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        ws.close();
        intentarFallback();
      }
    }, 2000);

    // Cuando la conexion abre correctamente, marcamos estado online.
    ws.onopen = () => {
      clearTimeout(connectionTimeout);
      intentoFallback = false;
      setStatus(true);
      document.getElementById("offline-banner").style.display = "none";

      // Cancelamos cualquier reintento pendiente porque ya estamos conectados.
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      agregarSistema(`Conectado al Servidor ${num} ✓`);
    };

    // Procesa mensajes que llegan desde el servidor.
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);

      // history llega al conectarse y trae todos los mensajes anteriores.
      if (data.type === "history") {
        data.messages.forEach(m => renderMensaje(m));
        return;
      }

      // message llega cuando otro usuario manda algo nuevo.
      if (data.type === "message") {
        renderMensaje(data);
      }
    };

    // Si se cierra la conexion, primero probamos el otro servidor.
    ws.onclose = () => {
      clearTimeout(connectionTimeout);

      if (!intentoFallback) {
        intentarFallback();
        return;
      }

      // Si ambos servidores fallaron, mostramos banner y reintentamos cada 3 segundos.
      setStatus(false);
      document.getElementById("offline-banner").style.display = "block";
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          intentoFallback = false;
          conectar();
        }, 3000);
      }
    };

    // No hacemos nada aqui porque onclose centraliza la recuperacion.
    ws.onerror = () => {};
  }

  // Cambia al servidor alterno cuando el actual no responde.
  function intentarFallback() {
    intentoFallback = true;
    servidorActual = servidorActual === 0 ? 1 : 0;

    const num = servidorActual + 1;
    agregarSistema(`Intentando Servidor ${num}...`);
    setStatus(false);
    document.getElementById("offline-banner").style.display = "block";
    conectar();
  }

  // Cambia el punto visual del header entre online y offline.
  function setStatus(online) {
    const dot = document.getElementById("status-dot");
    dot.className = online ? "online" : "offline";
  }

  // Envia un mensaje de texto y, si existe, primero sube el archivo por HTTP.
  async function enviar() {
    const input = document.getElementById("msg-input");
    const texto = input.value.trim();

    // No enviamos mensajes vacios ni intentamos mandar si el WS esta cerrado.
    if ((!texto && !archivoSeleccionado) || !ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // Mensaje base: usuario, texto y hora visible en la burbuja.
    const msg = {
      user: miNombre,
      text: texto,
      time: new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })
    };

    // Si hay archivo seleccionado, se sube por HTTP antes de mandar el mensaje WS.
    if (archivoSeleccionado) {
      try {
        mostrarSubida("Subiendo archivo...");
        msg.file = await subirArchivo(archivoSeleccionado);
      } catch (_) {
        alert("No se pudo subir el archivo.");
        mostrarArchivoSeleccionado();
        return;
      }
    }

    // La subida puede tardar; revisamos otra vez que el WebSocket siga abierto.
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      alert("Se perdió la conexión antes de enviar el mensaje.");
      mostrarArchivoSeleccionado();
      return;
    }

    // Mandamos el mensaje liviano por WebSocket.
    ws.send(JSON.stringify(msg));

    // Renderizamos localmente el mensaje propio sin esperar rebote del servidor.
    renderMensaje(msg);

    // Limpiamos caja de texto y archivo seleccionado.
    input.value = "";
    quitarArchivo();
    input.focus();
  }

  // Sube el archivo al endpoint HTTP /upload del servidor conectado.
  async function subirArchivo(file) {
    // El navegador lee el archivo como data URL para mandarlo dentro de JSON.
    const data = await leerArchivoComoDataUrl(file);

    // Usamos el servidor HTTP equivalente al servidor WebSocket actual.
    const res = await fetch(`${HTTP_SERVERS[servidorActual]}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        type: file.type || "application/octet-stream",
        data
      })
    });

    // Si el servidor responde error, avisamos a enviar() con una excepcion.
    if (!res.ok) {
      throw new Error("upload failed");
    }

    // Respuesta esperada: id, name, type, size y url del archivo.
    return await res.json();
  }

  // Lee un File del navegador y lo convierte a data URL base64.
  function leerArchivoComoDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // Muestra el chip con nombre y peso del archivo seleccionado.
  function mostrarArchivoSeleccionado() {
    const chip = document.getElementById("selected-file");
    const name = document.getElementById("selected-file-name");

    // Si no hay archivo, ocultamos el chip.
    if (!archivoSeleccionado) {
      chip.style.display = "none";
      name.textContent = "";
      return;
    }

    // Si hay archivo, mostramos nombre y tamano legible.
    name.textContent = `${archivoSeleccionado.name} · ${formatearBytes(archivoSeleccionado.size)}`;
    chip.style.display = "flex";
  }

  // Cambia temporalmente el chip para indicar que el archivo se esta subiendo.
  function mostrarSubida(texto) {
    const chip = document.getElementById("selected-file");
    const name = document.getElementById("selected-file-name");
    name.textContent = texto;
    chip.style.display = "flex";
  }

  // Quita el archivo seleccionado y limpia el input file.
  function quitarArchivo() {
    archivoSeleccionado = null;
    document.getElementById("file-input").value = "";
    mostrarArchivoSeleccionado();
  }

  // Convierte bytes a B, KB, MB o GB para mostrarlos en pantalla.
  function formatearBytes(bytes) {
    if (!bytes) {
      return "0 B";
    }

    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  // Permite enviar con Enter cuando el usuario esta escribiendo en el input.
  document.addEventListener("keydown", (e) => {
    const input = document.getElementById("msg-input");
    if (document.activeElement === input && e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      enviar();
    }
  });

  // Dibuja un mensaje en el contenedor del chat.
  function renderMensaje(msg) {
    const container = document.getElementById("messages");

    // Un mensaje es propio si el nombre coincide con el usuario local.
    const esPropio = msg.user === miNombre;

    // wrap alinea la burbuja a la derecha o izquierda.
    const wrap = document.createElement("div");
    wrap.className = "msg-wrap " + (esPropio ? "own" : "other");

    // Los mensajes ajenos muestran el nombre del remitente.
    if (!esPropio) {
      const name = document.createElement("div");
      name.className = "msg-name";
      name.textContent = msg.user;
      wrap.appendChild(name);
    }

    // Burbuja principal que contiene texto y/o archivo.
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    if (msg.file) {
      bubble.classList.add("has-file");
    }

    // Si hay texto, lo agregamos antes del adjunto.
    if (msg.text) {
      const text = document.createElement("div");
      text.className = msg.file ? "msg-text" : "";
      text.textContent = msg.text;
      bubble.appendChild(text);
    }

    // Si hay archivo, agregamos vista previa y tarjeta de descarga.
    if (msg.file && msg.file.url) {
      // Las imagenes se muestran dentro de la burbuja.
      if ((msg.file.type || "").startsWith("image/")) {
        const img = document.createElement("img");
        img.className = "image-attachment";
        img.src = msg.file.url;
        img.alt = msg.file.name || "Imagen adjunta";
        bubble.appendChild(img);
      }

      // El enlace permite abrir o descargar el archivo.
      const link = document.createElement("a");
      link.className = "file-card";
      link.href = msg.file.url;
      link.download = msg.file.name || "archivo";
      link.target = "_blank";

      // Icono simple de archivo mostrado dentro de la tarjeta.
      const icon = document.createElement("div");
      icon.className = "file-icon";
      icon.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';

      // Contenedor de nombre y tamano del archivo.
      const info = document.createElement("div");
      info.className = "file-info";

      const fileName = document.createElement("div");
      fileName.className = "file-name";
      fileName.textContent = msg.file.name || "Archivo";

      const fileSize = document.createElement("div");
      fileSize.className = "file-size";
      fileSize.textContent = formatearBytes(msg.file.size);

      // Ensamblamos la tarjeta de archivo.
      info.appendChild(fileName);
      info.appendChild(fileSize);
      link.appendChild(icon);
      link.appendChild(info);
      bubble.appendChild(link);
    }

    // Agregamos burbuja, hora y finalmente insertamos el mensaje en pantalla.
    wrap.appendChild(bubble);

    const time = document.createElement("div");
    time.className = "msg-time";
    time.textContent = msg.time || "";
    wrap.appendChild(time);

    container.appendChild(wrap);
    container.scrollTop = container.scrollHeight;
  }

  // Agrega mensajes del sistema: conectado, intentando servidor, etc.
  function agregarSistema(texto) {
    const container = document.getElementById("messages");
    const div = document.createElement("div");
    div.className = "msg-system";
    div.textContent = texto;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  // Enfoca el nombre apenas carga la pagina.
  document.getElementById("name-input").focus();

  // Permite entrar al chat presionando Enter en el input del nombre.
  document.getElementById("name-input").addEventListener("keydown", e => {
    if (e.key === "Enter") {
      entrar();
    }
  });

  // Guarda y valida el archivo cuando el usuario lo selecciona.
  document.getElementById("file-input").addEventListener("change", e => {
    const file = e.target.files[0];

    // Si cancela el selector, limpiamos cualquier seleccion anterior.
    if (!file) {
      quitarArchivo();
      return;
    }

    // Rechazamos archivos mayores a 20 MB antes de intentar subirlos.
    if (file.size > MAX_FILE_BYTES) {
      alert("El archivo debe pesar máximo 20 MB.");
      quitarArchivo();
      return;
    }

    // Guardamos el archivo y mostramos el chip de confirmacion.
    archivoSeleccionado = file;
    mostrarArchivoSeleccionado();
  });

