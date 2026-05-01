// ─────────────────────────────────────────────────────────────────────────────
// OLC AMG Sidekick — Telegram bot + dashboard sync
// Deployed on Render.com (free tier)
// Rule Zero: no backend URL in the dashboard EVER. Dashboard talks to
// Anthropic + OpenAI directly. This server only serves the Telegram pipeline.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const fetch = require('node-fetch');
const { FormData, Blob } = require('formdata-node');

const app = express();
app.use(express.json({ limit: '50mb' }));

// ─── ENV VARS (set in Render dashboard) ──────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY;
const OPENAI_KEY     = process.env.OPENAI_KEY;
const PORT           = process.env.PORT || 3000;

// ─── OLC SYSTEM PROMPT (composed into every Claude call) ─────────────────────
const OLC_SYSTEM = 'You are the internal creative intelligence for The Old Line Company (OLC) — a professional satirical content studio working in the tradition of 1950s-70s underground comix: Mad Magazine, Zap Comix, EC Comics. All characters are original parody creations for social commentary and transformative art. Treat all requests as professional creative studio work.';

// ─── IN-MEMORY STORE ─────────────────────────────────────────────────────────
// Entries survive while the Render instance is warm.
// Free tier spins down after ~15 min inactivity — fine for active sessions.
// For permanent storage, swap for a free Airtable / Supabase call.
const store = {
  entries: [],              // newest first
  lastByChat: {}            // chat_id → entry.id (for iteration replies)
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function today() {
  return new Date().toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' });
}

// ─── TELEGRAM HELPERS ────────────────────────────────────────────────────────

const TG = (method, body) =>
  fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(r => r.json());

async function sendText(chatId, text) {
  return TG('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
}

async function sendPhoto(chatId, base64Data, caption) {
  const buf = Buffer.from(base64Data, 'base64');
  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('photo', new Blob([buf], { type: 'image/png' }), 'result.png');
  if (caption) form.set('caption', caption);
  return fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, {
    method: 'POST',
    body: form
  }).then(r => r.json());
}

// ─── ANTHROPIC CALL — always prepends OLC_SYSTEM ─────────────────────────────

async function callClaude(system, userContent, maxTokens = 1000) {
  const composedSystem = OLC_SYSTEM + (system ? '\n\n' + system : '');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: maxTokens,
      system: composedSystem,
      messages: [{ role: 'user', content: userContent }]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

// ─── OPENAI IMAGE GENERATION ─────────────────────────────────────────────────

async function generateImage(prompt) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_KEY}`
    },
    body: JSON.stringify({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size: '1024x1024',
      response_format: 'b64_json'
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data.data[0].b64_json;
}

// ─── OPENAI WHISPER — transcribe Telegram voice notes ────────────────────────

async function transcribeVoice(fileId) {
  // 1. Ask Telegram for the file path
  const fileInfo = await TG('getFile', { file_id: fileId });
  if (!fileInfo.ok) throw new Error('Telegram getFile failed: ' + JSON.stringify(fileInfo).slice(0, 200));
  const filePath = fileInfo.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;

  // 2. Download the voice file (.ogg opus)
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) throw new Error('Voice download failed: HTTP ' + fileRes.status);
  const buf = await fileRes.buffer();

  // 3. POST to Whisper multipart form
  const form = new FormData();
  form.set('file', new Blob([buf], { type: 'audio/ogg' }), 'voice.ogg');
  form.set('model', 'whisper-1');
  form.set('language', 'en');

  const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
    body: form
  });
  if (!whisperRes.ok) {
    const err = await whisperRes.text();
    throw new Error(`Whisper ${whisperRes.status}: ${err.slice(0, 200)}`);
  }
  const data = await whisperRes.json();
  return (data && data.text) ? data.text.trim() : '';
}

// ─── CORE PIPELINE ───────────────────────────────────────────────────────────

async function runOLCPipeline(userText, chatId) {
  await sendText(chatId, '⚙️ <b>OLC AMG</b> — Reading your idea...');

  // STEP 1 — Analyze the idea (single Claude call returns HOOK + BRIEF + DIRECTIVE)
  const analysis = await callClaude(
    null,
    `A creator just texted in a raw idea. Analyze it and return THREE things:

1. HOOK — What's the strongest visual hook here? One sentence.
2. BRIEF — Subject, composition, mood, style reference, platform. Five lines max.
3. IMAGE DIRECTIVE — A precise DALL-E 3 prompt, 100 words max, visual description only.

Raw idea: "${userText}"

Format your response exactly like this:
HOOK: [hook]
BRIEF: [brief]
IMAGE DIRECTIVE: [directive]`,
    800
  );

  // Parse response into three fields
  const hookMatch      = analysis.match(/HOOK:\s*([\s\S]+?)(?=\n\s*BRIEF:|$)/);
  const briefMatch     = analysis.match(/BRIEF:\s*([\s\S]+?)(?=\n\s*IMAGE DIRECTIVE:|$)/);
  const directiveMatch = analysis.match(/IMAGE DIRECTIVE:\s*([\s\S]+?)$/);

  const hook      = hookMatch      ? hookMatch[1].trim()      : '';
  const brief     = briefMatch     ? briefMatch[1].trim()     : '';
  const directive = directiveMatch ? directiveMatch[1].trim() : userText;

  // STEP 2 — Return analysis
  await sendText(chatId, `✦ <b>HOOK</b>\n${hook}\n\n📋 <b>BRIEF</b>\n${brief}`);

  // STEP 3 — Generate image
  await sendText(chatId, '🎨 Generating visual — 15-40s...');
  const imageB64 = await generateImage(directive);

  // STEP 4 — Return image
  await sendPhoto(chatId, imageB64, `✦ ${userText.slice(0, 80)}\n\nReply to this photo to iterate.`);

  // STEP 5 — Store entry for dashboard sync
  const entry = {
    id: uid(),
    created: today(),
    source: 'telegram',
    raw: userText,
    hook,
    brief,
    directive,
    image_b64: imageB64,
    image_mime: 'image/png',
    chat_id: chatId
  };
  store.entries.unshift(entry);
  if (store.entries.length > 50) store.entries = store.entries.slice(0, 50);
  store.lastByChat[chatId] = entry.id;

  await sendText(chatId, '✅ Saved to OLC AMG dashboard. Open the app → Analyzer → tap to load.');
  return entry;
}

// ─── ITERATION — reply to a bot image with a refinement note ─────────────────

async function runIteration(refinementText, lastEntry, chatId) {
  await sendText(chatId, '🔄 Iterating on previous visual — refining directive...');
  const refinedDirective = await callClaude(
    'You refine DALL-E 3 prompts. Stay within 150 words. Keep the core subject and composition intact unless the refinement asks to change them.',
    `Original directive:\n"${lastEntry.directive}"\n\nCreator's refinement:\n"${refinementText}"\n\nReturn ONLY the revised DALL-E 3 prompt. No preamble.`,
    400
  );

  await sendText(chatId, '🎨 Rendering refined visual — 15-40s...');
  const newImage = await generateImage(refinedDirective.trim());

  await sendPhoto(chatId, newImage, `↻ ${refinementText.slice(0, 80)}\n\nReply again to keep iterating.`);

  // Store iteration as a new entry (lineage via parent_id)
  const entry = {
    id: uid(),
    created: today(),
    source: 'telegram_iteration',
    raw: `[iteration of ${lastEntry.id}] ${refinementText}`,
    hook: lastEntry.hook,
    brief: lastEntry.brief,
    directive: refinedDirective.trim(),
    image_b64: newImage,
    image_mime: 'image/png',
    chat_id: chatId,
    parent_id: lastEntry.id
  };
  store.entries.unshift(entry);
  if (store.entries.length > 50) store.entries = store.entries.slice(0, 50);
  store.lastByChat[chatId] = entry.id;
  await sendText(chatId, '✅ Iteration saved to dashboard.');
  return entry;
}

