# OLC AMG — Telegram Sidekick Deploy Guide

Deploy the Telegram bot server on Render.com (free), then plug its URL into
your dashboard's ⚙ Keys modal. The dashboard itself keeps running from
GitHub Pages — this server ONLY handles the Telegram pipeline.

---

## What You're Deploying

A small Node.js server (`server.js`) that:
- Receives Telegram text + voice messages from your phone
- Transcribes voice notes via OpenAI Whisper
- Runs the text through Claude (hook analysis + brief + image directive)
- Generates an image via DALL-E 3
- Sends results back to you in Telegram
- Serves `/entries` and `/entries/:id` so your OLC AMG dashboard can sync
- Handles iteration (reply to a bot photo with a note → regenerate)
- Handles `/brief` command (fetch last brief, or one matching a phrase)

---

## STEP 1 — Create Your Telegram Bot

1. Open Telegram, find **@BotFather**
2. Send `/newbot`
3. Give it a name (e.g. `OLC AMG Sidekick`) and a username ending in `_bot`
4. BotFather gives you a **TOKEN** — save it, looks like `123456789:ABC-xyz...`

---

## STEP 2 — Push Server Files To Your GitHub Repo

In your `OLC-AMG` repo, the following files are already present (pushed by Emergent's Save to GitHub):
- `server.js`
- `package.json`
- `DEPLOY.md` (this file)

If they're missing, push them via Emergent's Save to GitHub button.

---

## STEP 3 — Deploy On Render.com

1. Go to **render.com** — sign up free with your GitHub account
2. Click **New** → **Web Service**
3. Connect your `OLC-AMG` GitHub repo
4. Settings:
   - **Name:** `olc-amg-sidekick`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
5. Click **Advanced** → **Add Environment Variable** — add these three:
   - `TELEGRAM_TOKEN` = your BotFather token
   - `ANTHROPIC_KEY` = your Anthropic API key (sk-ant-...)
   - `OPENAI_KEY` = your OpenAI API key (sk-...)
6. Click **Create Web Service**
7. Wait ~3 minutes. You'll get a URL like:
   `https://olc-amg-sidekick.onrender.com`

---

## STEP 4 — Register Your Webhook With Telegram

Once Render gives you your URL, open this in your browser:

```
https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=<YOUR_RENDER_URL>/webhook
```

Example:
```
https://api.telegram.org/bot123456:ABC.../setWebhook?url=https://olc-amg-sidekick.onrender.com/webhook
```

You should see: `{"ok":true,"result":true,"description":"Webhook was set"}`

---

## STEP 5 — Plug The Render URL Into Your Dashboard

1. Open your OLC AMG dashboard (the bookmarked URL with `?v=...`)
2. Click **⚙ Keys** in the header
3. In the **Render Webhook URL** field, paste your Render service URL:
   `https://olc-amg-sidekick.onrender.com`
4. Click **Save**

The Analyzer tab will now show a Telegram Inbox strip at the top that polls
your Render server every 30 seconds.

---

## STEP 6 — Test The Full Flow

On your phone, open Telegram and find your bot (the one you made with BotFather).

1. Send `/start` — you should get a welcome message listing commands
2. Text any idea — a scene, character, vibe, reference
3. Within ~30-60 seconds you'll get back:
   - Hook analysis
   - Brief
   - Generated image
4. Reply to the photo with a refinement note (e.g. "more shadow, tighter crop") — bot regenerates
5. Send `/brief` — returns the last brief as copyable text
6. Send a **voice note** — bot transcribes, shows what it heard, runs the full pipeline
7. Open OLC AMG dashboard → Analyzer tab → the entry appears in the inbox at the top → tap to load it

---

## Render Free Tier Notes

- Free tier **spins down after 15 min inactivity**
- First message after sleep takes ~30 seconds to wake up
- The dashboard's inbox status will say "WAKING UP…" during that interval — normal
- If this becomes annoying, Render paid is $7/month for always-on

## Iteration Loop (How It Works)

When you reply to a bot-generated photo in Telegram with text, the server:
1. Finds your last entry from that chat
2. Sends the original directive + your refinement note to Claude
3. Claude returns a revised DALL-E 3 prompt
4. DALL-E renders the new image
5. Bot sends it back captioned `↻ <your note>`
6. The iteration is saved as a new entry (linked to parent via `parent_id`)

You can iterate on iterations.

## /brief Command

- `/brief` → returns the most recent entry from your chat
- `/brief angel fist` → returns the most recent entry whose idea/hook/brief contains "angel fist"

---

## Troubleshooting

**Bot doesn't respond to `/start`:**
Check Render logs (Render dashboard → your service → Logs). Confirm webhook is registered — visit `https://api.telegram.org/bot<TOKEN>/getWebhookInfo` and confirm `url` matches your Render URL.

**Dashboard inbox stuck on "WAKING UP…":**
Render is cold. Send the bot a message to wake it. Refresh inbox after 30 seconds.

**Dashboard inbox says "NO ENTRIES YET" but you've texted the bot:**
Render instance may have restarted (free tier) and cleared in-memory store. Recent entries only survive while the instance is warm. Fix long-term by connecting Airtable/Supabase.

**Voice transcription fails:**
Check your OpenAI key has credit. Whisper API is cheap (~$0.006/min). Check Render logs for the exact error.

---

## Architecture Summary

```
    Phone Telegram     →    Render Sidekick    →    Claude / DALL-E / Whisper
                                 ↓
                          in-memory store
                                 ↓
    OLC AMG Dashboard   ←   /entries  /entries/:id   (polled every 30s)
     (GitHub Pages)
```

Dashboard and Render server never touch each other except through the
two read-only endpoints. Dashboard still talks directly to Anthropic +
OpenAI for its own Analyzer work (Rule Zero).
