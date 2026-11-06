// LUDORA · Cloudflare Worker
// Sirve la página (index.html, img/, etc.) y hace 3 trabajos en el servidor:
//   /api/productos.js → los productos de la hoja de Google "pagina web Ludora"
//   /api/firmar       → calcula el total con los precios de la hoja y firma el pago de Wompi
//   /api/pqr          → guarda el formulario de juego dañado en la hoja "PQR Ludora"
// Variables (Cloudflare → tu Worker → Settings → Variables and Secrets):
//   HOJA_PRODUCTOS, PQR_URL, WOMPI_PUBLIC_KEY, WOMPI_INTEGRITY_KEY
import respaldo from "./productos.js";

const { JUEGOS, ENVIOS, GRUPOS } = respaldo;
const PALETA = ["#FF5A47", "#FFB020", "#14B8A6", "#8B6CF0", "#FF8A3D", "#EC4899", "#3B82F6", "#22A06B"];
const norm = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const slug = s => norm(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/* ---------- Hoja de productos ---------- */
export function leerCSV(texto) {
  const filas = []; let fila = [], campo = "", comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comillas) {
      if (c === '"') { if (texto[i + 1] === '"') { campo += '"'; i++; } else comillas = false; }
      else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === ",") { fila.push(campo); campo = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      fila.push(campo); filas.push(fila); fila = []; campo = "";
    } else campo += c;
  }
  if (campo !== "" || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}

// "50.000", "$50,000" o 50000 → 50000. Vacío → null.
function numero(v) {
  let t = String(v ?? "").trim();
  if (!t) return null;
  t = t.replace(/[.,]\d{1,2}$/, "");
  const d = t.replace(/[^\d]/g, "");
  return d ? Number(d) : null;
}

// Fotos separadas por espacio: img/archivo.jpg, solo el nombre, enlaces de Drive o de cualquier imagen.
function fotos(v) {
  return String(v ?? "").split(/[\s,;]+/).filter(Boolean).map(f => {
    const drive = f.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]{20,})/);
    if (drive) return `https://drive.google.com/thumbnail?id=${drive[1]}&sz=w1200`;
    if (/^https?:\/\//i.test(f)) return f;
    return f.includes("/") ? f.replace(/^\/+/, "") : `img/${f}`;
  });
}

export function convertir(filas) {
  const enc = (filas[0] || []).map(norm);
  const col = n => enc.findIndex(h => h === n || h.startsWith(n));
  const c = {
    activo: col("activo"), destacado: col("destacado"), categoria: col("categoria"),
    nombre: enc.indexOf("nombre"), original: col("nombre original"), precio: enc.indexOf("precio"),
    antes: col("precio antes"), inventario: col("inventario"), jugadores: col("jugadores"),
    descripcion: col("descripcion"), desarrolla: col("desarrolla"), foto: col("foto"), enlace: col("enlace")
  };
  if (c.nombre < 0 || c.precio < 0) throw new Error("La hoja no tiene las columnas Nombre y Precio.");
  const v = (f, k) => (c[k] >= 0 ? String(f[c[k]] ?? "").trim() : "");

  // Las categorías de siempre conservan su color; las nuevas toman uno de la paleta.
  const porNombre = {};
  for (const k in GRUPOS) porNombre[norm(GRUPOS[k].nombre)] = k;
  const nuevas = {};
  const grupoDe = nombre => {
    const n = norm(nombre) || "otros";
    if (porNombre[n]) return porNombre[n];
    const k = slug(nombre) || "otros";
    nuevas[k] = { nombre: String(nombre).trim() || "Otros", color: PALETA[(Object.keys(nuevas).length + 6) % PALETA.length] };
    porNombre[n] = k;
    return k;
  };

  const juegos = [], ids = new Set();
  for (const f of filas.slice(1)) {
    const nombre = v(f, "nombre"), precio = numero(v(f, "precio"));
    if (!nombre || !(precio > 0) || norm(v(f, "activo")) === "no") continue;
    let id = slug(v(f, "enlace")) || slug(nombre);
    if (ids.has(id)) { let i = 2; while (ids.has(`${id}-${i}`)) i++; id = `${id}-${i}`; }
    ids.add(id);
    const antes = numero(v(f, "antes"));
    juegos.push({
      id, nombre,
      nombreOriginal: v(f, "original"),
      precio,
      precioAntes: antes > precio ? antes : null,
      grupo: grupoDe(v(f, "categoria")),
      jugadores: v(f, "jugadores"),
      descripcion: v(f, "descripcion"),
      desarrolla: v(f, "desarrolla"),
      fotos: fotos(v(f, "foto")),
      inventario: numero(v(f, "inventario")),
      destacado: norm(v(f, "destacado")) === "si"
    });
  }
  if (!juegos.length) throw new Error("La hoja no tiene productos activos.");
  const usados = new Set(juegos.map(j => j.grupo));
  const grupos = {};
  for (const k in GRUPOS) if (usados.has(k)) grupos[k] = GRUPOS[k];
  for (const k in nuevas) if (usados.has(k)) grupos[k] = nuevas[k];
  return { juegos, grupos };
}

