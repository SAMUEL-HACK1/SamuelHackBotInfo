// ============================================================
//  index.js — Samuel Hack Store Bot v2.2
//  ✅ Conexión WhatsApp via QR / código (Baileys)
//  ✅ Panel admin completo (Telegram + WhatsApp)
//  ✅ Clientes: modo demo — vitrina de productos + recarga + soporte
//  ✅ Listeners Firebase en tiempo real (sin duplicación)
//  ✅ Callback query unificado
//  ✅ try/catch en todos los handlers
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const { initializeApp, getApps }                                       = require('firebase/app');
const { getDatabase, ref, get, set, push, remove, onChildAdded }       = require('firebase/database');
const { getFirestore, doc, getDoc, getDocs, setDoc,
        collection, updateDoc, query, orderBy, limit }                 = require('firebase/firestore');
const { default: makeWASocket, useMultiFileAuthState,
        fetchLatestBaileysVersion, DisconnectReason }                  = require('@whiskeysockets/baileys');
const { Boom }  = require('@hapi/boom');
const pino      = require('pino');
const config    = require('./config');

// ── FIREBASE ──────────────────────────────────────────────────
const firebaseApp = getApps().length === 0 ? initializeApp(config.firebaseConfig) : getApps()[0];
const rtdb   = getDatabase(firebaseApp);
const fstore = getFirestore(firebaseApp);

// ── TELEGRAM ──────────────────────────────────────────────────
const bot = new TelegramBot(config.telegramToken, { polling: true });

// ── ESTADO ────────────────────────────────────────────────────
const waEstados = {};
const tgEstados = {};
let waSock = null;
let listenersIniciados = false;   // evita duplicar listeners en reconexión

// ══════════════════════════════════════════════════════════════
//  NODOS DINÁMICOS (Firestore: bot/config → nodos)
// ══════════════════════════════════════════════════════════════
let N = { ...config.firebaseNodes };

async function cargarNodosDesdeFirestore() {
    try {
        const snap = await getDoc(doc(fstore, 'bot', 'config'));
        if (snap.exists() && snap.data().nodos) {
            N = { ...config.firebaseNodes, ...snap.data().nodos };
            console.log('[CONFIG] Nodos cargados desde Firestore.');
        } else {
            await setDoc(doc(fstore, 'bot', 'config'), { nodos: config.firebaseNodes }, { merge: true });
            console.log('[CONFIG] Documento bot/config creado con defaults.');
        }
    } catch(e) {
        console.warn('[CONFIG] Usando defaults:', e.message);
    }
}

setInterval(async () => {
    try {
        const snap = await getDoc(doc(fstore, 'bot', 'config'));
        if (snap.exists() && snap.data().nodos)
            N = { ...config.firebaseNodes, ...snap.data().nodos };
    } catch(e) {}
}, 5 * 60 * 1000);

// ══════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════
const ADMINS_WA = (config.adminWaNumbers || []).map(n => n.replace(/\D/g, ''));
const esAdminWA = numero  => ADMINS_WA.includes(String(numero).replace(/\D/g, ''));
const esAdminTG = chatId  => String(chatId) === String(config.adminTelegramId);

// ══════════════════════════════════════════════════════════════
//  FIREBASE HELPERS
// ══════════════════════════════════════════════════════════════
const fmt = n => `$${parseFloat(n || 0).toFixed(2)}`;

const rtdbGet    = async nodo      => { const s = await get(ref(rtdb, nodo)); return s.exists() ? s.val() : null; };
const rtdbSet    = async (n, d)    => set(ref(rtdb, n), d);
const rtdbPush   = async (n, d)    => { const r = await push(ref(rtdb, n), d); return r.key; };
const rtdbDelete = async nodo      => remove(ref(rtdb, nodo));

const rtdbEscucharNuevos = (nodo, cb) =>
    onChildAdded(ref(rtdb, nodo), snap => { if (snap.exists()) cb(snap.key, snap.val()); });

const fsGetDoc = async ruta => {
    const d = await getDoc(doc(fstore, ...ruta.split('/')));
    return d.exists() ? { id: d.id, ...d.data() } : null;
};
const fsUpdate = async (ruta, data) => updateDoc(doc(fstore, ...ruta.split('/')), data);
const fsGetOrdenado = async (col, campo, dir = 'desc', max = 50) => {
    const q = query(collection(fstore, ...col.split('/')), orderBy(campo, dir), limit(max));
    const s = await getDocs(q);
    return s.docs.map(d => ({ id: d.id, ...d.data() }));
};

// ── Helpers de negocio ────────────────────────────────────────
const getProductos         = ()        => rtdbGet(N.productos);
const getCliente           = uid       => fsGetDoc(`${N.clientesLista}/${uid}`);
const actualizarSaldo      = (uid, s)  => fsUpdate(`${N.clientesLista}/${uid}`, { dinero_usd: s });
const getTopRecargadores   = (n = 10)  => fsGetOrdenado(N.clientesLista, 'total_recargado', 'desc', n);

