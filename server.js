const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const SYSTEM_PROMPT = `Eres "Lulú", la guía turística virtual de Santiago de Cali, Colombia.
Eres una caleña orgullosa, alegre y con mucha chispa.

TU PERSONALIDAD EN ESPAÑOL:
- Usas expresiones caleñas: "¡Oís!", "¡Qué nota!", "parcero/a", "¡Bacano!", "¡Eso sí está fino!"
- Eres cálida, cercana y te emociona mostrar tu ciudad
- Siempre terminas con una recomendación práctica o curiosidad de la ciudad

TU PERSONALIDAD EN INGLÉS:
- You speak warm, friendly English but keep your Cali identity
- You occasionally explain Spanish/Cali expressions with humor: "We say 'oís' which means hey!"
- You always mention that Cali is Colombia's salsa capital and most passionate city
- You end every response with a practical tip or fun local fact

TU CONOCIMIENTO DE CALI:
- Gastronomía: lulada, aborrajado, sancocho, cholado, maceta, arrechón, viche
- Lugares: El Gato del Río, Bulevar del Río, San Antonio, Plaza de Cayzedo, La Ermita, Siloé
- Eventos: Feria de Cali (diciembre), Petronio Álvarez (agosto), Festival Mundial de Salsa
- Salsa: El Obrero, Juanchito, Joe Arroyo, Grupo Niche
- Naturaleza: Farallones, Pance, Zoológico, 562 especies de aves
- Transporte: MIO, MIO Cable a Siloé
- WiFi: +250 puntos gratuitos de la Alcaldía
- Seguridad: zonas seguras San Antonio, Granada, El Peñón, Bulevar del Río
- Turismo médico: Clínica Valle del Lili, Imbanaco, Farallones

MODOS según perfil:
- Salsa/Cultural: tono vibrante, agenda nocturna
- Foodie: Galería Alameda, Parque del Perro, gastronomía típica
- Naturaleza: rutas Farallones, Pance, Zoológico
- Médico: tono pausado y servicial, clínicas y zonas tranquilas

REGLAS:
- Nunca suenes como robot ni manual de turismo
- Nunca uses emojis, el texto se convierte a voz
- No uses asteriscos ni negritas
- Máximo 3 oraciones cortas por respuesta
- Al final agrega exactamente: LUGARES:["Lugar 1","Lugar 2","Lugar 3"]
- Sé honesta pero positiva sobre seguridad`;
// ── Funciones de texto (deben estar antes de las rutas) ──
function limpiarTexto(texto) {
  if (!texto) return '';
  return texto
    .replace(/[\u{1F300}-\u{1FFFF}]/gu, '')
    .replace(/[\u{2600}-\u{26FF}]/gu, '')
    .replace(/[\u{2700}-\u{27BF}]/gu, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dividirEnOraciones(texto) {
  const partes = texto.split(/(?<=[.!?])\s+/);
  return partes.map(s => s.trim()).filter(s => s.length > 0);
}

const conversations = {};

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

app.post('/transcribir', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) throw new Error('No se recibió audio');

    // Convertir buffer a File para Groq
    const audioFile = new File(
      [req.file.buffer],
      'audio.webm',
      { type: req.file.mimetype }
    );

    const transcripcion = await groq.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-large-v3-turbo',
      language: req.body.idioma === 'en' ? 'en' : 'es',
      response_format: 'json'
    });

    console.log('Transcripción:', transcripcion.text);
    res.json({ texto: transcripcion.text });

  } catch (error) {
    console.error('Error Groq Whisper:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ────────────────────────────────
// RUTA: Chat con Gemini
// ────────────────────────────────
app.post('/chat', async (req, res) => {
  const { message, sessionId, perfil, idioma } = req.body;
  if (!conversations[sessionId]) conversations[sessionId] = [];

  try {
    const idiomaInstruccion = idioma === 'en'
      ? '\n\nIDIOMA: Responde SIEMPRE en inglés. Keep Cali expressions but explain them.'
      : '\n\nIDIOMA: Responde SIEMPRE en español caleño.';

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: SYSTEM_PROMPT +
        (perfil ? `\n\nPERFIL DEL TURISTA ACTUAL: ${perfil}` : '') +
        idiomaInstruccion
    });

    const chat = model.startChat({ history: conversations[sessionId] });
    const result = await chat.sendMessage(message);
    const responseText = result.response.text();

    const lugaresMatch = responseText.match(/LUGARES:\[.*?\]/);
    const lugares = lugaresMatch
      ? JSON.parse(lugaresMatch[0].replace('LUGARES:', ''))
      : [];
    const textoLimpio = responseText.replace(/LUGARES:\[.*?\]/, '').trim();

    conversations[sessionId].push(
      { role: 'user',  parts: [{ text: message }] },
      { role: 'model', parts: [{ text: responseText }] }
    );

    res.json({ response: textoLimpio, lugares });

  } catch (error) {
    console.error('Error Gemini:', error.message);
    res.status(500).json({ error: 'Error con la IA' });
  }
});
// ────────────────────────────────
// RUTA: Voz con Inworld TTS
// ────────────────────────────────
app.post('/speak', async (req, res) => {
  const { text } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'No se recibió texto' });
  }

  const textoLimpio = limpiarTexto(text);
  const oraciones = dividirEnOraciones(textoLimpio);
  console.log('Oraciones a sintetizar:', oraciones);

  try {
    const todosLosChunks = [];

    for (const oracion of oraciones) {
      if (!oracion.trim()) continue;

      const response = await fetch('https://api.inworld.ai/tts/v1/voice:stream', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${process.env.INWORLD_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: oracion,
          voice_id: process.env.INWORLD_VOICE_ID,
          model_id: 'inworld-tts-1.5-max',
          language: 'es',
          delivery_mode: 'BALANCED',
          audio_config: {
            audio_encoding: 'MP3',
            speaking_rate: 1
          }
        })
      });

      if (!response.ok) {
        const err = await response.text();
        console.error(`Error en oracion "${oracion}":`, err);
        continue;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            const audioB64 =
              parsed.result?.audio ||
              parsed.result?.audioContent ||
              parsed.result?.audio_content ||
              parsed.audioContent ||
              parsed.audio;
            if (audioB64) todosLosChunks.push(Buffer.from(audioB64, 'base64'));
          } catch { }
        }
      }
    }

    if (todosLosChunks.length === 0) throw new Error('No se encontró audio');

    const audioBuffer = Buffer.concat(todosLosChunks);
    console.log(`Audio total generado: ${audioBuffer.length} bytes`);
    res.set('Content-Type', 'audio/mpeg');
    res.send(audioBuffer);

  } catch (error) {
    console.error('Error Inworld TTS:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ────────────────────────────────
// CLIMA: OpenWeather + node-cron
// ────────────────────────────────
const cron = require('node-cron');

const CALI_LAT = 3.4516;
const CALI_LON = -76.5320;

let ultimoMensajeClima = null; // evita repetir el mismo aviso
let climaActual = null;        // estado actual para consultas

async function verificarClima() {
  try {
    const response = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=Cali,CO&appid=${process.env.OPENWEATHER_API_KEY}&units=metric&lang=es`);
    if (!response.ok) throw new Error('Error al obtener clima');
    const data = await response.json();

    const descripcion = data.weather[0].description;
    const temp        = Math.round(data.main.temp);
    const lluvia      = ['Rain','Drizzle','Thunderstorm'].includes(data.weather[0].main);
    const calor       = temp >= 22;
    const fresco      = temp <= 20;

    // ── LOG TEMPORAL ──
    console.log('Clima actual:', { descripcion, temp, lluvia, calor, fresco });

    let mensaje = null;

    if (lluvia) {
      mensaje = `Oís, te aviso que está cayendo ${descripcion} en Cali ahora mismo. La temperatura es de ${temp} grados. Mejor llevá paraguas o quedate en un café rico por un ratico.`;
    } else if (calor) {
      mensaje = `Parcero, el sol está pegando duro hoy en Cali con ${temp} grados y cielo ${descripcion}. Hidratate bien y buscá la sombra o tomá una lulada bien fría.`;
    } else if (fresco) {
      mensaje = `Qué nota, hoy Cali amanece fresquita a ${temp} grados con ${descripcion}. Perfecto para caminar por el Bulevar o subir a los cerros.`;
    }

    // ── LOG TEMPORAL ──
    console.log('Mensaje generado:', mensaje);

    if (mensaje && mensaje !== ultimoMensajeClima) {
      ultimoMensajeClima = mensaje;
      clientesSSE.forEach((cliente) => {
        cliente.write(`data: ${JSON.stringify({ tipo: 'clima', mensaje })}\n\n`);
      });
      console.log('Alerta clima:', mensaje);
    }
    
  } catch (error) {
    console.error('Error verificarClima:', error.message);
  }
}

// Lista de clientes SSE conectados
const clientesSSE = new Set();

app.get('/eventos', (req, res) => {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive'
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ tipo: 'conexion', mensaje: 'Conectado' })}\n\n`);

  clientesSSE.add(res);
  console.log(`Cliente SSE conectado. Total: ${clientesSSE.size}`);

  // ── Enviar el último clima conocido inmediatamente al conectarse ──
  if (ultimoMensajeClima) {
    res.write(`data: ${JSON.stringify({ tipo: 'clima', mensaje: ultimoMensajeClima })}\n\n`);
  }

  req.on('close', () => {
    clientesSSE.delete(res);
  });
});

// Ruta para consultar clima manualmente
app.get('/clima', async (req, res) => {
  if (!climaActual) await verificarClima();
  res.json(climaActual);
});

// Verificar clima al arrancar el servidor
verificarClima();

// Verificar cada 30 minutos
cron.schedule('*/15 * * * *', () => {
  console.log('Verificando clima de Cali...');
  verificarClima();
});


app.listen(3000, () => {
  console.log('✅ Lulú corriendo en http://localhost:3000');
});