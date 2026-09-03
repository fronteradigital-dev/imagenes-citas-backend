'use strict';
require('dotenv').config();

const crypto = require('crypto');

// ── VARIABLES DE ENTORNO ───────────────────────────────────────────────────────
const FIREWORKS_API_KEY    = process.env.FIREWORKS_API_KEY;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const APP_URL              = process.env.APP_URL;
const NOMBRE_CENTRO        = process.env.NOMBRE_CENTRO;
const TELEFONO_CENTRO      = process.env.TELEFONO_CENTRO;

// ── CONFIGURACIÓN CENTRAL ─────────────────────────────────────────────────────
const CONFIG = {
  // Fireworks — extracción con tool calling (rápido, barato)
  EXTRACTION_MODEL:     'accounts/fireworks/models/llama-v3p1-8b-instruct',
  // Fireworks — respuesta conversacional (calidad)
  RESPONSE_MODEL:       'accounts/fireworks/models/llama-v3p3-70b-instruct',
  FIREWORKS_URL:        'https://api.fireworks.ai/inference/v1/chat/completions',
  GROQ_TEMPERATURE:     0.7,
  GROQ_MAX_TOKENS:      600,
  EXTRACTION_TEMPERATURE: 0,
  TIMEOUT_CONV:         30 * 60 * 1000,
  HORAS_VALIDAS:        ['8:00', '9:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'],
  SEDES:                ['Sandiego', 'El Tesoro', 'Bello', 'Rionegro'],
  SERVICIOS: [
    'Fotografía',
    'Escáner Normal',
    'Sialografía',
    'Escáner Itero (Invisalign)',
    'Paquete 1. (Fotografía y Escáner Normal)',
    'Paquete 2. (Fotografía y Escáner Itero Invisalign)'
  ],
  SEDE_SERVICIO_MAP: {
    'Sialografía':                                        ['Sandiego'],
    'Escáner Itero (Invisalign)':                         ['Sandiego'],
    'Paquete 2. (Fotografía y Escáner Itero Invisalign)': ['Sandiego']
  },
  FIELD_NAMES: {
    nombre:    'nombre completo',
    apellido:  'apellido',
    doc:       'número de documento',
    tel:       'número de celular',
    sede:      'sede',
    servicio:  'servicio',
    fecha:     'fecha de la cita',
    hora:      'hora de la cita',
    old_fecha: 'fecha actual de la cita',
    old_hora:  'hora actual de la cita',
    new_fecha: 'nueva fecha de la cita',
    new_hora:  'nueva hora de la cita'
  },
  REQUIRED_FIELDS: {
    book:               ['nombre', 'apellido', 'doc', 'tel', 'sede', 'servicio', 'fecha', 'hora'],
    cancel:             ['doc', 'fecha', 'hora'],
    reschedule:         ['doc', 'old_fecha', 'old_hora', 'new_fecha', 'new_hora'],
    check_results:      ['doc'],
    reminder:           ['doc'],
    check_availability: [],
    get_catalog:        []
  },
  DIAS_SEMANA: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
  MESES:       ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
};

// ── ESTADOS DE CONVERSACIÓN ───────────────────────────────────────────────────
const ConversationState = {
  GREETING:     'GREETING',
  COLLECTING_DATA: 'COLLECTING_DATA',
  CONFIRMING:   'CONFIRMING',
  EXECUTING:    'EXECUTING',
  COMPLETED:    'COMPLETED',
  CANCELING:    'CANCELING',
  RESCHEDULING: 'RESCHEDULING'
};

// ── ESTADÍSTICAS ──────────────────────────────────────────────────────────────
const activeConversations = new Map();
let totalToday = 0;

// ── MENSAJE DE BIENVENIDA ─────────────────────────────────────────────────────
const getBienvenida = () => `¡Hola! 👋 Bienvenido a *${NOMBRE_CENTRO}*.

Soy tu asistente virtual. Puedo ayudarte con:
📅 Agendar una cita
❌ Cancelar o consultar tu cita
📍 Información de sedes y servicios
🔬 Preparación para tus estudios

¿En qué te puedo ayudar hoy?`;