async function aprobarRecarga(id, uid, monto) {
    const c = await getCliente(uid);
    if (!c) throw new Error('Cliente no encontrado');
    const nuevoSaldo = parseFloat(c.dinero_usd  || 0) + parseFloat(monto);
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
    if (!prods) return '_(Sin productos aún)_';
    const activos = Object.entries(prods).filter(([, p]) => p.activo !== false);
    if (!activos.length) return '_(Sin productos activos)_';
    return activos.map(([id, p], i) =>
        `*${i+1}.* ${p.nombre || id}\n    💲 ${fmt(p.precio)} | Stock: ${p.stock ?? '—'}\n    ${p.descripcion ? '_' + p.descripcion + '_' : ''}`
    ).join('\n\n');
}

// ══════════════════════════════════════════════════════════════
//  NOTIFICACIONES ADMIN
// ══════════════════════════════════════════════════════════════
const notificarAdminTG = txt =>
    bot.sendMessage(config.adminTelegramId, txt, { parse_mode: 'Markdown' }).catch(() => {});

const notificarAdminWA = txt => {
    if (!waSock) return;
    ADMINS_WA.forEach(num =>
        waSock.sendMessage(`${num}@s.whatsapp.net`, { text: txt }).catch(() => {})
    );
};

const notificarAdmin = txt => { notificarAdminTG(txt); notificarAdminWA(txt); };

// ══════════════════════════════════════════════════════════════
//  LISTENERS FIREBASE — tiempo real (se inician solo una vez)
// ══════════════════════════════════════════════════════════════
function iniciarListeners() {
    if (listenersIniciados) return;
    listenersIniciados = true;

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
${r.numero   ? `Número WA: +${r.numero}\n`   : ''}${r.username ? `Usuario TG: ${r.username}\n` : ''}Monto: *${fmt(r.monto)}*
Método: ${r.metodo || '—'}
Canal: ${r.canal   || '—'}`;
        notificarAdminWA(txt + `\n\n✅ .aprobar ${id} ${r.uid} ${r.monto}\n🚫 .rechazar ${id} ${r.uid}`);
        bot.sendMessage(config.adminTelegramId, txt, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[
                { text: '✅ Aprobar', callback_data: `aprobar:${id}:${r.uid}:${r.monto}` },
                { text: '🚫 Rechazar', callback_data: `rechazar:${id}:${r.uid}` }
            ]]}
        }).catch(() => {});
    });

    rtdbEscucharNuevos(N.soporteMensajes, (id, m) => notificarAdmin(
`📨 *Soporte*
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
    if (!esAdminTG(msg.chat.id))
        return bot.sendMessage(msg.chat.id, config.mensajes.noAutorizado);
    return fn();
};

// Menú admin
bot.onText(/\/admin|\/menu/, msg => adminOnly(msg, () =>
    bot.sendMessage(msg.chat.id,
`🛠 *Panel Admin — ${config.botName} v${config.botVersion}*

👤 *USUARIOS*
/usuario \`[uid]\` — datos del cliente
/saldo \`[uid] [monto]\` — asignar saldo
/toprecargadores — top 10

💳 *RECARGAS*
/pendientes — ver y gestionar
/aprobar \`[id] [uid] [monto]\`
/rechazar \`[id] [uid]\`

📦 *PRODUCTOS*
/productos — catálogo RTDB
/stockbajo — stock ≤ 3 unidades

🌐 *PEDIDOS & SOPORTE*
/pedidos — últimos 5 pedidos
/soporte — últimos 5 mensajes

⚙️ *SISTEMA*
/nodos — paths Firebase activos
/ping — estado del bot`,
        { parse_mode: 'Markdown' })
));

bot.onText(/\/nodos/, msg => adminOnly(msg, () =>
    bot.sendMessage(msg.chat.id,
`⚙️ *Nodos Firebase activos*
_Editables en Firestore: bot/config → nodos_

📦 productos: \`${N.productos}\`
🛒 pedidosNuevos: \`${N.pedidosNuevos}\`
💳 recargasPendientes: \`${N.recargasPendientes}\`
📁 recargasHistorial: \`${N.recargasHistorial}\`
📨 soporteMensajes: \`${N.soporteMensajes}\`
🔔 notificaciones: \`${N.notificaciones}\`
👤 clientesLista: \`${N.clientesLista}\``,
        { parse_mode: 'Markdown' })
));

