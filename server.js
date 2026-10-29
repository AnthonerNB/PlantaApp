const express = require('express');
const http = require('http');
const os = require('os');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Servir la carpeta actual (index.html, reportes, etc.)
app.use(express.static(path.join(__dirname)));

// Ruta principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ---------------------------------------------------------------------------
// ESTADO EN MEMORIA (compartido entre todos los teléfonos y la sala de control)
// ---------------------------------------------------------------------------
// Último formulario recibido por línea + estación.
const estadosPorEstacion = new Map();   // "linea|estacion" -> datos
// Paradas que están ocurriendo AHORA MISMO (señal enviada desde el teléfono).
const paradasActivas = new Map();       // "linea|estacion" -> parada
// Historial de paradas cerradas (respaldo para reconexiones).
const historialParadas = [];
const MAX_HISTORIAL = 500;

function claveEstado(linea, estacion) {
    return `${String(linea)}|${String(estacion || '').toLowerCase()}`;
}

function horaHHMM(fecha = new Date()) {
    return `${String(fecha.getHours()).padStart(2, '0')}:${String(fecha.getMinutes()).padStart(2, '0')}`;
}

function estadoParaCliente() {
    return {
        servidorMs: Date.now(),
        estaciones: Array.from(estadosPorEstacion.values()),
        paradasActivas: Array.from(paradasActivas.values()),
        historial: historialParadas.slice(-200)
    };
}

function emitirEstadoInicial(socket) {
    socket.emit('estado_inicial', estadoParaCliente());
}

// Canal de comunicación en tiempo real con Socket.io
io.on('connection', (socket) => {
    console.log('Dispositivo conectado al servidor de planta.');

    // Al conectarse (o reconectarse) recibe el estado actual completo.
    emitirEstadoInicial(socket);

    socket.on('solicitar_estado', () => {
        emitirEstadoInicial(socket);
    });

    // El operador guarda / actualiza un formulario de estación.
    socket.on('actualizar_estado_linea', (data) => {
        if (!data || !data.linea || !data.estacion) return;

        data.servidorMs = Date.now();
        estadosPorEstacion.set(claveEstado(data.linea, data.estacion), data);

        console.log(`Sincronizando ${data.estacion} de la Línea ${data.linea}`);

        // Se reenvía a todos los demás dispositivos (sala de control).
        socket.broadcast.emit('sincronizar_pantalla', data);
    });

    // -----------------------------------------------------------------------
    // INICIO DE PARADA: el teléfono manda la señal con un solo toque.
    // -----------------------------------------------------------------------
    socket.on('iniciar_parada', (data) => {
        if (!data || !data.linea || !data.estacion) return;

        const k = claveEstado(data.linea, data.estacion);

        // Si ya estaba parada, se devuelve la parada existente (evita duplicados).
        if (paradasActivas.has(k)) {
            socket.emit('parada_iniciada', paradasActivas.get(k));
            return;
        }

        const ahora = new Date();
        const parada = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            linea: String(data.linea),
            estacion: String(data.estacion).toLowerCase(),
            zona: data.zona || 'Sin clasificar',
            desc: data.desc || 'Parada reportada por el operador',
            tecnico: data.tecnico || '',
            especialidad: data.especialidad || '',
            desde: horaHHMM(ahora),
            inicioMs: ahora.getTime(),
            servidorMs: Date.now()
        };

        paradasActivas.set(k, parada);
        console.log(`🔴 PARADA Línea ${parada.linea} - ${parada.estacion} (${parada.zona})`);

        io.emit('parada_iniciada', parada);
    });

    // -----------------------------------------------------------------------
    // FIN DE PARADA: se calcula la duración real y se archiva.
    // -----------------------------------------------------------------------
    socket.on('finalizar_parada', (data) => {
        if (!data || !data.linea || !data.estacion) return;

        const k = claveEstado(data.linea, data.estacion);
        const parada = paradasActivas.get(k);

        if (!parada) {
            socket.emit('parada_finalizada', {
                linea: String(data.linea),
                estacion: String(data.estacion).toLowerCase(),
                yaFinalizada: true,
                servidorMs: Date.now()
            });
            return;
        }

        const ahora = new Date();
        const duracionMs = Math.max(0, ahora.getTime() - parada.inicioMs);
        const cerrada = {
            ...parada,
            hasta: horaHHMM(ahora),
            hastaMs: ahora.getTime(),
            duracionMs,
            minutos: Math.max(1, Math.round(duracionMs / 60000)),
            servidorMs: Date.now()
        };

        paradasActivas.delete(k);
        historialParadas.push(cerrada);
        if (historialParadas.length > MAX_HISTORIAL) {
            historialParadas.splice(0, historialParadas.length - MAX_HISTORIAL);
        }

        console.log(`🟢 REANUDADA Línea ${cerrada.linea} - ${cerrada.estacion} (${cerrada.minutos} min)`);

        io.emit('parada_finalizada', cerrada);
    });

    // -----------------------------------------------------------------------
    // LIMPIEZA GLOBAL: el supervisor borra paradas y merma de todas las pantallas.
    // -----------------------------------------------------------------------
    socket.on('limpiar_datos_estaciones', () => {
        paradasActivas.clear();
        historialParadas.length = 0;
        io.emit('datos_estaciones_limpiados', { servidorMs: Date.now() });
        console.log('🧹 Paradas y merma limpiadas desde la sala de control');
    });

    socket.on('disconnect', () => {
        // La parada NO se borra al desconectarse el teléfono: la línea sigue parada
        // hasta que alguien la reanude.
        console.log('Dispositivo desconectado de la red.');
    });
});

// Endpoint de diagnóstico rápido (útil para probar desde el navegador)
app.get('/estado', (req, res) => {
    res.json(estadoParaCliente());
});

function obtenerIPsLocales() {
    const ips = [];
    const interfaces = os.networkInterfaces();
    for (const nombre of Object.keys(interfaces)) {
        for (const net of interfaces[nombre] || []) {
            if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
        }
    }
    return ips;
}

// Puerto de la red local de la planta
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('----------------------------------------------------');
    console.log('Servidor local de planta corriendo con exito!');
    console.log('Este PC (Supervisor):  http://localhost:' + PORT);
    const ips = obtenerIPsLocales();
    if (ips.length > 0) {
        ips.forEach(ip => {
            console.log('Telefonos en el Wi-Fi: http://' + ip + ':' + PORT);
        });
    } else {
        console.log('No se detecto IP local. Verifique la conexion Wi-Fi.');
    }
    console.log('----------------------------------------------------');
});
