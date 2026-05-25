// ============================================================
//  index.js — Samuel Hack Store Bot v2.1
//  - Nodos Firebase configurables desde Firestore (bot/config)
//  - Notificaciones WA muestran número real del remitente
//  - Telegram: username + ID real
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const { initializeApp, getApps } = require('firebase/app');
const { getDatabase, ref, get, set, update, push, remove, onChildAdded } = require('firebase/database');
const { getFirestore, doc, getDoc, getDocs, setDoc, collection, updateDoc, query, orderBy, limit } = require('firebase/firestore');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const config = require('./config');

// ── FIREBASE INIT ─────────────────────────────────────────────
const firebaseApp = getApps().length === 0 ? initializeApp(config.firebaseConfig) : getApps()[0];
const rtdb = getDatabase(firebaseApp);
const fstore = getFirestore(firebaseApp);

// ── TELEGRAM INIT ─────────────────────────────────────────────
const bot = new TelegramBot(config.telegramToken, { polling: true });

// ── ESTADOS CONVERSACIONALES ──────────────────────────────────
const waEstados = {};
const tgEstados = {};
let waSock = null;

// ══════════════════════════════════════════════════════════════
//  NODOS DINÁMICOS — se leen desde Firestore: bot/config
//  El admin puede cambiarlos sin reiniciar el bot
//  Documento: bot/config  →  campo "nodos" con los paths
//  Si no existe en Firestore, usa los defaults de config.js
// ══════════════════════════════════════════════════════════════
let N = { ...config.firebaseNodes }; // empieza con defaults

async function cargarNodosDesdeFirestore() {
    try {
        const snap = await getDoc(doc(fstore, 'bot', 'config'));
        if (snap.exists() && snap.data().nodos) {
            N = { ...config.firebaseNodes, ...snap.data().nodos };
            console.log('[CONFIG] Nodos cargados desde Firestore:', N);
        } else {
            // Primera vez: crea el documento con los defaults para que el admin lo vea
            await setDoc(doc(fstore, 'bot', 'config'), { nodos: config.firebaseNodes }, { merge: true });
            console.log('[CONFIG] Documento bot/config creado en Firestore con defaults.');
        }
    } catch(e) {
        console.warn('[CONFIG] Error cargando nodos, usando defaults:', e.message);
    }
}

// Recarga nodos cada 5 minutos sin reiniciar el bot
setInterval(async () => {
    try {
        const snap = await getDoc(doc(fstore, 'bot', 'config'));
        if (snap.exists() && snap.data().nodos) {
            N = { ...config.firebaseNodes, ...snap.data().nodos };
        }
    } catch(e) {}
}, 5 * 60 * 1000);

// ══════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════
const ADMINS_WA = (config.adminWaNumbers || []).map(n => n.replace(/\D/g, ''));
function esAdminWA(numero) { return ADMINS_WA.includes(String(numero).replace(/\D/g, '')); }
function esAdminTG(chatId) { return String(chatId) === String(config.adminTelegramId); }

// ══════════════════════════════════════════════════════════════
//  FIREBASE HELPERS
// ══════════════════════════════════════════════════════════════
const fmt = n => `$${parseFloat(n || 0).toFixed(2)}`;

async function rtdbGet(nodo)        { const s = await get(ref(rtdb, nodo)); return s.exists() ? s.val() : null; }
async function rtdbSet(nodo, data)  { await set(ref(rtdb, nodo), data); }
async function rtdbPush(nodo, data) { const r = await push(ref(rtdb, nodo), data); return r.key; }
async function rtdbDelete(nodo)     { await remove(ref(rtdb, nodo)); }

function rtdbEscucharNuevos(nodo, cb) {
    onChildAdded(ref(rtdb, nodo), snap => { if (snap.exists()) cb(snap.key, snap.val()); });
}