bot.onText(/\/usuario (.+)/, async (msg, match) => adminOnly(msg, async () => {
    try {
        const c = await getCliente(match[1].trim());
        if (!c) return bot.sendMessage(msg.chat.id, `❌ Cliente \`${match[1]}\` no encontrado.`, { parse_mode: 'Markdown' });
        bot.sendMessage(msg.chat.id,
`👤 *${c.usuario || c.username || match[1]}*
🆔 \`${match[1]}\`
💲 Saldo: *${fmt(c.dinero_usd)}*
📦 Total recargado: *${fmt(c.total_recargado)}*
🏅 Rango: ${c.rango || '—'}
✅ Verificado: ${c.verificado ? 'Sí' : 'No'}
📞 ${c.contacto || '—'}`,
            { parse_mode: 'Markdown' });
    } catch(e) { bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`); }
}));

bot.onText(/\/saldo (\S+) (\S+)/, async (msg, match) => adminOnly(msg, async () => {
    try {
        const monto = parseFloat(match[2]);
        if (isNaN(monto)) return bot.sendMessage(msg.chat.id, '❌ Monto inválido.');
        await actualizarSaldo(match[1], monto);
        bot.sendMessage(msg.chat.id, `✅ Saldo de \`${match[1]}\` → *${fmt(monto)}*`, { parse_mode: 'Markdown' });
    } catch(e) { bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`); }
}));

bot.onText(/\/toprecargadores/, async msg => adminOnly(msg, async () => {
    try {
        const top = await getTopRecargadores(10);
        if (!top?.length) return bot.sendMessage(msg.chat.id, 'Sin datos aún.');
        const lista = top.map((c, i) =>
            `${i+1}. *${c.usuario || c.id}* — ${fmt(c.total_recargado)} | 🏅 ${c.rango || '—'}`
        ).join('\n');
        bot.sendMessage(msg.chat.id, `🏆 *Top Recargadores*\n\n${lista}`, { parse_mode: 'Markdown' });
    } catch(e) { bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`); }
}));

bot.onText(/\/pendientes/, async msg => adminOnly(msg, async () => {
    try {
        const pend = await rtdbGet(N.recargasPendientes);
        if (!pend) return bot.sendMessage(msg.chat.id, '✅ No hay recargas pendientes.');
        for (const [id, r] of Object.entries(pend).slice(-5)) {
            bot.sendMessage(msg.chat.id,
`⏳ *Recarga Pendiente*
ID: \`${id}\`
UID: \`${r.uid}\`
${r.numero   ? `Número: +${r.numero}\n`   : ''}${r.username ? `Usuario: ${r.username}\n` : ''}Monto: *${fmt(r.monto)}*
Método: ${r.metodo || '—'}
Canal: ${r.canal   || '—'}`,
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
                    { text: '✅ Aprobar', callback_data: `aprobar:${id}:${r.uid}:${r.monto}` },
                    { text: '🚫 Rechazar', callback_data: `rechazar:${id}:${r.uid}` }
                ]]}});
        }
    } catch(e) { bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`); }
}));

bot.onText(/\/aprobar (\S+) (\S+) (\S+)/, async (msg, match) => adminOnly(msg, async () => {
    try {
        const nuevo = await aprobarRecarga(match[1], match[2], parseFloat(match[3]));
        bot.sendMessage(msg.chat.id, `✅ Aprobada. Saldo de \`${match[2]}\`: *${fmt(nuevo)}*`, { parse_mode: 'Markdown' });
    } catch(e) { bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`); }
}));

bot.onText(/\/rechazar (\S+) (\S+)/, async (msg, match) => adminOnly(msg, async () => {
    try {
        await rechazarRecarga(match[1], match[2]);
        bot.sendMessage(msg.chat.id, `🚫 Recarga \`${match[1]}\` rechazada.`, { parse_mode: 'Markdown' });
    } catch(e) { bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`); }
}));

bot.onText(/\/productos/, async msg => adminOnly(msg, async () => {
    try {
        const prods = await getProductos();
        if (!prods) return bot.sendMessage(msg.chat.id, '📦 Sin productos en RTDB.');
        const lista = Object.entries(prods).map(([id, p]) =>
            `• *${p.nombre || id}* — ${fmt(p.precio)} | Stock: ${p.stock ?? '—'} | ${p.activo !== false ? '🟢' : '🔴'}`
        ).join('\n');
        bot.sendMessage(msg.chat.id, `📦 *Catálogo RTDB*\n\n${lista}`, { parse_mode: 'Markdown' });
    } catch(e) { bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`); }
}));

bot.onText(/\/stockbajo/, async msg => adminOnly(msg, async () => {
    try {
        const prods = await getProductos();
        if (!prods) return bot.sendMessage(msg.chat.id, 'Sin productos.');
        const bajos = Object.entries(prods)
            .filter(([, p]) => (p.stock ?? 99) <= 3)
            .map(([id, p]) => `⚠️ *${p.nombre || id}* — Stock: ${p.stock ?? 0}`)
            .join('\n');
        bot.sendMessage(msg.chat.id, bajos || '✅ Todo el stock está bien.', { parse_mode: 'Markdown' });
    } catch(e) { bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`); }
}));

bot.onText(/\/pedidos/, async msg => adminOnly(msg, async () => {
    try {
        const ped = await rtdbGet(N.pedidosNuevos);
        if (!ped) return bot.sendMessage(msg.chat.id, 'Sin pedidos nuevos.');
        const lista = Object.entries(ped).slice(-5)
            .map(([id, p]) =>
`🛒 *${p.producto || id}*
👤 ${p.uid} ${p.username ? `(${p.username})` : ''}
💲 ${fmt(p.total)} | 📅 ${p.fecha ? p.fecha.slice(0,10) : '—'}`
            ).join('\n─────\n');
        bot.sendMessage(msg.chat.id, `🛒 *Últimos Pedidos*\n\n${lista}`, { parse_mode: 'Markdown' });
    } catch(e) { bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`); }
}));

