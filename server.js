/**
 * ============================================================================
 *  REPUBLIC WINGS — SERVIDOR PROXY (server.js)
 * ============================================================================
 *
 *  Este servidor se pone EN MEDIO del navegador y Google Apps Script.
 *
 *      index.html  ──►  server.js (Node)  ──►  Google Apps Script ──► Sheets
 *      (público)        (privado: .env)        (URL secreta)
 *
 *  ¿Por qué? Porque antes el index.html tenía las contraseñas y la URL de
 *  Apps Script escritas en texto plano: cualquier cliente podía abrir
 *  "Ver código fuente" y entrar como dueño o escribir directo a tu hoja.
 *  Ahora esos datos solo viven en .env, que nunca se sube a Git.
 *
 *  ENDPOINTS QUE CONSUME index.html
 *  --------------------------------
 *   POST /api/auth/sucursal   { password, id }   -> { ok }
 *   POST /api/auth/admin      { password }       -> { ok }   (gerencia)
 *   POST /api/auth/dev        { password }       -> { ok }
 *   POST /api/auth/dueno      { password }       -> { ok }
 *   GET  /api/menu?sucursal=ID                   -> [ productos ]
 *   GET  /api/ventas?sucursal=ID                 -> [ ventas ]
 *   POST /api/venta           { datosVenta }     -> { exito, idVenta }
 *   POST /api/productos       { cambios: [...] } -> { exito }
 *   POST /api/stock           { id, cantidad }   -> { exito }
 *   GET  /api/health                             -> { ok, modo }
 *
 *  Cada login exitoso deja una cookie firmada (httpOnly) con la sucursal y
 *  los roles acumulados. Las rutas de datos exigen esa cookie, así que un
 *  curl sin sesión no puede leer ventas ni escribir precios.
 * ============================================================================
 */

'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');

const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// ---------------------------------------------------------------------------
// Utilidad de línea de comandos:  npm run hash -- "miClaveSegura"
// Genera un hash bcrypt para pegar en .env en lugar de la clave en texto plano.
// ---------------------------------------------------------------------------
if (process.argv.includes('--hash')) {
  const clave = process.argv[process.argv.indexOf('--hash') + 1];
  if (!clave) {
    console.error('Uso: npm run hash -- "tuClaveSecreta"');
    process.exit(1);
  }
  console.log(bcrypt.hashSync(clave, 12));
  process.exit(0);
}

// ===========================================================================
// 1. CONFIGURACIÓN (todo sale de .env)
// ===========================================================================

const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const ES_PRODUCCION = NODE_ENV === 'production';

const GAS_URL = (process.env.GAS_URL || '').trim();
const MODO_DEMO = !GAS_URL; // sin URL de Apps Script trabajamos con archivos locales

const SESSION_SECRET = process.env.SESSION_SECRET || '';
if (!SESSION_SECRET || SESSION_SECRET.length < 24) {
  console.error('\n❌  Falta SESSION_SECRET en .env (mínimo 24 caracteres).');
  console.error('    Genera uno con:  npm run secret\n');
  process.exit(1);
}

const SESSION_HORAS = Number(process.env.SESSION_HORAS) || 12;
const COOKIE_NOMBRE = 'rw_session';
const MENU_CACHE_MS = (Number(process.env.MENU_CACHE_SEGUNDOS) || 30) * 1000;

/**
 * Sucursales: se leen de .env con el patrón
 *   SUCURSAL_1_ID / SUCURSAL_1_NOMBRE / SUCURSAL_1_PASS
 * Soporta hasta 20 locales sin tocar este archivo.
 */
function cargarSucursales() {
  const lista = [];
  for (let i = 1; i <= 20; i++) {
    const id = process.env[`SUCURSAL_${i}_ID`];
    if (!id) continue;
    lista.push({
      id: id.trim(),
      nombre: (process.env[`SUCURSAL_${i}_NOMBRE`] || id).trim(),
      pass: process.env[`SUCURSAL_${i}_PASS`] || ''
    });
  }
  return lista;
}

const SUCURSALES = cargarSucursales();
if (SUCURSALES.length === 0) {
  console.error('\n❌  No hay sucursales configuradas en .env (SUCURSAL_1_ID, ...).\n');
  process.exit(1);
}