async function fsGetDoc(ruta) {
    const p = ruta.split('/');
    const d = await getDoc(doc(fstore, ...p));
    return d.exists() ? { id: d.id, ...d.data() } : null;
}
async function fsUpdate(ruta, data) { await updateDoc(doc(fstore, ...ruta.split('/')), data); }
async function fsGetOrdenado(col, campo, dir = 'desc', max = 50) {
    const q = query(collection(fstore, ...col.split('/')), orderBy(campo, dir), limit(max));
    const s = await getDocs(q);
    return s.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ── Helpers de negocio ───────────────────────────────────────
async function getProductos()           { return await rtdbGet(N.productos); }
async function getCliente(uid)          { return await fsGetDoc(`${N.clientesLista}/${uid}`); }
async function actualizarSaldo(uid, s)  { await fsUpdate(`${N.clientesLista}/${uid}`, { dinero_usd: s }); }
async function getTopRecargadores(n=10) { return await fsGetOrdenado(N.clientesLista, 'total_recargado', 'desc', n); }

async function aprobarRecarga(id, uid, monto) {
    const c = await getCliente(uid);
    if (!c) throw new Error('Cliente no encontrado');
    const nuevoSaldo = parseFloat(c.dinero_usd || 0) + parseFloat(monto);
    const nuevoTotal = parseFloat(c.total_recargado || 0) + parseFloat(monto);
    await Promise.all([
        fsUpdate(`${N.clientesLista}/${uid}`, { dinero_usd: nuevoSaldo, total_recargado: nuevoTotal }),
        rtdbDelete(`${N.recargasPendientes}/${id}`),
        rtdbSet(`${N.recargasHistorial}/${id}`, { uid, monto, estado: 'aprobada', fecha: new Date().toISOString() })
    ]);
    return nuevoSaldo;
}

async function rechazarRecarga(id, uid) {
    await Promise.all([
        rtdbDelete(`${N.recargasPendientes}/${id}`),
        rtdbSet(`${N.recargasHistorial}/${id}`, { uid, estado: 'rechazada', fecha: new Date().toISOString() })
    ]);
}

function listaProductos(prods) {
    if (!prods) return '_(Sin productos)_';
    return Object.entries(prods)
        .filter(([, p]) => p.activo !== false)
        .map(([id, p], i) => `*${i+1}.* ${p.nombre || id} — ${fmt(p.precio)} | Stock: ${p.stock ?? '—'}`)
        .join('\n') || '_(Sin productos)_';
}

// ══════════════════════════════════════════════════════════════
//  NOTIFICACIONES AL ADMIN
// ══════════════════════════════════════════════════════════════
function notificarAdminTG(txt) {
    bot.sendMessage(config.adminTelegramId, txt, { parse_mode: 'Markdown' }).catch(() => {});
}
function notificarAdminWA(txt) {
    if (!waSock) return;
    ADMINS_WA.forEach(num => {
        waSock.sendMessage(`${num}@s.whatsapp.net`, { text: txt }).catch(() => {});
    });
}
function notificarAdmin(txt) { notificarAdminTG(txt); notificarAdminWA(txt); }

// ══════════════════════════════════════════════════════════════
//  LISTENERS FIREBASE (tiempo real)
// ══════════════════════════════════════════════════════════════
function iniciarListeners() {
    rtdbEscucharNuevos(N.pedidosNuevos, (id, p) => notificarAdmin(
`🛒 *Nuevo Pedido*
ID: \`${id}\`
Producto: *${p.producto || '—'}*
Usuario: ${p.uid || '—'}
Total: *${fmt(p.total)}*
📅 ${p.fecha || new Date().toLocaleString('es')}`
    ));

    rtdbEscucharNuevos(N.recargasPendientes, (id, r) => {
        const txt =
`💳 *Nueva Recarga Pendiente*
ID: \`${id}\`
UID: \`${r.uid}\`
Número WA: ${r.numero || '—'}
Monto: *${fmt(r.monto)}*
Método: ${r.metodo || '—'}
Canal: ${r.canal || '—'}

✅ \`/aprobar ${id} ${r.uid} ${r.monto}\`
🚫 \`/rechazar ${id} ${r.uid}\``;
        notificarAdminWA(txt);
        bot.sendMessage(config.adminTelegramId, txt, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[
                { text: '✅ Aprobar', callback_data: `aprobar:${id}:${r.uid}:${r.monto}` },
                { text: '🚫 Rechazar', callback_data: `rechazar:${id}:${r.uid}` }
            ]]}
        }).catch(() => {});
    });

    rtdbEscucharNuevos(N.soporteMensajes, (id, m) => notificarAdmin(
`📨 *Mensaje de Soporte*
Usuario: *${m.username || m.uid || '—'}*
${m.numero ? `Número: +${m.numero}\n` : ''}Canal: ${m.canal || 'web'}
"${m.texto}"`
    ));

    rtdbEscucharNuevos(N.notificaciones, (id, n) => notificarAdmin(
        `🔔 *Notificación*\n${n.titulo || ''}\n${n.mensaje || n.texto || ''}`
    ));

    console.log('[LISTENERS] ✅ Firebase escuchando en tiempo real');
}

