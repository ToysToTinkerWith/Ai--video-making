// script2meme_shorts.js
import 'dotenv/config';

import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import Jimp from "jimp";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { google } from "googleapis";

// === Firebase client SDK (Lite for Node) ===
import { initializeApp, getApps } from "firebase/app";
import { getFirestore, doc, getDoc } from "firebase/firestore/lite";
// If you truly need the full client (streaming, etc.), switch to "firebase/firestore"
// but firestore/lite is simpler and Node-friendly for reads.

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/* ===================== CONFIG ===================== */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY env var.");
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// Note: GOOGLE_REFRESH_TOKEN may be loaded from Firestore if not set.
let GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

/* ===================== Firebase (client) ===================== */
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID
};

const firebase_app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const db = getFirestore(firebase_app);

/* ===================== Retry helper ===================== */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function withRetry(taskFn, {
  retries = 5, baseDelayMs = 800, factor = 2, jitter = true,
  onRetry = (err, attempt) => console.warn(`Retry ${attempt}: ${err?.message || err}`)
} = {}) {
  let attempt = 0, delay = baseDelayMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { return await taskFn(); }
    catch (err) {
      attempt++;
      const status = err?.status ?? err?.response?.status;
      const transient = err?.name === "FetchError" ||
                        /Premature close/i.test(err?.message || "") ||
                        [408, 429, 500, 502, 503, 504].includes(status);
      if (!transient || attempt > retries) throw err;
      onRetry(err, attempt);
      await sleep(jitter ? Math.round(delay * (0.5 + Math.random())) : delay);
      delay *= factor;
    }
  }
}

/* ===================== Load GOOGLE_REFRESH_TOKEN from Firestore ===================== */
/**
 * Reads token from: collection 'cred' / doc 'cred' / field 'GOOGLE_REFRESH_TOKEN'
 * Returns a trimmed string and caches it in the module variable if found.
 */
async function readRefreshTokenFromFirebase() {
  const ref = doc(db, "creds", "creds");
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Cred doc not found: cred/cred");
  const token = (snap.data()?.GOOGLE_REFRESH_TOKEN ?? "").toString().trim();
  if (!token) throw new Error("Field 'GOOGLE_REFRESH_TOKEN' is empty in cred/cred");
  return token;
}

/* ===================== YouTube OAuth (uploads only) ===================== */
let _youtubeClient = null;
async function getYouTubeClient() {
  if (_youtubeClient) return _youtubeClient;

  // Ensure client id/secret exist
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    console.warn("⚠️ Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET; skipping YouTube upload.");
    return null;
  }

  // Prefer env refresh token; if absent, read from Firestore once.
  if (!GOOGLE_REFRESH_TOKEN) {
    try {
      GOOGLE_REFRESH_TOKEN = await readRefreshTokenFromFirebase();
      console.log("🔐 GOOGLE_REFRESH_TOKEN loaded from Firestore (cred/cred).");
    } catch (e) {
      console.warn("⚠️ Failed to load GOOGLE_REFRESH_TOKEN from Firestore:", e?.message || e);
      return null;
    }
  }

  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    "http://localhost/unused"
  );
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  _youtubeClient = google.youtube({ version: "v3", auth: oauth2Client });
  return _youtubeClient;
}

/* ===================== Theme from Firestore (client SDK) ===================== */
/**
 * Reads theme from: collection 'theme' / doc 'current' / field 'meme'
 * Returns a trimmed string (≤ 200 chars).
 * NOTE: Firestore rules must allow this read from your runtime.
 */
async function readThemeFromFirebase() {
  const ref = doc(db, "theme", "current");
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    throw new Error("Theme doc not found: theme/current");
  }
  const data = snap.data() || {};
  const theme = (data.meme ?? "").toString().trim();
  if (!theme) {
    throw new Error("Field 'meme' is empty in theme/current");
  }
  return theme.slice(0, 200);
}

