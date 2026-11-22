import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));

const PORT = process.env.PORT || 3000;
const MANUS_API_KEY = process.env.MANUS_API_KEY || '';
const MANUS_API_URL = process.env.MANUS_API_URL || 'https://api.manus.ai/v2/tasks';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-4-hydrogen';

async function callManus(prompt, mode) {
  if (!MANUS_API_KEY) throw new Error('Manus key not configured');

  const res = await fetch(MANUS_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${MANUS_API_KEY}`
    },
    body: JSON.stringify({ prompt, mode, assistant_name: 'Blue' })
  });

  if (!res.ok) throw new Error(`Manus status ${res.status}`);
  const data = await res.json();

  if (data.output) return data.output;

  const taskId = data.task_id || data.id;
  if (!taskId) throw new Error('No task ID from Manus');

  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const pollRes = await fetch(`${MANUS_API_URL}/${taskId}`, {
      headers: { 'Authorization': `Bearer ${MANUS_API_KEY}` }
    });
    if (!pollRes.ok) throw new Error(`Manus poll status ${pollRes.status}`);
    const pollData = await pollRes.json();
    if (pollData.status === 'completed' || pollData.output) {
      return pollData.output || JSON.stringify(pollData.result, null, 2);
    }
    if (pollData.status === 'failed') {
      throw new Error(pollData.error || 'Manus task failed');
    }
  }

  throw new Error('Manus task timed out');
}

async function callGemini(prompt, imageDataUrl, imageMimeType) {
  if (!GEMINI_API_KEY) throw new Error('Gemini key not configured');

  const parts = [{ text: prompt }];
  if (imageDataUrl && imageMimeType && imageDataUrl.includes(',')) {
    parts.push({
      inline_data: {
        mime_type: imageMimeType,
        data: imageDataUrl.split(',')[1]
      }
    });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }] })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Gemini status ${res.status}`);

  return data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('\n').trim() || 'No reply';
}

app.post('/api/chat', async (req, res) => {
  const { prompt, mode = 'auto', imageDataUrl = null, imageMimeType = null } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Prompt is required.' });
  }

  try {
    const reply = await callManus(prompt, mode);
    return res.json({ reply, provider: 'manus' });
  } catch (manusErr) {
    try {
      const reply = await callGemini(prompt, imageDataUrl, imageMimeType);
      return res.json({ reply, provider: 'gemini-fallback' });
    } catch (gemErr) {
      return res.status(502).json({
        error: `AI services unavailable: ${manusErr.message} | ${gemErr.message}`
      });
    }
  }
});

app.listen(PORT, () => console.log(`Blue proxy running on port ${PORT}`));