// ══════════════════════════════════════════════════════════════
//  TELEGRAM — ADMIN
// ══════════════════════════════════════════════════════════════
const adminOnly = (msg, fn) => {
    if (!esAdminTG(msg.chat.id)) return bot.sendMessage(msg.chat.id, config.mensajes.noAutorizado);
    return fn();
};

bot.onText(/\/admin|\/menu/, msg => adminOnly(msg, () =>
    bot.sendMessage(msg.chat.id,
`🛠 *Panel Admin — ${config.botName}*

*USUARIOS*
/usuario [uid] — datos del cliente
/saldo [uid] [monto] — asignar saldo
/toprecargadores — top 10

*RECARGAS*
/pendientes — recargas sin aprobar
/aprobar [id] [uid] [monto]
/rechazar [id] [uid]

*PRODUCTOS*
/productos — catálogo RTDB
/stockbajo — alertas de stock

*WEB*
/pedidos — últimos pedidos
/soporte — mensajes de soporte

*SISTEMA*
/nodos — ver nodos activos
/ping — estado del bot`,
        { parse_mode: 'Markdown' })
));

bot.onText(/\/nodos/, msg => adminOnly(msg, () =>
    bot.sendMessage(msg.chat.id,
`⚙️ *Nodos Firebase activos*
_(editables en Firestore: bot/config → nodos)_

productos: \`${N.productos}\`
pedidosNuevos: \`${N.pedidosNuevos}\`
recargasPendientes: \`${N.recargasPendientes}\`
recargasHistorial: \`${N.recargasHistorial}\`
soporteMensajes: \`${N.soporteMensajes}\`
notificaciones: \`${N.notificaciones}\`
clientesLista: \`${N.clientesLista}\``,
        { parse_mode: 'Markdown' })
));

bot.onText(/\/usuario (.+)/, async (msg, match) => adminOnly(msg, async () => {
    const c = await getCliente(match[1].trim());
    if (!c) return bot.sendMessage(msg.chat.id, `❌ Cliente no encontrado.`);
    bot.sendMessage(msg.chat.id,
`👤 *${c.usuario || c.username || match[1]}*
🆔 \`${match[1]}\`
💲 Saldo: ${fmt(c.dinero_usd)}
📦 Total recargado: ${fmt(c.total_recargado)}
🏅 Rango: ${c.rango || '—'}
✅ Verificado: ${c.verificado ? 'Sí' : 'No'}
📞 ${c.contacto || '—'}`,
        { parse_mode: 'Markdown' });
}));

bot.onText(/\/saldo (\S+) (\S+)/, async (msg, match) => adminOnly(msg, async () => {
    const monto = parseFloat(match[2]);
    if (isNaN(monto)) return bot.sendMessage(msg.chat.id, 'Monto inválido.');
    await actualizarSaldo(match[1], monto);
    bot.sendMessage(msg.chat.id, `✅ Saldo de \`${match[1]}\` → *${fmt(monto)}*`, { parse_mode: 'Markdown' });
}));

bot.onText(/\/toprecargadores/, async msg => adminOnly(msg, async () => {
    const top = await getTopRecargadores(10);
    if (!top || !top.length) return bot.sendMessage(msg.chat.id, 'Sin datos aún.');
    const lista = top.map((c, i) => `${i+1}. *${c.usuario || c.id}* — ${fmt(c.total_recargado)} | ${c.rango || '—'}`).join('\n');
    bot.sendMessage(msg.chat.id, `🏆 *Top Recargadores*\n\n${lista}`, { parse_mode: 'Markdown' });
}));

bot.onText(/\/pendientes/, async msg => adminOnly(msg, async () => {
    const pend = await rtdbGet(N.recargasPendientes);
    if (!pend) return bot.sendMessage(msg.chat.id, '✅ No hay recargas pendientes.');
    for (const [id, r] of Object.entries(pend).slice(-5)) {
        bot.sendMessage(msg.chat.id,
            `⏳ *Recarga Pendiente*\nID: \`${id}\`\nUID: \`${r.uid}\`\nNúmero: ${r.numero || '—'}\nMonto: *${fmt(r.monto)}*\nMétodo: ${r.metodo || '—'}`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
                { text: '✅ Aprobar', callback_data: `aprobar:${id}:${r.uid}:${r.monto}` },
                { text: '🚫 Rechazar', callback_data: `rechazar:${id}:${r.uid}` }
            ]]}});
    }
}));

