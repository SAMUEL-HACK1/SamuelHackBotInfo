// ============================================================
// SAMUEL HACK STORE - BOT COMPLETO
// Telegram (control) + WhatsApp (operación) + Firebase
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, get, set, push, update, onChildAdded, onValue } = require('firebase/database');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const QRCode = require('qrcode');
const config = require('./config');

// ============================================================
// INICIALIZACIÓN
// ============================================================
const bot = new TelegramBot(config.telegramToken, { polling: true });
const ADMIN_ID = config.adminTelegramId;
const ADMIN_WA = config.adminWaNumbers[0]; // número principal del config

const firebaseApp = initializeApp(config.firebaseConfig);
const db = getDatabase(firebaseApp);

let waSock = null;
let waConectado = false;
let waQueue = [];
let procesandoCola = false;

// ============================================================
// UTILIDAD: solo el admin puede usar el bot
// ============================================================
function esAdmin(id) {
    return String(id) === String(ADMIN_ID);
}

function soloPara(msg, cb) {
    if (!esAdmin(msg.from.id)) {
        bot.sendMessage(msg.chat.id, '⛔ No tienes permiso para usar este bot.');
        return;
    }
    cb();
}

// ============================================================
// COLA DE MENSAJES WHATSAPP
// ============================================================
async function procesarCola() {
    if (procesandoCola || waQueue.length === 0) return;
    procesandoCola = true;
    while (waQueue.length > 0) {
        const { jid, mensaje, imageUrl, audioPath, delay } = waQueue.shift();
        if (waSock && waConectado) {
            try {
                if (audioPath && fs.existsSync(audioPath)) {
                    await waSock.sendPresenceUpdate('recording', jid);
                    await esperar(2000);
                    await waSock.sendMessage(jid, {
                        audio: { url: audioPath },
                        mimetype: 'audio/mpeg',
                        ptt: true
                    });
                } else if (imageUrl) {
                    await waSock.sendPresenceUpdate('composing', jid);
                    await esperar(1500);
                    await waSock.sendMessage(jid, {
                        image: { url: imageUrl },
                        caption: mensaje || ''
                    });
                } else if (mensaje) {
                    await waSock.sendPresenceUpdate('composing', jid);
                    await esperar(1500);
                    await waSock.sendMessage(jid, { text: mensaje });
                }
            } catch (e) {
                console.error('❌ Error enviando WA:', e.message);
            }
        }
        await esperar(delay || 3000);
    }
    procesandoCola = false;
}

function enviarWA(numero, mensaje, imageUrl = null, audioPath = null, delay = 3000) {
    const jid = numero.includes('@') ? numero : `${numero}@s.whatsapp.net`;
    waQueue.push({ jid, mensaje, imageUrl, audioPath, delay });
    procesarCola();
}

function enviarWAGrupo(jid, mensaje) {
    waQueue.push({ jid, mensaje, delay: 2000 });
    procesarCola();
}

function esperar(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// INICIO / RECONEXIÓN WHATSAPP
// ============================================================
async function iniciarWhatsApp(chatIdTelegram = null) {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    waSock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        browser: ['SamuelHackStore', 'Chrome', '1.0.0'],
        printQRInTerminal: false
    });

    waSock.ev.on('creds.update', saveCreds);

    // ── QR o código de emparejamiento ──
    waSock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && chatIdTelegram) {
            try {
                const qrPath = path.join(__dirname, 'qr_temp.png');
                await QRCode.toFile(qrPath, qr, { width: 400 });
                await bot.sendPhoto(chatIdTelegram, qrPath, {
                    caption: '📱 *Escanea este QR con WhatsApp*\n\nVe a WhatsApp → Dispositivos vinculados → Vincular dispositivo\n\n⏳ Expira en 60 segundos.',
                    parse_mode: 'Markdown'
                });
                fs.unlink(qrPath, () => {});
            } catch (e) {
                if (chatIdTelegram) bot.sendMessage(chatIdTelegram, '⚠️ Error generando QR: ' + e.message);
            }
        }

        if (connection === 'open') {
            waConectado = true;
            console.log('✅ WhatsApp conectado');
            if (chatIdTelegram) {
                bot.sendMessage(chatIdTelegram, '✅ *WhatsApp vinculado correctamente.*\nYa puedo operar con ese número.', { parse_mode: 'Markdown' });
            }
            // Notificar también al número admin en WA
            enviarWA(ADMIN_WA, '✅ *Samuel Hack Store bot conectado y listo.*');
        }

        if (connection === 'close') {
            waConectado = false;
            const codigo = lastDisconnect?.error?.output?.statusCode;
            const debeReconectar = codigo !== DisconnectReason.loggedOut;
            console.log('🔌 WA desconectado. Código:', codigo);
            if (debeReconectar) {
                console.log('🔄 Reconectando...');
                setTimeout(() => iniciarWhatsApp(), 5000);
            } else {
                console.log('🚪 Sesión cerrada. Usa /vincular para reconectar.');
                if (chatIdTelegram) bot.sendMessage(chatIdTelegram, '⚠️ Sesión de WhatsApp cerrada. Usa /vincular para reconectar.');
            }
        }
    });

    // ── Mensajes entrantes WhatsApp ──
    waSock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            await manejarMensajeWA(msg);
        }
    });

    iniciarListenersFirebase();
}

