// Calcula el total del carrito con los precios de productos.js (no con lo que
// envía el navegador) y genera la firma de integridad que exige Wompi.
// Las llaves se configuran en Netlify como variables de entorno:
//   WOMPI_PUBLIC_KEY      (llave pública:   pub_prod_...)
//   WOMPI_INTEGRITY_KEY   (secreto de integridad: prod_integrity_...)
const crypto = require("crypto");
const { JUEGOS, ENVIOS } = require("../../productos.js");

const respuesta = (status, datos) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(datos)
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return respuesta(405, { error: "Método no permitido." });

  const llavePublica = process.env.WOMPI_PUBLIC_KEY;
  const secreto = process.env.WOMPI_INTEGRITY_KEY;
  if (!llavePublica || !secreto) return respuesta(500, { error: "Los pagos aún no están configurados en la tienda." });

  let items, destino;
  try { ({ items, envio: destino } = JSON.parse(event.body || "{}")); } catch { items = null; }
  if (!destino || !destino.departamento || !destino.ciudad) return respuesta(400, { error: "Completa los datos de envío." });
  // La zona se calcula aquí con la ciudad real, no la elige el navegador.
  const ciudad = String(destino.ciudad).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const zona = (destino.departamento === "Bogotá D.C." || ciudad.startsWith("bogota") || ciudad === "soacha") ? "bogota" : "nacional";
  const envio = ENVIOS[zona];
  if (!Array.isArray(items) || !items.length || items.length > 30) return respuesta(400, { error: "El carrito está vacío." });

  let total = 0;
  const partes = [];
  for (const it of items) {
    const juego = JUEGOS.find(j => j.id === it.id);
    const cantidad = Number(it.cantidad);
    if (!juego) return respuesta(400, { error: "Uno de los juegos ya no está disponible. Revisa tu carrito." });
    const sinDato = juego.inventario === null || juego.inventario === undefined;
    if (!sinDato && !(juego.inventario > 0)) return respuesta(400, { error: `${juego.nombre} está agotado. Quítalo del carrito para continuar.` });
    if (!sinDato && cantidad > juego.inventario) return respuesta(400, { error: `Solo quedan ${juego.inventario} unidades de ${juego.nombre}.` });
    if (!(juego.precio > 0)) return respuesta(400, { error: `${juego.nombre} todavía no tiene precio.` });
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 10) return respuesta(400, { error: "Revisa las cantidades del carrito." });
    total += juego.precio * cantidad;
    partes.push(`${juego.id}x${cantidad}`);
  }
  total += envio.valor;

  // La referencia aparece en tu panel de Wompi: así sabes qué juegos compraron.
  // Termina en -BOG (Bogotá y Soacha) o -NAL (resto del país): revisa que coincida con la dirección.
  const sufijo = zona === "bogota" ? "BOG" : "NAL";
  const referencia = `LUD-${Date.now().toString(36).toUpperCase()}-${partes.join("_").slice(0, 170)}-${sufijo}`;
  const montoEnCentavos = Math.round(total * 100);
  const firma = crypto.createHash("sha256")
    .update(`${referencia}${montoEnCentavos}COP${secreto}`)
    .digest("hex");

  return respuesta(200, { referencia, montoEnCentavos, firma, llavePublica });
};