const CLAVES = {
  admin: process.env.CLAVE_ADMIN || '',   // gerencia: Resumen e Inventario
  dev: process.env.CLAVE_DEV || '',       // precios y disponibilidad
  dueno: process.env.CLAVE_DUENO || ''    // panel consolidado de las 3 sucursales
};

for (const [rol, valor] of Object.entries(CLAVES)) {
  if (!valor) console.warn(`⚠️  CLAVE_${rol.toUpperCase()} no está definida en .env: ese acceso quedará bloqueado.`);
}

// ===========================================================================
// 2. COMPARACIÓN DE CONTRASEÑAS
//    Acepta hash bcrypt (recomendado, empieza con $2) o texto plano.
//    El texto plano se compara en tiempo constante para no filtrar información
//    por la duración de la respuesta.
// ===========================================================================

function claveCorrecta(ingresada, esperada) {
  if (!esperada || typeof ingresada !== 'string' || ingresada.length === 0) return false;
  if (esperada.startsWith('$2')) {
    try { return bcrypt.compareSync(ingresada, esperada); } catch { return false; }
  }
  const a = Buffer.from(ingresada);
  const b = Buffer.from(esperada);
  const largo = Math.max(a.length, b.length);
  const pa = Buffer.alloc(largo);
  const pb = Buffer.alloc(largo);
  a.copy(pa); b.copy(pb);
  return crypto.timingSafeEqual(pa, pb) && a.length === b.length;
}

// ===========================================================================
// 3. SESIÓN (JWT dentro de una cookie httpOnly)
// ===========================================================================

function emitirSesion(res, datos) {
  const token = jwt.sign(datos, SESSION_SECRET, { expiresIn: `${SESSION_HORAS}h` });
  res.cookie(COOKIE_NOMBRE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: ES_PRODUCCION,
    maxAge: SESSION_HORAS * 60 * 60 * 1000
  });
}

function leerSesion(req) {
  const token = req.cookies?.[COOKIE_NOMBRE];
  if (!token) return null;
  try { return jwt.verify(token, SESSION_SECRET); } catch { return null; }
}

/** Añade un rol a la sesión actual sin perder la sucursal ya autenticada. */
function agregarRol(req, res, rol) {
  const actual = leerSesion(req) || { sucursalId: null, sucursalNombre: null, roles: [] };
  const roles = Array.from(new Set([...(actual.roles || []), rol]));
  emitirSesion(res, { sucursalId: actual.sucursalId, sucursalNombre: actual.sucursalNombre, roles });
}

/** Middleware: exige sesión y, opcionalmente, uno de los roles indicados. */
function requiereRol(...rolesPermitidos) {
  return (req, res, next) => {
    const sesion = leerSesion(req);
    if (!sesion) {
      return res.status(401).json({ error: 'Sesión no iniciada. Vuelve a ingresar a tu sucursal.' });
    }
    const roles = sesion.roles || [];
    if (rolesPermitidos.length > 0 && !rolesPermitidos.some(r => roles.includes(r))) {
      return res.status(403).json({ error: 'No tienes permiso para esta operación.' });
    }
    req.sesion = sesion;
    next();
  };
}

/**
 * Decide qué sucursal puede consultar quien pide.
 *  - rol 'dueno': cualquiera (por eso el panel consolidado funciona).
 *  - rol 'sucursal': únicamente la suya, sin importar lo que mande la URL.
 */
function resolverSucursalPedida(sesion, pedida) {
  const roles = sesion.roles || [];
  if (roles.includes('dueno')) {
    if (!pedida) return null; // null = todas
    return SUCURSALES.some(s => s.id === pedida) ? pedida : null;
  }
  return sesion.sucursalId;
}

// ===========================================================================
// 4. PUENTE CON GOOGLE APPS SCRIPT  (o almacenamiento local en modo demo)
// ===========================================================================

const DATA_DIR = path.join(__dirname, 'data');

async function leerJsonLocal(archivo, porDefecto) {
  try {
    const txt = await fsp.readFile(path.join(DATA_DIR, archivo), 'utf8');
    return JSON.parse(txt);
  } catch {
    return porDefecto;
  }
}