// ============================================================
// MANEJADOR MENSAJES WHATSAPP ENTRANTES
// ============================================================
async function manejarMensajeWA(msg) {
    const remoteJid = msg.key.remoteJid;
    const sender = remoteJid.split('@')[0];
    const esGrupo = remoteJid.endsWith('@g.us');
    const texto = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption || ''
    ).trim();
    const t = texto.toLowerCase();

    if (!texto) return;

    // Notificar al admin en Telegram
    const origen = esGrupo ? `📢 Grupo: ${remoteJid}` : `👤 Usuario: +${sender}`;
    bot.sendMessage(ADMIN_ID, `📩 *Mensaje WA recibido*\n${origen}\n\n"${texto}"`, { parse_mode: 'Markdown' });

    // ── Autoaprendizaje: buscar respuesta en Firebase ──
    const respuestaGuardada = await buscarRespuestaAprendida(t);
    if (respuestaGuardada) {
        enviarWA(remoteJid, respuestaGuardada);
        return;
    }

    // ── Comandos descarga ──
    if (t.startsWith('.yt ') || t.startsWith('.youtube ')) {
        const query = texto.split(' ').slice(1).join(' ');
        enviarWA(remoteJid, `🔍 Buscando: *${query}*\nEsta función requiere ytdl-core y yt-search.`);
        return;
    }

    if (t.startsWith('.mf ') || t.startsWith('.mediafire ')) {
        const url = texto.split(' ')[1];
        const result = await mediafireDl(url);
        if (result) {
            enviarWA(remoteJid, `📥 *${result.title}*\n🔗 ${result.url}`);
        } else {
            enviarWA(remoteJid, '❌ No pude obtener el link de MediaFire.');
        }
        return;
    }

    // ── Respuesta por defecto ──
    enviarWA(remoteJid, '👋 Hola, en breve te atendemos. *Samuel Hack Store* 🛒');
}

// ============================================================
// AUTOAPRENDIZAJE FIREBASE
// ============================================================
async function buscarRespuestaAprendida(pregunta) {
    try {
        const snap = await get(ref(db, 'respuestas_bot'));
        if (!snap.exists()) return null;
        const data = snap.val();
        for (const key of Object.keys(data)) {
            if (pregunta.includes(key.toLowerCase())) {
                return data[key];
            }
        }
        return null;
    } catch (e) {
        return null;
    }
}

async function guardarRespuesta(pregunta, respuesta) {
    const clave = pregunta.trim().toLowerCase().replace(/\s+/g, '_').substring(0, 50);
    await set(ref(db, `respuestas_bot/${clave}`), respuesta);
}

// ============================================================
// MEDIAFIRE DOWNLOADER
// ============================================================
async function mediafireDl(url) {
    try {
        const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = cheerio.load(res.data);
        const downloadUrl = $('a#downloadButton').attr('href') || $('a.button.download').attr('href');
        const name = downloadUrl ? downloadUrl.split('/').pop().split('?')[0] : 'archivo';
        return downloadUrl ? { title: name, url: downloadUrl } : null;
    } catch (e) {
        return null;
    }
}

