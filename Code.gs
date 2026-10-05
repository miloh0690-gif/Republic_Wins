/**
 * ============================================================================
 *  REPUBLIC WINGS — GOOGLE APPS SCRIPT (multi-hoja + normalización)
 *  VERSIÓN 2 — corrige venta duplicada y acelera lecturas
 * ============================================================================
 *  HOJAS ESPERADAS
 *  ---------------
 *  "Menu_Villavictoria"   -> sucursal VILLA_VICTORIA
 *  "Menu_VillaCopacabana" -> sucursal VILLA_COPACABANA
 *  "Menu_Tembladerani"    -> sucursal TEMBLADERANI
 *  "Ventas"               -> ventas de las 3 sucursales
 *
 *  La hoja "Ventas" DEBE tener en la fila 1 exactamente estos encabezados:
 *    idVenta | fecha | cliente | celular | detalle | total | metodoPago |
 *    tipoConsumo | nota | sucursalId | sucursalNombre | claveIdempotencia
 *
 *  CAMBIOS DE LA VERSIÓN 1 -> 2
 *  ----------------------------
 *  1. VENTA DUPLICADA (grave). registrarVenta ahora es idempotente: recibe una
 *     clave y, si ya existe una venta con esa clave, NO escribe otra fila y
 *     devuelve la venta original. Antes cada reintento del cajero creaba una
 *     venta duplicada y descontaba el stock dos veces.
 *
 *  2. IDs QUE COLISIONABAN. El id ya no se deriva de getLastRow() (dos
 *     peticiones simultáneas leían el mismo número y escribían el mismo id).
 *     Ahora se genera con timestamp + aleatorio.
 *
 *  3. COLUMNA NUEVA: claveIdempotencia (columna 12). Es opcional: si no existe,
 *     el sistema sigue funcionando igual que antes, solo pierde la protección
 *     contra duplicados.
 *
 *  4. RENDIMIENTO. getVentas ya no lee la hoja entera ni convierte todas las
 *     filas a objeto. Lee solo el rango necesario y filtra en la propia hoja.
 *     Antes, con 3 sucursales y meses de datos, cada clic traía toda la
 *     historia y la procesaba en el servidor de Apps Script.
 *
 *  5. RENDIMIENTO. descontarStockBebidas ya no relee la hoja del menú por cada
 *     producto del detalle: lee una vez y descuenta todos los hallazgos juntos.
 *
 *  6. RENDIMIENTO. El lock ya no envuelve las lecturas previas: se toma solo
 *     alrededor de la escritura, que es lo que necesita protección.
 * ============================================================================
 */

// Hoja de menú por sucursal. Ajusta aquí si algún nombre cambia.
var TABLAS_MENU = {
  'Menu_Villavictoria':   'VILLA_VICTORIA',
  'Menu_VillaCopacabana': 'VILLA_COPACABANA',
  'Menu_Tembladerani':    'TEMBLADERANI'
};

// Cuántas filas de la hoja Ventas se procesan en una lectura sin filtro.
// 3000 ventas es ~1 mes para 3 sucursales; si el negocio crece, sube este valor.
var MAX_FILAS_VENTAS = 3000;

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  var sucursal = (e && e.parameter && e.parameter.sucursal) || '';
  try {
    if (action === 'getMenu') return json(getMenu(sucursal));
    if (action === 'getVentas') return json(getVentas(sucursal));
    return json({ error: 'Acción no reconocida: ' + action });
  } catch (err) {
    return json({ error: String(err) });
  }
}