/* ===================== 1) Plan the meme ===================== */
async function planMeme(theme, imageHint) {
  const sys = "You are a sharp meme copywriter and art director. Return strict JSON.";
  const user = `
Theme: "${theme}"

Create a meme plan as strict JSON.
Tone goals:
- Extra corny, obvious, dad-joke energy that is self-aware and harmless.
- The joke should be silly and groan-worthy on purpose.
- Avoid insults toward protected classes or real identifiable people.
- No profanity, no sexual content, keep brand-safe.

Image goals:
- Goofy, low-budget, hand-made vibe with practical props and natural lighting.
- Real people or photo-real characters; candid feel; slightly imperfect framing.
- Friendly and non-offensive; no logos or text on the image.

Return:
{
  "image_prompt": "Vivid, brand-safe visual (≤ 60 words) for a single vertical-friendly image, no text/logos. Incorporate this hint too: ${imageHint || "(none)"}",
  "top_text": "ALL CAPS, corny setup (≤ 8 words). Keep it harmless.",
  "bottom_text": "ALL CAPS, silly punchline (≤ 12 words). Keep it harmless.",
  "notes": "Optional brief art direction, ≤ 20 words."
}
No extra commentary. JSON only.
`.trim();

  const resp = await withRetry(() => openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    temperature: 0.9,
  }));

  let planText = resp.choices?.[0]?.message?.content || "{}";
  planText = planText.replace(/^```json\s*|^```\s*|```$/g, "").trim();

  let plan;
  try { plan = JSON.parse(planText); }
  catch {
    plan = {
      image_prompt: `Photo-real candid scene with practical props and natural light; slightly imperfect framing. No on-image text or logos.`,
      top_text: "EXPECTATION: EASY WIN",
      bottom_text: "REALITY: WHO GAVE THEM TOOLS",
      notes: "Keep it friendly; simple background."
    };
  }
  return plan;
}

/* ===================== 2) Make the 1024x1536 image (higher quality) ===================== */
async function generateImage(prompt, outPath, size = "1024x1536") {
  const fullPrompt = [
    prompt,
    "",
    "STYLE/MOOD:",
    "- Photo-real, natural lighting, practical/hand-made props; candid documentary feel.",
    "- Subtle imperfections (slight motion, scuffed surfaces, varied skin texture).",
    "- Simple uncluttered background; clear subject separation.",
    "",
    "RULES:",
    "- No on-image text, no logos/watermarks/UI.",
    "- Keep some headroom and footroom for captions.",
    "- Friendly, brand-safe humor; no real-person likeness targeting.",
    "",
    "AVOID:",
    "- Plastic sheen, over-smooth skin, extra fingers, warped eyes, melted objects."
  ].join("\n");

  const img = await withRetry(() => openai.images.generate({
    model: "gpt-image-1",
    prompt: fullPrompt,
    size,
    quality: "high"
  }));

  const b64 = img?.data?.[0]?.b64_json;
  if (!b64) throw new Error("No image data returned.");
  await fs.promises.writeFile(outPath, Buffer.from(b64, "base64"));
  console.log(`🖼️  Base image saved to ${path.resolve(outPath)}`);
  return outPath;
}

/* ===================== 3) Jimp overlay (meme text) ===================== */
function wrapTextToWidth(image, font, text, maxWidth) {
  if (!text) return [];
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";

  for (const w of words) {
    const tryLine = cur ? cur + " " + w : w;
    const width = Jimp.measureText(font, tryLine);
    if (width <= maxWidth) cur = tryLine;
    else {
      if (cur) lines.push(cur);
      if (Jimp.measureText(font, w) > maxWidth) {
        let part = "";
        for (const ch of w) {
          if (Jimp.measureText(font, part + ch) <= maxWidth) part += ch;
          else { lines.push(part); part = ch; }
        }
        cur = part;
      } else {
        cur = w;
      }
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

async function renderMeme(basePath, outPath, { top = "", bottom = "" }) {
  const image = await Jimp.read(basePath);

  const font128W = await Jimp.loadFont(Jimp.FONT_SANS_128_WHITE);
  const font64W  = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
  const font32W  = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);

  const font128B = await Jimp.loadFont(Jimp.FONT_SANS_128_BLACK);
  const font64B  = await Jimp.loadFont(Jimp.FONT_SANS_64_BLACK);
  const font32B  = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);

  const W = image.bitmap.width;
  const H = image.bitmap.height;
  const marginX = Math.max(24, Math.round(W * 0.07));
  const topY = Math.max(24, Math.round(H * 0.05));
  const bottomY = Math.max(24, Math.round(H * 0.05));
  const usableWidth = W - marginX * 2;

  const pickFonts = (txt) => {
    if (!txt) return { white: font64W, black: font64B };
    const l128 = wrapTextToWidth(image, font128W, txt, usableWidth);
    if (l128.length <= 2 && l128.every(l => Jimp.measureText(font128W, l) <= usableWidth)) {
      return { white: font128W, black: font128B };
    }
    const l64 = wrapTextToWidth(image, font64W, txt, usableWidth);
    if (l64.length <= 3 && l64.every(l => Jimp.measureText(font64W, l) <= usableWidth)) {
      return { white: font64W, black: font64B };
    }
    return { white: font32W, black: font32B };
  };

  const drawStrokedBlock = (txt, fonts, blockPos) => {
    if (!txt) return;
    const lines = wrapTextToWidth(image, fonts.white, txt, usableWidth);
    const lineHeights = lines.map(l => Jimp.measureTextHeight(fonts.white, l, usableWidth));
    const totalH = lineHeights.reduce((a, b) => a + b, 0);
    let y = blockPos === "top" ? topY : (H - bottomY - totalH);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const textWidth = Jimp.measureText(fonts.white, line);
      const textHeight = lineHeights[i];
      const x = (W - textWidth) / 2;

      // Thick stroke
      const offsets = [
        [-4, 0],[4, 0],[0, -4],[0, 4],
        [-4, -4],[4, -4],[-4, 4],[4, 4]
      ];
      for (const [dx, dy] of offsets) {
        image.print(fonts.black, x + dx, y + dy, { text: line, alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER }, textWidth, textHeight);
      }
      image.print(fonts.white, x, y, { text: line, alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER }, textWidth, textHeight);

      y += textHeight;
    }
  };

  const fontsTop = pickFonts(top);
  const fontsBottom = pickFonts(bottom);

  drawStrokedBlock(top, fontsTop, "top");
  drawStrokedBlock(bottom, fontsBottom, "bottom");

  await image.writeAsync(outPath);
  console.log(`✅ Meme image saved to ${path.resolve(outPath)}`);
  return outPath;
}

/* ===================== 3.5) Corny/Sloppy -> Cinematic (subtle) ===================== */
function clampByte(v) { return v < 0 ? 0 : v > 255 ? 255 : v|0; }
/** Add per-channel random noise in-place. strength = 0..1 (e.g. 0.015 = 1.5% of 255) */
async function addNoise(img, strength = 0.015) {
  const amp = 255 * strength;
  const { width: w, height: h, data } = img.bitmap;
  img.scan(0, 0, w, h, function (x, y, idx) {
    const nR = (Math.random() - 0.5) * 2 * amp;
    const nG = (Math.random() - 0.5) * 2 * amp;
    const nB = (Math.random() - 0.5) * 2 * amp;
    data[idx + 0] = clampByte(data[idx + 0] + nR);
    data[idx + 1] = clampByte(data[idx + 1] + nG);
    data[idx + 2] = clampByte(data[idx + 2] + nB);
    // alpha unchanged
  });
}

async function applyCinematicLook(inPath, outPath) {
  const img = await Jimp.read(inPath);

  // Tiny micro-rotation to feel organic (very small)
  const tilt = (Math.random() * 0.6) - 0.3;
  img.rotate(tilt, true); // bilinear for clean edges

  // Gentle clarity and tone
  img.contrast(0.05);
  img.brightness(0.01);
  img.color([{ apply: "saturate", params: [5] }]); // +5% saturation

  // Subtle film grain
  await addNoise(img, 0.015);

  // Soft vignette
  const w = img.bitmap.width;
  const h = img.bitmap.height;
  const edge = Math.floor(Math.min(w, h) * 0.05);

  const topBottom = await new Jimp(w, edge, 0x00000022);
  img.composite(topBottom, 0, 0);
  img.composite(topBottom, 0, h - edge);

  const leftRight = await new Jimp(edge, h, 0x00000022);
  img.composite(leftRight, 0, 0);
  img.composite(leftRight, w - edge, 0);

  await img.writeAsync(outPath);
  console.log(`🎨 Applied cinematic look -> ${path.resolve(outPath)}`);
  return outPath;
}

/* ===================== 4) TTS: meme text -> mp3 (random voice) ===================== */
async function generateVoiceoverFromMeme({ top, bottom }, outPath = "meme_voice.mp3") {
  const text = [top, bottom].filter(Boolean).join(". ").trim();
  if (!text) {
    await fs.promises.writeFile(outPath, Buffer.from([]));
    console.warn("⚠️ Meme has no text; wrote empty audio.");
    return outPath;
  }

  const voices = ["alloy","ash","coral","echo","fable","nova","onyx","sage","shimmer"];
  const voice = voices[Math.floor(Math.random() * voices.length)];
  console.log(`🎙️  Using voice: ${voice}`);

  const resp = await withRetry(() =>
    openai.audio.speech.create({
      model: "tts-1",
      voice,
      input: text,
      format: "mp3",
    })
  );

  const buf = Buffer.from(await resp.arrayBuffer());
  await fs.promises.writeFile(outPath, buf);
  console.log(`🗣️  Voiceover saved to ${path.resolve(outPath)}`);
  return outPath;
}

/* ===================== 5) ffprobe duration ===================== */
function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const dur = metadata?.format?.duration;
      if (!Number.isFinite(dur)) return reject(new Error("Could not read audio duration."));
      resolve(dur);
    });
  });
}

/* ===================== 6) Build Shorts video (9:16) w/ 50% volume ===================== */
async function makeVideoFromImageAndAudio({ imagePath, audioPath, outPath = "meme.mp4", framerate = 30 }) {
  if (!fs.existsSync(imagePath)) throw new Error(`Image not found: ${imagePath}`);
  if (!fs.existsSync(audioPath)) throw new Error(`Audio not found: ${audioPath}`);

  const duration = await getAudioDuration(audioPath);
  console.log(`🕒 Audio duration: ${duration.toFixed(3)}s`);

  await new Promise((resolve, reject) => {
    const filterGraph = [
      "[0:v]split=2[v1][v2];",
      "[v1]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=40:1[bg];",
      "[v2]scale=1080:1620:force_original_aspect_ratio=decrease[fg];",
      "[bg][fg]overlay=(W-w)/2:(H-h)/2[outv];",
      "[1:a]volume=0.5[aout]"
    ].join("");

    const cmd = ffmpeg();
    cmd.addInput(imagePath).inputOptions(["-loop 1"]);
    cmd.addInput(audioPath);

    cmd
      .complexFilter(filterGraph)
      .outputOptions([
        "-map", "[outv]",
        "-map", "[aout]",
        "-pix_fmt", "yuv420p",
        "-c:v", "libx264",
        "-r", String(framerate),
        "-t", String(duration),
        "-shortest",
        "-movflags", "+faststart"
      ])
      .audioCodec("aac")
      .on("start", (cl) => console.log("🎬 ffmpeg:", cl))
      .on("error", (err) => { console.error("ffmpeg error:", err?.message || err); reject(err); })
      .on("end", () => { console.log(`✅ Video written to ${path.resolve(outPath)}`); resolve(); })
      .save(outPath);
  });

  return outPath;
}

/* ===================== 7) Shorts metadata ===================== */
function guessCategoryIdFromText(text) {
  const t = (text || "").toLowerCase();
  if (/(game|gaming|league of legends|valorant|minecraft|overwatch)/.test(t)) return "20";
  if (/(tutorial|how to|guide|learn|course|lesson|tips)/.test(t)) return "27";
  if (/(music|song|track|cover)/.test(t)) return "10";
  if (/(news|politics|breaking)/.test(t)) return "25";
  if (/(science|tech|programming|coding|software|javascript|node|ai|openai|blockchain|algorand)/.test(t)) return "28";
  if (/(sports|highlights|nfl|nba|soccer|football)/.test(t)) return "17";
  if (/(vlog|day in the life|storytime)/.test(t)) return "22";
  return "24";
}
function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set(); const out = []; let totalLen = 0;
  for (const raw of tags) {
    const t = String(raw).trim().replace(/^#/, "");
    if (!t || seen.has(t)) continue;
    if (t.length > 60) continue;
    if (out.length >= 15) break;
    if (totalLen + t.length > 450) break;
    out.push(t); seen.add(t); totalLen += t.length;
  }
  if (!seen.has("shorts")) out.push("shorts");
  return out;
}
function clamp(str, max) { return (str || "").slice(0, max); }

async function generateShortsMetadata(theme, top, bottom) {
  const sys = "You are an expert YouTube Shorts strategist. Return strict JSON only.";
  const user = `
Create YouTube Shorts metadata as JSON for a meme short with intentionally goofy visuals and extra-corny humor.

Context:
- Theme: ${theme}
- Top text: ${top || "(none)"}
- Bottom text: ${bottom || "(none)"}

Guidelines:
- Keep it harmless, playful, and brand-safe. No targeted insults.
- Lean into the 'low-budget goofy' charm.

JSON shape:
{
  "title": "catchy, ≤ 90 chars; include one keyword from theme if natural; no hashtags",
  "description": "2–4 punchy lines describing the silly, intentionally low-budget joke; end with 2–4 hashtags including #Shorts; ≤ 4900 chars",
  "tags": ["8–15 concise tags, no '#', include 'shorts'"]
}
JSON only, no commentary.
`.trim();

  const resp = await withRetry(() => openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    temperature: 0.7,
  }));

  let text = resp.choices?.[0]?.message?.content || "{}";
  text = text.replace(/^```json\s*|^```\s*|```$/g, "").trim();

  let meta; try { meta = JSON.parse(text); } catch { meta = {}; }
  let { title, description, tags } = meta || {};
  title = clamp(title || "This Meme Is Proudly Low-Budget", 90);
  if (!/#shorts/i.test(description || "")) {
    const tail = (description || "").trim().length ? "\n" : "";
    description = clamp(`${description || ""}${tail}#Shorts`, 4900);
  }
  tags = sanitizeTags(tags || []);
  const categoryId = guessCategoryIdFromText(`${theme} ${top} ${bottom}`);
  return { title, description, tags, categoryId };
}