// ============================================================
// LISTENERS FIREBASE - NOTIFICACIONES
// ============================================================
let listenersiniciados = false;
function iniciarListenersFirebase() {
    if (listenersiniciados) return;
    listenersiniciados = true;

    // ── Nuevos registros ──
    onChildAdded(ref(db, 'usuarios'), (snap) => {
        const data = snap.val();
        if (!data) return;
        const msg =
            `🆕 *NUEVO REGISTRO*\n` +
            `👤 Nombre: ${data.nombre || 'Sin nombre'}\n` +
            `📱 WhatsApp: ${data.whatsapp || 'N/A'}\n` +
            `📧 Email: ${data.email || 'N/A'}\n` +
            `🕐 Hora: ${new Date().toLocaleString('es-VE')}`;
        bot.sendMessage(ADMIN_ID, msg, { parse_mode: 'Markdown' });
        if (waConectado) enviarWA(ADMIN_WA, msg);
    });

    // ── Recargas ──
    onChildAdded(ref(db, 'recargas'), (snap) => {
        const data = snap.val();
        if (!data) return;
        const msg =
            `💰 *NUEVA RECARGA*\n` +
            `👤 Usuario: ${data.usuario || 'Desconocido'}\n` +
            `💵 Monto: $${data.monto || '0'}\n` +
            `🏦 Método: ${data.metodo || 'N/A'}\n` +
            `🕐 Hora: ${new Date().toLocaleString('es-VE')}`;
        bot.sendMessage(ADMIN_ID, msg, { parse_mode: 'Markdown' });
        if (waConectado) enviarWA(ADMIN_WA, msg);
    });

    // ── Pedidos ──
    onChildAdded(ref(db, 'pedidos'), (snap) => {
        const data = snap.val();
        if (!data) return;
        const msg =
            `🛒 *NUEVO PEDIDO*\n` +
            `👤 Cliente: ${data.cliente || 'N/A'}\n` +
            `📦 Producto: ${data.producto || 'N/A'}\n` +
            `💵 Total: $${data.total || '0'}\n` +
            `🕐 Hora: ${new Date().toLocaleString('es-VE')}`;
        bot.sendMessage(ADMIN_ID, msg, { parse_mode: 'Markdown' });
        if (waConectado) enviarWA(ADMIN_WA, msg);
    });
}

// ============================================================
// COMANDOS TELEGRAM
// ============================================================

// /start
bot.onText(/\/start/, (msg) => {
    if (!esAdmin(msg.from.id)) return;
    bot.sendMessage(msg.chat.id,
        `👋 *Samuel Hack Store - Panel de Control*\n\n` +
        `📱 /vincular - Vincular número de WhatsApp\n` +
        `🔗 /codigo - Vincular con código de 8 dígitos\n` +
        `📊 /estado - Ver estado del bot\n` +
        `✉️ /enviar - Enviar mensaje WA\n` +
        `📢 /grupo - Enviar mensaje al grupo WA\n` +
        `📣 /canal - Enviar mensaje al canal WA\n` +
        `🧠 /aprender - Enseñar respuesta automática\n` +
        `📋 /respuestas - Ver respuestas guardadas\n` +
        `🗑️ /olvidar - Eliminar una respuesta\n` +
        `🌐 /html - Generar código HTML\n` +
        `📥 /descargar - Descargar de MediaFire/YT\n` +
        `🔴 /desconectar - Cerrar sesión WA`,
        { parse_mode: 'Markdown' }
    );
});

// /vincular → QR
bot.onText(/\/vincular/, (msg) => {
    soloPara(msg, async () => {
        bot.sendMessage(msg.chat.id, '🔄 Iniciando vinculación por *QR*...\nEspera un momento.', { parse_mode: 'Markdown' });
        // Limpiar sesión anterior si existe
        try { fs.rmSync('auth_info_baileys', { recursive: true, force: true }); } catch (_) {}
        waConectado = false;
        waSock = null;
        await iniciarWhatsApp(msg.chat.id);
    });
});

