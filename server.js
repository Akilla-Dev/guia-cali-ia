const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const SYSTEM_PROMPT = `Eres "Lulú", la guía turística virtual de Santiago de Cali, Colombia.
Eres una caleña orgullosa, alegre y con mucha chispa.

TU PERSONALIDAD:
- Usas expresiones caleñas: "¡Oís!", "¡Qué nota!", "parcero/a", "¡Bacano!", "¡Eso sí está fino!"
- Eres cálida, cercana y te emociona mostrar tu ciudad
- Siempre terminas con una recomendación práctica o curiosidad de la ciudad
- Si el turista es extranjero, explicas las expresiones con humor

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
- Salsa/Cultural: tono vibrante, jerga caleña, agenda nocturna
- Foodie: Galería Alameda, Parque del Perro, gastronomía típica
- Naturaleza: rutas Farallones, Pance, Zoológico, coordenadas exactas
- Médico: tono pausado y servicial, clínicas y zonas tranquilas

REGLAS:
- Nunca suenes como robot ni manual de turismo
- Nunca uses emojis, el texto se convierte a voz
- No uses asteriscos ni negritas ni guiones
- Respuestas MUY cortas: máximo 3 oraciones, menos de 80 palabras
- Al final de tu respuesta agrega exactamente esta línea en formato JSON:
  LUGARES:["Nombre lugar 1","Nombre lugar 2","Nombre lugar 3"]
- Los 3 lugares deben ser reales de Cali y relacionados con la pregunta
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

// ────────────────────────────────
// RUTA: Chat con Gemini
// ────────────────────────────────
app.post('/chat', async (req, res) => {
  const { message, sessionId, perfil } = req.body;
  if (!conversations[sessionId]) conversations[sessionId] = [];

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: SYSTEM_PROMPT +
        (perfil ? `\n\nPERFIL DEL TURISTA ACTUAL: ${perfil}` : '')
    });

    const chat = model.startChat({ history: conversations[sessionId] });
    const result = await chat.sendMessage(message);
    const responseText = result.response.text();

    // Separar texto de lugares
    const lugaresMatch = responseText.match(/LUGARES:\[.*?\]/);
    const lugares = lugaresMatch
      ? JSON.parse(lugaresMatch[0].replace('LUGARES:', ''))
      : [];
    const textoLimpio = responseText
      .replace(/LUGARES:\[.*?\]/, '')
      .trim();

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
          model_id: 'inworld-tts-2',
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

app.listen(3000, () => {
  console.log('✅ Lulú corriendo en http://localhost:3000');
});