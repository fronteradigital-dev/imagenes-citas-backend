'use strict';

// ── RECORDATORIO NOCTURNO ─────────────────────────────────────────────────────
// Corre cada noche a las 8pm y manda WhatsApp a todos los pacientes
// con cita al día siguiente

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WA_SERVER = `http://${process.env.SERVER_IP}:${process.env.SERVER_PORT}`;
const NOMBRE_CENTRO = process.env.NOMBRE_CENTRO;
const TELEFONO_CENTRO = process.env.TELEFONO_CENTRO;

const SEDES_DIR = {
  'Sandiego':  'C.C. Sandiego, Bloque Norte, Of. 231',
  'El Tesoro': 'C.C. El Tesoro, Torre Medica 2, Of. 1266',
  'Bello':     'C.C. Metro Bello, Of. 307',
  'Rionegro':  'C.C. Savanna Plaza, Of. 504'
};

// Obtener fecha de mañana en formato YYYY-MM-DD
function manana() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

// Formatear fecha legible
function fmt(f) {
  if (!f) return '';
  const meses = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const [y, m, d] = f.split('-');
  return `${d} ${meses[parseInt(m)-1]} ${y}`;
}

// Consultar citas de mañana en Supabase
async function getCitasManana() {
  const fecha = manana();
  const url = `${SUPABASE_URL}/rest/v1/citas?fecha=eq.${fecha}&estado=eq.pendiente&select=*`;
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });
  if (!res.ok) throw new Error(`Supabase error: ${res.status}`);
  return await res.json();
}

// Enviar recordatorio via servidor WA
async function enviarRecordatorio(cita) {
  const mensaje = `🔔 *Recordatorio de Cita - ${NOMBRE_CENTRO}*\n\nHola *${cita.nombre} ${cita.apellido}*, te recordamos tu cita de mañana:\n\n• 🏥 Sede: ${cita.sede}\n• 📍 ${SEDES_DIR[cita.sede] || ''}\n• 🔬 Estudio: ${cita.servicio}\n• 📅 Fecha: ${fmt(cita.fecha)}\n• ⏰ Hora: ${cita.hora}\n\n_Por favor llega 10 minutos antes._\n📞 ${TELEFONO_CENTRO}`;

  const res = await fetch(`${WA_SERVER}/enviar/recordatorio`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cita: {
        id: cita.id,
        nombre: cita.nombre,
        apellido: cita.apellido,
        tel: cita.tel,
        sede: cita.sede,
        servicio: cita.servicio,
        fechaFmt: fmt(cita.fecha),
        hora: cita.hora
      }
    })
  });

  const data = await res.json();
  return data.ok;
}

// Función principal
async function enviarRecordatorios() {
  console.log(`\n[${new Date().toLocaleString()}] Iniciando recordatorios nocturnos...`);
  console.log(`Buscando citas para mañana: ${manana()}`);

  try {
    const citas = await getCitasManana();
    console.log(`Citas encontradas: ${citas.length}`);

    if (citas.length === 0) {
      console.log('No hay citas para mañana.');
      return;
    }

    let enviados = 0;
    let errores = 0;

    for (const cita of citas) {
      try {
        const ok = await enviarRecordatorio(cita);
        if (ok) {
          enviados++;
          console.log(`✅ Recordatorio enviado a ${cita.nombre} ${cita.apellido} — ${cita.sede} ${cita.hora}`);
        } else {
          errores++;
          console.log(`❌ Error enviando a ${cita.nombre} ${cita.apellido}`);
        }
        // Esperar 2 segundos entre mensajes para no saturar
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        errores++;
        console.error(`Error con ${cita.nombre}:`, e.message);
      }
    }

    console.log(`\nResumen: ${enviados} enviados, ${errores} errores`);

  } catch (e) {
    console.error('Error general:', e.message);
  }
}

// Ejecutar inmediatamente si se llama directo
if (require.main === module) {
  enviarRecordatorios();
}

module.exports = { enviarRecordatorios };