// /codigo → código de 8 dígitos (para quien no puede escanear QR)
bot.onText(/\/codigo(?:\s+(\d+))?/, (msg, match) => {
    soloPara(msg, async () => {
        const numero = match[1];
        if (!numero) {
            bot.sendMessage(msg.chat.id,
                '📱 Usa: `/codigo 584XXXXXXXXX`\nEjemplo: `/codigo 584166371131`\n\nEscribe el número con código de país sin +',
                { parse_mode: 'Markdown' }
            );
            return;
        }
        try {
            bot.sendMessage(msg.chat.id, `🔄 Generando código para *+${numero}*...`, { parse_mode: 'Markdown' });
            try { fs.rmSync('auth_info_baileys', { recursive: true, force: true }); } catch (_) {}
            waConectado = false;

            const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
            const { version } = await fetchLatestBaileysVersion();

            waSock = makeWASocket({
                version,
                logger: pino({ level: 'silent' }),
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
                },
                browser: ['SamuelHackStore', 'Chrome', '1.0.0'],
                printQRInTerminal: false
            });

            waSock.ev.on('creds.update', saveCreds);

            // Esperar que el socket esté listo
            await esperar(3000);

            const code = await waSock.requestPairingCode(numero);
            const codigoFormateado = code?.match(/.{1,4}/g)?.join('-') || code;

            bot.sendMessage(msg.chat.id,
                `🔑 *Código de vinculación:*\n\n` +
                `\`${codigoFormateado}\`\n\n` +
                `📱 *Cómo usarlo:*\n` +
                `1. Abre WhatsApp en el número +${numero}\n` +
                `2. Ve a ⋮ → Dispositivos vinculados\n` +
                `3. Toca "Vincular dispositivo"\n` +
                `4. Toca "Vincular con número"\n` +
                `5. Ingresa el código de arriba\n\n` +
                `⏳ Expira en 60 segundos.`,
                { parse_mode: 'Markdown' }
            );

            waSock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;
                if (connection === 'open') {
                    waConectado = true;
                    bot.sendMessage(msg.chat.id, `✅ *WhatsApp vinculado con +${numero}*\n¡El bot ya está operativo!`, { parse_mode: 'Markdown' });
                    enviarWA(ADMIN_WA, `✅ Samuel Hack Store bot conectado con +${numero}`);
                    iniciarListenersFirebase();
                }
                if (connection === 'close') {
                    waConectado = false;
                    const codigo = lastDisconnect?.error?.output?.statusCode;
                    if (codigo !== DisconnectReason.loggedOut) {
                        setTimeout(() => iniciarWhatsApp(), 5000);
                    }
                }
            });

            waSock.ev.on('messages.upsert', async ({ messages, type }) => {
                if (type !== 'notify') return;
                for (const m of messages) {
                    if (!m.message || m.key.fromMe) continue;
                    await manejarMensajeWA(m);
                }
            });

        } catch (e) {
            bot.sendMessage(msg.chat.id, `❌ Error generando código: ${e.message}`);
        }
    });
});

// /estado
bot.onText(/\/estado/, (msg) => {
    soloPara(msg, () => {
        const estado = waConectado ? '🟢 Conectado' : '🔴 Desconectado';
        bot.sendMessage(msg.chat.id,
            `📊 *Estado del Bot*\n\n` +
            `WhatsApp: ${estado}\n` +
            `Cola de mensajes: ${waQueue.length}\n` +
            `Firebase: 🟢 Activo`,
            { parse_mode: 'Markdown' }
        );
    });
});

// /enviar NUMERO | MENSAJE
bot.onText(/\/enviar/, (msg) => {
    soloPara(msg, () => {
        const partes = msg.text.replace('/enviar', '').trim().split('|');
        if (partes.length < 2) {
            bot.sendMessage(msg.chat.id, '📤 Uso: `/enviar 584XXXXXXXXX | Tu mensaje aquí`', { parse_mode: 'Markdown' });
            return;
        }
        const numero = partes[0].trim();
        const mensaje = partes.slice(1).join('|').trim();
        if (!waConectado) {
            bot.sendMessage(msg.chat.id, '⚠️ WhatsApp no está conectado. Usa /vincular primero.');
            return;
        }
        enviarWA(numero, mensaje);
        bot.sendMessage(msg.chat.id, `✅ Mensaje enviado a *+${numero}*`, { parse_mode: 'Markdown' });
    });
});

