// config.js - Samuel Hack Store
module.exports = {
    telegramToken: "8751520013:AAG5OnvVbLSEx6JrgeTT2zVAz1bkLM7DjJc",
    adminTelegramId: 8698439117,
    adminWaNumbers: ["584166371131"],
    botName: "Samuel Hack Store",
    botVersion: "2.1",
    mensajes: {
        bienvenida: "👋 ¡Bienvenido a *Samuel Hack Store Bot*! Elige una opción en el menú para continuar.",
        noAutorizado: "❌ No tienes permisos de administrador para usar este comando."
    },
    // Nodos por defecto para que no crashee index.js
    firebaseNodes: {
        productos: "productos",
        pedidosNuevos: "pedidos_nuevos",
        recargasPendientes: "recargas_pendientes",
        recargasHistorial: "recargas_historial",
        soporteMensajes: "soporte_mensajes",
        notificaciones: "notificaciones",
        clientesLista: "clientes"
    },
    firebaseConfig: {
        apiKey: "AIzaSyB-J-8BUFhnDcZIEvYRNq6UAFaPcgxuAtE",
        authDomain: "saku-store.firebaseapp.com",
        databaseURL: "https://saku-store-default-rtdb.firebaseio.com",
        projectId: "saku-store",
        storageBucket: "saku-store.firebasestorage.app",
        messagingSenderId: "815286002143",
        appId: "1:815286002143:web:60e7c7770da491a6da646a",
        measurementId: "G-W9EHSXZJVT"
    }
};