bot.on('callback_query', async cb => {
    if (!esAdminTG(cb.from.id)) return bot.answerCallbackQuery(cb.id, { text: 'Sin permiso.' });
    const [accion, id, uid, monto] = cb.data.split(':');
    if (accion === 'aprobar') {
        try {
            const nuevo = await aprobarRecarga(id, uid, parseFloat(monto));
            bot.answerCallbackQuery(cb.id, { text: `✅ Aprobada. Saldo: ${fmt(nuevo)}` });
            bot.editMessageText(`✅ *Aprobada* — ${uid} → ${fmt(nuevo)}`,
                { chat_id: cb.message.chat.id, message_id: cb.message.message_id, parse_mode: 'Markdown' });
        } catch(e) { bot.answerCallbackQuery(cb.id, { text: `❌ ${e.message}` }); }
    } else if (accion === 'rechazar') {
        await rechazarRecarga(id, uid);
        bot.answerCallbackQuery(cb.id, { text: '🚫 Rechazada.' });
        bot.editMessageText(`🚫 *Rechazada* — ${uid}`,
            { chat_id: cb.message.chat.id, message_id: cb.message.message_id, parse_mode: 'Markdown' });
    }
});

bot.onText(/\/aprobar (\S+) (\S+) (\S+)/, async (msg, match) => adminOnly(msg, async () => {
    const nuevo = await aprobarRecarga(match[1], match[2], parseFloat(match[3]));
    bot.sendMessage(msg.chat.id, `✅ Aprobada. Saldo de \`${match[2]}\`: *${fmt(nuevo)}*`, { parse_mode: 'Markdown' });
}));

bot.onText(/\/rechazar (\S+) (\S+)/, async (msg, match) => adminOnly(msg, async () => {
    await rechazarRecarga(match[1], match[2]);
    bot.sendMessage(msg.chat.id, `🚫 Recarga \`${match[1]}\` rechazada.`, { parse_mode: 'Markdown' });
}));

bot.onText(/\/productos/, async msg => adminOnly(msg, async () => {
    const prods = await getProductos();
    if (!prods) return bot.sendMessage(msg.chat.id, 'Sin productos en RTDB.');
    const lista = Object.entries(prods).map(([id, p]) =>
        `• *${p.nombre || id}* — ${fmt(p.precio)} | Stock: ${p.stock ?? '—'}`).join('\n');
    bot.sendMessage(msg.chat.id, `📦 *Catálogo RTDB*\n\n${lista}`, { parse_mode: 'Markdown' });
}));

bot.onText(/\/stockbajo/, async msg => adminOnly(msg, async () => {
    const prods = await getProductos();
    if (!prods) return bot.sendMessage(msg.chat.id, 'Sin productos.');
    const bajos = Object.entries(prods).filter(([, p]) => (p.stock ?? 99) <= 3)
        .map(([id, p]) => `⚠️ *${p.nombre || id}* — Stock: ${p.stock ?? 0}`).join('\n');
    bot.sendMessage(msg.chat.id, bajos || '✅ Stock en buen estado.', { parse_mode: 'Markdown' });
}));

bot.onText(/\/pedidos/, async msg => adminOnly(msg, async () => {
    const ped = await rtdbGet(N.pedidosNuevos);
    if (!ped) return bot.sendMessage(msg.chat.id, 'Sin pedidos nuevos.');
    const lista = Object.entries(ped).slice(-5)
        .map(([id, p]) => `🛒 *${p.producto || id}*\n👤 ${p.uid}\n💲 ${fmt(p.total)}`).join('\n─────\n');
    bot.sendMessage(msg.chat.id, `🛒 *Últimos Pedidos*\n\n${lista}`, { parse_mode: 'Markdown' });
}));

bot.onText(/\/soporte/, async msg => adminOnly(msg, async () => {
    const msgs = await rtdbGet(N.soporteMensajes);
    if (!msgs) return bot.sendMessage(msg.chat.id, 'Sin mensajes.');
    const lista = Object.entries(msgs).slice(-5)
        .map(([, m]) => `💬 *${m.username || m.uid || '?'}* (${m.numero || 'sin número'}): "${m.texto}"`).join('\n─────\n');
    bot.sendMessage(msg.chat.id, `📨 *Soporte*\n\n${lista}`, { parse_mode: 'Markdown' });
}));

