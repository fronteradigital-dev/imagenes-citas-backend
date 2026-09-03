# Backend IMAX en Render — Pasos

Esto despliega `server.js` (el que expone `/ping`, `/estado`, `/enviar/*`)
como un Web Service en Render. Importante: **sin WAHA corriendo aparte,
los endpoints `/enviar/*` van a seguir sin poder mandar WhatsApp** — el
servidor arranca y responde bien igual, simplemente esa parte específica
falla al llamarla, exactamente como está ahora. Es útil para tener el
backend ya migrado y listo, sin depender del bot de WhatsApp para que
funcione.

## 1. Sube esto a TU repositorio de GitHub

Puede ser el mismo repo del frontend (en una subcarpeta `/server`) o uno
aparte — lo que te sea más cómodo de mantener. Ejemplo con uno aparte:

```bash
cd deploy-backend
git init
git add .
git commit -m "Backend IMAX - migración"
git remote add origin https://github.com/TU_USUARIO/imax-backend.git
git branch -M main
git push -u origin main
```

## 2. Crea el Web Service en Render

1. En Render: **New +** → **Web Service**.
2. Conecta el repo `imax-backend`.
3. Configuración:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free (para esta fase de demo/transición)

## 3. Variables de entorno (Environment)

En **Environment → Add Environment Variable**, agrega estas (NO subas
`.env` al repo, ya está en `.gitignore`):

| Variable | Valor |
|---|---|
| `SERVER_PORT` | `3001` (Render igual expone su propio puerto público) |
| `NOMBRE_CENTRO` | `Imagenes y Especialistas` |
| `TELEFONO_CENTRO` | `604 322 2753` |
| `APP_URL` | la URL del frontend en Render (paso anterior) |
| `SUPABASE_URL` | tu URL de Supabase |
| `SUPABASE_SERVICE_KEY` | **nueva** service key (rotada, ver abajo) |
| `API_SECRET` | **nueva** clave generada (ver abajo) |
| `GROQ_API_KEY` / `FIREWORKS_API_KEY` | según cuál uses (ver nota) |
| `WAHA_URL` | déjalo vacío o apunta a algo por ahora — fallará limpio hasta que montes WAHA en fase 2 |
| `WAHA_API_KEY` | igual, pendiente para fase 2 |

### Genera un API_SECRET nuevo

No reutilices el que traía el `.env` original — ese circuló por fuera de
tu control. Corre esto en tu computador y pega el resultado:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Sobre Groq vs. Fireworks

El código de `agente.js` en realidad llama a Fireworks AI
(`FIREWORKS_API_KEY`, `CONFIG.FIREWORKS_URL`), no a Groq, aunque el
`.env` original traía ambas keys. Usa la key de Fireworks si vas a
reactivar el agente conversacional más adelante; por ahora, si el bot no
está en uso, puedes omitir esa variable sin que el servidor deje de
levantar (solo fallaría si alguien intenta usar el chat).

### Rota TODAS las claves del `.env` original

Ese archivo venía dentro del zip que te pasó el desarrollador anterior,
así que cualquiera con esos archivos tiene las claves reales de
Supabase, Groq/Fireworks y OpenRouter. Antes de dar por cerrada la
migración: genera credenciales nuevas en cada uno de esos servicios y
usa solo las nuevas aquí.

## 4. Verifica que levantó bien

Una vez desplegado, entra a `https://tu-backend.onrender.com/ping` — 
deberías ver un JSON con el estado de las 4 sedes (van a salir como
`ERROR` o `UNKNOWN` porque no hay WAHA conectado todavía, y eso es
esperado en esta fase).

## Nota sobre el plan gratis de Render

El plan Free se "duerme" tras 15 minutos sin tráfico y tarda ~1 minuto en
despertar con la siguiente solicitud. Para una demo está perfecto; si
esto pasa a ser el backend definitivo en producción, conviene subir al
plan pagado más económico para que no se duerma.