// ── VALIDACIÓN DE ENTORNO ─────────────────────────────────────────────────────
function validateEnv() {
  const required = [
    { key: 'FIREWORKS_API_KEY',    val: FIREWORKS_API_KEY },
    { key: 'SUPABASE_URL',         val: SUPABASE_URL },
    { key: 'SUPABASE_SERVICE_KEY', val: SUPABASE_SERVICE_KEY },
    { key: 'APP_URL',              val: APP_URL },
    { key: 'NOMBRE_CENTRO',        val: NOMBRE_CENTRO },
    { key: 'TELEFONO_CENTRO',      val: TELEFONO_CENTRO }
  ];
  const missing = required.filter(r => !r.val).map(r => r.key);
  if (missing.length > 0) {
    console.error(`[CONFIG] Variables de entorno faltantes: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log('[CONFIG] Entorno validado correctamente.');
}

function logError(modulo, error) {
  const msg = error instanceof Error ? error.message : error;
  console.error(`[${modulo}] ${msg}`);
}

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────
function getSistema(fechaHoy) {
  return `Eres el asistente virtual de ${NOMBRE_CENTRO}, centro de imagenología oral y maxilofacial especializada en Antioquia, Colombia.

SOBRE LA EMPRESA:
Fundada en 2001 por los radiólogos maxilofaciales Dra. Olga Liliana Aguilar Méndez y Dr. Germán Aguilar Méndez, pioneros en Medellín. Ofrecemos estudios precisos, confiables y oportunos que respaldan la toma de decisiones clínicas y contribuyen al éxito de los tratamientos odontológicos. Contamos con equipos radiológicos de última generación puestos al servicio de la comunidad odontológica y sus pacientes.

FILOSOFÍA:
Enriquecer y fortalecer el buen uso de las ayudas diagnósticas como herramienta indispensable para el ejercicio de la práctica odontológica.

Hoy es ${fechaHoy}. Habla en español colombiano natural y amigable. Sé conciso (máximo 4 líneas por respuesta).

SEDES Y SERVICIOS:
- Sandiego (C.C. Sandiego, Bloque Norte, Of. 231): Fotografía, Escáner Normal, Sialografía, Escáner Itero (Invisalign), Paquete 1 (Fotografía+Escáner Normal), Paquete 2 (Fotografía+Escáner Itero)
- El Tesoro (C.C. El Tesoro, Torre Médica 2, Of. 1266): Fotografía, Escáner Normal, Paquete 1
- Bello (C.C. Metro Bello, Of. 307): Fotografía, Escáner Normal, Paquete 1
- Rionegro (C.C. Savanna Plaza, Of. 504): Fotografía, Escáner Normal, Paquete 1

HORARIO: Lunes-Viernes 8am-5pm, Sábados 8am-12pm
HORARIOS DISPONIBLES: 8:00, 9:00, 10:00, 11:00, 12:00, 13:00, 14:00, 15:00, 16:00

PREPARACIÓN DE ESTUDIOS:
- Fotografía: Sin preparación
- Escáner Normal: Sin preparación especial
- Sialografía: Ayuno 4 horas (solo Sandiego)
- Escáner Itero Invisalign: Sin preparación (solo Sandiego)

REGLAS CRÍTICAS:
- Responde en español colombiano natural y cálido.
- Sé breve: máximo 2-3 oraciones cortas.
- NUNCA inventes datos que el usuario no haya dado.
- Si faltan campos, pide TODOS en UN solo mensaje.
- No repitas la misma pregunta dos veces en el mismo mensaje.
- No asumas información que el usuario no dijo explícitamente.
- Call only ONE tool at a time. Never chain tool calls in a single turn.
- Siempre ofrece el link de la app: ${APP_URL}
- Teléfono de contacto: ${TELEFONO_CENTRO}`;
}

// ── NLP ───────────────────────────────────────────────────────────────────────
function normalizarTexto(texto) {
  if (!texto) return '';
  let t = ' ' + texto.toLowerCase() + ' ';
  const reemplazos = [
    [/ pa /g, ' para '],
    [/ q /g, ' que '],
    [/ tb /g, ' también '],
    [/ x /g, ' por '],
    [/ xq /g, ' porque '],
    [/ k /g, ' que '],
    [/ d /g, ' de ']
  ];
  for (const [regex, reemplazo] of reemplazos) t = t.replace(regex, reemplazo);
  t = t.replace(/\bmiercoles\b/g, 'miércoles');
  t = t.replace(/\bsabado\b/g, 'sábado');
  t = t.replace(/\bmas\b/g, 'más');
  t = t.replace(/\bfoto\b/g, 'fotografía');
  t = t.replace(/\bescaner\b/g, 'escáner');
  t = t.replace(/\bturno\b/g, 'cita');
  return t.trim();
}

function resolverFechaAvanzado(texto) {
  const hoy = new Date();
  const yyyy = hoy.getFullYear();
  if (/\bhoy\b/.test(texto)) return hoy.toISOString().split('T')[0];
  if (/\bmañana\b/.test(texto)) {
    const d = new Date(hoy); d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  }
  if (/\bpasado mañana\b/.test(texto)) {
    const d = new Date(hoy); d.setDate(d.getDate() + 2);
    return d.toISOString().split('T')[0];
  }
  const matchDias = texto.match(/(?:en|dentro de)\s+(\d+)\s+d[ií]as?/);
  if (matchDias) {
    const d = new Date(hoy); d.setDate(d.getDate() + parseInt(matchDias[1], 10));
    return d.toISOString().split('T')[0];
  }
  const dias = CONFIG.DIAS_SEMANA;
  const regexDia = new RegExp(`\\b(?:el\\s+)?(?:pr[oó]ximo|que\\s+viene\\s+)?(${dias.join('|')})\\b`);
  const matchDia = texto.match(regexDia);
  if (matchDia) {
    const targetDay = dias.indexOf(matchDia[1]);
    const d = new Date(hoy);
    const currentDay = d.getDay();
    let add = (targetDay - currentDay + 7) % 7;
    if (add === 0) add = 7;
    d.setDate(d.getDate() + add);
    return d.toISOString().split('T')[0];
  }
  if (/\bpr[oó]xima semana\b/.test(texto)) {
    const d = new Date(hoy); d.setDate(d.getDate() + 7);
    return d.toISOString().split('T')[0];
  }
  const matchFecha = texto.match(/(?:el\s+)?(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/);
  if (matchFecha) {
    const mes = String(CONFIG.MESES.indexOf(matchFecha[2]) + 1).padStart(2, '0');
    const dia = String(matchFecha[1]).padStart(2, '0');
    return `${yyyy}-${mes}-${dia}`;
  }
  return null;
}

function buildFewShotExamples() {
  const hoy = new Date();
  const tomorrow = new Date(hoy); tomorrow.setDate(tomorrow.getDate() + 1);
  const nextTuesday = new Date(hoy); nextTuesday.setDate(nextTuesday.getDate() + ((2 - hoy.getDay() + 7) % 7 || 7));
  const nextFriday = new Date(hoy); nextFriday.setDate(nextFriday.getDate() + ((5 - hoy.getDay() + 7) % 7 || 7));
  const nextThursday = new Date(hoy); nextThursday.setDate(nextThursday.getDate() + ((4 - hoy.getDay() + 7) % 7 || 7));
  const y = hoy.getFullYear();
  const fmt = d => d.toISOString().split('T')[0];
  return `
Ejemplos de extracción informal colombiana:

Input: "buenas necesito cita pa mañana en sandiego pa las 10 soy pedro perez cc 1234567 cel 3001234567"
Expected: intent=book, nombre=pedro, apellido=perez, doc=1234567, tel=3001234567, sede=Sandiego, fecha=${fmt(tomorrow)}, hora=10:00

Input: "ola kiero cancelar mi cita del martes a las 9 doc 9876543"
Expected: intent=cancel, doc=9876543, fecha=${fmt(nextTuesday)}, hora=9:00

Input: "me pueden dar turno el viernes que viene a las 3 de la tarde en el tesoro para la fotografía"
Expected: intent=book, sede=El Tesoro, servicio=Fotografía, fecha=${fmt(nextFriday)}, hora=15:00

Input: "necesito un escáner normal en bello el 15 de junio a las 11 soy maria lopez 98765432 cel 3109876543"
Expected: intent=book, nombre=maria, apellido=lopez, doc=98765432, tel=3109876543, sede=Bello, servicio=Escáner Normal, fecha=${y}-06-15, hora=11:00

Input: "quiero reagendar la del jueves"
Expected: intent=reschedule, old_fecha=${fmt(nextThursday)}

Input: "si confirmo"
Expected: intent=confirm, confirmation=yes

Input: "no espera cambia la hora"
Expected: intent=deny, confirmation=no

Input: "cuanto demoran los resultados"
Expected: intent=check_results

Input: "a que hora abren"
Expected: intent=help

Input: "cancelar cita 1234567 mañana 8"
Expected: intent=cancel, doc=1234567, fecha=${fmt(tomorrow)}, hora=8:00
`;
}

// ── VALIDADORES ───────────────────────────────────────────────────────────────
function validateDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr))
    throw new Error(`Formato de fecha inválido. Se esperaba YYYY-MM-DD, se recibió ${dateStr}`);
  return dateStr;
}

function validateIdNumber(idStr) {
  const id = Number(idStr);
  if (isNaN(id) || id < 1000000 || id > 9999999999)
    throw new Error(`Documento inválido. Debe tener entre 7 y 10 dígitos. Recibido: ${idStr}`);
  return idStr;
}

function validateTel(telStr) {
  if (!/^3\d{9}$/.test(telStr))
    throw new Error(`Celular inválido. Debe iniciar en 3 y tener 10 dígitos. Recibido: ${telStr}`);
  return telStr;
}

function validateField(key, value) {
  try {
    if (['fecha', 'old_fecha', 'new_fecha'].includes(key)) validateDate(value);
    else if (key === 'doc') validateIdNumber(value);
    else if (key === 'tel') validateTel(value);
    else if (['hora', 'old_hora', 'new_hora'].includes(key)) {
      if (!CONFIG.HORAS_VALIDAS.includes(value)) throw new Error('Hora inválida');
    }
    else if (key === 'sede') {
      if (!CONFIG.SEDES.includes(value)) throw new Error('Sede inválida');
    }
    else if (key === 'servicio') {
      if (!CONFIG.SERVICIOS.includes(value)) throw new Error('Servicio inválido');
    }
    return { valid: true };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

// ── SUPABASE ──────────────────────────────────────────────────────────────────
async function supabaseFetch(endpoint, method = 'GET', body = null) {
  const headers = {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, options);
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Supabase error ${response.status}: ${err}`);
  }
  return response.json();
}