bot.onText(/\/ping/, msg => adminOnly(msg, () =>
    bot.sendMessage(msg.chat.id,
        `🟢 *${config.botName} v${config.botVersion}* operativo\n⏱ ${new Date().toLocaleString('es')}\n⚙️ Nodo productos: \`${N.productos}\``,
        { parse_mode: 'Markdown' })
));

// ══════════════════════════════════════════════════════════════
//  TELEGRAM — CLIENTE
//  Identifica con username real + ID de Telegram
// ══════════════════════════════════════════════════════════════
function infoTG(from) {
    const username = from.username ? `@${from.username}` : from.first_name || 'sin username';
    return `${username} (ID: ${from.id})`;
}

bot.onText(/\/start/, async msg => {
    if (esAdminTG(msg.chat.id)) return;
    console.log(`[TG CLIENTE] Inicio: ${infoTG(msg.from)}`);
    bot.sendMessage(msg.chat.id, `${config.mensajes.bienvenida}\n\nUsa los botones para navegar:`, {
        reply_markup: { keyboard: [
            [{ text: '🛍 Catálogo' }, { text: '💰 Mi Saldo' }],
            [{ text: '💳 Recargar' }, { text: '🆘 Soporte' }]
        ], resize_keyboard: true }
    });
});

bot.on('message', async msg => {
    if (esAdminTG(msg.chat.id)) return;
    if (!msg.text || msg.text.startsWith('/')) return;
    const t   = msg.text.trim();
    const cid = msg.chat.id;
    const uid = String(msg.from.id);
    const est = tgEstados[uid] || { paso: 'inicio' };
    const quien = infoTG(msg.from);

    if (t === '🛍 Catálogo') {
        const prods = await getProductos();
        if (!prods) return bot.sendMessage(cid, 'Sin productos disponibles.');
        const btns = Object.entries(prods).filter(([, p]) => p.activo !== false)
            .map(([id, p]) => [{ text: `${p.nombre || id} — ${fmt(p.precio)}`, callback_data: `prod:${id}` }]);
        return bot.sendMessage(cid, '🛍 *Elige un producto:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
    }

    if (t === '💰 Mi Saldo') return bot.sendMessage(cid, 'Para ver tu saldo inicia sesión en la web o dinos tu usuario.');

    if (t === '💳 Recargar') {
        tgEstados[uid] = { paso: 'recarga_monto' };
        return bot.sendMessage(cid, '💳 ¿Cuánto deseas recargar? Escribe el monto en USD.\nEjemplo: *5.00*', { parse_mode: 'Markdown' });
    }

    if (t === '🆘 Soporte') {
        tgEstados[uid] = { paso: 'soporte_msg' };
        return bot.sendMessage(cid, '📨 Describe tu problema y te responderemos pronto:');
    }

    if (est.paso === 'recarga_monto') {
        const monto = parseFloat(t);
        if (isNaN(monto) || monto <= 0) return bot.sendMessage(cid, '❌ Monto inválido.');
        tgEstados[uid] = { paso: 'recarga_metodo', monto };
        return bot.sendMessage(cid, `💲 Monto: *${fmt(monto)}*\n\nElige método de pago:`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [
                [{ text: 'Binance Pay',     callback_data: `metodo:binance:${monto}:${uid}` }],
                [{ text: 'Nequi/Daviplata', callback_data: `metodo:nequi:${monto}:${uid}` }],
                [{ text: 'PayPal',          callback_data: `metodo:paypal:${monto}:${uid}` }]
            ]}
        });
    }

    if (est.paso === 'soporte_msg') {
        await rtdbPush(N.soporteMensajes, {
            uid,
            username: quien,
            tgId: uid,
            texto: t,
            fecha: new Date().toISOString(),
            canal: 'telegram'
        });
        tgEstados[uid] = { paso: 'inicio' };
        // Notificar admin con identidad real
        notificarAdmin(`📨 *Soporte vía Telegram*\nDe: *${quien}*\n"${t}"`);
        return bot.sendMessage(cid, '✅ Mensaje recibido. Un admin te responderá pronto.');
    }
});