// /grupo JID@g.us | MENSAJE
bot.onText(/\/grupo/, (msg) => {
    soloPara(msg, () => {
        const partes = msg.text.replace('/grupo', '').trim().split('|');
        if (partes.length < 2) {
            bot.sendMessage(msg.chat.id,
                '📢 Uso: `/grupo 120363XXXXXXXXX@g.us | Tu mensaje`\n\nPuedes obtener el JID del grupo con /jids',
                { parse_mode: 'Markdown' }
            );
            return;
        }
        const jid = partes[0].trim();
        const mensaje = partes.slice(1).join('|').trim();
        if (!waConectado) { bot.sendMessage(msg.chat.id, '⚠️ WhatsApp no conectado.'); return; }
        enviarWAGrupo(jid, mensaje);
        bot.sendMessage(msg.chat.id, `✅ Mensaje enviado al grupo`, { parse_mode: 'Markdown' });
    });
});

// /canal JID@newsletter | MENSAJE
bot.onText(/\/canal/, (msg) => {
    soloPara(msg, () => {
        const partes = msg.text.replace('/canal', '').trim().split('|');
        if (partes.length < 2) {
            bot.sendMessage(msg.chat.id, '📣 Uso: `/canal JID@newsletter | Tu mensaje`', { parse_mode: 'Markdown' });
            return;
        }
        const jid = partes[0].trim();
        const mensaje = partes.slice(1).join('|').trim();
        if (!waConectado) { bot.sendMessage(msg.chat.id, '⚠️ WhatsApp no conectado.'); return; }
        enviarWAGrupo(jid, mensaje);
        bot.sendMessage(msg.chat.id, `✅ Mensaje enviado al canal`, { parse_mode: 'Markdown' });
    });
});

// /jids → listar grupos y canales
bot.onText(/\/jids/, (msg) => {
    soloPara(msg, async () => {
        if (!waConectado || !waSock) {
            bot.sendMessage(msg.chat.id, '⚠️ WhatsApp no conectado.');
            return;
        }
        try {
            const chats = await waSock.groupFetchAllParticipating();
            const lista = Object.entries(chats).map(([jid, g]) => `• *${g.subject}*\n  \`${jid}\``).join('\n\n');
            bot.sendMessage(msg.chat.id, `📋 *Grupos WhatsApp:*\n\n${lista || 'Sin grupos'}`, { parse_mode: 'Markdown' });
        } catch (e) {
            bot.sendMessage(msg.chat.id, '❌ Error listando grupos: ' + e.message);
        }
    });
});

// /aprender PREGUNTA | RESPUESTA
bot.onText(/\/aprender/, (msg) => {
    soloPara(msg, async () => {
        const partes = msg.text.replace('/aprender', '').trim().split('|');
        if (partes.length < 2) {
            bot.sendMessage(msg.chat.id,
                '🧠 Uso: `/aprender precio | El precio es $5 por cuenta`\n\nCuando alguien escriba "precio" en WA, el bot responderá automáticamente.',
                { parse_mode: 'Markdown' }
            );
            return;
        }
        const pregunta = partes[0].trim();
        const respuesta = partes.slice(1).join('|').trim();
        await guardarRespuesta(pregunta, respuesta);
        bot.sendMessage(msg.chat.id, `✅ *Aprendido:*\nSi alguien escribe "*${pregunta}*" responderé:\n"${respuesta}"`, { parse_mode: 'Markdown' });
    });
});

// /respuestas → listar todo lo aprendido
bot.onText(/\/respuestas/, (msg) => {
    soloPara(msg, async () => {
        const snap = await get(ref(db, 'respuestas_bot'));
        if (!snap.exists()) {
            bot.sendMessage(msg.chat.id, '📭 No hay respuestas guardadas aún.');
            return;
        }
        const data = snap.val();
        const lista = Object.entries(data).map(([k, v]) => `🔑 *${k}*\n💬 ${v}`).join('\n\n');
        bot.sendMessage(msg.chat.id, `🧠 *Respuestas aprendidas:*\n\n${lista}`, { parse_mode: 'Markdown' });
    });
});

// /olvidar CLAVE
bot.onText(/\/olvidar (.+)/, (msg, match) => {
    soloPara(msg, async () => {
        const clave = match[1].trim().toLowerCase().replace(/\s+/g, '_');
        await set(ref(db, `respuestas_bot/${clave}`), null);
        bot.sendMessage(msg.chat.id, `🗑️ Respuesta *${clave}* eliminada.`, { parse_mode: 'Markdown' });
    });
});