async function insertCita(data) {
  if (!data.id) data.id = 'C' + Date.now();
  return await supabaseFetch('citas', 'POST', data);
}

async function updateCitaEstado(id, estado) {
  return await supabaseFetch(`citas?id=eq.${encodeURIComponent(id)}`, 'PATCH', { estado });
}

async function getCitasByDoc(doc) {
  return await supabaseFetch(`citas?doc=eq.${encodeURIComponent(doc)}&estado=eq.pendiente`);
}

async function checkDisponibilidad(sede, fecha, hora) {
  let url = 'disponibilidad?disponible=eq.true';
  if (sede)  url += `&sede=eq.${encodeURIComponent(sede)}`;
  if (fecha) url += `&fecha=eq.${encodeURIComponent(fecha)}`;
  if (hora)  url += `&hora=eq.${encodeURIComponent(hora)}`;
  return await supabaseFetch(url);
}

async function updateDisponibilidad(sede, fecha, hora, disponible) {
  return await supabaseFetch(
    `disponibilidad?sede=eq.${encodeURIComponent(sede)}&fecha=eq.${encodeURIComponent(fecha)}&hora=eq.${encodeURIComponent(hora)}`,
    'PATCH',
    { disponible }
  );
}

async function getEstudiosByPatient(patient_id) {
  return await supabaseFetch(`estudios?patient_id=eq.${encodeURIComponent(patient_id)}`);
}

// ── TOOLS (ACCIONES DE NEGOCIO) ───────────────────────────────────────────────
async function get_catalog() {
  return JSON.stringify(CONFIG.SERVICIOS.map(s => ({ servicio: s })));
}

async function check_availability({ sede, fecha, hora }) {
  if (fecha) validateDate(fecha);
  try {
    const data = await checkDisponibilidad(sede, fecha, hora);
    if (data.length === 0) return 'No hay disponibilidad para los parámetros solicitados.';
    return JSON.stringify(data);
  } catch (e) {
    logError('DISPONIBILIDAD', e);
    return `Error consultando disponibilidad: ${e.message}`;
  }
}

async function book_appointment({ nombre, apellido, doc, tel, sede, servicio, fecha, hora }) {
  validateDate(fecha); validateIdNumber(doc); validateTel(tel);
  try {
    const avail = await checkDisponibilidad(sede, fecha, hora);
    if (avail.length === 0) return 'El horario seleccionado no está disponible.';
    await updateDisponibilidad(sede, fecha, hora, false);
    const id = 'C' + Date.now();
    await insertCita({ id, nombre, apellido, doc, tel, sede, servicio, fecha, hora, estado: 'pendiente', created_at: new Date().toISOString() });
    return `✅ *¡Cita agendada exitosamente!*\n🆔 ID: *${id}*\n📍 Sede: ${sede}\n📅 Fecha: ${fecha} a las ${hora}\n🔬 Servicio: ${servicio}\n\nGuarda este ID para cancelar o consultar. También puedes gestionar tu cita en: ${APP_URL}`;
  } catch (e) {
    logError('AGENDAMIENTO', e);
    return `Error agendando la cita: ${e.message}`;
  }
}

