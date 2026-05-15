const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ── Clientes ──
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
- Máximo 3 párrafos cortos por respuesta
- Sé honesta pero positiva sobre seguridad`;

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
      systemInstruction: SYSTEM_PROMPT 
        (perfil ? `\n\nPERFIL DEL TURISTA ACTUAL: ${perfil}` : '')
    });

    const chat = model.startChat({ history: conversations[sessionId] });
    const result = await chat.sendMessage(message);
    const responseText = result.response.text();

    conversations[sessionId].push(
      { role: 'user',  parts: [{ text: message }] },
      { role: 'model', parts: [{ text: responseText }] }
    );

    res.json({ response: responseText });

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

  try {
    const response = await fetch('https://api.inworld.ai/tts/v1/voice:stream', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${process.env.INWORLD_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: text,
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
      throw new Error(`Inworld error ${response.status}: ${err}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const audioChunks = [];
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
          console.log('Keys en result:', Object.keys(parsed.result || parsed));
          const audioB64 =
            parsed.result?.audio ||
            parsed.result?.audioContent ||
            parsed.result?.audio_content ||
            parsed.audioContent ||
            parsed.audio;
          if (audioB64) {
            audioChunks.push(Buffer.from(audioB64, 'base64'));
          }
        } catch { }
      }
    }

    if (audioChunks.length === 0) {
      throw new Error('No se encontró audio');
    }

    const audioBuffer = Buffer.concat(audioChunks);
    console.log(`✅ Audio generado: ${audioBuffer.length} bytes`);
    res.set('Content-Type', 'audio/mpeg');
    res.send(audioBuffer);

  } catch (error) {
    console.error('Error Inworld TTS:', error.message);
    res.status(500).json({ error: error.message });
  }
});
app.listen(3000, () => {
  console.log(`✅ Lulú corriendo en http://localhost:3000`);
});

app.post('/speak', async (req, res) => {
  const { text } = req.body;

  try {
    const response = await fetch('https://api.inworld.ai/tts/v1/voice:stream', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${process.env.INWORLD_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        voiceId: process.env.INWORLD_VOICE_ID,
        modelId: 'inworld-tts-2',
        text: limpiarTexto(text),
        audioConfig: {
          audioEncoding: 'MP3',
          sampleRateHertz: 24000
        }
      })
    });

    console.log('Status Inworld:', response.status);
    
    const rawText = await response.text();
    console.log('Respuesta cruda (primeros 300 chars):', rawText.substring(0, 300));

    // Por ahora solo devolvemos para ver qué llega
    res.json({ debug: rawText.substring(0, 500) });

  } catch (error) {
    console.error('Error Inworld TTS:', error.message);
    res.status(500).json({ error: 'Error generando voz' });
  }
});

function limpiarTexto(texto) {
  return texto
    .replace(/[\u{1F300}-\u{1FFFF}]/gu, '') // elimina emojis
    .replace(/\s+/g, ' ')                    // espacios dobles
    .trim();
}