bot.onText(/\/soporte/, async msg => adminOnly(msg, async () => {
    try {
        const msgs = await rtdbGet(N.soporteMensajes);
        if (!msgs) return bot.sendMessage(msg.chat.id, 'Sin mensajes de soporte.');
        const lista = Object.entries(msgs).slice(-5)
            .map(([, m]) =>
`💬 *${m.username || m.uid || '?'}*
${m.numero ? `📞 +${m.numero}\n` : ''}Canal: ${m.canal || '—'}
"${m.texto}"`
            ).join('\n─────\n');
        bot.sendMessage(msg.chat.id, `📨 *Soporte*\n\n${lista}`, { parse_mode: 'Markdown' });
    } catch(e) { bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`); }
}));

bot.onText(/\/ping/, msg => adminOnly(msg, () =>
    bot.sendMessage(msg.chat.id,
`🟢 *${config.botName} v${config.botVersion}* — Operativo
⏱ ${new Date().toLocaleString('es')}
📡 WA: ${waSock ? 'Conectado' : 'Desconectado'}
⚙️ Productos en: \`${N.productos}\``,
        { parse_mode: 'Markdown' })
));

// ══════════════════════════════════════════════════════════════
//  TELEGRAM — CLIENTE
// ══════════════════════════════════════════════════════════════
function infoTG(from) {
    const username = from.username ? `@${from.username}` : from.first_name || 'Usuario';
    return `${username} (ID: ${from.id})`;
}

bot.onText(/\/start/, msg => {
    if (esAdminTG(msg.chat.id)) return;
    const nombre = msg.from.first_name || msg.from.username || 'por aquí';
    bot.sendMessage(msg.chat.id,
`${config.mensajes.bienvenida}

👋 Hola *${nombre}*, bienvenido a *${config.botName}*
Somos tu tienda de confianza 🛒

Usa los botones para navegar:`,
        { parse_mode: 'Markdown',
          reply_markup: { keyboard: [
            [{ text: '🛍 Ver Productos' }, { text: '💳 Recargar Saldo' }],
            [{ text: '🆘 Soporte'       }, { text: 'ℹ️ Información'   }]
          ], resize_keyboard: true }
        });
});

bot.on('message', async msg => {
    if (esAdminTG(msg.chat.id)) return;
    if (!msg.text || msg.text.startsWith('/')) return;

    const t    = msg.text.trim();
    const cid  = msg.chat.id;
    const uid  = String(msg.from.id);
    const est  = tgEstados[uid] || { paso: 'inicio' };
    const quien = infoTG(msg.from);

    try {
        // ── Botones del menú ─────────────────────────────────
        if (t === '🛍 Ver Productos') {
            const prods = await getProductos();
            if (!prods) return bot.sendMessage(cid, '📦 No hay productos disponibles aún. Vuelve pronto.');
            const activos = Object.entries(prods).filter(([, p]) => p.activo !== false);
            if (!activos.length) return bot.sendMessage(cid, '📦 No hay productos activos en este momento.');
            const btns = activos.map(([id, p]) => [{
                text: `${p.nombre || id} — ${fmt(p.precio)}`,
                callback_data: `prod:${id}`
            }]);
            return bot.sendMessage(cid,
                `🛍 *Catálogo — ${config.botName}*\n\nElige un producto para ver más detalles:`,
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
        }

        if (t === '💳 Recargar Saldo') {
            tgEstados[uid] = { paso: 'recarga_monto' };
            return bot.sendMessage(cid,
`💳 *Recargar Saldo*

Escribe el monto en USD que deseas recargar.
_Mínimo: $1.00 — Máximo: $500.00_

Ejemplo: *10.00*`,
                { parse_mode: 'Markdown' });
        }

        if (t === '🆘 Soporte') {
            tgEstados[uid] = { paso: 'soporte_msg' };
            return bot.sendMessage(cid,
`📨 *Soporte*

Describe tu problema o consulta y un administrador te responderá a la brevedad.`,
                { parse_mode: 'Markdown' });
        }

        if (t === 'ℹ️ Información') {
            return bot.sendMessage(cid,
`ℹ️ *${config.botName}*

Somos una tienda especializada en productos digitales.

🌐 Compras disponibles desde la web
💳 Métodos de pago: Binance Pay, Nequi/Daviplata, PayPal
🆘 Soporte disponible por este bot

_Más funciones próximamente..._`,
                { parse_mode: 'Markdown' });
        }

        // ── Flujo recarga ─────────────────────────────────────
        if (est.paso === 'recarga_monto') {
            const monto = parseFloat(t);
            if (isNaN(monto) || monto < 1)  return bot.sendMessage(cid, '❌ El monto mínimo es *$1.00*', { parse_mode: 'Markdown' });
            if (monto > 500)                 return bot.sendMessage(cid, '❌ El monto máximo es *$500.00*', { parse_mode: 'Markdown' });
            tgEstados[uid] = { paso: 'recarga_metodo', monto };
            return bot.sendMessage(cid,
                `💲 Monto a recargar: *${fmt(monto)}*\n\nElige tu método de pago:`,
                { parse_mode: 'Markdown',
                  reply_markup: { inline_keyboard: [
                    [{ text: '🟡 Binance Pay',     callback_data: `metodo:Binance Pay:${monto}:${uid}` }],
                    [{ text: '🟣 Nequi/Daviplata', callback_data: `metodo:Nequi-Daviplata:${monto}:${uid}` }],
                    [{ text: '🔵 PayPal',          callback_data: `metodo:PayPal:${monto}:${uid}` }],
                    [{ text: '❌ Cancelar',         callback_data: 'cancelar' }]
                  ]}
                });
        }

        // ── Flujo soporte ─────────────────────────────────────
        if (est.paso === 'soporte_msg') {
            await rtdbPush(N.soporteMensajes, {
                uid,
                username: quien,
                tgId:  uid,
                texto: t,
                canal: 'telegram',
                fecha: new Date().toISOString()
            });
            tgEstados[uid] = { paso: 'inicio' };
            notificarAdmin(`📨 *Soporte — Telegram*\nDe: *${quien}*\n"${t}"`);
            return bot.sendMessage(cid, '✅ Mensaje enviado. Un admin te responderá pronto.\n\n_Gracias por contactarnos_ 🙏', { parse_mode: 'Markdown' });
        }

    } catch(e) {
        console.error('[TG MSG ERROR]', e.message);
        bot.sendMessage(cid, config.mensajes.errorGeneral).catch(() => {});
    }
});

// ══════════════════════════════════════════════════════════════
//  TELEGRAM — CALLBACK QUERY (admin + cliente unificado)
// ══════════════════════════════════════════════════════════════
bot.on('callback_query', async cb => {
    const parts   = cb.data.split(':');
    const tipo    = parts[0];
    const cid     = cb.message.chat.id;
    const uid     = String(cb.from.id);
    const quien   = infoTG(cb.from);
    const esAdmin = esAdminTG(cb.from.id);

    try {
        // ── Admin: aprobar ────────────────────────────────────
        if (tipo === 'aprobar') {
            if (!esAdmin) return bot.answerCallbackQuery(cb.id, { text: '⛔ Sin permiso.' });
            const [, id, ruid, monto] = parts;
            const nuevo = await aprobarRecarga(id, ruid, parseFloat(monto));
            bot.answerCallbackQuery(cb.id, { text: `✅ Aprobada. Nuevo saldo: ${fmt(nuevo)}` });
            bot.editMessageText(`✅ *Aprobada* — \`${ruid}\` → *${fmt(nuevo)}*`,
                { chat_id: cid, message_id: cb.message.message_id, parse_mode: 'Markdown' });
            // Notificar al cliente en TG
            bot.sendMessage(ruid,
`✅ *¡Recarga aprobada!*
Monto acreditado: *${fmt(monto)}*
¡Gracias por recargar en ${config.botName}! 🎉`,
                { parse_mode: 'Markdown' }).catch(() => {});
            return;
        }

        // ── Admin: rechazar ───────────────────────────────────
        if (tipo === 'rechazar') {
            if (!esAdmin) return bot.answerCallbackQuery(cb.id, { text: '⛔ Sin permiso.' });
            const [, id, ruid] = parts;
            await rechazarRecarga(id, ruid);
            bot.answerCallbackQuery(cb.id, { text: '🚫 Recarga rechazada.' });
            bot.editMessageText(`🚫 *Rechazada* — \`${ruid}\``,
                { chat_id: cid, message_id: cb.message.message_id, parse_mode: 'Markdown' });
            bot.sendMessage(ruid,
`🚫 *Tu recarga fue rechazada.*
Si crees que es un error, contacta a soporte.`,
                { parse_mode: 'Markdown' }).catch(() => {});
            return;
        }

        // Bloquear admin en flujos de cliente
        if (esAdmin) return bot.answerCallbackQuery(cb.id);

        // ── Cliente: ver producto ─────────────────────────────
        if (tipo === 'prod') {
            const prods = await getProductos();
            const p = prods?.[parts[1]];
            if (!p) return bot.answerCallbackQuery(cb.id, { text: '❌ Producto no disponible.' });
            tgEstados[uid] = { paso: 'confirmar_compra', productoId: parts[1], producto: p };
            bot.sendMessage(cid,
`🛍 *${p.nombre || parts[1]}*

💲 Precio: *${fmt(p.precio)}*
📦 Stock: ${p.stock ?? '—'}
${p.descripcion ? `📝 ${p.descripcion}\n` : ''}
_Las compras se procesan a través de la web. Puedes solicitar tu pedido aquí y un admin lo gestionará._

¿Deseas solicitar este producto?`,
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
                    { text: '✅ Solicitar',  callback_data: `solicitar:${parts[1]}` },
                    { text: '❌ Cancelar',  callback_data: 'cancelar' }
                ]]}});
            return bot.answerCallbackQuery(cb.id);
        }

        // ── Cliente: solicitar producto (modo demo) ───────────
        if (tipo === 'solicitar') {
            const est = tgEstados[uid];
            if (!est || est.paso !== 'confirmar_compra') {
                return bot.answerCallbackQuery(cb.id, { text: 'Sesión expirada. Vuelve al catálogo.' });
            }
            const p = est.producto;
            const pedidoId = await rtdbPush(N.pedidosNuevos, {
                uid,
                username: quien,
                producto:   p.nombre || est.productoId,
                productoId: est.productoId,
                total:  parseFloat(p.precio || 0),
                estado: 'pendiente_pago',
                canal:  'telegram',
                fecha:  new Date().toISOString()
            });
            tgEstados[uid] = { paso: 'inicio' };
            bot.answerCallbackQuery(cb.id, { text: '✅ Solicitud registrada' });
            bot.sendMessage(cid,
`✅ *Solicitud registrada*

Producto: *${p.nombre || est.productoId}*
Precio: *${fmt(p.precio)}*
ID: \`${pedidoId}\`

Un admin revisará tu solicitud y te contactará para coordinar el pago. 🙌`,
                { parse_mode: 'Markdown' });
            notificarAdmin(
`🛒 *Solicitud de Compra — Telegram*
De: *${quien}*
Producto: *${p.nombre || est.productoId}*
Precio: *${fmt(p.precio)}*
ID: \`${pedidoId}\``);
            return;
        }

        // ── Cliente: método de pago ───────────────────────────
        if (tipo === 'metodo') {
            const [, metodo, monto] = parts;
            const recargaId = await rtdbPush(N.recargasPendientes, {
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
            notificarAdminTG(
`💳 *Nueva Recarga — Telegram*
De: *${quien}*
Monto: *${fmt(monto)}*
Método: *${metodo}*
ID: \`${recargaId}\``);
            bot.sendMessage(cid,
`✅ *Solicitud de recarga registrada*

💲 Monto: *${fmt(monto)}*
💳 Método: *${metodo}*
🆔 ID: \`${recargaId}\`

Un admin verificará tu pago y acreditará el saldo. ⏳`,
                { parse_mode: 'Markdown' });
            return bot.answerCallbackQuery(cb.id);
        }

        // ── Cancelar ──────────────────────────────────────────
        if (tipo === 'cancelar') {
            tgEstados[uid] = { paso: 'inicio' };
            bot.sendMessage(cid, '❌ Operación cancelada.');
            return bot.answerCallbackQuery(cb.id);
        }

    } catch(e) {
        console.error('[TG CALLBACK ERROR]', e.message);
        bot.answerCallbackQuery(cb.id, { text: '❌ Error interno.' }).catch(() => {});
    }
});

