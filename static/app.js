  // Guarda la conexion WebSocket activa con el servidor elegido.
  let ws = null;

  // Nombre que escribe el usuario en la pantalla de entrada.
  let miNombre = "";

  // ID estable de la cuenta. No cambia aunque el usuario edite su nombre.
  let miUserId = "";

  // URL de la foto de perfil que se manda junto con cada mensaje.
  let miAvatarUrl = "/static/default_pfp.webp";

  // Imagen elegida en el login antes de entrar al chat.
  let fotoPerfilSeleccionada = null;

  // Imagen nueva elegida desde el modal de editar perfil.
  let fotoPerfilEditada = null;

  // Controla la grabacion de notas de voz.
  let mediaRecorder = null;
  let audioChunks = [];

  // Timer usado cuando ambos servidores fallan y toca reintentar despues.
  let reconnectTimer = null;

  // Archivo elegido en el input tipo file, antes de subirlo por HTTP.
  let archivoSeleccionado = null;

  // Limite de archivo permitido: 20 MB.
  const MAX_FILE_BYTES = 20 * 1024 * 1024;

  // Limite especial para foto de perfil: 2 MB.
  const MAX_PROFILE_BYTES = 2 * 1024 * 1024;

  // Clave donde el navegador guarda la cuenta para reutilizarla en otras pestanas.
  const ACCOUNT_STORAGE_KEY = "tecos-chat-account";

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

  // Lista de usuarios conectados que manda el servidor.
  let usuariosConectados = [];

  // Elige aleatoriamente a que servidor se conectara el navegador.
  function servidorRandom() {
    return Math.random() < 0.5 ? 0 : 1;
  }

  // Genera un ID local suficientemente unico para identificar una cuenta del navegador.
  function generarUserId() {
    if (crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `user-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  // Entra al chat despues de validar que el usuario escribio un nombre.
  async function entrar() {
    const nombre = document.getElementById("name-input").value.trim();
    if (!nombre) {
      alert("Ponle tu nombre pls 😄");
      return;
    }

    // Guardamos el nombre para identificar mensajes propios y ajenos.
    miNombre = nombre;
    miUserId ||= generarUserId();

    // Escogemos servidor inicial al azar para repartir conexiones.
    servidorActual = servidorRandom();
    intentoFallback = false;

    // Si el usuario eligio una foto, la subimos al HTTP del servidor elegido.
    // Si falla, seguimos con la foto default para no bloquear el login.
    if (fotoPerfilSeleccionada) {
      try {
        miAvatarUrl = (await subirArchivo(fotoPerfilSeleccionada)).url;
      } catch (_) {
        alert("No se pudo subir la foto de perfil, se usará la imagen default.");
        miAvatarUrl = "/static/default_pfp.webp";
      }
    } else {
      miAvatarUrl = "/static/default_pfp.webp";
    }

    // Persistimos la cuenta para que otra pestana del mismo navegador use la misma identidad.
    guardarCuenta();

    // Ocultamos login y mostramos la interfaz del chat.
    document.getElementById("login-screen").style.display = "none";
    document.getElementById("chat-screen").style.display = "flex";
    document.getElementById("edit-profile-btn").style.display = "flex";

    // Abrimos la conexion WebSocket.
    conectar();
  }

  // Guarda la cuenta actual en localStorage del navegador.
  function guardarCuenta() {
    localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify({
      id: miUserId,
      name: miNombre,
      avatar: miAvatarUrl
    }));
  }

  // Lee la cuenta persistida. Si no existe o esta corrupta, devuelve null.
  function cargarCuentaGuardada() {
    try {
      const raw = localStorage.getItem(ACCOUNT_STORAGE_KEY);
      if (!raw) {
        return null;
      }

      const account = JSON.parse(raw);
      if (!account.name) {
        return null;
      }

      return {
        id: String(account.id || generarUserId()),
        name: String(account.name),
        avatar: String(account.avatar || "/static/default_pfp.webp")
      };
    } catch (_) {
      return null;
    }
  }

  // Si ya hay una cuenta guardada, entra automaticamente con esa identidad.
  function restaurarCuentaGuardada() {
    const account = cargarCuentaGuardada();
    if (!account) {
      document.getElementById("name-input").focus();
      return;
    }

    miNombre = account.name;
    miUserId = account.id;
    miAvatarUrl = account.avatar;
    fotoPerfilSeleccionada = null;

    // Si la cuenta venia de una version anterior sin ID, persistimos el nuevo ID.
    guardarCuenta();

    document.getElementById("name-input").value = miNombre;
    document.getElementById("profile-preview").src = miAvatarUrl;

    servidorActual = servidorRandom();
    intentoFallback = false;

    document.getElementById("login-screen").style.display = "none";
    document.getElementById("chat-screen").style.display = "flex";
    document.getElementById("edit-profile-btn").style.display = "flex";

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
      enviarPresencia();
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
        return;
      }

      // presence trae la lista global de usuarios conectados.
      if (data.type === "presence") {
        actualizarUsuariosConectados(data.users || []);
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

  // Envia al servidor la identidad de este cliente para la lista de conectados.
  function enviarPresencia() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !miNombre) {
      return;
    }

    ws.send(JSON.stringify({
      type: "hello",
      id: miUserId,
      user: miNombre,
      avatar: miAvatarUrl
    }));
  }

  // Actualiza el subtitulo del header con los usuarios conectados.
  function actualizarUsuariosConectados(users) {
    usuariosConectados = users;
    const label = document.getElementById("users-list");

    if (!users.length) {
      label.textContent = "Sin usuarios conectados";
      return;
    }

    const names = users.map(item => item.user).filter(Boolean);
    if (names.length <= 3) {
      label.textContent = names.join(", ");
      return;
    }

    label.textContent = `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
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
      userId: miUserId,
      avatar: miAvatarUrl,
      text: texto,
      time: new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })
    };

    // Si hay archivo seleccionado, se sube por HTTP antes de mandar el mensaje WS.
    if (archivoSeleccionado) {
      try {
        mostrarProgresoSubida("Subiendo archivo...", 0);
        msg.file = await subirArchivo(archivoSeleccionado, (percent) => {
          mostrarProgresoSubida("Subiendo archivo...", percent);
        });
      } catch (_) {
        alert("No se pudo subir el archivo.");
        ocultarProgresoSubida();
        mostrarArchivoSeleccionado();
        return;
      }
      ocultarProgresoSubida();
    }

    // La subida puede tardar; revisamos otra vez que el WebSocket siga abierto.
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      alert("Se perdió la conexión antes de enviar el mensaje.");
      ocultarProgresoSubida();
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
  async function subirArchivo(file, onProgress = null) {
    // El navegador lee el archivo como data URL para mandarlo dentro de JSON.
    const data = await leerArchivoComoDataUrl(file);

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${HTTP_SERVERS[servidorActual]}/upload`);
      xhr.setRequestHeader("Content-Type", "application/json");

      // upload.onprogress permite mostrar avance real de subida.
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) {
          onProgress(Math.round((event.loaded / event.total) * 100));
        }
      };

      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error("upload failed"));
          return;
        }

        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (_) {
          reject(new Error("invalid upload response"));
        }
      };

      xhr.onerror = () => reject(new Error("upload failed"));

      xhr.send(JSON.stringify({
        name: file.name,
        type: file.type || "application/octet-stream",
        data
      }));
    });
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

  // Muestra la barra de progreso de subida con porcentaje.
  function mostrarProgresoSubida(texto, percent) {
    const box = document.getElementById("upload-progress");
    const bar = document.getElementById("upload-progress-bar");
    const label = document.getElementById("upload-progress-text");
    box.style.display = "block";
    bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    label.textContent = `${texto} ${percent}%`;
  }

  // Oculta y reinicia la barra de progreso.
  function ocultarProgresoSubida() {
    const box = document.getElementById("upload-progress");
    const bar = document.getElementById("upload-progress-bar");
    const label = document.getElementById("upload-progress-text");
    box.style.display = "none";
    bar.style.width = "0%";
    label.textContent = "Subiendo...";
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

    // Un mensaje es propio si el ID coincide con la cuenta local.
    // Si viene de mensajes viejos sin ID, se usa el nombre como fallback.
    const esPropio = msg.userId ? msg.userId === miUserId : msg.user === miNombre;

    // wrap alinea la burbuja a la derecha o izquierda.
    const wrap = document.createElement("div");
    wrap.className = "msg-wrap " + (esPropio ? "own" : "other");

    // La fila contiene avatar y contenido; cambia de direccion si es mensaje propio.
    const row = document.createElement("div");
    row.className = "msg-row";

    // Avatar del remitente. Si el mensaje no trae avatar, usamos el default.
    const avatar = document.createElement("img");
    avatar.className = "msg-avatar";
    avatar.src = msg.avatar || "/static/default_pfp.webp";
    avatar.alt = `Foto de ${msg.user || "usuario"}`;
    avatar.onerror = () => { avatar.src = "/static/default_pfp.webp"; };
    row.appendChild(avatar);

    // Columna interna con nombre, burbuja y hora.
    const content = document.createElement("div");
    content.className = "msg-content";

    // Los mensajes ajenos muestran el nombre del remitente.
    if (!esPropio) {
      const name = document.createElement("div");
      name.className = "msg-name";
      name.textContent = msg.user;
      content.appendChild(name);
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

      // Las notas de voz y audios se reproducen directamente en el chat.
      if ((msg.file.type || "").startsWith("audio/")) {
        const audio = document.createElement("audio");
        audio.className = "audio-attachment";
        audio.controls = true;
        audio.src = msg.file.url;
        bubble.appendChild(audio);
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
    content.appendChild(bubble);

    const time = document.createElement("div");
    time.className = "msg-time";
    time.textContent = msg.time || "";
    content.appendChild(time);

    row.appendChild(content);
    wrap.appendChild(row);
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

  // Inicia o detiene la grabacion de una nota de voz.
  async function toggleGrabacion() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("Este navegador no permite usar el micrófono desde esta página. Abre el chat en localhost o usa HTTPS.");
      return;
    }

    if (!window.isSecureContext) {
      alert("El micrófono requiere una conexión segura. Abre el chat como http://localhost:8000 en esta máquina o usa HTTPS para acceder desde otra computadora.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream);

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
        document.getElementById("voice-btn").classList.remove("recording");

        const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
        archivoSeleccionado = new File([blob], `nota-voz-${Date.now()}.webm`, {
          type: blob.type || "audio/webm"
        });
        document.getElementById("msg-input").value ||= "Nota de voz";
        mostrarArchivoSeleccionado();
      };

      mediaRecorder.start();
      document.getElementById("voice-btn").classList.add("recording");
      mostrarSubida("Grabando nota de voz...");
    } catch (error) {
      alert(`No se pudo acceder al micrófono (${error.name}). Revisa permisos del navegador y del sistema.`);
    }
  }

  // Abre el modal para editar nombre y foto.
  function abrirPerfil() {
    fotoPerfilEditada = null;
    document.getElementById("profile-name-input").value = miNombre;
    document.getElementById("profile-edit-preview").src = miAvatarUrl;
    document.getElementById("profile-modal").classList.add("open");
  }

  // Cierra el modal de perfil sin guardar cambios.
  function cerrarPerfil() {
    fotoPerfilEditada = null;
    document.getElementById("profile-edit-input").value = "";
    document.getElementById("profile-modal").classList.remove("open");
  }

  // Guarda cambios de perfil y avisa al servidor para actualizar la lista de usuarios.
  async function guardarPerfilEditado() {
    const nuevoNombre = document.getElementById("profile-name-input").value.trim();
    if (!nuevoNombre) {
      alert("El nombre no puede estar vacío.");
      return;
    }

    miNombre = nuevoNombre;
    miUserId ||= generarUserId();

    if (fotoPerfilEditada) {
      try {
        miAvatarUrl = (await subirArchivo(fotoPerfilEditada)).url;
      } catch (_) {
        alert("No se pudo subir la nueva foto.");
      }
    }

    guardarCuenta();
    enviarPresencia();
    cerrarPerfil();
  }

  // Intenta restaurar la cuenta guardada apenas carga la pagina.
  restaurarCuentaGuardada();

  // Permite entrar al chat presionando Enter en el input del nombre.
  document.getElementById("name-input").addEventListener("keydown", e => {
    if (e.key === "Enter") {
      entrar();
    }
  });

  // Permite elegir una foto de perfil antes de entrar al chat.
  document.getElementById("profile-input").addEventListener("change", e => {
    const file = e.target.files[0];

    // Si cancela el selector, regresamos a la imagen default.
    if (!file) {
      fotoPerfilSeleccionada = null;
      document.getElementById("profile-preview").src = "/static/default_pfp.webp";
      return;
    }

    // Solo aceptamos imagenes para evitar usar PDFs u otros archivos como avatar.
    if (!file.type.startsWith("image/")) {
      alert("La foto de perfil debe ser una imagen.");
      e.target.value = "";
      return;
    }

    // Limitamos la foto de perfil para que el login sea rapido.
    if (file.size > MAX_PROFILE_BYTES) {
      alert("La foto de perfil debe pesar máximo 2 MB.");
      e.target.value = "";
      return;
    }

    // Guardamos la imagen y mostramos una vista previa local.
    fotoPerfilSeleccionada = file;
    document.getElementById("profile-preview").src = URL.createObjectURL(file);
  });

  // Valida y previsualiza la foto seleccionada desde el modal de perfil.
  document.getElementById("profile-edit-input").addEventListener("change", e => {
    const file = e.target.files[0];

    if (!file) {
      fotoPerfilEditada = null;
      document.getElementById("profile-edit-preview").src = miAvatarUrl;
      return;
    }

    if (!file.type.startsWith("image/")) {
      alert("La foto de perfil debe ser una imagen.");
      e.target.value = "";
      return;
    }

    if (file.size > MAX_PROFILE_BYTES) {
      alert("La foto de perfil debe pesar máximo 2 MB.");
      e.target.value = "";
      return;
    }

    fotoPerfilEditada = file;
    document.getElementById("profile-edit-preview").src = URL.createObjectURL(file);
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