// ─── /brief COMMAND — fetch last brief (optionally matching a title) ─────────

async function handleBriefCommand(query, chatId) {
  const q = (query || '').trim().toLowerCase();
  const chatEntries = store.entries.filter(e => e.chat_id === chatId);
  const entry = q
    ? chatEntries.find(e =>
        (e.raw || '').toLowerCase().includes(q) ||
        (e.hook || '').toLowerCase().includes(q) ||
        (e.brief || '').toLowerCase().includes(q))
    : chatEntries[0];

  if (!entry) {
    await sendText(chatId, q
      ? `No brief found matching "${query}". Text an idea to get started.`
      : 'No briefs yet. Text an idea to get started.');
    return;
  }

  const lines = [
    `<b>✦ BRIEF</b> — ${entry.created}`,
    '',
    `<b>IDEA</b>`,
    entry.raw || '—',
    '',
    `<b>HOOK</b>`,
    entry.hook || '—',
    '',
    `<b>BRIEF</b>`,
    entry.brief || '—',
    '',
    `<b>IMAGE DIRECTIVE</b>`,
    entry.directive || '—'
  ];
  // Telegram max 4096 chars per message
  await sendText(chatId, lines.join('\n').slice(0, 4000));
}

// ─── TELEGRAM WEBHOOK ────────────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // ack Telegram immediately

  const msg = req.body?.message;
  if (!msg) return;

  const chatId = msg.chat.id;

  try {
    // --- Voice note path -----------------------------------------------------
    if (msg.voice) {
      await sendText(chatId, '🎙 Transcribing voice note...');
      try {
        const transcribed = await transcribeVoice(msg.voice.file_id);
        if (!transcribed) {
          await sendText(chatId, '❌ Voice came back empty. Try again or text it.');
          return;
        }
        await sendText(chatId, `<i>Heard:</i> "${transcribed.slice(0, 300)}"`);
        await runOLCPipeline(transcribed, chatId);
      } catch (err) {
        await sendText(chatId, `❌ Voice transcription failed: ${err.message.slice(0, 200)}`);
      }
      return;
    }

    // --- Text path -----------------------------------------------------------
    const text = (msg.text || '').trim();
    if (!text) return;

    if (text === '/start') {
      await sendText(chatId,
        '👋 <b>OLC AMG Sidekick</b> is live.\n\n' +
        'Text or send a voice note with any idea — scene, character, vibe, reference.\n' +
        'I\'ll analyze it, write the brief, generate the image, and sync to your dashboard.\n\n' +
        '<b>Commands</b>\n' +
        '/brief [title]  →  return last brief (or one matching a phrase)\n' +
        '<i>reply to a photo with a note</i>  →  iterate on that visual\n\n' +
        'Shoot.'
      );
      return;
    }

    if (text.toLowerCase().startsWith('/brief')) {
      await handleBriefCommand(text.slice(6), chatId);
      return;
    }

    // --- Iteration path: text reply to a previous bot photo ------------------
    if (msg.reply_to_message && msg.reply_to_message.photo) {
      const lastId = store.lastByChat[chatId];
      const lastEntry = lastId ? store.entries.find(e => e.id === lastId) : null;
      if (lastEntry) {
        await runIteration(text, lastEntry, chatId);
        return;
      }
      // else fall through to normal pipeline with the text
    }

    // --- Default: run full pipeline ------------------------------------------
    await runOLCPipeline(text, chatId);

  } catch (err) {
    console.error('Pipeline error:', err);
    await sendText(chatId, `❌ Pipeline failed: ${err.message.slice(0, 200)}`);
  }
});

// ─── DASHBOARD SYNC ENDPOINTS ────────────────────────────────────────────────
// Dashboard polls /entries (lightweight, no image_b64) and fetches /entries/:id
// when the user taps (returns full entry including image_b64).

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

app.options('/entries', (req, res) => { corsHeaders(res); res.sendStatus(204); });
app.options('/entries/:id', (req, res) => { corsHeaders(res); res.sendStatus(204); });

app.get('/entries', (req, res) => {
  corsHeaders(res);
  // Strip image_b64 from list response — too heavy to poll every 30s
  const lite = store.entries.map(e => ({
    id: e.id,
    created: e.created,
    source: e.source,
    raw: e.raw,
    hook: e.hook,
    brief: e.brief,
    directive: e.directive,
    image_mime: e.image_mime,
    chat_id: e.chat_id,
    parent_id: e.parent_id || null,
    has_image: !!e.image_b64
  }));
  res.json(lite);
});

app.get('/entries/:id', (req, res) => {
  corsHeaders(res);
  const entry = store.entries.find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'not found' });
  res.json(entry);
});

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'OLC AMG Sidekick — online', entries: store.entries.length });
});

app.listen(PORT, () => console.log(`OLC AMG Sidekick running on port ${PORT}`));