// ══════════════════════════════════════════════════════════════
//  WHATSAPP — ADMIN
// ══════════════════════════════════════════════════════════════
async function handleWAAdmin(sock, jid, text) {
    const t = text.trim().toLowerCase();
    const r = msg => sock.sendMessage(jid, { text: msg });

    if (['.admin', '.menu', '.ayuda'].includes(t)) return r(
`🛠 Panel Admin — ${config.botName} v${config.botVersion}

.usuario [uid]          → Datos del cliente
.saldo [uid] [monto]    → Asignar saldo
.toprecargadores        → Top 10
.pendientes             → Recargas pendientes
.aprobar [id] [uid] [monto]
.rechazar [id] [uid]
.productos              → Catálogo RTDB
.stockbajo              → Stock bajo (≤3)
.pedidos                → Últimos 5 pedidos
.soporte                → Últimos 5 mensajes
.nodos                  → Paths Firebase
.ping                   → Estado del bot`
    );

    if (t === '.ping') return r(
`🟢 ${config.botName} v${config.botVersion} — Operativo
⏱ ${new Date().toLocaleString('es')}
📡 WA: Conectado
⚙️ Productos en: ${N.productos}`
    );

    if (t === '.nodos') return r(
`⚙️ Nodos Firebase activos:
productos:          ${N.productos}
pedidosNuevos:      ${N.pedidosNuevos}
recargasPendientes: ${N.recargasPendientes}
recargasHistorial:  ${N.recargasHistorial}
soporteMensajes:    ${N.soporteMensajes}
clientesLista:      ${N.clientesLista}

(Edítalos en Firestore: bot/config → nodos)`
    );

    if (t.startsWith('.usuario ')) {
        try {
            const uid = text.split(' ')[1];
            const c = await getCliente(uid);
            if (!c) return r(`❌ Cliente "${uid}" no encontrado.`);
            return r(
`👤 ${c.usuario || c.username || uid}
🆔 UID: ${uid}
💲 Saldo: ${fmt(c.dinero_usd)}
📦 Total recargado: ${fmt(c.total_recargado)}
🏅 Rango: ${c.rango || '—'}
✅ Verificado: ${c.verificado ? 'Sí' : 'No'}
📞 ${c.contacto || '—'}`);
        } catch(e) { return r(`❌ Error: ${e.message}`); }
    }

    if (t.startsWith('.saldo ')) {
        try {
            const [, uid, montoStr] = text.split(' ');
            const monto = parseFloat(montoStr);
            if (isNaN(monto)) return r('Uso: .saldo [uid] [monto]');
            await actualizarSaldo(uid, monto);
            return r(`✅ Saldo de ${uid} → ${fmt(monto)}`);
        } catch(e) { return r(`❌ Error: ${e.message}`); }
    }

    if (t === '.toprecargadores') {
        try {
            const top = await getTopRecargadores(10);
            if (!top?.length) return r('Sin datos aún.');
            return r(`🏆 Top Recargadores\n\n${top.map((c, i) =>
                `${i+1}. ${c.usuario || c.id} — ${fmt(c.total_recargado)} | ${c.rango || '—'}`
            ).join('\n')}`);
        } catch(e) { return r(`❌ Error: ${e.message}`); }
    }

    if (t === '.pendientes') {
        try {
            const pend = await rtdbGet(N.recargasPendientes);
            if (!pend) return r('✅ No hay recargas pendientes.');
            return r(`⏳ Recargas Pendientes\n\n${Object.entries(pend).map(([id, rx]) =>
`ID: ${id}
UID: ${rx.uid}
${rx.numero   ? `Número: +${rx.numero}\n` : ''}${rx.username ? `Usuario: ${rx.username}\n` : ''}Monto: ${fmt(rx.monto)}
Método: ${rx.metodo || '—'}`
            ).join('\n─────\n')}\n\nUsa: .aprobar [id] [uid] [monto]`);
        } catch(e) { return r(`❌ Error: ${e.message}`); }
    }

    if (t.startsWith('.aprobar ')) {
        try {
            const [, id, uid, montoStr] = text.split(' ');
            const nuevo = await aprobarRecarga(id, uid, parseFloat(montoStr));
            return r(`✅ Aprobada. Nuevo saldo de ${uid}: ${fmt(nuevo)}`);
        } catch(e) { return r(`❌ Error: ${e.message}`); }
    }

    if (t.startsWith('.rechazar ')) {
        try {
            const [, id, uid] = text.split(' ');
            await rechazarRecarga(id, uid);
            return r(`🚫 Recarga ${id} rechazada.`);
        } catch(e) { return r(`❌ Error: ${e.message}`); }
    }

    if (t === '.productos') {
        try {
            const p = await getProductos();
            return r(`📦 Catálogo\n\n${listaProductos(p)}`);
        } catch(e) { return r(`❌ Error: ${e.message}`); }
    }

    if (t === '.stockbajo') {
        try {
            const prods = await getProductos();
            if (!prods) return r('Sin productos.');
            const bajos = Object.entries(prods)
                .filter(([, p]) => (p.stock ?? 99) <= 3)
                .map(([id, p]) => `⚠️ ${p.nombre || id} — Stock: ${p.stock ?? 0}`)
                .join('\n');
            return r(bajos || '✅ Todo el stock está bien.');
        } catch(e) { return r(`❌ Error: ${e.message}`); }
    }

    if (t === '.pedidos') {
        try {
            const ped = await rtdbGet(N.pedidosNuevos);
            if (!ped) return r('Sin pedidos.');
            return r(`🛒 Últimos Pedidos\n\n${Object.entries(ped).slice(-5)
                .map(([id, p]) => `${p.producto || id} — ${p.uid} — ${fmt(p.total)}`).join('\n')}`);
        } catch(e) { return r(`❌ Error: ${e.message}`); }
    }

    if (t === '.soporte') {
        try {
            const msgs = await rtdbGet(N.soporteMensajes);
            if (!msgs) return r('Sin mensajes.');
            return r(`📨 Soporte\n\n${Object.entries(msgs).slice(-5)
                .map(([, m]) => `${m.username || m.uid || '?'} (${m.numero || 'sin nro'}): "${m.texto}"`)
                .join('\n─────\n')}`);
        } catch(e) { return r(`❌ Error: ${e.message}`); }
    }

    return r(`❓ Comando no reconocido.\nEnvía *.admin* para ver el menú.`);
}