async function escribirJsonLocal(archivo, datos) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(path.join(DATA_DIR, archivo), JSON.stringify(datos, null, 2), 'utf8');
}

/** GET hacia Apps Script. */
async function gasGet(action, params = {}) {
  const url = new URL(GAS_URL);
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
  const texto = await res.text();
  try {
    return JSON.parse(texto);
  } catch {
    throw new Error('Apps Script no devolvió JSON (revisa que la implementación sea "Cualquier usuario" y que la URL termine en /exec).');
  }
}

/**
 * POST hacia Apps Script.
 * Se envía como text/plain a propósito: Apps Script no responde bien al
 * preflight CORS de application/json y e.postData.contents llega igual.
 */
async function gasPost(action, cuerpo) {
  const url = new URL(GAS_URL);
  if (action) url.searchParams.set('action', action);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(cuerpo),
    redirect: 'follow',
    signal: AbortSignal.timeout(20000)
  });
  const texto = await res.text();
  try {
    return JSON.parse(texto);
  } catch {
    throw new Error('Apps Script no devolvió JSON al guardar.');
  }
}

// ---------------------------------------------------------------------------
// Normalizadores: dejan los datos tal como los espera index.html, sin importar
// cómo estén nombradas las columnas en la hoja de cálculo.
// ---------------------------------------------------------------------------

function normalizarProducto(p) {
  return {
    id: String(p.id ?? p.ID ?? '').trim(),
    nombre: String(p.nombre ?? p.Nombre ?? '').trim(),
    categoria: String(p.categoria ?? p.Categoria ?? p['Categoría'] ?? '').trim(),
    precio: Number(p.precio ?? p.Precio ?? 0) || 0,
    imagenUrl: p.imagenUrl ?? p.ImagenUrl ?? p.imagen ?? '',
    disponible: p.disponible ?? p.Disponible ?? true,
    stock: p.stock ?? p.Stock ?? ''
  };
}

function normalizarVenta(v) {
  // La hoja puede guardar el cliente en una sola columna o separado en
  // clienteNombre / clienteCelular. El frontend solo lee "cliente".
  const nombre = v.cliente ?? v.clienteNombre ?? v.Cliente ?? '';
  const celular = v.clienteCelular ?? v.celular ?? '';
  const totalNum = Number(String(v.total ?? 0).replace(/[^\d.,-]/g, '').replace(',', '.')) || 0;
  return {
    idVenta: v.idVenta ?? v.id ?? v.ID ?? '',
    fecha: v.fecha ?? v.Fecha ?? '',
    cliente: String(nombre).trim() || 'Cliente',
    celular: String(celular).trim(),
    total: `${totalNum.toFixed(2)} Bs`, // formato fijo: evita el crash cuando la celda viene vacía
    totalNum,
    detalle: v.detalle ?? v.detalleJson ?? '',
    metodoPago: v.metodoPago ?? '',
    tipoConsumo: v.tipoConsumo ?? '',
    nota: v.nota ?? '',
    sucursalId: v.sucursalId ?? '',
    sucursalNombre: v.sucursalNombre ?? ''
  };
}

// ---------------------------------------------------------------------------
// Caché de menú (por sucursal). Evita golpear Apps Script en cada clic:
// Apps Script tiene cuotas diarias y es lento (~1-2 s por llamada).
// ---------------------------------------------------------------------------

const cacheMenu = new Map(); // idSucursal -> { datos, expira }

async function obtenerMenu(sucursalId, forzar = false) {
  const clave = sucursalId || 'GLOBAL';
  const enCache = cacheMenu.get(clave);
  if (!forzar && enCache && enCache.expira > Date.now()) return enCache.datos;

  let datos;
  if (MODO_DEMO) {
    datos = await leerJsonLocal('menu.json', MENU_DEMO);
  } else {
    const respuesta = await gasGet('getMenu', { sucursal: sucursalId });
    if (respuesta && respuesta.error) throw new Error(respuesta.error);
    datos = Array.isArray(respuesta) ? respuesta : [];
  }
  datos = datos.map(normalizarProducto).filter(p => p.id && p.nombre);
  cacheMenu.set(clave, { datos, expira: Date.now() + MENU_CACHE_MS });
  return datos;
}