bot.on('callback_query', async cb => {
    if (esAdminTG(cb.from.id)) return;
    const parts = cb.data.split(':');
    const tipo  = parts[0];
    const cid   = cb.message.chat.id;
    const uid   = String(cb.from.id);
    const quien = infoTG(cb.from);

    if (tipo === 'prod') {
        const prods = await getProductos();
        const p = prods?.[parts[1]];
        if (!p) return bot.answerCallbackQuery(cb.id, { text: 'Producto no disponible.' });
        tgEstados[uid] = { paso: 'confirmar_compra', productoId: parts[1], producto: p };
        bot.sendMessage(cid, `🛍 *${p.nombre || parts[1]}*\n💲 ${fmt(p.precio)}\n${p.descripcion ? '_'+p.descripcion+'_\n' : ''}\n¿Confirmar compra?`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[
                { text: '✅ Comprar', callback_data: `comprar:${parts[1]}` },
                { text: '❌ Cancelar', callback_data: 'cancelar' }
            ]]}
        });
        bot.answerCallbackQuery(cb.id);
    }

    if (tipo === 'metodo') {
        const [, metodo, monto] = parts;
        await rtdbPush(N.recargasPendientes, {
            uid,
            tgId:     uid,
            username: quien,
            monto:    parseFloat(monto),
            metodo,
            estado:   'pendiente',
            canal:    'telegram',
            fecha:    new Date().toISOString()
        });
        tgEstados[uid] = { paso: 'inicio' };
        // Notificar admin con identidad real de Telegram
        notificarAdminTG(
`💳 *Nueva Recarga — Telegram*
De: *${quien}*
Monto: *${fmt(monto)}*
Método: *${metodo}*`
        );
        bot.sendMessage(cid, `✅ Solicitud registrada\nMonto: *${fmt(monto)}*\nMétodo: *${metodo}*\n\nEspera confirmación del admin.`, { parse_mode: 'Markdown' });
        bot.answerCallbackQuery(cb.id);
    }

    if (tipo === 'cancelar') {
        tgEstados[uid] = { paso: 'inicio' };
        bot.sendMessage(cid, '❌ Operación cancelada.');
        bot.answerCallbackQuery(cb.id);
    }
});