/* ===================== 8) YouTube Upload (OAuth) ===================== */
async function uploadToYouTubeShorts({
  filePath,
  title,
  description,
  tags,
  categoryId,
  privacyStatus = "public",
  madeForKids = false,
}) {
  const youtube = await getYouTubeClient();
  if (!youtube) {
    console.warn("⚠️  Skipping YouTube upload (missing Google OAuth config or refresh token).");
    return null;
  }
  console.log("⏫ Uploading to YouTube (Shorts)...");
  const res = await youtube.videos.insert({
    part: "snippet,status",
    requestBody: {
      snippet: { title, description, tags, categoryId },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: madeForKids,
      }
    },
    media: { body: fs.createReadStream(filePath) }
  });
  const videoId = res?.data?.id;
  if (!videoId) throw new Error("YouTube upload failed (no video ID in response).");
  console.log(`✅ YouTube video ID: ${videoId}`);
  console.log(`🔗 https://youtu.be/${videoId}`);
  return videoId;
}

/* ===================== Main ===================== */
async function main() {
  // READ THEME FROM FIRESTORE (theme/current.meme)
  const THEME = await withRetry(() => readThemeFromFirebase());
  console.log("🎯 Using Firestore theme (theme/current.meme) with realistic, higher-quality image...");
  console.log(`Theme: "${THEME}"\n`);

  // Plan
  console.log(`🧠 Planning meme for theme: "${THEME}" (extra corny + photo-real vibe)`);
  const plan = await planMeme(THEME, "");

  console.log("\n--- MEME PLAN ---");
  console.log(`Image prompt: ${plan.image_prompt}`);
  console.log(`Top text:     ${plan.top_text || "(none)"}`);
  console.log(`Bottom text:  ${plan.bottom_text || "(none)"}`);
  if (plan.notes) console.log(`Notes:        ${plan.notes}`);
  console.log("-----------------\n");

  const baseImg = path.resolve("meme_base.png");
  const memeImg = path.resolve("meme.png");
  const memeCinematic = path.resolve("meme_cinematic.png");
  const voiceMp3 = path.resolve("meme_voice.mp3");
  const outMp4  = path.resolve("meme.mp4");

  // 1) Generate higher-res image
  await generateImage(plan.image_prompt, baseImg, "1024x1536");

  // 2) Overlay text (uppercase for classic meme look)
  const top = (plan.top_text || "").toUpperCase();
  const bottom = (plan.bottom_text || "").toUpperCase();
  await renderMeme(baseImg, memeImg, { top, bottom });

  // 2.5) Subtle cinematic polish to reduce “AI look”
  await applyCinematicLook(memeImg, memeCinematic);

  // 3) Voiceover from meme text (random voice)
  await generateVoiceoverFromMeme({ top, bottom }, voiceMp3);

  // 4) Build 9:16 video (blurred bg, volume=0.5)
  await makeVideoFromImageAndAudio({ imagePath: memeCinematic, audioPath: voiceMp3, outPath: outMp4 });

  // 5) Generate Shorts metadata
  const meta = await generateShortsMetadata(THEME, top, bottom);
  console.log("\n📝 Shorts metadata:", meta);

  // 6) Upload to YouTube Shorts (public)
  const videoId = await uploadToYouTubeShorts({
    filePath: outMp4,
    title: meta.title,
    description: meta.description,
    tags: meta.tags,
    categoryId: meta.categoryId,
    privacyStatus: "public",
    madeForKids: false,
  });

  console.log("\n🎉 All done.", videoId ? `Video: https://youtu.be/${videoId}` : "");
}

main().catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});