// ══════════════════════════════════════════════════════════════
//  WHATSAPP — CLIENTE (modo demo)
// ══════════════════════════════════════════════════════════════
async function handleWACliente(sock, jid, text, sender) {
    const t   = text.trim().toLowerCase();
    const r   = msg => sock.sendMessage(jid, { text: msg });
    const est = waEstados[sender] || { paso: 'inicio' };

    // Saludo / menú principal
    if (['hola', 'hi', 'inicio', 'menu', '.menu', 'start', 'buenas', 'hey'].includes(t)) {
        waEstados[sender] = { paso: 'menu' };
        notificarAdmin(`👀 *Nuevo visitante — WhatsApp*\nNúmero: +${sender}`);
        return r(
`👾 Bienvenido a *${config.botName}* 🛒

¿Qué deseas hacer?

1️⃣ Ver productos
2️⃣ Recargar saldo
3️⃣ Soporte
4️⃣ Información

Responde con el número.`);
    }

    if (est.paso === 'menu') {
        if (t === '1') {
            const prods = await getProductos();
            waEstados[sender] = { paso: 'inicio' };
            return r(`🛍 *Catálogo — ${config.botName}*\n\n${listaProductos(prods)}\n\n_Para comprar visita nuestra web o escríbenos al soporte._`);
        }
        if (t === '2') {
            waEstados[sender] = { paso: 'recarga_monto' };
            return r('💳 ¿Cuánto deseas recargar?\nEscribe el monto en USD. Ej: *10.00*\n\n_Mínimo $1.00 — Máximo $500.00_');
        }
        if (t === '3') {
            waEstados[sender] = { paso: 'soporte_msg' };
            return r('📨 Describe tu problema o consulta y un admin te responderá pronto:');
        }
        if (t === '4') {
            waEstados[sender] = { paso: 'inicio' };
            return r(
`ℹ️ *${config.botName}*

Tienda de productos digitales.
💳 Métodos: Binance Pay, Nequi/Daviplata, PayPal
🌐 Compras disponibles desde la web
🆘 Soporte por este chat

_Más funciones próximamente..._`);
        }
    }

    // Flujo recarga
    if (est.paso === 'recarga_monto') {
        const monto = parseFloat(t);
        if (isNaN(monto) || monto < 1)  return r('❌ El monto mínimo es $1.00');
        if (monto > 500)                 return r('❌ El monto máximo es $500.00');
        waEstados[sender] = { paso: 'recarga_metodo', monto };
        return r(`💲 Monto: *$${monto.toFixed(2)}*\n\nElige método de pago:\n1. Binance Pay\n2. Nequi/Daviplata\n3. PayPal\n\nResponde 1, 2 o 3.`);
    }

    if (est.paso === 'recarga_metodo') {
        const metodos = { '1': 'Binance Pay', '2': 'Nequi/Daviplata', '3': 'PayPal' };
        if (!metodos[t]) return r('Responde 1, 2 o 3.');
        const id = await rtdbPush(N.recargasPendientes, {
            uid:    sender,
            numero: sender,
            monto:  est.monto,
            metodo: metodos[t],
            estado: 'pendiente',
            canal:  'whatsapp',
            fecha:  new Date().toISOString()
        });
        waEstados[sender] = { paso: 'inicio' };
        notificarAdmin(
`💳 *Nueva Recarga — WhatsApp*
Número: *+${sender}*
Monto: *${fmt(est.monto)}*
Método: *${metodos[t]}*
ID: \`${id}\``);
        return r(
`✅ Solicitud registrada

🆔 ID: ${id}
💲 Monto: $${est.monto.toFixed(2)}
💳 Método: ${metodos[t]}

Un admin verificará tu pago y te confirmará. ⏳`);
    }

    // Flujo soporte
    if (est.paso === 'soporte_msg') {
        await rtdbPush(N.soporteMensajes, {
            uid:    sender,
            numero: sender,
            texto:  text,
            canal:  'whatsapp',
            fecha:  new Date().toISOString()
        });
        waEstados[sender] = { paso: 'inicio' };
        notificarAdmin(`📨 *Soporte — WhatsApp*\nNúmero: *+${sender}*\n"${text}"`);
        return r('✅ Mensaje recibido. Un admin te responderá pronto.\n\n_Gracias por contactarnos 🙏_');
    }

    // Fallback
    return r(`👾 Escribe *hola* para ver el menú de ${config.botName} 🛒`);
}