// ══════════════════════════════════════════════════════════════
//  WHATSAPP — ADMIN
// ══════════════════════════════════════════════════════════════
async function handleWAAdmin(sock, jid, text) {
    const t = text.trim().toLowerCase();
    const r = msg => sock.sendMessage(jid, { text: msg });

    if (['.admin', '.menu', '.ayuda'].includes(t)) return r(
`🛠 *Panel Admin — ${config.botName}*

.usuario [uid]       → Datos del cliente
.saldo [uid] [monto] → Asignar saldo
.toprecargadores     → Top 10
.pendientes          → Recargas sin aprobar
.aprobar [id] [uid] [monto]
.rechazar [id] [uid]
.productos           → Catálogo RTDB
.stockbajo           → Stock bajo
.pedidos             → Últimos pedidos
.soporte             → Mensajes soporte
.nodos               → Ver nodos activos
.ping                → Estado del bot`
    );

    if (t === '.nodos') return r(
`⚙️ Nodos Firebase activos:
productos: ${N.productos}
pedidosNuevos: ${N.pedidosNuevos}
recargasPendientes: ${N.recargasPendientes}
soporteMensajes: ${N.soporteMensajes}
clientesLista: ${N.clientesLista}

(Edítalos en Firestore: bot/config → nodos)`
    );

    if (t.startsWith('.usuario ')) {
        const uid = text.split(' ')[1];
        const c = await getCliente(uid);
        if (!c) return r(`❌ Cliente ${uid} no encontrado.`);
        return r(`👤 *${c.usuario || uid}*\n💲 Saldo: ${fmt(c.dinero_usd)}\n📦 Total recargado: ${fmt(c.total_recargado)}\n🏅 Rango: ${c.rango || '—'}\n✅ Verificado: ${c.verificado ? 'Sí' : 'No'}\n📞 ${c.contacto || '—'}`);
    }

    if (t.startsWith('.saldo ')) {
        const [, uid, montoStr] = text.split(' ');
        const monto = parseFloat(montoStr);
        if (isNaN(monto)) return r('Uso: .saldo [uid] [monto]');
        await actualizarSaldo(uid, monto);
        return r(`✅ Saldo de ${uid} → ${fmt(monto)}`);
    }

    if (t === '.toprecargadores') {
        const top = await getTopRecargadores(10);
        if (!top || !top.length) return r('Sin datos.');
        return r(`🏆 Top Recargadores\n\n${top.map((c, i) => `${i+1}. ${c.usuario || c.id} — ${fmt(c.total_recargado)} | ${c.rango || '—'}`).join('\n')}`);
    }

    if (t === '.pendientes') {
        const pend = await rtdbGet(N.recargasPendientes);
        if (!pend) return r('✅ No hay recargas pendientes.');
        return r(`⏳ Recargas Pendientes\n\n${Object.entries(pend).map(([id, rx]) =>
            `ID: ${id}\nUID: ${rx.uid}\nNúmero: ${rx.numero || rx.username || '—'}\nMonto: ${fmt(rx.monto)}\nMétodo: ${rx.metodo || '—'}`
        ).join('\n─────\n')}\n\nUsa: .aprobar [id] [uid] [monto]`);
    }

    if (t.startsWith('.aprobar ')) {
        const [, id, uid, montoStr] = text.split(' ');
        try {
            const nuevo = await aprobarRecarga(id, uid, parseFloat(montoStr));
            return r(`✅ Aprobada. Saldo de ${uid}: ${fmt(nuevo)}`);
        } catch(e) { return r(`❌ Error: ${e.message}`); }
    }

    if (t.startsWith('.rechazar ')) {
        const [, id, uid] = text.split(' ');
        await rechazarRecarga(id, uid);
        return r(`🚫 Recarga ${id} rechazada.`);
    }

    if (t === '.productos') { const p = await getProductos(); return r(`📦 Catálogo\n\n${listaProductos(p)}`); }

    if (t === '.stockbajo') {
        const prods = await getProductos();
        if (!prods) return r('Sin productos.');
        const bajos = Object.entries(prods).filter(([, p]) => (p.stock ?? 99) <= 3)
            .map(([id, p]) => `⚠️ ${p.nombre || id} — Stock: ${p.stock ?? 0}`).join('\n');
        return r(bajos || '✅ Stock en buen estado.');
    }

    if (t === '.pedidos') {
        const ped = await rtdbGet(N.pedidosNuevos);
        if (!ped) return r('Sin pedidos.');
        return r(`🛒 Últimos Pedidos\n\n${Object.entries(ped).slice(-5)
            .map(([id, p]) => `${p.producto || id} — ${p.uid} — ${fmt(p.total)}`).join('\n')}`);
    }

    if (t === '.soporte') {
        const msgs = await rtdbGet(N.soporteMensajes);
        if (!msgs) return r('Sin mensajes.');
        return r(`📨 Soporte\n\n${Object.entries(msgs).slice(-5)
            .map(([, m]) => `${m.username || m.uid || '?'} (${m.numero || 'sin nro'}): "${m.texto}"`).join('\n─────\n')}`);
    }

    if (t === '.ping') return r(`🟢 ${config.botName} v${config.botVersion} — operativo\n⏱ ${new Date().toLocaleString('es')}\nNodo productos: ${N.productos}`);

    return r(`❓ Comando no reconocido. Envía *.admin* para el menú.`);
}