function invalidarCacheMenu() {
  cacheMenu.clear();
}

async function obtenerVentas(sucursalId) {
  if (MODO_DEMO) {
    const todas = await leerJsonLocal('ventas.json', []);
    const filtradas = sucursalId ? todas.filter(v => v.sucursalId === sucursalId) : todas;
    return filtradas.map(normalizarVenta);
  }
  const respuesta = await gasGet('getVentas', { sucursal: sucursalId });
  if (respuesta && respuesta.error) throw new Error(respuesta.error);
  const lista = Array.isArray(respuesta) ? respuesta : [];
  // Segundo filtro por si el Apps Script todavía no sabe filtrar por sucursal.
  const filtradas = sucursalId
    ? lista.filter(v => !v.sucursalId || v.sucursalId === sucursalId)
    : lista;
  return filtradas.map(normalizarVenta);
}

// ===========================================================================
// 5. APLICACIÓN EXPRESS
// ===========================================================================

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  // El index.html usa Tailwind CDN, Lucide (unpkg) y Google Fonts, además de
  // estilos y scripts en línea. Esta política permite exactamente eso y nada más.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://cdn.tailwindcss.com', 'https://unpkg.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(compression());
app.use(morgan(ES_PRODUCCION ? 'combined' : 'dev'));
app.use(cookieParser());
app.use(express.json({ limit: '256kb' }));
app.use(express.text({ type: 'text/plain', limit: '256kb' }));

// Si algún cliente manda JSON como text/plain, lo convertimos.
app.use((req, _res, next) => {
  if (typeof req.body === 'string' && req.body.trim().startsWith('{')) {
    try { req.body = JSON.parse(req.body); } catch { /* se ignora */ }
  }
  next();
});

const limitadorLogin = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 15,                       // 15 intentos de clave cada 10 min por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Demasiados intentos fallidos. Espera unos minutos.' }
});

