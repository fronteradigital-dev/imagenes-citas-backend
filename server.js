'use strict';
require('dotenv').config();
const { procesarMensaje } = require('./agente');
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const PORT        = process.env.SERVER_PORT || 3001;
const NOMBRE_CENTRO  = process.env.NOMBRE_CENTRO;
const TELEFONO_CENTRO = process.env.TELEFONO_CENTRO;
const WAHA_URL    = process.env.WAHA_URL || 'http://localhost:3002';
const WAHA_KEY    = process.env.WAHA_API_KEY;

const SEDES = [
  { id: 'sandiego', nombre: 'Sandiego',  direccion: 'C.C. Sandiego, Bloque Norte, Of. 231' },
  { id: 'tesoro',   nombre: 'El Tesoro', direccion: 'C.C. El Tesoro, Torre Medica 2, Of. 1266' },
  { id: 'bello',    nombre: 'Bello',     direccion: 'C.C. Metro Bello, Of. 307' },
  { id: 'rionegro', nombre: 'Rionegro',  direccion: 'C.C. Savanna Plaza, Of. 504' }
];

const SEDE_MAP = {};
SEDES.forEach(s => { SEDE_MAP[s.nombre] = s.id; });

// ── WAHA HELPERS ──────────────────────────────────────────────────────────────
async function wahaGet(path) {
  const res = await fetch(`${WAHA_URL}${path}`, {
    headers: { 'X-Api-Key': WAHA_KEY }
  });
  return res.json();
}