function direcciones(enlace) {
  enlace = String(enlace || "").trim();
  const id = (enlace.match(/\/d\/([\w-]{20,})/) || [])[1] || (/^[\w-]{20,}$/.test(enlace) ? enlace : null);
  if (!id) return [];
  const gid = (enlace.match(/[#&?]gid=(\d+)/) || [])[1] || "0";
  return [
    `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`,
    `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=Productos`
  ];
}

let memoria = { hora: 0, datos: null };
async function leerCatalogo(env, maxEdad = 60000) {
  if (memoria.datos && Date.now() - memoria.hora < maxEdad) return memoria.datos;
  let aviso = "Falta la variable HOJA_PRODUCTOS.";
  for (const url of direcciones(env.HOJA_PRODUCTOS)) {
    try {
      const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(6000) });
      const texto = await r.text();
      if (!r.ok || /^\s*</.test(texto)) throw new Error(`La hoja respondió ${r.status}. ¿Está compartida como "Cualquier persona con el enlace"?`);
      memoria = { hora: Date.now(), datos: { ...convertir(leerCSV(texto)), origen: "hoja" } };
      return memoria.datos;
    } catch (e) { aviso = e.message; }
  }
  if (memoria.datos) return memoria.datos; // mejor la última versión buena que el respaldo viejo
  return { juegos: JUEGOS.filter(j => j.precio > 0), grupos: GRUPOS, origen: "respaldo", aviso };
}

/* ---------- Respuestas ---------- */
const json = (status, datos) => new Response(JSON.stringify(datos), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

async function productosJS(env) {
  const d = await leerCatalogo(env);
  const js = `/* Ludora · productos desde ${d.origen === "hoja" ? "la hoja de Google" : "el respaldo (" + String(d.aviso).replace(/\*\//g, "") + ")"} */
(function (d) {
  JUEGOS.splice(0, JUEGOS.length, ...d.juegos);
  for (const k in GRUPOS) delete GRUPOS[k];
  Object.assign(GRUPOS, d.grupos);
})(${JSON.stringify({ juegos: d.juegos, grupos: d.grupos })});
`;
  return new Response(js, {
    headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=30" }
  });
}

async function sha256(texto) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function firmar(request, env) {
  const llavePublica = env.WOMPI_PUBLIC_KEY, secreto = env.WOMPI_INTEGRITY_KEY;
  if (!llavePublica || !secreto) return json(500, { error: "Los pagos aún no están configurados en la tienda." });

  let items, destino;
  try { ({ items, envio: destino } = await request.json()); } catch { items = null; }
  if (!destino || !destino.departamento || !destino.ciudad) return json(400, { error: "Completa los datos de envío." });
  // La zona se calcula aquí con la ciudad real, no la elige el navegador.
  const ciudad = norm(destino.ciudad);
  const zona = (destino.departamento === "Bogotá D.C." || ciudad.startsWith("bogota") || ciudad === "soacha") ? "bogota" : "nacional";
  if (!Array.isArray(items) || !items.length || items.length > 30) return json(400, { error: "El carrito está vacío." });

  const { juegos } = await leerCatalogo(env, 30000);
  let total = 0;
  const partes = [];
  for (const it of items) {
    const juego = juegos.find(j => j.id === it.id);
    const cantidad = Number(it.cantidad);
    if (!juego) return json(400, { error: "Uno de los juegos ya no está disponible. Revisa tu carrito." });
    const sinDato = juego.inventario === null || juego.inventario === undefined;
    if (!sinDato && !(juego.inventario > 0)) return json(400, { error: `${juego.nombre} está agotado. Quítalo del carrito para continuar.` });
    if (!sinDato && cantidad > juego.inventario) return json(400, { error: `Solo quedan ${juego.inventario} unidades de ${juego.nombre}.` });
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 10) return json(400, { error: "Revisa las cantidades del carrito." });
    total += juego.precio * cantidad;
    partes.push(`${juego.id}x${cantidad}`);
  }
  total += ENVIOS[zona].valor;

  // La referencia aparece en tu panel de Wompi: así sabes qué juegos compraron.
  // Termina en -BOG (Bogotá y Soacha) o -NAL (resto del país).
  const referencia = `LUD-${Date.now().toString(36).toUpperCase()}-${partes.join("_").slice(0, 170)}-${zona === "bogota" ? "BOG" : "NAL"}`;
  const montoEnCentavos = Math.round(total * 100);
  const firma = await sha256(`${referencia}${montoEnCentavos}COP${secreto}`);
  return json(200, { referencia, montoEnCentavos, firma, llavePublica });
}

const limpio = (v, max) => String(v ?? "").replace(/[\u0000-\u0009\u000B-\u001F]/g, " ").trim().slice(0, max);
async function pqr(request, env) {
  if (!env.PQR_URL) return json(500, { error: "El formulario aún no está activo. Intenta más tarde." });
  let d;
  try { d = await request.json(); } catch { d = {}; }
  if (d.sitio) return json(200, { ok: true, radicado: "PQR-OK" }); // casilla trampa para robots
  const datos = {
    nombre: limpio(d.nombre, 100), celular: limpio(d.celular, 15).replace(/\s/g, ""),
    correo: limpio(d.correo, 120), guia: limpio(d.guia, 40), mensaje: limpio(d.mensaje, 2000)
  };
  if (datos.nombre.split(/\s+/).length < 2) return json(400, { error: "Escribe tu nombre y apellido." });
  if (!/^3\d{9}$/.test(datos.celular)) return json(400, { error: "Escribe un celular de 10 dígitos que empiece por 3." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(datos.correo)) return json(400, { error: "Escribe un correo válido." });
  if (datos.guia.length < 4) return json(400, { error: "Escribe el número de guía de tu envío." });
  if (datos.mensaje.length < 10) return json(400, { error: "Cuéntanos un poco más qué pasó con tu pedido." });

  const hoy = new Date(Date.now() - 5 * 3600 * 1000); // hora de Colombia
  const radicado = `PQR-${hoy.toISOString().slice(2, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  try {
    const r = await fetch(env.PQR_URL, {
      method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ...datos, radicado }), redirect: "follow", signal: AbortSignal.timeout(15000)
    });
    const res = await r.json().catch(() => ({}));
    if (!res.ok) throw new Error(res.error || `Apps Script respondió ${r.status}`);
  } catch (e) {
    console.error("PQR no guardada:", e.message);
    return json(502, { error: "No pudimos enviar tu solicitud. Intenta de nuevo en unos minutos." });
  }
  return json(200, { ok: true, radicado });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/productos.js") return productosJS(env);
    if (pathname === "/api/firmar") return request.method === "POST" ? firmar(request, env) : json(405, { error: "Método no permitido." });
    if (pathname === "/api/pqr") return request.method === "POST" ? pqr(request, env) : json(405, { error: "Método no permitido." });
    return env.ASSETS.fetch(request);
  }
};