const limitadorApi = rateLimit({ windowMs: 60 * 1000, limit: 240, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limitadorApi);

// --------------------------------------------------------------------------
// 5.1 AUTENTICACIÓN
// --------------------------------------------------------------------------

app.post('/api/auth/sucursal', limitadorLogin, (req, res) => {
  const { password, id } = req.body || {};
  const sucursal = SUCURSALES.find(s => s.id === id);
  if (!sucursal || !claveCorrecta(password, sucursal.pass)) {
    return res.status(401).json({ ok: false });
  }
  // Login de sucursal = sesión nueva: se pierden roles de gerencia/dev previos.
  emitirSesion(res, { sucursalId: sucursal.id, sucursalNombre: sucursal.nombre, roles: ['sucursal'] });
  res.json({ ok: true, sucursal: { id: sucursal.id, nombre: sucursal.nombre } });
});

app.post('/api/auth/admin', limitadorLogin, (req, res) => {
  if (!claveCorrecta(req.body?.password, CLAVES.admin)) return res.status(401).json({ ok: false });
  agregarRol(req, res, 'admin');
  res.json({ ok: true });
});

app.post('/api/auth/dev', limitadorLogin, (req, res) => {
  if (!claveCorrecta(req.body?.password, CLAVES.dev)) return res.status(401).json({ ok: false });
  agregarRol(req, res, 'dev');
  res.json({ ok: true });
});

app.post('/api/auth/dueno', limitadorLogin, (req, res) => {
  if (!claveCorrecta(req.body?.password, CLAVES.dueno)) return res.status(401).json({ ok: false });
  agregarRol(req, res, 'dueno');
  res.json({ ok: true });
});

app.post('/api/auth/salir', (req, res) => {
  res.clearCookie(COOKIE_NOMBRE);
  res.json({ ok: true });
});

/** Lista pública de sucursales (id y nombre, nunca las claves). */
app.get('/api/sucursales', (_req, res) => {
  res.json(SUCURSALES.map(s => ({ id: s.id, nombre: s.nombre })));
});

app.get('/api/sesion', (req, res) => {
  const sesion = leerSesion(req);
  if (!sesion) return res.json({ autenticado: false });
  res.json({ autenticado: true, sucursalId: sesion.sucursalId, sucursalNombre: sesion.sucursalNombre, roles: sesion.roles || [] });
});

// --------------------------------------------------------------------------
// 5.2 MENÚ
// --------------------------------------------------------------------------

app.get('/api/menu', requiereRol(), async (req, res) => {
  try {
    const sucursalId = resolverSucursalPedida(req.sesion, req.query.sucursal);
    const menu = await obtenerMenu(sucursalId);
    res.json(menu);
  } catch (err) {
    console.error('[menu]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// --------------------------------------------------------------------------
// 5.3 VENTAS (lectura)
// --------------------------------------------------------------------------

app.get('/api/ventas', requiereRol('sucursal', 'admin', 'dueno'), async (req, res) => {
  try {
    const roles = req.sesion.roles || [];
    const pedida = req.query.sucursal;
    // Una sucursal no puede espiar los números de otra, aunque cambie la URL.
    if (pedida && !roles.includes('dueno') && pedida !== req.sesion.sucursalId) {
      return res.status(403).json({ error: 'Solo puedes ver las ventas de tu sucursal.' });
    }
    const ventas = await obtenerVentas(resolverSucursalPedida(req.sesion, pedida));
    res.json(ventas);
  } catch (err) {
    console.error('[ventas]', err.message);
    res.status(502).json({ error: err.message });
  }
});

/** Resumen consolidado del dueño en una sola llamada (opcional, más rápido). */
app.get('/api/dueno/resumen', requiereRol('dueno'), async (_req, res) => {
  try {
    const resultado = {};
    await Promise.all(SUCURSALES.map(async s => {
      try { resultado[s.id] = await obtenerVentas(s.id); }
      catch { resultado[s.id] = []; }
    }));
    res.json(resultado);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --------------------------------------------------------------------------
// 5.4 VENTAS (registro)
// --------------------------------------------------------------------------

const TIPOS_CONSUMO = ['Para Llevar', 'En el Local'];
const METODOS_PAGO = ['Efectivo', 'Tarjeta', 'QR'];

/**
 * Recalcula el total a partir del detalle ("2x Alitas (6 pcs) [salsas]")
 * usando los precios reales del menú. Así, aunque alguien edite el precio
 * en el navegador antes de cobrar, la hoja guarda el monto correcto.
 */
function recalcularTotal(detalle, menu) {
  let total = 0;
  let completo = true;
  for (const parte of String(detalle).split(' | ')) {
    const m = parte.match(/^(\d+)x\s+([^[]+)/);
    if (!m) { completo = false; continue; }
    const cantidad = parseInt(m[1], 10);
    const nombre = m[2].trim();
    const prod = menu.find(p => p.nombre.trim() === nombre);
    if (!prod) { completo = false; continue; }
    total += cantidad * Number(prod.precio);
  }
  return { total, completo };
}

app.post('/api/venta', requiereRol('sucursal'), async (req, res) => {
  try {
    const b = req.body || {};
    const clienteNombre = String(b.clienteNombre || '').trim();
    const detalle = String(b.detalleJson || b.detalle || '').trim();
    const tipoConsumo = String(b.tipoConsumo || '').trim();
    const metodoPago = String(b.metodoPago || '').trim();

    if (!clienteNombre) return res.status(400).json({ exito: false, error: 'Falta el nombre del cliente.' });
    if (!detalle) return res.status(400).json({ exito: false, error: 'La orden está vacía.' });
    if (!METODOS_PAGO.includes(metodoPago)) return res.status(400).json({ exito: false, error: 'Método de pago inválido.' });
    if (!TIPOS_CONSUMO.includes(tipoConsumo)) return res.status(400).json({ exito: false, error: 'Tipo de pedido inválido.' });

    const menu = await obtenerMenu(req.sesion.sucursalId);
    const { total: totalServidor, completo } = recalcularTotal(detalle, menu);
    const totalCliente = Number(String(b.total || '0').replace(/[^\d.]/g, '')) || 0;

    if (completo && Math.abs(totalServidor - totalCliente) > 0.01) {
      console.warn(`[venta] Total del navegador (${totalCliente}) ≠ total calculado (${totalServidor}). Se guarda el del servidor.`);
    }
    const totalFinal = completo ? totalServidor : totalCliente;

    // La sucursal SIEMPRE sale de la cookie, nunca de lo que mande el navegador.
    const venta = {
      total: `${totalFinal.toFixed(2)} Bs`,
      metodoPago,
      clienteNombre,
      clienteCelular: String(b.clienteCelular || 'N/A').trim().slice(0, 30),
      detalleJson: detalle,
      tipoConsumo,
      nota: String(b.nota || '').trim().slice(0, 500),
      sucursalId: req.sesion.sucursalId,
      sucursalNombre: req.sesion.sucursalNombre
    };

    if (MODO_DEMO) {
      const ventas = await leerJsonLocal('ventas.json', []);
      const idVenta = `RW-${String(ventas.length + 1).padStart(4, '0')}`;
      ventas.push({ idVenta, fecha: new Date().toISOString(), ...venta });
      await escribirJsonLocal('ventas.json', ventas);
      return res.json({ exito: true, idVenta });
    }

    const respuesta = await gasPost(null, venta); // doPost sin action = registrar venta
    if (!respuesta || respuesta.exito !== true) {
      return res.status(502).json({ exito: false, error: respuesta?.error || 'Apps Script rechazó la venta.' });
    }
    res.json({ exito: true, idVenta: respuesta.idVenta });
  } catch (err) {
    console.error('[venta]', err.message);
    res.status(502).json({ exito: false, error: err.message });
  }
});

// --------------------------------------------------------------------------
// 5.5 MODO DESARROLLADOR: precios y disponibilidad
// --------------------------------------------------------------------------

app.post('/api/productos', requiereRol('dev'), async (req, res) => {
  try {
    const entrada = Array.isArray(req.body?.cambios) ? req.body.cambios : [];
    if (entrada.length === 0) return res.status(400).json({ exito: false, error: 'No se enviaron cambios.' });

    const menu = await obtenerMenu(req.sesion.sucursalId);
    const cambios = [];
    for (const c of entrada) {
      const prod = menu.find(p => p.id === String(c.id));
      if (!prod) continue; // ignora ids que no existen en el menú
      const limpio = { id: prod.id };
      if (c.precio !== undefined) {
        const precio = Number(c.precio);
        if (!Number.isFinite(precio) || precio < 0 || precio > 100000) {
          return res.status(400).json({ exito: false, error: `Precio inválido para ${prod.nombre}.` });
        }
        limpio.precio = Number(precio.toFixed(2));
      }
      if (c.disponible !== undefined) limpio.disponible = Boolean(c.disponible);
      cambios.push(limpio);
    }
    if (cambios.length === 0) return res.status(400).json({ exito: false, error: 'Ningún cambio válido.' });

    if (MODO_DEMO) {
      const actual = await leerJsonLocal('menu.json', MENU_DEMO);
      cambios.forEach(c => {
        const p = actual.find(x => String(x.id) === c.id);
        if (!p) return;
        if (c.precio !== undefined) p.precio = c.precio;
        if (c.disponible !== undefined) p.disponible = c.disponible;
      });
      await escribirJsonLocal('menu.json', actual);
    } else {
      const r = await gasPost('actualizarProductos', { cambios, sucursal: req.sesion.sucursalId });
      if (!r || r.exito !== true) {
        return res.status(502).json({ exito: false, error: r?.error || 'Apps Script no aplicó los cambios.' });
      }
    }
    invalidarCacheMenu();
    console.log(`[dev] ${cambios.length} producto(s) actualizados en ${req.sesion.sucursalId}`);
    res.json({ exito: true, actualizados: cambios.length });
  } catch (err) {
    console.error('[productos]', err.message);
    res.status(502).json({ exito: false, error: err.message });
  }
});

// --------------------------------------------------------------------------
// 5.6 INVENTARIO: reposición de stock
// --------------------------------------------------------------------------

app.post('/api/stock', requiereRol('admin', 'dev'), async (req, res) => {
  try {
    const id = String(req.body?.id || '').trim();
    const cantidad = Number(req.body?.cantidad);
    if (!id) return res.status(400).json({ exito: false, error: 'Falta el producto.' });
    if (!Number.isFinite(cantidad) || cantidad <= 0 || cantidad > 10000) {
      return res.status(400).json({ exito: false, error: 'Cantidad inválida.' });
    }

    const menu = await obtenerMenu(req.sesion.sucursalId);
    const prod = menu.find(p => p.id === id);
    if (!prod) return res.status(404).json({ exito: false, error: 'Producto no encontrado.' });

    if (MODO_DEMO) {
      const actual = await leerJsonLocal('menu.json', MENU_DEMO);
      const p = actual.find(x => String(x.id) === id);
      if (p) p.stock = (Number(p.stock) || 0) + cantidad;
      await escribirJsonLocal('menu.json', actual);
    } else {
      const r = await gasPost('actualizarStock', { id, cantidad, sucursal: req.sesion.sucursalId });
      if (!r || r.exito !== true) {
        return res.status(502).json({ exito: false, error: r?.error || 'Apps Script no actualizó el stock.' });
      }
    }
    invalidarCacheMenu();
    console.log(`[stock] +${cantidad} de ${prod.nombre} en ${req.sesion.sucursalId}`);
    res.json({ exito: true });
  } catch (err) {
    console.error('[stock]', err.message);
    res.status(502).json({ exito: false, error: err.message });
  }
});

// --------------------------------------------------------------------------
// 5.7 SALUD Y ARCHIVOS ESTÁTICOS
// --------------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, modo: MODO_DEMO ? 'demo-local' : 'google-sheets', sucursales: SUCURSALES.length });
});

/**
 * Se sirven SOLO los archivos públicos por nombre.
 * Ojo: no se usa express.static(__dirname) porque eso publicaría .env,
 * server.js y package.json en internet.
 */
const PUBLICOS = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/manifest.json': 'manifest.json',
  '/sw.js': 'sw.js'
};

for (const [ruta, archivo] of Object.entries(PUBLICOS)) {
  app.get(ruta, (_req, res) => {
    const completo = path.join(__dirname, archivo);
    if (!fs.existsSync(completo)) return res.status(404).send('No encontrado');
    res.sendFile(completo);
  });
}

app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ===========================================================================
// 6. MENÚ DE EJEMPLO (solo modo demo, cuando aún no hay GAS_URL)
// ===========================================================================

const MENU_DEMO = [
  { id: 'P001', nombre: 'Alitas (6 pcs)', categoria: 'ALITAS', precio: 35, imagenUrl: '', disponible: true, stock: '' },
  { id: 'P002', nombre: 'Alitas (12 pcs)', categoria: 'ALITAS', precio: 62, imagenUrl: '', disponible: true, stock: '' },
  { id: 'P003', nombre: 'Chicken Fingers (5 pcs)', categoria: 'FINGERS', precio: 38, imagenUrl: '', disponible: true, stock: '' },
  { id: 'P004', nombre: 'Pollo a la Canasta', categoria: 'POLLO A LA CANASTA', precio: 45, imagenUrl: '', disponible: true, stock: '' },
  { id: 'P005', nombre: 'Papas Fritas', categoria: 'ACOMPAÑAMIENTOS', precio: 15, imagenUrl: '', disponible: true, stock: '' },
  { id: 'P006', nombre: 'Coca Cola 500ml', categoria: 'BEBIDAS', precio: 8, imagenUrl: '', disponible: true, stock: 24 },
  { id: 'P007', nombre: 'Sprite 500ml', categoria: 'BEBIDAS', precio: 8, imagenUrl: '', disponible: true, stock: 18 },
  { id: 'P008', nombre: 'Agua 500ml', categoria: 'BEBIDAS', precio: 6, imagenUrl: '', disponible: true, stock: 30 }
];

// ===========================================================================
// 7. ARRANQUE
// ===========================================================================

app.listen(PORT, () => {
  console.log('\n🔥  REPUBLIC WINGS — Servidor POS');
  console.log(`    Puerto      : ${PORT}  (http://localhost:${PORT})`);
  console.log(`    Entorno     : ${NODE_ENV}`);
  console.log(`    Origen datos: ${MODO_DEMO ? 'DEMO local (./data) — define GAS_URL en .env para usar Google Sheets' : 'Google Apps Script'}`);
  console.log(`    Sucursales  : ${SUCURSALES.map(s => s.nombre).join(', ')}\n`);
});