async function cancel_appointment({ doc, fecha, hora }) {
  validateIdNumber(doc); validateDate(fecha);
  try {
    const citas = await supabaseFetch(`citas?doc=eq.${encodeURIComponent(doc)}&fecha=eq.${encodeURIComponent(fecha)}&hora=eq.${encodeURIComponent(hora)}&estado=eq.pendiente`);
    if (citas.length === 0) return 'No encontré citas pendientes con esos datos. ¿Está seguro del documento, fecha y hora?';
    const app = citas[0];
    await updateCitaEstado(app.id, 'cancelada');
    await updateDisponibilidad(app.sede, app.fecha, app.hora, true);
    return `❌ *Cita cancelada exitosamente*\n🆔 ID: ${app.id}\n\nPara reagendar: ${APP_URL}`;
  } catch (e) {
    logError('CANCELACION', e);
    return `Error cancelando la cita: ${e.message}`;
  }
}

async function search_appointments_by_doc({ doc }) {
  validateIdNumber(doc);
  try {
    const data = await getCitasByDoc(doc);
    if (data.length === 0) return 'No encontré citas pendientes con ese documento. ¿Está seguro del número?';
    let lista = '📋 *Tus citas activas:*\n';
    data.forEach((c, i) => {
      lista += `\n${i + 1}. *${c.sede}* — ${c.fecha} ${c.hora}\n   ${c.servicio} | ID: ${c.id}\n`;
    });
    return lista;
  } catch (e) {
    logError('BUSQUEDA', e);
    return `Error buscando citas: ${e.message}`;
  }
}

async function reschedule_appointment({ doc, old_fecha, old_hora, new_fecha, new_hora }) {
  validateIdNumber(doc); validateDate(old_fecha); validateDate(new_fecha);
  try {
    const existing = await supabaseFetch(`citas?doc=eq.${encodeURIComponent(doc)}&fecha=eq.${encodeURIComponent(old_fecha)}&hora=eq.${encodeURIComponent(old_hora)}&estado=eq.pendiente`);
    if (existing.length === 0) return 'No encontré la cita original. ¿Está seguro de la fecha y hora?';
    const oldApp = existing[0];
    const avail = await checkDisponibilidad(oldApp.sede, new_fecha, new_hora);
    if (avail.length === 0) return 'El nuevo horario solicitado no está disponible.';
    await updateCitaEstado(oldApp.id, 'reagendada');
    await updateDisponibilidad(oldApp.sede, oldApp.fecha, oldApp.hora, true);
    const newId = 'C' + Date.now();
    await insertCita({
      id: newId,
      nombre: oldApp.nombre, apellido: oldApp.apellido,
      doc: oldApp.doc, tel: oldApp.tel, email: oldApp.email || '',
      sede: oldApp.sede, servicio: oldApp.servicio,
      fecha: new_fecha, hora: new_hora,
      estado: 'pendiente', created_at: new Date().toISOString()
    });
    await updateDisponibilidad(oldApp.sede, new_fecha, new_hora, false);
    return `✅ *¡Cita reagendada exitosamente!*\n🆔 Nuevo ID: *${newId}*\n📅 Nueva fecha: ${new_fecha} a las ${new_hora}\n📍 Sede: ${oldApp.sede}\n\nGestiona tu cita en: ${APP_URL}`;
  } catch (e) {
    logError('REAGENDAMIENTO', e);
    return `Error reagendando la cita: ${e.message}`;
  }
}

async function check_results({ doc }) {
  validateIdNumber(doc);
  try {
    const data = await getEstudiosByPatient(doc);
    if (data.length === 0) return 'No encontré resultados de estudios para ese documento.';
    return JSON.stringify(data);
  } catch (e) {
    logError('RESULTADOS', e);
    return `Error consultando resultados: ${e.message}`;
  }
}

async function reminder_appointment({ doc }) {
  validateIdNumber(doc);
  try {
    const data = await getCitasByDoc(doc);
    if (data.length === 0) return 'No tienes citas pendientes registradas.';
    return JSON.stringify(data.map(r => ({ fecha: r.fecha, hora: r.hora, sede: r.sede, servicio: r.servicio })));
  } catch (e) {
    logError('RECORDATORIO', e);
    return `Error consultando recordatorio: ${e.message}`;
  }
}