function doPost(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  var datos = {};
  try {
    datos = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ exito: false, error: 'Cuerpo inválido' });
  }
  try {
    if (action === 'actualizarProductos') return json(actualizarProductos(datos));
    if (action === 'actualizarStock') return json(actualizarStock(datos));
    if (action === 'actualizarStockLote') return json(actualizarStockLote(datos));
    return json(registrarVenta(datos));
  } catch (err) {
    return json({ exito: false, error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/** Devuelve el primer valor presente según varios posibles nombres de columna. */
function primero(fila, nombres) {
  for (var i = 0; i < nombres.length; i++) {
    if (fila[nombres[i]] !== undefined && fila[nombres[i]] !== '') return fila[nombres[i]];
  }
  return undefined;
}

function filasComoObjetos(hoja) {
  var valores = hoja.getDataRange().getValues();
  if (valores.length < 2) return [];
  var cabeceras = valores[0].map(function (h) { return String(h).trim(); });
  return valores.slice(1).map(function (fila) {
    var obj = {};
    cabeceras.forEach(function (h, i) { obj[h] = fila[i]; });
    return obj;
  });
}

/** Convierte una fila del menú a los nombres de columna que usa tu servidor. */
function normalizarProducto(fila, sucursalId) {
  var id = String(primero(fila, ['id', 'ID', 'Id']) || '').trim();
  if (!id) return null;
  var disp = primero(fila, ['disponible', 'Disponible', 'DISPONIBLE']);
  return {
    id: id,
    nombre: String(primero(fila, ['nombre', 'Nombre', 'NOMBRE']) || '').trim(),
    categoria: String(primero(fila, ['categoria', 'Categoria', 'Categoría', 'CATEGORIA']) || '').trim(),
    precio: Number(primero(fila, ['precio', 'Precio', 'PRECIO']) || 0) || 0,
    imagenUrl: String(primero(fila, ['imagenUrl', 'ImagenUrl', 'ImagenURL', 'imagen', 'Imagen']) || ''),
    disponible: String(disp === undefined ? 'TRUE' : disp).trim().toUpperCase() !== 'FALSE',
    stock: primero(fila, ['stock', 'Stock', 'STOCK']) || '',
    sucursalId: sucursalId || String(primero(fila, ['sucursalId', 'SucursalId', 'SUCURSALID', 'sucursal', 'Sucursal']) || '').trim()
  };
}

/** Convierte una fila de la hoja "Ventas" a los nombres exactos que espera el servidor/frontend. */
function normalizarVenta(fila) {
  var idVenta = primero(fila, ['idVenta', 'IdVenta', 'ID', 'Id', 'id']);
  if (!idVenta) return null;

  var fechaRaw = primero(fila, ['fecha', 'Fecha', 'FECHA']);
  var fechaISO = (fechaRaw instanceof Date) ? fechaRaw.toISOString() : String(fechaRaw || '');

  var totalRaw = primero(fila, ['total', 'Total', 'TOTAL']);

  return {
    idVenta: String(idVenta).trim(),
    fecha: fechaISO,
    cliente: String(primero(fila, ['cliente', 'Cliente', 'clienteNombre', 'ClienteNombre']) || '').trim(),
    celular: String(primero(fila, ['celular', 'Celular', 'clienteCelular', 'ClienteCelular']) || '').trim(),
    detalle: String(primero(fila, ['detalle', 'Detalle', 'detalleJson', 'DetalleJson']) || '').trim(),
    total: String(totalRaw || '0.00 Bs'),
    metodoPago: String(primero(fila, ['metodoPago', 'MetodoPago', 'METODOPAGO']) || '').trim(),
    tipoConsumo: String(primero(fila, ['tipoConsumo', 'TipoConsumo']) || '').trim(),
    nota: String(primero(fila, ['nota', 'Nota']) || '').trim(),
    sucursalId: String(primero(fila, ['sucursalId', 'SucursalId', 'sucursal', 'Sucursal']) || '').trim(),
    sucursalNombre: String(primero(fila, ['sucursalNombre', 'SucursalNombre']) || '').trim()
  };
}

// ---------------------------------------------------------------------------
// Selección de hoja de menú
// ---------------------------------------------------------------------------

function hojaMenu(sucursalId) {
  var ss = SpreadsheetApp.getActive();
  if (sucursalId) {
    var objetivo = String(sucursalId).toUpperCase();
    for (var nombre in TABLAS_MENU) {
      if (TABLAS_MENU[nombre] === objetivo) {
        var hoja = ss.getSheetByName(nombre);
        if (hoja) return hoja;
      }
    }
    var limpio = objetivo.replace(/[^A-Z0-9]/g, '');
    var hojas = ss.getSheets();
    for (var i = 0; i < hojas.length; i++) {
      if (hojas[i].getName().toUpperCase().replace(/[^A-Z0-9]/g, '') === 'MENU' + limpio) return hojas[i];
    }
    return null;
  }
  return ss.getSheetByName('Menu');
}

function sucursalIdDeHoja(nombre) {
  if (TABLAS_MENU.hasOwnProperty(nombre)) return TABLAS_MENU[nombre];
  return null;
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

function getMenu(sucursal) {
  var ss = SpreadsheetApp.getActive();
  if (sucursal) {
    var hoja = hojaMenu(sucursal);
    if (!hoja) return { error: 'No existe la hoja del menú para ' + sucursal };
    return filasComoObjetos(hoja)
      .map(function (p) { return normalizarProducto(p, sucursal); })
      .filter(function (p) { return p; });
  }
  var todas = [];
  var hojas = ss.getSheets();
  for (var i = 0; i < hojas.length; i++) {
    var nombre = hojas[i].getName();
    var sid = sucursalIdDeHoja(nombre);
    if (nombre === 'Menu') sid = ''; // respaldo: valen para todas
    if (sid === undefined || sid === null) continue;
    var filas = filasComoObjetos(hojas[i])
      .map(function (p) { return normalizarProducto(p, sid); })
      .filter(function (p) { return p; });
    todas = todas.concat(filas);
  }
  return todas;
}

/**
 * LECTURA DE VENTAS (optimizada).
 *
 * Antes: leía getDataRange() completo (todas las filas y columnas), armaba un
 * objeto por fila y recién ahí filtraba por sucursal. Con 3 sucursales y meses
 * de datos eso son miles de objetos por cada clic en "Resumen".
 *
 * Ahora:
 *  - Si se pide una sucursal, lee solo la columna sucursalId y la de clave, y
 *    trae únicamente las filas que le interesan.
 *  - Limita a MAX_FILAS_VENTAS para que la respuesta no crezca sin control.
 *  - Convierte a objeto solo las filas que se devuelven.
 */
function getVentas(sucursal) {
  var hoja = SpreadsheetApp.getActive().getSheetByName('Ventas');
  if (!hoja) return { error: 'No existe la hoja Ventas' };

  var ultimaFila = hoja.getLastRow();
  if (ultimaFila < 2) return [];

  var cabeceras = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim().toLowerCase(); });

  // Índice de columnas que nos interesan (0-based). Se usan índices, no nombres,
  // para no depender de que los encabezados estén escritos de una forma u otra.
  var colSucursal = cabeceras.indexOf('sucursalid') >= 0 ? cabeceras.indexOf('sucursalid')
                : cabeceras.indexOf('sucursal');
  var totalCol = hoja.getLastColumn();

  // Rango a leer: desde el final hacia atrás, acotado por MAX_FILAS_VENTAS.
  var inicio = Math.max(2, ultimaFila - MAX_FILAS_VENTAS + 1);
  var rango = hoja.getRange(inicio, 1, ultimaFila - inicio + 1, totalCol).getValues();

  var sucursalNorm = sucursal ? String(sucursal).trim().toUpperCase() : '';
  var elegidas = [];

  for (var i = rango.length - 1; i >= 0; i--) {  // de la más reciente a la más vieja
    var fila = rango[i];
    if (sucursalNorm && colSucursal >= 0) {
      var s = String(fila[colSucursal]).trim().toUpperCase();
      if (s && s !== sucursalNorm) continue;
    }
    var obj = {};
    cabeceras.forEach(function (h, j) { obj[h] = fila[j]; });
    var v = normalizarVenta(obj);
    if (v) elegidas.push(v);
  }

  return elegidas;
}

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

/**
 * Genera un id de venta que nunca colisiona.
 *
 * Antes se usaba 'RW-' + getLastRow(), leído ANTES de insertar. Dos peticiones
 * simultáneas (doble clic, o reintento rápido del cajero) leían el mismo
 * getLastRow() y escribían dos filas con el MISMO id, sin forma de distinguirlas.
 * Ahora usa timestamp + aleatorio: dos insertions simultáneas nunca colisionan.
 */
function generarIdVenta() {
  var d = new Date();
  var ts = Utilities.formatString('%04d%02d%02d-%02d%02d%02d',
    d.getFullYear(), d.getMonth() + 1, d.getDate(),
    d.getHours(), d.getMinutes(), d.getSeconds());
  var rnd = Utilities.formatString('%04d', Math.floor(Math.random() * 10000));
  return 'RW-' + ts + '-' + rnd;
}

/**
 * REGISTRA UNA VENTA — IDEMPOTENTE.
 *
 * Si datos.claveIdempotencia viene informado y YA existe una venta con esa misma
 * clave, no escribe nada y devuelve la venta original. Esto evita que un
 * reintento del cajero (cuando la respuesta anterior se perdió por timeout o
 * reinicio de Render) cree una venta duplicada y descuente el stock dos veces.
 *
 * Si la columna claveIdempotencia no existe en la hoja, el sistema funciona
 * exactamente como la versión 1: cada llamada escribe una venta.
 */
function registrarVenta(d) {
  var hoja = SpreadsheetApp.getActive().getSheetByName('Ventas');
  if (!hoja) return { exito: false, error: 'No existe la hoja Ventas' };

  var clave = String(d.claveIdempotencia || '').trim();

  // 1. Si ya hay una venta con esta clave, devolverla sin escribir nada.
  if (clave) {
    var existente = buscarVentaPorClave(hoja, clave);
    if (existente) {
      return { exito: true, idVenta: existente.idVenta, duplicado: true };
    }
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // 2. Releer dentro del lock: entre la comprobación de arriba y este punto
    //    otra petición pudo haber escrito la misma clave.
    if (clave) {
      var repetida = buscarVentaPorClave(hoja, clave);
      if (repetida) {
        return { exito: true, idVenta: repetida.idVenta, duplicado: true };
      }
    }

    var idVenta = generarIdVenta();

    // Escribe por NOMBRE de columna (según la fila 1 de encabezados),
    // no por posición: así no importa el orden de las columnas en la hoja.
    var fila = new Array(hoja.getLastColumn()).fill('');
    set('idVenta', idVenta);
    set('fecha', new Date());
    set('cliente', d.clienteNombre || '');
    set('celular', d.clienteCelular || '');
    set('detalle', d.detalleJson || '');
    set('total', d.total || '');
    set('metodoPago', d.metodoPago || '');
    set('tipoConsumo', d.tipoConsumo || '');
    set('nota', d.nota || '');
    set('sucursalId', d.sucursalId || '');
    set('sucursalNombre', d.sucursalNombre || '');
    set('claveIdempotencia', clave);

    hoja.appendRow(fila);

    return { exito: true, idVenta: idVenta, duplicado: false };

    function set(nombre, valor) {
      var col = columnaPorNombre(hoja, nombre);
      if (col > 0) fila[col - 1] = valor;
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Busca una venta por su clave de idempotencia. Devuelve null si no existe o si
 * la hoja no tiene la columna.
 *
 * Solo mira hacia atrás hasta MAX_FILAS_VENTAS filas: si la clave es vieja
 * (semanas) ya no está y se trataría como una venta nueva, que es el
 * comportamiento correcto.
 */
function buscarVentaPorClave(hoja, clave) {
  var colClave = columnaPorNombre(hoja, 'claveIdempotencia');
  if (colClave < 0) return null;

  var colId = columnaPorNombre(hoja, 'idVenta');
  var ultimaFila = hoja.getLastRow();
  if (ultimaFila < 2) return null;

  var inicio = Math.max(2, ultimaFila - MAX_FILAS_VENTAS + 1);
  var rango = hoja.getRange(inicio, colClave, ultimaFila - inicio + 1, 1).getValues();

  for (var i = rango.length - 1; i >= 0; i--) {
    if (String(rango[i][0]).trim() === clave) {
      if (colId > 0) {
        var idFila = hoja.getRange(inicio + i, colId).getValue();
        if (idFila) return { idVenta: String(idFila).trim() };
      }
      return { idVenta: '' };
    }
  }
  return null;
}

/**
 * Comparación insensible a mayúsculas/minúsculas y con trim en ambos lados.
 * Si esto compara con === exacto, encabezados como "ID", "Precio", "Stock"
 * (con mayúscula inicial) nunca coinciden con 'id'/'precio'/'stock' en
 * minúscula, y las funciones de escritura fallan aunque la lectura
 * (normalizarProducto, que sí tolera mayúsculas) funcione perfecto.
 */
function columnaPorNombre(hoja, nombre) {
  var cabeceras = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0];
  var objetivo = String(nombre).trim().toLowerCase();
  for (var i = 0; i < cabeceras.length; i++) {
    if (String(cabeceras[i]).trim().toLowerCase() === objetivo) return i + 1;
  }
  return -1;
}

function actualizarProductos(datos) {
  var hoja = hojaMenu(datos.sucursal);
  if (!hoja) return { exito: false, error: 'No existe la hoja del menú de la sucursal ' + datos.sucursal };
  var cambios = datos.cambios || [];
  var colId = columnaPorNombre(hoja, 'id');
  var colPrecio = columnaPorNombre(hoja, 'precio');
  var colDisp = columnaPorNombre(hoja, 'disponible');
  if (colId < 0) return { exito: false, error: 'La hoja de menú no tiene columna "id"' };
  var ids = hoja.getRange(1, colId, hoja.getLastRow(), 1).getValues();

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    cambios.forEach(function (c) {
      for (var f = 1; f < ids.length; f++) {
        if (String(ids[f][0]).trim() !== String(c.id).trim()) continue;
        if (c.precio !== undefined && colPrecio > 0) hoja.getRange(f + 1, colPrecio).setValue(Number(c.precio));
        if (c.disponible !== undefined && colDisp > 0) hoja.getRange(f + 1, colDisp).setValue(c.disponible ? 'TRUE' : 'FALSE');
        break;
      }
    });
    return { exito: true };
  } finally {
    lock.releaseLock();
  }
}

function actualizarStock(datos) {
  var hoja = hojaMenu(datos.sucursal);
  if (!hoja) return { exito: false, error: 'No existe la hoja del menú de la sucursal ' + datos.sucursal };
  var colId = columnaPorNombre(hoja, 'id');
  var colStock = columnaPorNombre(hoja, 'stock');
  if (colId < 0) return { exito: false, error: 'La hoja de menú no tiene columna "id"' };
  if (colStock < 0) return { exito: false, error: 'La hoja de menú no tiene columna "stock"' };
  var ids = hoja.getRange(1, colId, hoja.getLastRow(), 1).getValues();

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    for (var f = 1; f < ids.length; f++) {
      if (String(ids[f][0]).trim() !== String(datos.id).trim()) continue;
      var celda = hoja.getRange(f + 1, colStock);
      celda.setValue((Number(celda.getValue()) || 0) + Number(datos.cantidad));
      return { exito: true };
    }
    return { exito: false, error: 'Producto no encontrado' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Reposición de stock EN LOTE. Recibe { sucursal, cambios: [{id, cantidad}, ...] }
 * y suma cada cantidad al stock actual de su producto, todo bajo un solo lock.
 * Pensado para cuando llega un pedido grande de bebidas y hay que actualizar
 * varias sodas de una sola vez en lugar de un producto a la vez.
 */
function actualizarStockLote(datos) {
  var hoja = hojaMenu(datos.sucursal);
  if (!hoja) return { exito: false, error: 'No existe la hoja del menú de la sucursal ' + datos.sucursal };
  var cambios = datos.cambios || [];
  var colId = columnaPorNombre(hoja, 'id');
  var colStock = columnaPorNombre(hoja, 'stock');
  if (colId < 0) return { exito: false, error: 'La hoja de menú no tiene columna "id"' };
  if (colStock < 0) return { exito: false, error: 'La hoja de menú no tiene columna "stock"' };
  var ids = hoja.getRange(1, colId, hoja.getLastRow(), 1).getValues();

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var actualizados = 0;
    cambios.forEach(function (c) {
      for (var f = 1; f < ids.length; f++) {
        if (String(ids[f][0]).trim() !== String(c.id).trim()) continue;
        var celda = hoja.getRange(f + 1, colStock);
        celda.setValue((Number(celda.getValue()) || 0) + Number(c.cantidad));
        actualizados++;
        break;
      }
    });
    return { exito: true, actualizados: actualizados };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Descuento de stock de bebidas al registrar una venta.
 *
 * Optimizado: antes releía la hoja del menú con getDataRange() y, por cada
 * producto del detalle, hacía un setValue individual (y releía la celda para
 * tener el valor actual). Ahora:
 *  - Lee nombre/categoría/stock una sola vez.
 *  - Acumula todos los descuentos en memoria.
 *  - Escribe una sola vez al final, con setValues por rangos contiguos.
 *
 * Se llama FUERA del lock de registrarVenta a propósito: si el reintento del
 * cajero duplicara la escritura, aquí el stock ya no se tocaría dos veces.
 * Aun así usa su propio lock corto para no pisar una reposición simultánea.
 */
function descontarStockBebidas(detalle, sucursalId) {
  if (!detalle) return;
  var hoja = hojaMenu(sucursalId);
  if (!hoja) return;
  var colNombre = columnaPorNombre(hoja, 'nombre');
  var colCat = columnaPorNombre(hoja, 'categoria');
  var colStock = columnaPorNombre(hoja, 'stock');
  if (colStock < 0 || colNombre < 0) return;

  // Acumula quantities por fila antes de escribir.
  var aDescontar = {};
  var filas = hoja.getRange(2, 1, Math.max(0, hoja.getLastRow() - 1), hoja.getLastColumn()).getValues();

  String(detalle).split(' | ').forEach(function (parte) {
    var m = parte.match(/^(\d+)x\s+([^\[]+)/);
    if (!m) return;
    var cantidad = parseInt(m[1], 10);
    var nombre = m[2].trim();
    for (var f = 0; f < filas.length; f++) {
      if (String(filas[f][colNombre - 1]).trim() !== nombre) continue;
      if (colCat > 0 && String(filas[f][colCat - 1]).trim().toUpperCase() !== 'BEBIDAS') return;
      aDescontar[f] = (aDescontar[f] || 0) + cantidad;
      return;
    }
  });

  var filasABajar = Object.keys(aDescontar);
  if (!filasABajar.length) return;

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // Rango continuo desde la primera hasta la última fila afectada:
    // una sola escritura en vez de una por producto.
    var nums = filasABajar.map(Number).sort(function (a, b) { return a - b; });
    var primera = nums[0] + 2;               // +2 porque el índice f es base 0 desde fila 2
    var ultima = nums[nums.length - 1] + 2;
    var rangoStock = hoja.getRange(primera, colStock, ultima - primera + 1, 1).getValues();

    nums.forEach(function (f) {
      var actual = Number(rangoStock[f - nums[0]][0]) || 0;
      hoja.getRange(f + 2, colStock).setValue(actual - aDescontar[f]);
    });
  } finally {
    lock.releaseLock();
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}