// ══════════════════════════════════════════════════════════════
//  WHATSAPP — INICIO BAILEYS
// ══════════════════════════════════════════════════════════════
async function iniciarWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version }          = await fetchLatestBaileysVersion();

    waSock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth:   state,
        browser: [config.botName, 'Chrome', config.botVersion]
    });

    waSock.ev.on('creds.update', saveCreds);

    waSock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            try { require('qrcode-terminal').generate(qr, { small: true }); } catch(e) {}
            console.log('[WHATSAPP] 📱 Escanea el QR para conectar...');
        }
        if (connection === 'open') {
            console.log('[WHATSAPP] ✅ Conectado correctamente');
            iniciarListeners();
        }
        if (connection === 'close') {
            const reconectar = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
                : true;
            console.log('[WHATSAPP] Desconectado. Reconectando:', reconectar);
            if (reconectar) setTimeout(() => iniciarWhatsApp(), 3000);
        }
    });

    waSock.ev.on('messages.upsert', async m => {
        if (m.type !== 'notify') return;
        for (const msg of m.messages) {
            if (!msg.message || msg.key.fromMe) continue;
            const jid    = msg.key.remoteJid;
            const sender = jid.split('@')[0];
            const text   = msg.message.conversation
                        || msg.message.extendedTextMessage?.text
                        || '';
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
    console.log(`\n🚀 Iniciando ${config.botName} v${config.botVersion}...`);
    await cargarNodosDesdeFirestore();
    iniciarWhatsApp().catch(e => console.error('[WA INIT ERROR]', e.message));
    console.log('[TELEGRAM] ✅ Bot en línea y escuchando\n');
})();