// ══════════════════════════════════════════════════════════════
//  WHATSAPP — CLIENTE
//  sender = número real de WhatsApp siempre
// ══════════════════════════════════════════════════════════════
async function handleWACliente(sock, jid, text, sender) {
    const t   = text.trim().toLowerCase();
    const r   = msg => sock.sendMessage(jid, { text: msg });
    const est = waEstados[sender] || { paso: 'inicio' };

    if (['hola', 'hi', 'inicio', 'menu', '.menu', 'start'].includes(t)) {
        waEstados[sender] = { paso: 'menu' };
        // Notificar al admin quién inició
        notificarAdmin(`👀 *Nuevo cliente en WhatsApp*\nNúmero: +${sender}`);
        return r(`${config.mensajes.bienvenida}\n\n1️⃣ Ver catálogo\n2️⃣ Consultar saldo\n3️⃣ Hacer recarga\n4️⃣ Soporte\n\nResponde con el número.`);
    }

    if (est.paso === 'menu') {
        if (t === '1') {
            const prods = await getProductos();
            waEstados[sender] = { paso: 'inicio' };
            return r(`🛍 *Catálogo*\n\n${listaProductos(prods)}`);
        }
        if (t === '2') return r('Para ver tu saldo inicia sesión en la web o dinos tu usuario.');
        if (t === '3') { waEstados[sender] = { paso: 'recarga_monto' }; return r('💳 ¿Cuánto deseas recargar? Escribe el monto en USD. Ej: *5.00*'); }
        if (t === '4') { waEstados[sender] = { paso: 'soporte_msg' }; return r('📨 Describe tu problema:'); }
    }

    if (est.paso === 'recarga_monto') {
        const monto = parseFloat(t);
        if (isNaN(monto) || monto <= 0) return r('❌ Monto inválido.');
        waEstados[sender] = { paso: 'recarga_metodo', monto };
        return r(`💲 Monto: *${fmt(monto)}*\n\n1. Binance Pay\n2. Nequi/Daviplata\n3. PayPal\n\nElige 1, 2 o 3.`);
    }

    if (est.paso === 'recarga_metodo') {
        const metodos = { '1': 'Binance Pay', '2': 'Nequi/Daviplata', '3': 'PayPal' };
        if (!metodos[t]) return r('Responde 1, 2 o 3.');
        // Guarda el número real del cliente
        const id = await rtdbPush(N.recargasPendientes, {
            uid:    sender,
            numero: sender,        // número real de WhatsApp
            monto:  est.monto,
            metodo: metodos[t],
            estado: 'pendiente',
            canal:  'whatsapp',
            fecha:  new Date().toISOString()
        });
        waEstados[sender] = { paso: 'inicio' };
        // Notificar admin con número real
        notificarAdmin(
`💳 *Nueva Recarga — WhatsApp*
Número: *+${sender}*
Monto: *${fmt(est.monto)}*
Método: *${metodos[t]}*
ID: \`${id}\``
        );
        return r(`✅ Solicitud registrada\nID: ${id}\nMonto: ${fmt(est.monto)}\nMétodo: ${metodos[t]}\n\nEspera confirmación del admin.`);
    }

    if (est.paso === 'soporte_msg') {
        await rtdbPush(N.soporteMensajes, {
            uid:    sender,
            numero: sender,        // número real
            texto:  text,
            canal:  'whatsapp',
            fecha:  new Date().toISOString()
        });
        waEstados[sender] = { paso: 'inicio' };
        notificarAdmin(`📨 *Soporte vía WhatsApp*\nNúmero: *+${sender}*\n"${text}"`);
        return r('✅ Mensaje recibido. Un admin te responderá pronto.');
    }

    return r(`${config.mensajes.bienvenida}\n\nEscribe *hola* para ver el menú.`);
}

// ══════════════════════════════════════════════════════════════
//  WHATSAPP — INICIO BAILEYS
// ══════════════════════════════════════════════════════════════
async function iniciarWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    waSock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: [config.botName, 'Chrome', config.botVersion]
    });

    waSock.ev.on('creds.update', saveCreds);

    waSock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            try { require('qrcode-terminal').generate(qr, { small: true }); } catch(e) {}
            console.log('[WHATSAPP] Escanea el QR para conectar...');
        }
        if (connection === 'open') {
            console.log('[WHATSAPP] ✅ Conectado');
            iniciarListeners();
        }
        if (connection === 'close') {
            const reconectar = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
                : true;
            console.log('[WHATSAPP] Desconectado. Reconectando:', reconectar);
            if (reconectar) iniciarWhatsApp();
        }
    });

    waSock.ev.on('messages.upsert', async m => {
        if (m.type !== 'notify') return;
        for (const msg of m.messages) {
            if (!msg.message || msg.key.fromMe) continue;
            const jid    = msg.key.remoteJid;
            const sender = jid.split('@')[0];    // número real siempre
            const text   = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            if (!text.trim()) continue;
            try {
                if (esAdminWA(sender)) await handleWAAdmin(waSock, jid, text);
                else                   await handleWACliente(waSock, jid, text, sender);
            } catch(e) { console.error('[WA ERROR]', e.message); }
        }
    });
}

// ══════════════════════════════════════════════════════════════
//  ARRANCAR
// ══════════════════════════════════════════════════════════════
(async () => {
    console.log(`[BOT] Iniciando ${config.botName} v${config.botVersion}...`);
    await cargarNodosDesdeFirestore();   // carga nodos desde Firestore antes de arrancar
    iniciarWhatsApp().catch(e => console.error('[WA INIT ERROR]', e.message));
    console.log('[TELEGRAM] ✅ Bot en línea');
})();