// /html DESCRIPCION
bot.onText(/\/html (.+)/, (msg, match) => {
    soloPara(msg, async () => {
        const descripcion = match[1].trim();
        bot.sendMessage(msg.chat.id, `🌐 Generando HTML para: *${descripcion}*...`, { parse_mode: 'Markdown' });

        // Generador básico de HTML según descripción
        const htmlGenerado = generarHTML(descripcion);
        const explicacion = generarExplicacionHTML(descripcion);

        bot.sendMessage(msg.chat.id,
            `📄 *Código HTML generado:*\n\n\`\`\`html\n${htmlGenerado}\n\`\`\`\n\n📝 *Explicación:*\n${explicacion}`,
            { parse_mode: 'Markdown' }
        );
    });
});

function generarHTML(descripcion) {
    const d = descripcion.toLowerCase();
    if (d.includes('formulario') || d.includes('form')) {
        return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Formulario</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 20px; }
    input, textarea { width: 100%; padding: 10px; margin: 8px 0; border: 1px solid #ccc; border-radius: 5px; }
    button { background: #4CAF50; color: white; padding: 12px 24px; border: none; border-radius: 5px; cursor: pointer; }
  </style>
</head>
<body>
  <h2>${descripcion}</h2>
  <form>
    <input type="text" placeholder="Nombre" required>
    <input type="email" placeholder="Email" required>
    <textarea placeholder="Mensaje" rows="4"></textarea>
    <button type="submit">Enviar</button>
  </form>
</body>
</html>`;
    } else if (d.includes('tabla') || d.includes('table')) {
        return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Tabla</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 20px; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #333; color: white; padding: 10px; }
    td { border: 1px solid #ddd; padding: 8px; }
    tr:nth-child(even) { background: #f5f5f5; }
  </style>
</head>
<body>
  <h2>${descripcion}</h2>
  <table>
    <tr><th>ID</th><th>Nombre</th><th>Precio</th><th>Estado</th></tr>
    <tr><td>1</td><td>Producto 1</td><td>$10</td><td>Activo</td></tr>
    <tr><td>2</td><td>Producto 2</td><td>$20</td><td>Activo</td></tr>
  </table>
</body>
</html>`;
    } else if (d.includes('landing') || d.includes('pagina') || d.includes('página')) {
        return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${descripcion}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', sans-serif; }
    header { background: linear-gradient(135deg, #1a1a2e, #16213e); color: white; text-align: center; padding: 80px 20px; }
    header h1 { font-size: 3rem; margin-bottom: 15px; }
    header p { font-size: 1.2rem; opacity: 0.8; }
    .btn { display: inline-block; margin-top: 25px; padding: 14px 35px; background: #e94560; color: white; border-radius: 30px; text-decoration: none; font-weight: bold; }
    section { padding: 60px 20px; text-align: center; max-width: 800px; margin: auto; }
  </style>
</head>
<body>
  <header>
    <h1>Samuel Hack Store</h1>
    <p>${descripcion}</p>
    <a href="#" class="btn">Comprar Ahora</a>
  </header>
  <section>
    <h2>¿Por qué elegirnos?</h2>
    <p>Ofrecemos los mejores precios y servicio garantizado.</p>
  </section>
</body>
</html>`;
    } else {
        return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${descripcion}</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 700px; margin: 40px auto; padding: 20px; background: #f9f9f9; }
    .card { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    h1 { color: #333; }
    p { color: #666; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${descripcion}</h1>
    <p>Este es el contenido principal de la página generada para: <strong>${descripcion}</strong>.</p>
    <p>Personaliza este HTML según tus necesidades.</p>
  </div>
</body>
</html>`;
    }
}

function generarExplicacionHTML(descripcion) {
    const d = descripcion.toLowerCase();
    if (d.includes('formulario') || d.includes('form')) {
        return `• \`<form>\` agrupa los campos del formulario\n• \`<input type="text">\` campo de texto\n• \`<input type="email">\` valida que sea un email\n• \`<textarea>\` campo de texto largo\n• \`<button type="submit">\` envía el formulario`;
    } else if (d.includes('tabla')) {
        return `• \`<table>\` crea la tabla\n• \`<tr>\` es cada fila\n• \`<th>\` encabezados (negrita)\n• \`<td>\` celdas normales\n• CSS con \`border-collapse\` elimina doble borde`;
    } else if (d.includes('landing') || d.includes('pagina')) {
        return `• \`<header>\` sección principal con gradiente\n• Botón CTA con \`border-radius\` redondeado\n• \`<section>\` para el contenido secundario\n• Diseño responsivo con \`max-width\``;
    }
    return `• Estructura HTML5 básica con \`<!DOCTYPE html>\`\n• Meta viewport para móviles\n• \`.card\` con \`box-shadow\` para efecto elevado\n• Colores neutros para fácil personalización`;
}

// /descargar URL o NOMBRE
bot.onText(/\/descargar (.+)/, (msg, match) => {
    soloPara(msg, async () => {
        const input = match[1].trim();
        bot.sendMessage(msg.chat.id, `📥 Procesando: *${input}*...`, { parse_mode: 'Markdown' });

        if (input.includes('mediafire.com')) {
            const result = await mediafireDl(input);
            if (result) {
                bot.sendMessage(msg.chat.id, `✅ *${result.title}*\n🔗 ${result.url}`, { parse_mode: 'Markdown' });
            } else {
                bot.sendMessage(msg.chat.id, '❌ No se pudo obtener el link de MediaFire.');
            }
        } else if (input.includes('youtube.com') || input.includes('youtu.be')) {
            bot.sendMessage(msg.chat.id, `🎵 Link YouTube detectado.\n🔗 ${input}\n\nUsa \`npm install ytdl-core yt-search\` y activa el módulo de descarga.`, { parse_mode: 'Markdown' });
        } else {
            // Búsqueda en YouTube por nombre
            bot.sendMessage(msg.chat.id,
                `🔍 Buscando: *${input}*\nPara buscar por nombre necesitas instalar:\n\`npm install yt-search\`\n\nO pásame el link directo de YouTube/MediaFire.`,
                { parse_mode: 'Markdown' }
            );
        }
    });
});

// /desconectar
bot.onText(/\/desconectar/, (msg) => {
    soloPara(msg, async () => {
        if (waSock) {
            await waSock.logout();
            waSock = null;
            waConectado = false;
        }
        try { fs.rmSync('auth_info_baileys', { recursive: true, force: true }); } catch (_) {}
        bot.sendMessage(msg.chat.id, '🔴 WhatsApp desconectado y sesión borrada.\nUsa /vincular o /codigo para reconectar.');
    });
});

// /ayuda
bot.onText(/\/ayuda|\/help/, (msg) => {
    soloPara(msg, () => {
        bot.sendMessage(msg.chat.id,
            `📚 *Comandos disponibles:*\n\n` +
            `🔗 */vincular* - Conectar WA por QR\n` +
            `🔑 */codigo 584XX* - Conectar por código\n` +
            `📊 */estado* - Estado actual\n` +
            `✉️ */enviar NUM | MSG* - Enviar mensaje WA\n` +
            `📢 */grupo JID | MSG* - Mensaje al grupo\n` +
            `📣 */canal JID | MSG* - Mensaje al canal\n` +
            `📋 */jids* - Listar grupos\n` +
            `🧠 */aprender PREG | RESP* - Enseñar respuesta\n` +
            `📋 */respuestas* - Ver respuestas guardadas\n` +
            `🗑️ */olvidar CLAVE* - Borrar respuesta\n` +
            `🌐 */html DESCRIPCION* - Generar código HTML\n` +
            `📥 */descargar URL* - Descargar archivo\n` +
            `🔴 */desconectar* - Cerrar sesión WA`,
            { parse_mode: 'Markdown' }
        );
    });
});

// ============================================================
// ARRANQUE
// ============================================================
console.log('🚀 Samuel Hack Store bot iniciando...');
console.log('📱 Telegram: activo');
console.log('🔥 Firebase: conectando...');
console.log(`👤 Admin ID: ${ADMIN_ID}`);
console.log('➡️  Usa /vincular o /codigo en Telegram para conectar WhatsApp');

bot.sendMessage(ADMIN_ID, '🟢 *Bot iniciado correctamente*\nUsa /vincular o /codigo para conectar WhatsApp.', { parse_mode: 'Markdown' }).catch(() => {});