async function wahaPost(path, body) {
  const res = await fetch(`${WAHA_URL}${path}`, {
    method: 'POST',
    headers: { 'X-Api-Key': WAHA_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function getSessionStatus(sedeId) {
  try {
    const data = await wahaGet(`/api/sessions/${sedeId}`);
    return data.status || 'UNKNOWN';
  } catch (e) {
    return 'ERROR';
  }
}

async function getQRImage(sedeId) {
  try {
    const res = await fetch(`${WAHA_URL}/api/${sedeId}/auth/qr`, {
      headers: { 'X-Api-Key': WAHA_KEY }
    });
    if (!res.ok) return null;
    const buf = await res.buffer();
    return 'data:image/png;base64,' + buf.toString('base64');
  } catch (e) {
    return null;
  }
}

async function enviarMensajeWaha(sedeId, telefono, mensaje) {
  let num = telefono.replace(/\D/g, '');
  if (!num.startsWith('57')) num = '57' + num;
  const chatId = num + '@c.us';
  await wahaPost(`/api/sendText`, {
    session: sedeId,
    chatId,
    text: mensaje
  });
}

// ── MENSAJES ──────────────────────────────────────────────────────────────────
function msgConfirmacion(c) {
  const dir = SEDES.find(s => s.nombre === c.sede)?.direccion || '';
  return `✅ *Cita Confirmada - ${NOMBRE_CENTRO}*\n\nHola *${c.nombre}*, tu cita ha sido registrada.\n\n📋 *Detalles:*\n• 🏥 Sede: ${c.sede}\n• 📍 ${dir}\n• 🔬 Estudio: ${c.servicio}\n• 📅 Fecha: ${c.fecha}\n• ⏰ Hora: ${c.hora}\n• 🆔 ID: ${c.id}\n\n_Guarda este mensaje para cancelar o consultar tu cita._\n\n📞 ${TELEFONO_CENTRO}`;
}

function msgRecordatorio(c) {
  const dir = SEDES.find(s => s.nombre === c.sede)?.direccion || '';
  return `🔔 *Recordatorio de Cita - ${NOMBRE_CENTRO}*\n\nHola *${c.nombre}*, te recordamos tu cita de mañana:\n\n• 🏥 Sede: ${c.sede}\n• 📍 ${dir}\n• 🔬 Estudio: ${c.servicio}\n• 📅 Fecha: ${c.fecha}\n• ⏰ Hora: ${c.hora}\n\n_Por favor llega 10 minutos antes._\n📞 ${TELEFONO_CENTRO}`;
}

function msgCancelada(c) {
  return `❌ *Cita Cancelada - ${NOMBRE_CENTRO}*\n\nHola *${c.nombre}*, tu cita ha sido *cancelada*.\n\n• 🏥 Sede: ${c.sede}\n• 🔬 Estudio: ${c.servicio}\n• 📅 Fecha: ${c.fecha}\n• ⏰ Hora: ${c.hora}\n\nPara reagendar comunícate al:\n📞 ${TELEFONO_CENTRO}`;
}

function msgReagendada(c) {
  return `🔄 *Cita Reagendada - ${NOMBRE_CENTRO}*\n\nHola *${c.nombre}*, tu cita fue *reprogramada*.\n\n• 🏥 Sede: ${c.sede}\n• 🔬 Estudio: ${c.servicio}\n• 📅 Nueva fecha: ${c.fecha}\n• ⏰ Nueva hora: ${c.hora}\n\n_Recuerda llegar 10 minutos antes._\n📞 ${TELEFONO_CENTRO}`;
}

function msgAtendida(c) {
  return `✅ *Cita Atendida - ${NOMBRE_CENTRO}*\n\nHola *${c.nombre}*, tu cita fue marcada como *atendida*.\n\nGracias por confiar en nosotros. 💙\n\n📞 ${TELEFONO_CENTRO}`;
}

// ── EXPRESS ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

const rateLimit = require('express-rate-limit');
const limiter = rateLimit({ windowMs: 60 * 1000, max: 100, message: { ok: false, error: 'Demasiadas peticiones' } });
app.use(limiter);

function verificarKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_SECRET) return res.status(401).json({ ok: false, error: 'No autorizado' });
  next();
}

// ── WEBHOOK DE WAHA ───────────────────────────────────────────────────────────
app.post('/webhook/waha', async (req, res) => {
  res.sendStatus(200);
  try {
    const { event, session, payload } = req.body;
    if (event !== 'message') return;
    if (!payload || payload.fromMe) return;

    const texto = payload.body || '';
    if (!texto) return;

    const numero = payload.from.replace('@c.us', '').replace('@s.whatsapp.net', '');
    const sedeId = session;

    console.log(`[${sedeId}] 📩 Mensaje de ${numero}: ${texto}`);

    // Delay de 1 segundo para parecer más humano
    await new Promise(r => setTimeout(r, 1000));

    console.log(`[${sedeId}] Procesando...`);
    const respuesta = await procesarMensaje(numero, texto, null);
    console.log(`[${sedeId}] Respuesta: ${respuesta?.substring(0, 60)}`);

    await enviarMensajeWaha(sedeId, numero, respuesta);
  } catch (e) {
    console.error('[WEBHOOK] Error:', e.message);
  }
});

// ── PANEL ─────────────────────────────────────────────────────────────────────
app.get('/ping', async (req, res) => {
  const result = {};
  for (const s of SEDES) {
    result[s.nombre] = await getSessionStatus(s.id);
  }
  res.json({ ok: true, sedes: result });
});

app.get('/estado', async (req, res) => {
  const result = {};
  for (const s of SEDES) {
    const status = await getSessionStatus(s.id);
    result[s.nombre] = { estado: status, tieneQR: status === 'SCAN_QR_CODE' };
  }
  res.json(result);
});

app.get('/qr/:sedeId', async (req, res) => {
  const { sedeId } = req.params;
  const sede = SEDES.find(s => s.id === sedeId);
  if (!sede) return res.status(404).send('Sede no encontrada');

  const status = await getSessionStatus(sedeId);

  if (status === 'WORKING') {
    return res.send(`<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;font-family:sans-serif;background:#f0f4f0"><h2 style="color:#1a6b3a">✅ ${sede.nombre} — WhatsApp Conectado</h2></body></html>`);
  }

  if (status !== 'SCAN_QR_CODE') {
    return res.send(`<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;font-family:sans-serif"><h2>${sede.nombre} — Estado: ${status}</h2><script>setTimeout(()=>location.reload(),3000)</script></body></html>`);
  }

  const imgData = await getQRImage(sedeId);
  if (!imgData) {
    return res.send(`<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;font-family:sans-serif"><h2>${sede.nombre} — Generando QR...</h2><script>setTimeout(()=>location.reload(),3000)</script></body></html>`);
  }

  res.send(`<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;font-family:sans-serif"><h2>📱 ${sede.nombre} — Escanea con WhatsApp</h2><img src="${imgData}" style="border:8px solid white;border-radius:12px;width:300px"><script>setTimeout(()=>location.reload(),20000)</script></body></html>`);
});

app.get('/', async (req, res) => {
  let html = `<html><body style="font-family:sans-serif;max-width:600px;margin:2rem auto"><h1>🏥 ${NOMBRE_CENTRO}</h1>`;
  for (const s of SEDES) {
    const status = await getSessionStatus(s.id);
    const connected = status === 'WORKING';
    const color = connected ? '#1a6b3a' : status === 'SCAN_QR_CODE' ? '#b87a00' : '#b83232';
    const emoji = connected ? '✅' : status === 'SCAN_QR_CODE' ? '📱' : '❌';
    html += `<div style="border:1px solid #ddd;border-radius:8px;padding:1rem;margin:.75rem 0;display:flex;justify-content:space-between">`;
    html += `<div><strong>${s.nombre}</strong><br><small>${s.direccion}</small></div>`;
    html += `<div style="text-align:right"><span style="color:${color}">${emoji} ${status}</span><br>`;
    if (!connected) html += `<a href="/qr/${s.id}">Ver QR →</a>`;
    html += `</div></div>`;
  }
  html += `<script>setTimeout(()=>location.reload(),10000)</script></body></html>`;
  res.send(html);
});

// ── ENVÍO DE MENSAJES ─────────────────────────────────────────────────────────
app.post('/enviar/confirmacion', verificarKey, async (req, res) => {
  try {
    const { cita } = req.body;
    const sedeId = SEDE_MAP[cita.sede];
    await enviarMensajeWaha(sedeId, cita.tel, msgConfirmacion(cita));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/enviar/recordatorio', verificarKey, async (req, res) => {
  try {
    const { cita } = req.body;
    const sedeId = SEDE_MAP[cita.sede];
    await enviarMensajeWaha(sedeId, cita.tel, msgRecordatorio(cita));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/enviar/cancelada', verificarKey, async (req, res) => {
  try {
    const { cita } = req.body;
    const sedeId = SEDE_MAP[cita.sede];
    await enviarMensajeWaha(sedeId, cita.tel, msgCancelada(cita));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/enviar/reagendada', verificarKey, async (req, res) => {
  try {
    const { cita } = req.body;
    const sedeId = SEDE_MAP[cita.sede];
    await enviarMensajeWaha(sedeId, cita.tel, msgReagendada(cita));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/enviar/atendida', verificarKey, async (req, res) => {
  try {
    const { cita } = req.body;
    const sedeId = SEDE_MAP[cita.sede];
    await enviarMensajeWaha(sedeId, cita.tel, msgAtendida(cita));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.listen(PORT, () => console.log(`\n🌐 Panel: http://${process.env.SERVER_IP}:${PORT}`));

console.log(`\n🚀 ${NOMBRE_CENTRO} — Servidor WhatsApp Multi-Sede (WAHA)`);