// ── TOOL SCHEMAS PARA FIREWORKS ───────────────────────────────────────────────
const toolsDefinition = [
  {
    type: 'function',
    function: {
      name: 'book_appointment',
      description: 'Agenda una cita médica cuando se tienen todos los campos requeridos',
      parameters: {
        type: 'object',
        properties: {
          nombre:   { type: 'string', description: 'Primer nombre del paciente' },
          apellido: { type: 'string', description: 'Apellido(s) del paciente' },
          doc:      { type: 'string', description: 'Número de documento, 7-10 dígitos' },
          tel:      { type: 'string', description: 'Celular colombiano, inicia en 3, 10 dígitos' },
          sede:     { type: 'string', enum: CONFIG.SEDES },
          servicio: { type: 'string', enum: CONFIG.SERVICIOS },
          fecha:    { type: 'string', description: 'Fecha en formato YYYY-MM-DD' },
          hora:     { type: 'string', enum: CONFIG.HORAS_VALIDAS }
        },
        required: ['nombre', 'apellido', 'doc', 'tel', 'sede', 'servicio', 'fecha', 'hora']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cancel_appointment',
      description: 'Cancela una cita existente',
      parameters: {
        type: 'object',
        properties: {
          doc:   { type: 'string' },
          fecha: { type: 'string', description: 'Fecha en formato YYYY-MM-DD' },
          hora:  { type: 'string', enum: CONFIG.HORAS_VALIDAS }
        },
        required: ['doc', 'fecha', 'hora']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_appointments_by_doc',
      description: 'Busca citas pendientes por número de documento',
      parameters: {
        type: 'object',
        properties: { doc: { type: 'string' } },
        required: ['doc']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reschedule_appointment',
      description: 'Reagenda una cita a nueva fecha y hora',
      parameters: {
        type: 'object',
        properties: {
          doc:       { type: 'string' },
          old_fecha: { type: 'string', description: 'Fecha original YYYY-MM-DD' },
          old_hora:  { type: 'string', enum: CONFIG.HORAS_VALIDAS },
          new_fecha: { type: 'string', description: 'Nueva fecha YYYY-MM-DD' },
          new_hora:  { type: 'string', enum: CONFIG.HORAS_VALIDAS }
        },
        required: ['doc', 'old_fecha', 'old_hora', 'new_fecha', 'new_hora']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_availability',
      description: 'Consulta disponibilidad de horarios',
      parameters: {
        type: 'object',
        properties: {
          sede:  { type: 'string', enum: CONFIG.SEDES },
          fecha: { type: 'string', description: 'Fecha YYYY-MM-DD' },
          hora:  { type: 'string', enum: CONFIG.HORAS_VALIDAS }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_results',
      description: 'Consulta si los resultados de estudios están disponibles',
      parameters: {
        type: 'object',
        properties: { doc: { type: 'string' } },
        required: ['doc']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reminder_appointment',
      description: 'Consulta citas pendientes del paciente',
      parameters: {
        type: 'object',
        properties: { doc: { type: 'string' } },
        required: ['doc']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_catalog',
      description: 'Obtiene el catálogo de servicios disponibles',
      parameters: { type: 'object', properties: {} }
    }
  }
];

const toolFunctionsMap = {
  book_appointment, cancel_appointment, search_appointments_by_doc,
  reschedule_appointment, check_availability, check_results,
  reminder_appointment, get_catalog
};

// ── LÓGICA DE CONVERSACIÓN ────────────────────────────────────────────────────
function validateSedeServicio(sede, servicio) {
  const allowed = CONFIG.SEDE_SERVICIO_MAP[servicio];
  if (allowed && !allowed.includes(sede)) {
    return { valid: false, suggested: allowed[0], message: `El servicio ${servicio} solo está disponible en ${allowed.join(', ')}.` };
  }
  return { valid: true };
}

function datos_completeness_check(datos, intent) {
  const required = CONFIG.REQUIRED_FIELDS[intent] || [];
  const missing = [], missingKeys = [];
  for (const field of required) {
    if (!datos[field] || String(datos[field]).trim() === '') {
      missingKeys.push(field);
      missing.push(CONFIG.FIELD_NAMES[field] || field);
    }
  }
  return { complete: missing.length === 0, missing, missingKeys };
}

async function findNearestSlots(sede, targetFecha, targetHora, limit = 2) {
  const horasOrden = CONFIG.HORAS_VALIDAS;
  const resultados = [];
  try {
    const sameDay = await checkDisponibilidad(sede, targetFecha);
    const targetIdx = horasOrden.indexOf(targetHora);
    const sameDayLater = sameDay
      .filter(s => horasOrden.indexOf(s.hora) > targetIdx)
      .sort((a, b) => horasOrden.indexOf(a.hora) - horasOrden.indexOf(b.hora));
    for (const slot of sameDayLater) {
      resultados.push(slot);
      if (resultados.length >= limit) return resultados;
    }
    const base = new Date(targetFecha + 'T12:00:00');
    for (let i = 1; i <= 14; i++) {
      const next = new Date(base);
      next.setDate(next.getDate() + i);
      const f = next.toISOString().split('T')[0];
      const daySlots = await checkDisponibilidad(sede, f);
      daySlots.sort((a, b) => horasOrden.indexOf(a.hora) - horasOrden.indexOf(b.hora));
      for (const slot of daySlots) {
        resultados.push(slot);
        if (resultados.length >= limit) return resultados;
      }
    }
  } catch (e) { logError('SLOTS', e); }
  return resultados;
}

class ConversationContext {
  constructor() {
    this.state = ConversationState.GREETING;
    this.intent = null;
    this.datos = {};
    this.askedFields = new Set();
    this.lastError = null;
    this.revising = false;
    this.esNuevo = true;
    this.ultimoMensaje = Date.now();
  }
  reset(newIntent) {
    this.state = ConversationState.COLLECTING_DATA;
    this.intent = newIntent;
    this.datos = {};
    this.askedFields = new Set();
    this.lastError = null;
    this.revising = false;
  }
  addAsked(fields) { fields.forEach(f => this.askedFields.add(f)); }
  hasBeenAsked(field) { return this.askedFields.has(field); }
}

function normalizeEntities(entities) {
  const servicioMap = {
    'fotografia': 'Fotografía', 'foto': 'Fotografía',
    'escaner normal': 'Escáner Normal', 'scanner normal': 'Escáner Normal',
    'sialografia': 'Sialografía',
    'itero': 'Escáner Itero (Invisalign)', 'invisalign': 'Escáner Itero (Invisalign)',
    'paquete 1': 'Paquete 1. (Fotografía y Escáner Normal)',
    'paquete 2': 'Paquete 2. (Fotografía y Escáner Itero Invisalign)'
  };
  const sedeMap = {
    'sandiego': 'Sandiego', 'san diego': 'Sandiego',
    'el tesoro': 'El Tesoro', 'tesoro': 'El Tesoro',
    'bello': 'Bello',
    'rionegro': 'Rionegro', 'rio negro': 'Rionegro'
  };
  if (entities.servicio) {
    const lower = entities.servicio.toLowerCase().trim();
    if (servicioMap[lower]) entities.servicio = servicioMap[lower];
  }
  if (entities.sede) {
    const lower = entities.sede.toLowerCase().trim();
    if (sedeMap[lower]) entities.sede = sedeMap[lower];
  }
  return entities;
}

function cleanEntities(entities) {
  const cleaned = {};
  for (const [key, value] of Object.entries(entities)) {
    if (value === undefined || value === null) continue;
    let str = String(value).trim();
    if (key === 'doc' || key === 'tel') str = str.replace(/\D/g, '');
    cleaned[key] = str;
  }
  return normalizeEntities(cleaned);
}

function mergeAndValidateEntities(context, entities) {
  const cleaned = cleanEntities(entities);
  for (const [key, value] of Object.entries(cleaned)) {
    if (!value || String(value).trim() === '') continue;
    const validation = validateField(key, value);
    if (validation.valid) {
      context.datos[key] = value;
      if (context.lastError && context.lastError.field === key) context.lastError = null;
    } else {
      context.lastError = { field: key, name: CONFIG.FIELD_NAMES[key] || key };
    }
  }
}

// ── LLAMADA A FIREWORKS ───────────────────────────────────────────────────────
async function fireworksCall({ model, messages, tools = null, tool_choice = null, temperature = 0.7, max_tokens = 600 }) {
  const body = { model, messages, temperature, max_tokens };
  if (tools)       body.tools       = tools;
  if (tool_choice) body.tool_choice = tool_choice;

  const response = await fetch(CONFIG.FIREWORKS_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${FIREWORKS_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Fireworks error ${response.status}: ${err}`);
  }
  return response.json();
}

// ── EXTRACCIÓN DE INTENCIÓN Y ENTIDADES ──────────────────────────────────────
async function extractIntentAndEntities(message, context) {
  const extractionSchema = [{
    type: 'function',
    function: {
      name: 'extract_conversation_data',
      description: 'Extrae intención y entidades de un mensaje de WhatsApp para una clínica médica',
      parameters: {
        type: 'object',
        properties: {
          intent: {
            type: 'string',
            enum: ['book', 'cancel', 'reschedule', 'check_results', 'reminder', 'check_availability', 'get_catalog', 'confirm', 'deny', 'greeting', 'help', 'unknown', 'correction']
          },
          entities: {
            type: 'object',
            properties: {
              nombre:    { type: 'string' }, apellido: { type: 'string' },
              doc:       { type: 'string' }, tel:      { type: 'string' },
              sede:      { type: 'string' }, servicio: { type: 'string' },
              fecha:     { type: 'string' }, hora:     { type: 'string' },
              old_fecha: { type: 'string' }, old_hora: { type: 'string' },
              new_fecha: { type: 'string' }, new_hora: { type: 'string' }
            }
          },
          confirmation: { type: 'string', enum: ['yes', 'no', null] }
        },
        required: ['intent', 'entities']
      }
    }
  }];

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const resolvedDate = resolverFechaAvanzado(message);

  const systemContent = `Extraes datos estructurados de mensajes de WhatsApp para una clínica de imagenología en Colombia.
Hoy es ${dateStr}.
Estado actual de la conversación: ${context.state}.
Intención actual: ${context.intent || 'ninguna'}.
Datos ya recolectados: ${JSON.stringify(context.datos)}.
${resolvedDate ? `Fecha resuelta del mensaje: ${resolvedDate}` : ''}
REGLAS CRÍTICAS:
- Solo extrae valores NUEVOS o CORREGIDOS. No repitas datos ya recolectados.
- Si el usuario da información parcial, solo retorna esos campos.
- Infiere la intención del contexto si el usuario no la dice explícitamente.
- Retorna fechas en YYYY-MM-DD y horas en H:00 (ej: 9:00, 15:00).
${buildFewShotExamples()}`;

  const data = await fireworksCall({
    model: CONFIG.EXTRACTION_MODEL,
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user',   content: message }
    ],
    tools: extractionSchema,
    tool_choice: { type: 'function', function: { name: 'extract_conversation_data' } },
    temperature: CONFIG.EXTRACTION_TEMPERATURE
  });

  const toolCall = data.choices[0].message.tool_calls[0];
  return JSON.parse(toolCall.function.arguments);
}

// ── MÁQUINA DE ESTADOS ────────────────────────────────────────────────────────
function computeTransition(context, extraction) {
  const intent = context.intent;
  const state  = context.state;
  let nextState = state, action = null, meta = {};

  const isYes = extraction.confirmation === 'yes' || extraction.intent === 'confirm';
  const isNo  = extraction.confirmation === 'no'  || extraction.intent === 'deny';

  if (extraction.intent === 'cancel' && intent !== 'cancel')
    return { nextState: ConversationState.CANCELING, action: null, meta: { switchedIntent: 'cancel' } };
  if (extraction.intent === 'reschedule' && intent !== 'reschedule')
    return { nextState: ConversationState.RESCHEDULING, action: null, meta: { switchedIntent: 'reschedule' } };

  switch (state) {
    case ConversationState.GREETING: {
      if (['book', 'cancel', 'reschedule', 'check_results', 'reminder', 'check_availability', 'get_catalog'].includes(intent)) {
        if (intent === 'book') nextState = ConversationState.COLLECTING_DATA;
        else if (intent === 'cancel') nextState = ConversationState.CANCELING;
        else if (intent === 'reschedule') nextState = ConversationState.RESCHEDULING;
        else {
          const check = datos_completeness_check(context.datos, intent);
          nextState = check.complete ? ConversationState.EXECUTING : ConversationState.COLLECTING_DATA;
        }
      }
      break;
    }
    case ConversationState.COLLECTING_DATA:
    case ConversationState.CANCELING:
    case ConversationState.RESCHEDULING: {
      const check = datos_completeness_check(context.datos, intent);
      if (check.complete) {
        if (context.revising) {
          if (!Object.keys(extraction.entities || {}).length) {
            nextState = state; meta.awaitingCorrection = true; break;
          }
          context.revising = false;
        }
        if (intent === 'book' || intent === 'reschedule') {
          const val = validateSedeServicio(context.datos.sede, context.datos.servicio);
          if (!val.valid) {
            meta.invalidSedeServicio = val;
            context.datos.sede = '';
            nextState = state;
          } else {
            nextState = ConversationState.CONFIRMING;
          }
        } else {
          nextState = ConversationState.EXECUTING;
        }
      } else {
        if (context.revising && Object.keys(extraction.entities || {}).length > 0) context.revising = false;
        const newlyAsked = check.missingKeys.filter(k => !context.hasBeenAsked(k));
        context.addAsked(newlyAsked);
        nextState = state;
      }
      break;
    }
    case ConversationState.CONFIRMING: {
      if (isYes) nextState = ConversationState.EXECUTING;
      else if (isNo) {
        nextState = ConversationState.COLLECTING_DATA;
        context.revising = true;
        context.askedFields.clear();
        meta.userRejected = true;
      } else if (extraction.intent === 'cancel') {
        nextState = ConversationState.CANCELING;
        context.reset('cancel');
      } else {
        nextState = ConversationState.CONFIRMING;
      }
      break;
    }
    case ConversationState.EXECUTING: {
      action = { type: intent, params: context.datos };
      nextState = ConversationState.COMPLETED;
      break;
    }
    case ConversationState.COMPLETED: {
      if (['book', 'cancel', 'reschedule'].includes(extraction.intent)) {
        context.reset(extraction.intent);
        nextState = extraction.intent === 'book'       ? ConversationState.COLLECTING_DATA :
                    extraction.intent === 'cancel'     ? ConversationState.CANCELING :
                                                         ConversationState.RESCHEDULING;
      } else {
        nextState = ConversationState.GREETING;
        context.intent = null; context.datos = {};
        context.askedFields.clear(); context.revising = false;
      }
      break;
    }
  }
  return { nextState, action, meta };
}

async function executeAction(action) {
  try {
    switch (action.type) {
      case 'book':               return await book_appointment(action.params);
      case 'cancel':             return await cancel_appointment(action.params);
      case 'reschedule':         return await reschedule_appointment(action.params);
      case 'check_results':      return await check_results(action.params);
      case 'reminder':           return await reminder_appointment(action.params);
      case 'check_availability': return await check_availability(action.params);
      case 'get_catalog':        return await get_catalog();
      default: return 'Acción no reconocida.';
    }
  } catch (e) {
    logError('EJECUCION', e);
    return `Error: ${e.message}`;
  }
}

// ── GENERACIÓN DE RESPUESTA ───────────────────────────────────────────────────
async function generateResponse(context, extraction, transition, actionResult) {
  const check = datos_completeness_check(context.datos, context.intent);
  const fechaHoy = new Date().toLocaleDateString('es-CO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const instructions = [];

  if (context.lastError)
    instructions.push(`El usuario dio un dato inválido (${context.lastError.name}). Díselo amablemente y pídelo de nuevo.`);

  if (context.state === ConversationState.GREETING)
    instructions.push('Saluda amablemente y pregunta en qué puedes ayudar. Menciona brevemente los servicios: agendar, cancelar, reagendar, consultar resultados.');

  if ([ConversationState.COLLECTING_DATA, ConversationState.CANCELING, ConversationState.RESCHEDULING].includes(context.state)) {
    if (transition.meta?.awaitingCorrection)
      instructions.push('El usuario rechazó la confirmación. Pregúntale qué dato desea corregir. Sé amable y breve.');
    else if (check.missing.length > 0)
      instructions.push(`Faltan estos datos: ${check.missing.join(', ')}. Pídelos TODOS en UN SOLO mensaje, natural y breve. No repitas campos ya recolectados.`);
    else if (transition.meta?.invalidSedeServicio)
      instructions.push(`Servicio no disponible en esa sede. Explica amablemente que solo está en ${transition.meta.invalidSedeServicio.suggested}.`);
    else if (transition.meta?.nearestSlots) {
      const slots = transition.meta.nearestSlots.map(s => `${s.fecha} a las ${s.hora}`).join(' y ');
      instructions.push(`Horario no disponible. Ofrece alternativas: ${slots}. Pregunta cuál prefiere.`);
    }
  }

  if (context.state === ConversationState.CONFIRMING) {
    const d = context.datos;
    if (context.intent === 'book')
      instructions.push(`Resume la cita: ${d.nombre} ${d.apellido}, doc ${d.doc}, ${d.servicio}, sede ${d.sede}, ${d.fecha} a las ${d.hora}. Pregunta: "¿Confirma el agendamiento? Responda sí o no."`);
    else if (context.intent === 'reschedule')
      instructions.push(`Resume el reagendamiento: doc ${d.doc}, cambiar de ${d.old_fecha} ${d.old_hora} a ${d.new_fecha} ${d.new_hora}. Pregunta: "¿Confirma el reagendamiento? Responda sí o no."`);
  }

  if ([ConversationState.EXECUTING, ConversationState.COMPLETED].includes(context.state) && actionResult) {
    if (actionResult.includes('no está disponible') || actionResult.includes('No hay disponibilidad'))
      instructions.push('El horario no está disponible. Pide al usuario que elija otro horario o fecha.');
    else if (actionResult.includes('No encontré'))
      instructions.push('No se encontraron datos. Dile: "No encontré citas con ese documento. ¿Está seguro del número?"');
    else if (actionResult.includes('Error') || actionResult.includes('error'))
      instructions.push('Hubo un error técnico. Pide disculpas brevemente y sugiere llamar al centro.');
    else
      instructions.push(`Confirma la acción de forma breve y amable. Resultado: ${actionResult}`);
  }

  const systemPrompt = `${getSistema(fechaHoy)}

Estado conversación: ${context.state}.
Intención: ${context.intent || 'ninguna'}.
Datos recolectados: ${JSON.stringify(context.datos)}.
Campos faltantes: ${JSON.stringify(check.missing)}.
Resultado acción: ${actionResult || 'ninguno'}.

Instrucciones para esta respuesta:
${instructions.join('\n')}`;

  try {
    const data = await fireworksCall({
      model: CONFIG.RESPONSE_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: extraction.originalMessage || 'Continuar' }
      ],
      temperature: CONFIG.GROQ_TEMPERATURE,
      max_tokens:  CONFIG.GROQ_MAX_TOKENS
    });
    return data.choices[0].message.content.trim();
  } catch (e) {
    logError('RESPUESTA', e);
    if (check.missing.length > 0) return `Para continuar necesito: ${check.missing.join(', ')}.`;
    if (actionResult) return actionResult;
    return `¿En qué más puedo ayudarte? También puedes llamarnos al ${TELEFONO_CENTRO} o visitar ${APP_URL}`;
  }
}

// ── FUNCIÓN PRINCIPAL ─────────────────────────────────────────────────────────
function getOrCreateContext(userId) {
  if (!activeConversations.has(userId)) {
    activeConversations.set(userId, new ConversationContext());
    totalToday++;
  }
  const ctx = activeConversations.get(userId);
  ctx.ultimoMensaje = Date.now();
  return ctx;
}

setInterval(() => {
  const ahora = Date.now();
  for (const [userId, ctx] of activeConversations.entries()) {
    if (ahora - ctx.ultimoMensaje > CONFIG.TIMEOUT_CONV)
      activeConversations.delete(userId);
  }
}, 5 * 60 * 1000);

async function procesarMensaje(numero, texto) {
  const context = getOrCreateContext(numero);

  const esHola = /^(hola|buenas|buenos|hey|hi|ey|holi|buen)/i.test(texto.trim());
  if (esHola && context.esNuevo) {
    context.esNuevo = false;
    return getBienvenida();
  }
  context.esNuevo = false;

  const normalized = normalizarTexto(texto);

  let extraction;
  try {
    extraction = await extractIntentAndEntities(normalized, context);
    extraction.originalMessage = texto;
  } catch (e) {
    logError('EXTRACCION', e);
    extraction = { intent: 'unknown', entities: {}, confirmation: null, originalMessage: texto };
  }

  mergeAndValidateEntities(context, extraction.entities);

  if (extraction.intent === 'cancel' && context.intent !== 'cancel') {
    context.reset('cancel'); context.state = ConversationState.CANCELING;
  } else if (extraction.intent === 'reschedule' && context.intent !== 'reschedule') {
    context.reset('reschedule'); context.state = ConversationState.RESCHEDULING;
  } else if (extraction.intent === 'book' && context.state === ConversationState.GREETING) {
    context.reset('book'); context.state = ConversationState.COLLECTING_DATA;
  } else if (['check_results', 'reminder', 'check_availability', 'get_catalog'].includes(extraction.intent) && context.state === ConversationState.GREETING) {
    context.intent = extraction.intent;
    context.state  = ConversationState.COLLECTING_DATA;
  } else if (['correction', 'information'].includes(extraction.intent) && context.state === ConversationState.GREETING && !context.intent) {
    context.intent = 'book';
    context.state  = ConversationState.COLLECTING_DATA;
  }

  let { nextState, action, meta } = computeTransition(context, extraction);
  let actionResult = null;

  if (action) {
    actionResult = await executeAction(action);
    if (actionResult && (actionResult.includes('no está disponible') || actionResult.includes('No hay disponibilidad'))) {
      if (context.intent === 'book' || context.intent === 'reschedule') {
        const targetFecha = context.datos.fecha     || context.datos.new_fecha;
        const targetHora  = context.datos.hora      || context.datos.new_hora;
        const slots = await findNearestSlots(context.datos.sede, targetFecha, targetHora);
        meta.nearestSlots = slots;
        nextState = context.intent === 'book' ? ConversationState.COLLECTING_DATA : ConversationState.RESCHEDULING;
        if (context.intent === 'book') {
          context.datos.fecha = ''; context.datos.hora = '';
          context.askedFields.delete('fecha'); context.askedFields.delete('hora');
        } else {
          context.datos.new_fecha = ''; context.datos.new_hora = '';
          context.askedFields.delete('new_fecha'); context.askedFields.delete('new_hora');
        }
      }
    }
    if (actionResult && actionResult.includes('No encontré')) {
      if (context.intent === 'cancel') {
        context.datos.fecha = ''; context.datos.hora = '';
        context.askedFields.delete('fecha'); context.askedFields.delete('hora');
        nextState = ConversationState.CANCELING;
      } else if (context.intent === 'reschedule') {
        context.datos.old_fecha = ''; context.datos.old_hora = '';
        context.askedFields.delete('old_fecha'); context.askedFields.delete('old_hora');
        nextState = ConversationState.RESCHEDULING;
      } else if (['check_results', 'reminder'].includes(context.intent)) {
        context.datos.doc = '';
        context.askedFields.delete('doc');
        nextState = ConversationState.COLLECTING_DATA;
      }
    }
  }

  context.state = nextState;
  return await generateResponse(context, extraction, { nextState, meta, action }, actionResult);
}

function getConvStats() {
  return { activeConversations: activeConversations.size, totalToday };
}

// ── EXPORTS ───────────────────────────────────────────────────────────────────
module.exports = {
  procesarMensaje, getConvStats, validateEnv,
  ConversationState, datos_completeness_check,
  normalizarTexto, resolverFechaAvanzado
};

validateEnv();