// config.js — Samuel Hack Store Bot
module.exports = {

    // ── TELEGRAM ─────────────────────────────────────────────
    telegramToken:   '8751520013:AAG5OnvVbLSEx6JrgeTT2zVAz1bkLM7DjJc',
    adminTelegramId: 8698439117,

    // ── WHATSAPP ─────────────────────────────────────────────
    adminWaNumbers: ['584166371131'],

    // ── IDENTIDAD ────────────────────────────────────────────
    botName:    'Samuel Hack Store',
    botVersion: '2.0.0',

    // ── FIREBASE ─────────────────────────────────────────────
    firebaseConfig: {
        apiKey:            'AIzaSyB-J-8BUFhnDcZIEvYRNq6UAFaPcgxuAtE',
        authDomain:        'saku-store.firebaseapp.com',
        databaseURL:       'https://saku-store-default-rtdb.firebaseio.com',
        projectId:         'saku-store',
        storageBucket:     'saku-store.firebasestorage.app',
        messagingSenderId: '815286002143',
        appId:             '1:815286002143:web:60e7c7770da491a6da646a',
        measurementId:     'G-W9EHSXZJVT'
    },

    // ── NODOS FIREBASE ───────────────────────────────────────
    // Si mueves algo en Firebase, solo cambia aquí
    firebaseNodes: {
        productos:          'productos',
        pedidosNuevos:      'pedidos/nuevos',
        pedidosHistorial:   'pedidos/historial',
        recargasPendientes: 'recargas/pendientes',
        recargasHistorial:  'recargas/historial',
        soporteMensajes:    'soporte/mensajes',
        notificaciones:     'notificaciones/admin',
        clientesLista:      'usuarios/clientes/lista',
        configuracion:      'configuracion/accesos'
    },

    // ── MENSAJES ─────────────────────────────────────────────
    mensajes: {
        bienvenida:   '👾 *Bienvenido a Samuel Hack Store*\n\n¿Qué deseas hacer hoy?',
        noAutorizado: '⛔ No tienes permiso para usar este comando.',
        errorGeneral: '❌ Ocurrió un error. Intenta de nuevo.'
    }
};
