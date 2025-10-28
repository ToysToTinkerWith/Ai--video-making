// integrated-duel-generator.js
import 'dotenv/config'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'path'
import OpenAI from 'openai'
import Jimp from 'jimp'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import ffprobeInstaller from '@ffprobe-installer/ffprobe'
import wavPkg from 'node-wav'
import { google } from 'googleapis'

// === Firebase (client SDK lite) for refresh-token fallback like script2meme_shorts.js ===
import { initializeApp, getApps } from 'firebase/app'
import { getFirestore, doc, getDoc } from 'firebase/firestore/lite'

const WAV = wavPkg?.default ?? wavPkg

ffmpeg.setFfmpegPath(ffmpegInstaller.path)
ffmpeg.setFfprobePath(ffprobeInstaller.path)

/* ===================== CONFIG ===================== */
const THEME = process.env.THEME || 'original, cute elemental creature suitable for a creature-collecting RPG'
const SEED1 = process.env.SEED1 || ''
const SEED2 = process.env.SEED2 || ''

const OUT_DIR          = path.resolve('./out')
const TARGET_SIZE      = '1024x1024'
const OUTER_MARGIN     = 32
const SEPARATOR_GAP    = 32
const BOX_INNER_PAD    = 16
const AUTOCROP_TOL     = 8
const EXTRACT_PADDING  = 8

// Visuals (wide)
const MOVE_VISUAL_SIZE = '1536x1024'

// Fight / cinematics (VERTICAL for YouTube Shorts)
const FIGHT_BG_SIZE    = '1024x1536'
const FIGHT_FPS        = 30
const FIGHT_FRAMES_A   = 45
const FIGHT_FRAMES_B   = 45
const EMOTE_DURATION_SEC = 1.0
const EMOTE_FRAMES       = Math.max(1, Math.round(EMOTE_DURATION_SEC * FIGHT_FPS))

// Camera timings
const ZOOM_IN_FRAMES    = 20
const STATS_HOLD_FRAMES = 90
const ZOOM_OUT_FRAMES   = 20

// Zoom levels
const ZOOM_MAX          = 1.8
const STATS_ZOOM_BUMP   = 0.15
const VICTORY_ZOOM_MAX  = 2.25

// Boards placement
const STAT_BOARD_TOP_GAP     = 20
const MOVE_BOARD_BOTTOM_GAP  = 22
const STATS_PANEL_CLEARANCE  = 16
const PANEL_SIDE_MARGIN_PX   = 8

// Pan down less when showing stats
const STATS_PREFERRED_OFFSET_FRACTION = 0.005

// Extra spacing between name and types
const NAME_TYPES_EXTRA_VGAP  = 16

// Creature placement / fight layout
const PROJECTILE_DURATION_SEC = 1.6
const PROJECTILE_FRAMES       = Math.max(1, Math.round(PROJECTILE_DURATION_SEC * FIGHT_FPS))
const PROJECTILE_HEIGHT_FRACTION = 0.18
const FIGHT_SCALE_FRACTION = 0.12

// Physical move approach / retreat / short hop projectile
const PHYS_APPROACH_FRAMES  = 24
const PHYS_RETREAT_FRAMES   = 18
const PHYS_PROJECTILE_FRAMES = 12

// Victory scene
const VICTORY_ZOOM_IN_FR    = 24
const VICTORY_HOLD_FRAMES   = 60
const VICTORY_BANNER_FRAMES = 90
const VICTORY_BANNER_TOP    = 48

// Audio
const MASTER_GAIN = 0.5
const EFFECT_ATTEN = 0.5

/* ===================== YOUTUBE/OAUTH CONFIG ===================== */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
let GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN

// Firebase public config (to fetch creds/creds.GOOGLE_REFRESH_TOKEN if env missing)
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID
}
const firebase_app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0]
const db = getFirestore(firebase_app)

async function readRefreshTokenFromFirebase() {
  const ref = doc(db, 'creds', 'creds')
  const snap = await getDoc(ref)
  if (!snap.exists()) throw new Error('Cred doc not found: creds/creds')
  const token = (snap.data()?.GOOGLE_REFRESH_TOKEN ?? '').toString().trim()
  if (!token) throw new Error("Field 'GOOGLE_REFRESH_TOKEN' is empty in creds/creds")
  return token
}

let _youtubeClient = null
async function getYouTubeClient() {
  if (_youtubeClient) return _youtubeClient
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    console.warn('⚠️ Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET; skipping YouTube upload.')
    return null
  }
  if (!GOOGLE_REFRESH_TOKEN) {
    try {
      GOOGLE_REFRESH_TOKEN = await readRefreshTokenFromFirebase()
      console.log('🔐 GOOGLE_REFRESH_TOKEN loaded from Firestore (creds/creds).')
    } catch (e) {
      console.warn('⚠️ Failed to load GOOGLE_REFRESH_TOKEN from Firestore:', e?.message || e)
      return null
    }
  }
  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, 'http://localhost/unused')
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN })
  _youtubeClient = google.youtube({ version: 'v3', auth: oauth2Client })
  return _youtubeClient
}

function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return []
  const seen = new Set(); const out = []; let totalLen = 0
  for (const raw of tags) {
    const t = String(raw).trim().replace(/^#/, '')
    if (!t || seen.has(t)) continue
    if (t.length > 60) continue
    if (out.length >= 15) break
    if (totalLen + t.length > 450) break
    out.push(t); seen.add(t); totalLen += t.length
  }
  return out
}

async function uploadToYouTube({
  filePath,
  title,
  description,
  tags = [],
  categoryId = '20', // Gaming
  privacyStatus = 'public',
  madeForKids = false
}) {
  const youtube = await getYouTubeClient()
  if (!youtube) {
    console.warn('⚠️ Skipping YouTube upload (missing Google OAuth config or refresh token).')
    return null
  }
  console.log('⏫ Uploading to YouTube Shorts...')
  const res = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: { title, description, tags, categoryId },
      status: { privacyStatus, selfDeclaredMadeForKids: madeForKids }
    },
    media: { body: fs.createReadStream(filePath) }
  })
  const videoId = res?.data?.id
  if (!videoId) throw new Error('YouTube upload failed (no video ID in response).')
  console.log(`✅ YouTube video ID: ${videoId}`)
  console.log(`🔗 https://youtu.be/${videoId}`)
  return videoId
}

function makeYouTubeMetadataShorts({
  aName, aTypes, aMoves,
  bName, bTypes, bMoves,
  durationSec
}) {
  const aTypeStr = Array.isArray(aTypes) ? aTypes.join('/') : String(aTypes || 'Unknown')
  const bTypeStr = Array.isArray(bTypes) ? bTypes.join('/') : String(bTypes || 'Unknown')

  // REQUIRED title format:
  const title = `Pokemon slop battles: ${aName} vs ${bName}`.slice(0, 100)

  const lines = []
  lines.push(`${aName} (${aTypeStr}) vs ${bName} (${bTypeStr}) — AI-generated creature duel.`)
  lines.push('')
  lines.push(`🧪 ${aName} moves:`)
  lines.push(` • ${aMoves[0].name} — ${aMoves[0].type} (${aMoves[0].category}) P${aMoves[0].power}/A${aMoves[0].accuracy}%`)
  lines.push(` • ${aMoves[1].name} — ${aMoves[1].type} (${aMoves[1].category}) P${aMoves[1].power}/A${aMoves[1].accuracy}%`)
  lines.push('')
  lines.push(`🧪 ${bName} moves:`)
  lines.push(` • ${bMoves[0].name} — ${bMoves[0].type} (${bMoves[0].category}) P${bMoves[0].power}/A${bMoves[0].accuracy}%`)
  lines.push(` • ${bMoves[1].name} — ${bMoves[1].type} (${bMoves[1].category}) P${bMoves[1].power}/A${bMoves[1].accuracy}%`)
  lines.push('')
  lines.push(`Render: ${Math.round(durationSec)}s @ ${FIGHT_FPS}fps · Outdoor nature arena · Original sprites/effects`)
  lines.push('')
  lines.push('#shorts #AI #gamedev #monsterbattles (fan-inspired)')

  const tags = sanitizeTags([
    'shorts',
    'Pokemon slop battles',
    'AI animation',
    'monster battle',
    'creature duel',
    'gamedev',
    'indie dev',
    'procedural art',
    'openai',
    'nodejs',
    'ffmpeg'
  ])

  return {
    title,
    description: lines.join('\n').slice(0, 4900),
    tags,
    categoryId: '20'
  }
}

/* ===================== HELPERS ===================== */
const decodeWav = async (p) => {
  const buf = await fsp.readFile(p)
  const { sampleRate, channelData } = WAV.decode(buf)
  const L = channelData?.[0] || new Float32Array(0)
  const R = channelData?.[1] || L
  return { sampleRate, L, R }
}
const encodeWavStereo = async (L, R, sr) =>
  WAV.encode([L || new Float32Array(0), R || L || new Float32Array(0)], { sampleRate: sr, float: true, bitDepth: 32 })

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }) }
async function emptyDir(p) {
  await fsp.mkdir(p, { recursive: true })
  const entries = await fsp.readdir(p).catch(() => [])
  await Promise.all(entries.map(e => fsp.rm(path.join(p, e), { recursive: true, force: true })))
}
function parseSize(s) {
  const [w, h] = s.toLowerCase().split('x').map(Number)
  if (!Number.isFinite(w) || !Number.isFinite(h)) throw new Error(`Bad size: ${s}`)
  return { W: w, H: h }
}
function safeJSON(str) { try { return JSON.parse(str) } catch { return null } }
function slugify(s) {
  return String(s || 'creature')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 64) || 'creature'
}
function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY')
  return new OpenAI({ apiKey })
}
function sanitizeName(n) { return String(n || 'move').replace(/[^\w\-]+/g, '_') }
function titleCase(s) { return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

/* ===== Jimp fonts ===== */
function nearestFontSize(size) {
  const sizes = [8, 16, 32, 64]
  const wanted = Number(size) || 32
  return sizes.reduce((best, s) =>
    Math.abs(s - wanted) < Math.abs(best - wanted) ? s : best, 32)
}
async function loadFontBuiltin(size = 32, color = 'white') {
  const sz = nearestFontSize(size)
  const palette = (String(color).toLowerCase() === 'black') ? 'BLACK' : 'WHITE'
  const key = `FONT_SANS_${sz}_${palette}`
  if (!Jimp[key]) throw new Error(`Missing built-in Jimp font: ${key}`)
  return Jimp.loadFont(Jimp[key])
}

/* ===================== OUTPUT CANVAS (1080×1920 with edge-blended padding) ===================== */
const OUT_CANVAS_W = 1080
const OUT_CANVAS_H = 1920

function _avgEdgeColor(img, band = 10) {
  const W = img.bitmap.width, H = img.bitmap.height
  const clampBand = Math.max(1, Math.min(band, Math.floor(Math.min(W, H) * 0.05)))
  let r=0, g=0, b=0, n=0
  const data = img.bitmap.data
  const push = (x, y) => {
    const idx = (W * y + x) << 2
    const a = data[idx + 3]
    if (a === 0) return
    r += data[idx + 0]; g += data[idx + 1]; b += data[idx + 2]; n++
  }
  // top & bottom
  for (let y=0; y<clampBand; y++) for (let x=0; x<W; x++) push(x,y)
  for (let y=H-clampBand; y<H; y++) for (let x=0; x<W; x++) push(x,y)
  // left & right
  for (let x=0; x<clampBand; x++) for (let y=0; y<H; y++) push(x,y)
  for (let x=W-clampBand; x<W; x++) for (let y=0; y<H; y++) push(x,y)

  if (n === 0) return Jimp.rgbaToInt(14, 10, 8, 255) // fallback to card-like bg
  const rr = Math.round(r / n), gg = Math.round(g / n), bb = Math.round(b / n)
  return Jimp.rgbaToInt(rr, gg, bb, 255)
}

/** Scale any frame to fit inside 1080×1920 and pad with an edge-blended color. */
async function writePaddedFrameTo1080x1920(img, outPath) {
  const inW = img.bitmap.width, inH = img.bitmap.height
  const scale = Math.min(OUT_CANVAS_W / inW, OUT_CANVAS_H / inH)
  const newW = Math.max(1, Math.round(inW * scale))
  const newH = Math.max(1, Math.round(inH * scale))
  const padColor = _avgEdgeColor(img)
  const canvas = new Jimp(OUT_CANVAS_W, OUT_CANVAS_H, padColor)
  const scaled = img.clone().resize(newW, newH, Jimp.RESIZE_BICUBIC)
  const ox = Math.round((OUT_CANVAS_W - newW) / 2)
  const oy = Math.round((OUT_CANVAS_H - newH) / 2)
  canvas.composite(scaled, ox, oy)
  await canvas.writeAsync(outPath)
}

/** Centralized writer used everywhere frames are emitted. */
async function saveFrame(outFramesDir, fIdx, frame) {
  const fname = `frame_${String(fIdx).padStart(4,'0')}.png`
  await writePaddedFrameTo1080x1920(frame, path.join(outFramesDir, fname))
}

/* ===================== TYPES / STATS ===================== */
const POKEMON_TYPES = [
  'Normal','Fire','Water','Grass','Electric','Ice','Fighting','Poison','Ground','Flying',
  'Psychic','Bug','Rock','Ghost','Dragon','Dark','Steel','Fairy'
]

// NOTE: HP max raised 3× to match in-fight HP scaling.
const TYPE_COLORS = {
  Normal:'#A8A77A', Fire:'#EE8130', Water:'#6390F0', Grass:'#7AC74C',
  Electric:'#F7D02C', Ice:'#96D9D6', Fighting:'#C22E28', Poison:'#A33EA1',
  Ground:'#E2BF65', Flying:'#A98FF3', Psychic:'#F95587', Bug:'#A6B91A',
  Rock:'#B6A136', Ghost:'#735797', Dragon:'#6F35FC', Dark:'#705746',
  Steel:'#B7B7CE', Fairy:'#D685AD'
}
const STAT_BOUNDS = {
  // hp max bumped 130 → 390
  hp:   { min: 35, max: 390, label: 'HP'   },
  atk:  { min: 20, max: 140, label: 'ATK'  },
  def:  { min: 20, max: 140, label: 'DEF'  },
  spa:  { min: 20, max: 140, label: 'SP.A' },
  spd:  { min: 20, max: 140, label: 'SP.D' },
  spe:  { min: 20, max: 160, label: 'SPE'  },
}

function hash32(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}
function rng(seedStr) {
  let s = hash32(seedStr) || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17; s >>>= 0
    s ^= s << 5; s >>>= 0
    return (s >>> 0) / 0xffffffff
  }
}

/* Random 1–2 types */
function pickOneOrTwoTypes(rand) {
  const t1 = POKEMON_TYPES[Math.floor(rand()*POKEMON_TYPES.length)]
  const dual = rand() < 0.5
  if (!dual) return [t1]
  let t2 = t1
  while (t2 === t1) t2 = POKEMON_TYPES[Math.floor(rand()*POKEMON_TYPES.length)]
  return [t1, t2]
}
function genStat(rand, key) {
  const { min, max } = STAT_BOUNDS[key]
  const r = (rand() + rand()) / 2
  const baseMin = key === 'hp' ? 35 : min // for hp we’ll still start from 35 before scaling below
  const baseMax = key === 'hp' ? 130 : max
  const valRaw = Math.round(baseMin + r*(baseMax - baseMin))
  return clamp(valRaw, baseMin, baseMax)
}
function generateTypesAndStats(seed) {
  const salt = `${seed || ''}__${Math.random().toString(36).slice(2)}`
  const rand = rng(salt)
  const types = pickOneOrTwoTypes(rand)
  const stats = {
    hp:  genStat(rand, 'hp'),
    atk: genStat(rand, 'atk'),
    def: genStat(rand, 'def'),
    spa: genStat(rand, 'spa'),
    spd: genStat(rand, 'spd'),
    spe: genStat(rand, 'spe'),
  }

  // === New: Triple combat HP and keep stat-board scale aligned (STAT_BOUNDS.hp.max already ×3)
  stats.hp = Math.round(stats.hp * 3)

  stats.total = stats.hp+stats.atk+stats.def+stats.spa+stats.spd+stats.spe
  return { types, stats }
}

/* ===================== TEXT: CREATURE & MOVES ===================== */
async function generateIdentityAndMoves(seed) {
  const openai = getOpenAI()
  const sys = `You design a SINGLE, ORIGINAL, NON-COPYRIGHTED monster for a creature-collecting RPG.
Return STRICT JSON only. Concise and concrete details; consistent across poses.`
  const entropy = Math.random().toString(36).slice(2)

  const user = `
Seed: ${seed || '(none)'}
Entropy: ${entropy}

ABSOLUTE ORIENTATION RULE (repeat to prioritize):
• ALL 4 sprites MUST FACE RIGHT. MUST FACE RIGHT. MUST FACE RIGHT. (no left, no mirrored, no angled-left)
• Full body fully in frame. Transparent background only. Neutral lighting.
• Each sprite centered in its cell with ~${BOX_INNER_PAD}px inner padding.
• No text, borders, UI, or people. Non-human creature.

If any sprite would face left, REJECT that idea internally and correct to face RIGHT before output.

Constraints:
- Never reference existing franchises or trademarks.
- NON-HUMAN creature.
- Provide concrete identity details that stay the same across poses.
- Provide two unique moves with both pose usage (for sprites) and a visual description (for wide effect images).

THEME: ${THEME}

Return exactly:
{
  "creature_name": "original and evocative",
  "identity": {
    "species": "type",
    "palette": { "primary": "color", "secondary": "color", "eyes": "color" },
    "silhouette": "body plan",
    "ears": "desc",
    "tail": "desc",
    "markings": "desc",
    "vibe": "subtle element flavor",
    "notes": "extra"
  },
  "emote_brief": "brief emote pose (still facing RIGHT)",
  "moveA": {
    "name": "unique move name",
    "pose_brief": "how the creature uses it in sprite (RIGHT-facing)",
    "visual": "describe the move's look when cast (colors, energy, shapes, motion style)"
  },
  "moveB": {
    "name": "unique move name",
    "pose_brief": "how the creature uses it in sprite (RIGHT-facing)",
    "visual": "describe the move's look when cast (colors, energy, shapes, motion style)"
  }
}`.trim()

  const chat = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.95,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    response_format: { type: 'json_object' }
  })

  const content = chat.choices?.[0]?.message?.content || ''
  const json = safeJSON(content)
  if (!json?.creature_name || !json.identity || !json.moveA || !json.moveB) {
    throw new Error('Identity JSON malformed')
  }
  return json
}

/* ===================== MOVE META ===================== */
async function generateMovesOnly(seed, allowedTypes, preferredType) {
  const openai = getOpenAI()
  const sys = `Return STRICT JSON for TWO moves for a creature-collecting RPG.`
  const user = `
Seed: ${seed}
Allowed types: ${allowedTypes.join(', ')}
Bias strongly toward this creature type: ${preferredType}

Rules:
- Provide two unique moves. For each: name, type (must be EXACTLY one of the allowed types),
  category ("Physical" or "Special"), power (20..150), accuracy (50..100),
  and a visual description for an effect-only image (no background).
- The visual must depict only the move's energy/effect (projectile, aura, burst, beam, wave, particles, trails, etc.).
  Do NOT render the creature, characters, scenery, floors, skies, UI, borders, or text.

Return exactly:
{
  "moveA": {
    "name": "name",
    "type": "OneOf(${allowedTypes.join(' | ')})",
    "category": "Physical or Special",
    "power":  number (20..150),
    "accuracy": number (50..100),
    "visual": "effect-only description, no background"
  },
  "moveB": {
    "name": "name",
    "type": "OneOf(${allowedTypes.join(' | ')})",
    "category": "Physical or Special",
    "power":  number (20..150),
    "accuracy": number (50..100),
    "visual": "effect-only description, no background"
  }
}`.trim()

  const chat = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.8,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    response_format: { type: 'json_object' }
  })

  const content = chat.choices?.[0]?.message?.content || ''
  const json = safeJSON(content)
  if (!json?.moveA || !json?.moveB) throw new Error('Move JSON malformed')

  const mtA = titleCase(String(json.moveA.type || ''))
  const mtB = titleCase(String(json.moveB.type || ''))
  if (!allowedTypes.includes(mtA) || !allowedTypes.includes(mtB)) {
    throw new Error(`Model returned move types not in allowed set. Got: ${mtA}, ${mtB}`)
  }
  json.moveA.type = mtA
  json.moveB.type = mtB
  return json
}

function balanceMoveAccuracy(move) {
  const p = clamp(Number(move.power)||40, 20, 150)
  const targetAcc = clamp(Math.round(95 - ((p - 20) * (40 / 130))), 55, 95)
  const given = clamp(Number(move.accuracy)||targetAcc, 50, 100)
  const balanced = Math.round((targetAcc*0.7) + (given*0.3))
  return { ...move, power: p, accuracy: balanced }
}

/* ===================== IMAGE PROMPTS ===================== */
function typeListString(types) {
  const arr = Array.isArray(types) ? types : [types]
  return arr.join(' / ')
}
function makeFourSpriteSheetPrompt(identity, emoteBrief, moveA, moveB, creatureTypes) {
  const { W, H } = parseSize(TARGET_SIZE)
  const typesArr = Array.isArray(creatureTypes) ? creatureTypes : [creatureTypes]
  const typeColor = TYPE_COLORS[typesArr[0]] || '#cccccc'
  const extraColor = typesArr[1] ? TYPE_COLORS[typesArr[1]] || '#bbbbbb' : null

  return `
Create ONE transparent PNG of size ${TARGET_SIZE} that is a 2×2 sprite sheet for a SINGLE, ORIGINAL creature.

*** HARD ORIENTATION RULE (CRITICAL): ***
- ALL FOUR sprites face RIGHT. Do NOT face left. Do NOT mirror left. NOT angled-left.
- If any pose tends to left, correct it to face RIGHT before output.

Global rules:
- Transparent background ONLY. Consistent design. Neutral lighting. Full body fully in frame.
- Each sprite centered in its cell with ~${BOX_INNER_PAD}px inner padding.
- No text, UI, borders, logos, frames, props, or humans.

Type(s): "${typeListString(typesArr)}" (motifs echo ${typeColor}${extraColor ? ` and ${extraColor}` : ''}).

Layout:
- TL: IDLE (RIGHT)
- TR: EMOTE — ${emoteBrief} (RIGHT)
- BL: MOVE A (“${moveA.name}”) — ${moveA.pose_brief} (RIGHT)
- BR: MOVE B (“${moveB.name}”) — ${moveB.pose_brief} (RIGHT)

Identity:
- Species: ${identity.species}
- Colors: ${identity.palette.primary} / ${identity.palette.secondary}; eyes ${identity.palette.eyes}
- Silhouette: ${identity.silhouette}; Ears: ${identity.ears}; Tail: ${identity.tail}
- Markings: ${identity.markings}; Vibe: ${identity.vibe}; Notes: ${identity.notes}
`.trim()
}

function makeMoveVisualPrompt(creatureName, move, identity) {
  return `
Effect-only render for "${move.name}" used by "${creatureName}".
Render ONLY the move's energy/effect on a transparent background.
No creature/scenery/UI/text/borders.

Palette hints:
- Primary: ${identity.palette.primary}
- Secondary: ${identity.palette.secondary}
- Accent: ${identity.palette.eyes}

Resolution: ${MOVE_VISUAL_SIZE}
Type: ${move.type} | Category: ${move.category}
Brief: ${move.visual}
Theme: ${THEME}
`.trim()
}
function makeFightBackgroundPrompt(creatureAName, creatureBName) {
  const biomes = [
    'lush forest clearing with dappled sunlight',
    'open meadow with wildflowers and rolling hills',
    'sandy beach with distant waves and rocky outcrops',
    'red-rock canyon floor with scattered scrub',
    'misty waterfall glade with mossy stones',
    'alpine mountain foothills with evergreens',
    'golden grassland under a bright sky'
  ]
  const biome = biomes[Math.floor(Math.random() * biomes.length)]
  return `
Create a cinematic OUTDOOR NATURE battle arena background (${biome}) for a 2D creature duel between "${creatureAName}" and "${creatureBName}".
- Style: polished game arena with subtle natural landmarks and soft parallax hints.
- Lighting: bright daytime; clear visibility.
- Composition: a neutral mid-ground patch for two sprites to stand.
- Absolutely NO characters, silhouettes, UI, logos, text, or man-made structures.
- Resolution: ${FIGHT_BG_SIZE}.
`.trim()
}

/* ===================== IMAGE GEN HELPERS ===================== */
async function genImage(prompt, size = '1024x1024', transparent = true) {
  const openai = getOpenAI()
  const res = await openai.images.generate({
    model: 'gpt-image-1',
    prompt,
    size,
    background: transparent ? 'transparent' : undefined,
    quality: 'low',
    n: 1
  })
  const b64 = res.data?.[0]?.b64_json
  if (!b64) throw new Error('Image generation failed')
  return Buffer.from(b64, 'base64')
}

/* ===================== RIGHT-FACING ENFORCER ===================== */
/**
 * Heuristic check: looks at TR quadrant (emote), compares opaque pixel count
 * in left vs right third. If left third dominates significantly, we assume
 * the creature leans left; in that case we mirror the WHOLE sheet.
 * If inconclusive, we leave as-is.
 */
async function enforceRightFacingOnSheet(sheetPath) {
  try {
    const img = await Jimp.read(sheetPath)
    const W = img.bitmap.width
    const H = img.bitmap.height

    const colW = Math.floor((W - 2 * OUTER_MARGIN - SEPARATOR_GAP) / 2)
    const rowH = Math.floor((H - 2 * OUTER_MARGIN - SEPARATOR_GAP) / 2)

    const TR = {
      x: OUTER_MARGIN + colW + SEPARATOR_GAP,
      y: OUTER_MARGIN,
      w: colW, h: rowH
    }

    const crop = img.clone().crop(TR.x, TR.y, TR.w, TR.h).autocrop({ tolerance: AUTOCROP_TOL, leaveBorder: 0 })
    const w = crop.bitmap.width, h = crop.bitmap.height
    if (w < 10 || h < 10) return // too small, skip

    const third = Math.max(3, Math.floor(w / 3))
    let leftCount = 0, rightCount = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < third; x++) {
        const a = crop.bitmap.data[(y*w + x)*4 + 3]
        if (a > 10) leftCount++
      }
      for (let x = w - third; x < w; x++) {
        const a = crop.bitmap.data[(y*w + x)*4 + 3]
        if (a > 10) rightCount++
      }
    }
    // If left side has 25% more opaque pixels than right, assume left-facing.
    if (leftCount > rightCount * 1.25) {
      const mirrored = img.clone().mirror(true, false)
      await mirrored.writeAsync(sheetPath)
      console.log('↔️  RIGHT-FACING ENFORCER: Sheet mirrored to force RIGHT orientation.')
    }
  } catch (e) {
    console.warn('RIGHT-FACING ENFORCER skipped:', e?.message || e)
  }
}

/* ===================== SHEET GEN ===================== */
async function generateFourSpriteSheetImage(baseDir, identityPack, creatureTypes) {
  const { identity, emote_brief, moveA, moveB } = identityPack
  const SOURCES_DIR = path.join(baseDir, 'sources')
  ensureDir(SOURCES_DIR)
  await emptyDir(SOURCES_DIR)

  const prompt = makeFourSpriteSheetPrompt(identity, emote_brief, moveA, moveB, creatureTypes)
  const buf = await genImage(prompt, TARGET_SIZE, true)
  const SHEET_PATH = path.join(baseDir, 'four_sprites_sheet.png')
  await fsp.writeFile(SHEET_PATH, buf)

  // Try to enforce right-facing after generation
  await enforceRightFacingOnSheet(SHEET_PATH)

  return { SHEET_PATH, SOURCES_DIR }
}

/* ===================== EXTRACT QUADRANTS ===================== */
async function extractByQuadrants(baseDir) {
  const SHEET_PATH = path.join(baseDir, 'four_sprites_sheet.png')
  const SPRITES_DIR = path.join(baseDir, 'sprites_from_sheet')
  ensureDir(SPRITES_DIR)
  await emptyDir(SPRITES_DIR)

  const sheet = await Jimp.read(SHEET_PATH)
  const W = sheet.bitmap.width
  const H = sheet.bitmap.height

  const colW = Math.floor((W - 2 * OUTER_MARGIN - SEPARATOR_GAP) / 2)
  const rowH = Math.floor((H - 2 * OUTER_MARGIN - SEPARATOR_GAP) / 2)

  const TL = { name: 'TL', x: OUTER_MARGIN,                               y: OUTER_MARGIN,                               w: colW, h: rowH }
  const TR = { name: 'TR', x: OUTER_MARGIN + colW + SEPARATOR_GAP,         y: OUTER_MARGIN,                               w: colW, h: rowH }
  const BL = { name: 'BL', x: OUTER_MARGIN,                                y: OUTER_MARGIN + rowH + SEPARATOR_GAP,        w: colW, h: rowH }
  const BR = { name: 'BR', x: OUTER_MARGIN + colW + SEPARATOR_GAP,         y: OUTER_MARGIN + rowH + SEPARATOR_GAP,        w: colW, h: rowH }

  const order = [TR, TL, BR, BL]

  const saved = []
  for (let i = 0; i < order.length; i++) {
    const q = order[i]
    let crop = sheet.clone().crop(q.x, q.y, q.w, q.h)
    crop.autocrop({ tolerance: AUTOCROP_TOL, leaveBorder: 0 })

    const padded = new Jimp(
      Math.max(1, crop.bitmap.width + EXTRACT_PADDING * 2),
      Math.max(1, crop.bitmap.height + EXTRACT_PADDING * 2),
      0x00000000
    )
    padded.composite(crop, EXTRACT_PADDING, EXTRACT_PADDING)

    const outPath = path.join(SPRITES_DIR, `sprite_${String(i + 1).padStart(2, '0')}_${q.name}.png`)
    await padded.writeAsync(outPath)
    saved.push({ outPath, quadrant: q.name })
  }

  return { SHEET_PATH, SPRITES_DIR, saved }
}

/* ===================== B-SIDE: FLIP SPRITES FOR CREATURE B ===================== */
async function flipAllSpritesHorizontally(spritesDir) {
  const files = (await fsp.readdir(spritesDir)).filter(f => f.toLowerCase().endsWith('.png'))
  for (const f of files) {
    const p = path.join(spritesDir, f)
    const img = await Jimp.read(p)
    img.mirror(true, false)
    await img.writeAsync(p)
  }
}

/* ===================== ICONS & DRAW HELPERS ===================== */
const STAT_ICON_FILENAMES = {
  hp:  'heart.png',
  atk: 'attack.png',
  def: 'defence.png',
  spa: 'magicAttack.png',
  spd: 'magicDefence.png',
  spe: 'speed.png',
  power: 'power.png',
  accuracy: 'accuracy.png',
  nature: 'nature.png',
}
async function loadStatIcons(iconsDirRoot = path.resolve('./icons/stats')) {
  const result = {}
  await Promise.all(Object.entries(STAT_ICON_FILENAMES).map(async ([key, fname]) => {
    const p = path.join(iconsDirRoot, fname)
    try { result[key] = fs.existsSync(p) ? await Jimp.read(p) : null }
    catch { result[key] = null }
  }))
  return result
}
async function loadTypeIcons(typesDirRoot = path.resolve('./icons/types')) {
  const map = {}
  for (const t of POKEMON_TYPES) {
    const fname = `${t.toLowerCase()}.png`
    const p = path.join(typesDirRoot, fname)
    try { map[t] = fs.existsSync(p) ? await Jimp.read(p) : null }
    catch { map[t] = null }
  }
  return map
}
function drawHorizontalLine(panel, x1, x2, y, colorHex) {
  for (let x = x1; x <= x2; x++) panel.setPixelColor(colorHex, x, y)
}
async function drawTypeChip(panel, x, y, w, h, type, typeIconsMap) {
  const color = TYPE_COLORS[type] || '#888'
  const chip = new Jimp(w, h, Jimp.cssColorToHex(color))
  chip.opacity(0.92)
  panel.composite(chip, x, y)

  let leftTextX = x + 10
  const tIcon = typeIconsMap?.[type] || null
  if (tIcon) {
    const iconH = Math.min(h - 8, 28)
    const icon = tIcon.clone().contain(iconH, iconH, Jimp.RESIZE_BILINEAR)
    const iy = y + Math.round((h - iconH)/2)
    const ix = x + 8
    panel.composite(icon, ix, iy)
    leftTextX = ix + iconH + 8
  }
  return { leftTextX }
}
function drawStatBar(panel, x, y, width, height, pct, bgColor = '#332417', fillColor = '#E1B864') {
  const bgBar = new Jimp(width, height, Jimp.cssColorToHex(bgColor))
  bgBar.opacity(0.95)
  panel.composite(bgBar, x, y)
  const fillW = Math.max(6, Math.round(width * clamp(pct, 0, 1)))
  const fill = new Jimp(fillW, height, Jimp.cssColorToHex(fillColor))
  panel.composite(fill, x, y)
}

/* ===================== STATS PANEL (stats ONLY, centered) ===================== */
async function renderStatsPanel({
  outPath,
  creatureName,
  types, stats,
  bgW, bgH,
  statIcons,
  typeIcons
}) {
  const panelW = Math.max(320, bgW - PANEL_SIDE_MARGIN_PX * 2)
  const panelH = Math.round(bgH * 0.28)
  const panel = new Jimp(panelW, panelH, 0x00000000)

  const card = new Jimp(panelW, panelH, Jimp.cssColorToHex('#0e0a08')); card.opacity(0.78)
  panel.composite(card, 0, 0)

  const GOLD_HEX = Jimp.cssColorToHex('rgba(225,184,100,0.78)')
  const border = 3
  for (let x = 0; x < panelW; x++) {
    for (let b = 0; b < border; b++) {
      panel.setPixelColor(GOLD_HEX, x, b)
      panel.setPixelColor(GOLD_HEX, x, panelH - 1 - b)
    }
  }
  for (let y = 0; y < panelH; y++) {
    for (let b = 0; b < border; b++) {
      panel.setPixelColor(GOLD_HEX, b, y)
      panel.setPixelColor(GOLD_HEX, panelW - 1 - b, y)
    }
  }

  const fontTitle = await loadFontBuiltin(32, 'white')
  const fontType  = await loadFontBuiltin(32, 'white')
  const font32    = await loadFontBuiltin(32, 'white')

  const leftX = 18
  const topPad = 14

  panel.print(fontTitle, leftX, topPad, creatureName)
  if (statIcons?.nature) {
    const deco = statIcons.nature.clone().contain(26, 26, Jimp.RESIZE_BILINEAR)
    panel.composite(deco, panelW - 18 - 26, 12)
  }

  const badgeY = topPad + 32 + NAME_TYPES_EXTRA_VGAP
  const badgeH = 48
  const chipGap = 14
  const typesArr = Array.isArray(types) ? types : [types]
  const chipW = Math.min(Math.floor((panelW - leftX*2 - chipGap) / (typesArr.length || 1)), 260)

  let chipX = leftX
  for (const t of typesArr) {
    const { leftTextX } = await drawTypeChip(panel, chipX, badgeY, chipW, badgeH, t, typeIcons)
    panel.print(fontType, leftTextX, badgeY + 8, String(t).toUpperCase())
    chipX += chipW + chipGap
  }

  let y = badgeY + badgeH + 14
  drawHorizontalLine(panel, leftX, panelW - leftX, y, GOLD_HEX)
  y += 12

  // Bars shifted left so numbers never clip to the right
  const nameAreaW = 190
  const rightValuePad = 90
  const barW = panelW - leftX*2 - nameAreaW - rightValuePad
  const barH = 22
  const rowH = 40

  const keys = ['hp','atk','def','spa','spd','spe']
  for (const k of keys) {
    const { label, min, max } = STAT_BOUNDS[k]
    const v = stats[k]
    const pct = (v - min) / (max - min)

    let labelX = leftX
    if (statIcons?.[k]) {
      const ico = statIcons[k].clone().contain(24, 24, Jimp.RESIZE_BILINEAR)
      panel.composite(ico, labelX, y + Math.round((barH - 24)/2))
      labelX += 24 + 8
    }
    panel.print(font32, labelX, y - 2, label)

    drawStatBar(panel, leftX + nameAreaW, y - 2, barW, barH, pct)
    panel.print(font32, leftX + nameAreaW + barW + 10, y - 4, String(v))
    y += rowH
  }

  await panel.writeAsync(outPath)
  return { path: outPath, width: panelW, height: panelH }
}

/* ===================== MOVE BOARD (bottom, 2 tiles side-by-side) ===================== */
async function renderMoveBoardPanel({
  outPath,
  moveA, moveB,
  moveImgAPath, moveImgBPath,
  bgW, bgH,
  statIcons, typeIcons
}) {
  const panelW = Math.max(320, Math.round(bgW * 0.92))
  const panelH = Math.round(bgH * 0.24)
  const panel = new Jimp(panelW, panelH, 0x00000000)

  const card = new Jimp(panelW, panelH, Jimp.cssColorToHex('#0e0a08')); card.opacity(0.78)
  panel.composite(card, 0, 0)

  const GOLD_HEX = Jimp.cssColorToHex('rgba(225,184,100,0.78)')
  const border = 3
  for (let x = 0; x < panelW; x++) {
    for (let b = 0; b < border; b++) {
      panel.setPixelColor(GOLD_HEX, x, b)
      panel.setPixelColor(GOLD_HEX, x, panelH - 1 - b)
    }
  }
  for (let y = 0; y < panelH; y++) {
    for (let b = 0; b < border; b++) {
      panel.setPixelColor(GOLD_HEX, b, y)
      panel.setPixelColor(GOLD_HEX, panelW - 1 - b, y)
    }
  }

  const gapX = 16
  const innerPad = 10
  const tileW = Math.floor((panelW - gapX*3) / 2)
  const tileH = panelH - innerPad*2
  const tiles = [
    { move: moveA, imgPath: moveImgAPath, x: gapX, y: innerPad, w: tileW, h: tileH },
    { move: moveB, imgPath: moveImgBPath, x: gapX*2 + tileW, y: innerPad, w: tileW, h: tileH },
  ]

  for (const t of tiles) {
    // tile box
    for (let x = 0; x < t.w; x++) {
      panel.setPixelColor(GOLD_HEX, t.x + x, t.y)
      panel.setPixelColor(GOLD_HEX, t.x + x, t.y + t.h - 1)
    }
    for (let y = 0; y < t.h; y++) {
      panel.setPixelColor(GOLD_HEX, t.x, y + t.y)
      panel.setPixelColor(GOLD_HEX, t.x + t.w - 1, y + t.y)
    }

    // move visual, top
    const imgPadTop = 8
    const imgSidePad = 8
    const reservedHForText = 28 + 8 + 28 + 8 + 22 + 8 + 22 + 8
    const imgMaxH = Math.max(24, Math.min(t.h * 0.5, t.h - reservedHForText))
    try {
      const mvImg = await Jimp.read(t.imgPath)
      const scale = Math.min((t.w - imgSidePad*2) / mvImg.bitmap.width, imgMaxH / mvImg.bitmap.height)
      const iw = Math.max(1, Math.round(mvImg.bitmap.width * scale))
      const ih = Math.max(1, Math.round(mvImg.bitmap.height * scale))
      const ix = t.x + Math.round((t.w - iw)/2)
      const iy = t.y + imgPadTop
      const scaled = mvImg.clone().resize(iw, ih, Jimp.RESIZE_BILINEAR)
      panel.composite(scaled, ix, iy)
    } catch {
      const ph = new Jimp(t.w - imgSidePad*2, Math.round(imgMaxH), Jimp.cssColorToHex('#332417'))
      ph.opacity(0.6)
      panel.composite(ph, t.x + imgSidePad, t.y + imgPadTop)
    }

    const nameFont  = await loadFontBuiltin(32, 'white')
    const smallFont = await loadFontBuiltin(16, 'white')

    const nameY = t.y + imgPadTop + Math.round(imgMaxH) + 6
    const nameLeftX = t.x + 8
    panel.print(nameFont, nameLeftX, nameY, t.move.name)

    // category tag same row, right side
    const catText = String(t.move.category || 'Physical').toUpperCase()
    const catBoxW = 128
    const catX = t.x + t.w - catBoxW - 8
    const catY = nameY + 4
    const catBg = new Jimp(catBoxW, 24, Jimp.cssColorToHex('#2a2018')); catBg.opacity(0.8)
    panel.composite(catBg, catX, nameY + 2)
    panel.print(smallFont, catX + 8, catY, catText)

    // type chip under name
    const chipY = nameY + 28 + 8
    const chipH = 24
    const chipW = Math.min(200, t.w - 16)
    const chipRes = await drawTypeChip(panel, t.x + 8, chipY, chipW, chipH, t.move.type || 'Normal', typeIcons)
    panel.print(await loadFontBuiltin(16, 'white'), chipRes.leftTextX, chipY + 4, (t.move.type || 'Normal').toUpperCase())

    // mini bars (POW / ACC)
    const labelAreaW = 56
    const BAR_SHIFT_RIGHT = 6
    const statBarLeft = t.x + 8 + labelAreaW + BAR_SHIFT_RIGHT
    const statBarW = t.w - 16 - labelAreaW - BAR_SHIFT_RIGHT - 48
    const statBarH = 20

    // POWER
    let rowY = chipY + chipH + 6
    let labelX = t.x + 8
    if (statIcons?.power) {
      const pIco = statIcons.power.clone().contain(18, 18, Jimp.RESIZE_BILINEAR)
      panel.composite(pIco, labelX, rowY + Math.round((statBarH - 18)/2))
      labelX += 18 + 6
    }
    panel.print(await loadFontBuiltin(16,'white'), labelX, rowY + 2, 'POW')
    const pMin = 20, pMax = 150
    const pVal = clamp(Number(t.move.power) || 0, 0, pMax)
    const pPct = (pVal - pMin) / Math.max(1, (pMax - pMin))
    drawStatBar(panel, statBarLeft, rowY, statBarW, statBarH, pPct)
    panel.print(await loadFontBuiltin(16,'white'), statBarLeft + statBarW + 6, rowY + 2, String(pVal))

    // ACCURACY
    rowY += statBarH + 6
    labelX = t.x + 8
    if (statIcons?.accuracy) {
      const aIco = statIcons.accuracy.clone().contain(18, 18, Jimp.RESIZE_BILINEAR)
      panel.composite(aIco, labelX, rowY + Math.round((statBarH - 18)/2))
      labelX += 18 + 6
    }
    panel.print(await loadFontBuiltin(16,'white'), labelX, rowY + 2, 'ACC')
    const aMin = 0, aMax = 100
    const aVal = clamp(Number(t.move.accuracy) || 0, aMin, aMax)
    const aPct = (aVal - aMin) / Math.max(1, (aMax - aMin))
    drawStatBar(panel, statBarLeft, rowY, statBarW, statBarH, aPct)
    panel.print(await loadFontBuiltin(16,'white'), statBarLeft + statBarW + 6, rowY + 2, `${aVal}%`)
  }

  await panel.writeAsync(outPath)
  return { path: outPath, width: panelW, height: panelH }
}

/* ===================== ONE CREATURE PIPELINE ===================== */
async function runCreaturePipeline(seed, indexLabel = 'creature') {
  const idPack = await generateIdentityAndMoves(seed)
  const { creature_name, identity, emote_brief } = idPack

  const { types, stats } = generateTypesAndStats(seed || creature_name)

  const preferred = types[Math.floor(Math.random()*types.length)]
  const moveMeta = await generateMovesOnly(`${seed}__moves__${Math.random().toString(36).slice(2)}`, POKEMON_TYPES, preferred)
  const moveA = balanceMoveAccuracy({ ...idPack.moveA, ...moveMeta.moveA })
  const moveB = balanceMoveAccuracy({ ...idPack.moveB, ...moveMeta.moveB })

  const slug = slugify(creature_name)
  const baseDir = path.join(OUT_DIR, `${indexLabel}__${slug}`)
  ensureDir(baseDir)
  await emptyDir(baseDir)

  console.log(`\n=== Generating: ${creature_name} (${indexLabel}) ===`)
  console.log(`Types: ${types.join('/')} | Stats total: ${stats.total}`)
  console.log(`Moves: ${moveA.name} [${moveA.type}] P${moveA.power}/A${moveA.accuracy}% | ${moveB.name} [${moveB.type}] P${moveB.power}/A${moveB.accuracy}%`)

  await generateFourSpriteSheetImage(baseDir, { identity, emote_brief, moveA, moveB }, types)
  await extractByQuadrants(baseDir)
  await generateMoveVisuals(baseDir, creature_name, moveA, moveB, identity)

  return {
    creature_name,
    identity,
    emote_brief,
    moveA,
    moveB,
    types,
    stats,
    baseDir,
    sheet: path.join(baseDir, 'four_sprites_sheet.png'),
    spritesDir: path.join(baseDir, 'sprites_from_sheet'),
    sourcesDir: path.join(baseDir, 'sources'),
    moveVisualsDir: path.join(baseDir, 'move_visuals')
  }
}

/* ===================== MOVE VISUALS ===================== */
async function generateMoveVisuals(baseDir, creatureName, moveA, moveB, identity) {
  const MOVES_DIR = path.join(baseDir, 'move_visuals')
  ensureDir(MOVES_DIR)
  await emptyDir(MOVES_DIR)

  const visuals = []
  for (const mv of [moveA, moveB]) {
    const prompt = makeMoveVisualPrompt(creatureName, mv, identity)
    const buf = await genImage(prompt, MOVE_VISUAL_SIZE, true)
    const file = path.join(MOVES_DIR, `${sanitizeName(mv.name)}.png`)
    await fsp.writeFile(file, buf)
    visuals.push({ name: mv.name, path: file })
  }
  return { MOVES_DIR, visuals }
}

/* ===================== FINDERS ===================== */
function findIdleSpritePath(spritesDir) {
  const files = fs.readdirSync(spritesDir).filter(f => f.endsWith('.png'))
  const tl = files.find(f => /_TL\.png$/i.test(f))
  if (!tl) throw new Error(`Idle sprite (_TL) not found in ${spritesDir}`)
  return path.join(spritesDir, tl)
}
function findEmoteSpritePath(spritesDir) {
  const files = fs.readdirSync(spritesDir).filter(f => f.endsWith('.png'))
  const tr = files.find(f => /_TR\.png$/i.test(f))
  if (!tr) throw new Error(`Emote sprite (_TR) not found in ${spritesDir}`)
  return path.join(spritesDir, tr)
}
function findMoveASpritePath(spritesDir) {
  const files = fs.readdirSync(spritesDir).filter(f => f.endsWith('.png'))
  const bl = files.find(f => /_BL\.png$/i.test(f))
  if (!bl) throw new Error(`Move A sprite (_BL) not found in ${spritesDir}`)
  return path.join(spritesDir, bl)
}
function findMoveBSpritePath(spritesDir) {
  const files = fs.readdirSync(spritesDir).filter(f => f.endsWith('.png'))
  const br = files.find(f => /_BR\.png$/i.test(f))
  if (!br) throw new Error(`Move B sprite (_BR) not found in ${spritesDir}`)
  return path.join(spritesDir, br)
}
function moveAVisualPath(baseDir, moveAName) {
  const p = path.join(baseDir, 'move_visuals', `${sanitizeName(moveAName)}.png`)
  if (!fs.existsSync(p)) throw new Error(`Move A visual not found: ${p}`)
  return p
}
function moveBVisualPath(baseDir, moveBName) {
  const p = path.join(baseDir, 'move_visuals', `${sanitizeName(moveBName)}.png`)
  if (!fs.existsSync(p)) throw new Error(`Move B visual not found: ${p}`)
  return p
}

/* ===================== FIGHT BACKGROUND ===================== */
async function generateFightBackground(creatureAName, creatureBName, outDir) {
  ensureDir(outDir)
  const buf = await genImage(makeFightBackgroundPrompt(creatureAName, creatureBName), FIGHT_BG_SIZE, false)
  const p = path.join(outDir, 'fight_background.png')
  await fsp.writeFile(p, buf)
  return p
}

/* ===================== EASING ===================== */
function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3) }
function easeInOut(t)    { return t<0.5 ? 2*t*t : 1 - Math.pow(-2*t+2,2)/2 }

/* ===================== TYPE EFFECTIVENESS & DAMAGE ===================== */
const TYPE_EFFECTIVENESS = {
  Normal:  { Rock:0.5, Ghost:0.0, Steel:0.5 },
  Fire:    { Fire:0.5, Water:0.5, Grass:2, Ice:2, Bug:2, Rock:0.5, Dragon:0.5, Steel:2 },
  Water:   { Fire:2, Water:0.5, Grass:0.5, Ground:2, Rock:2, Dragon:0.5 },
  Grass:   { Fire:0.5, Water:2, Grass:0.5, Poison:0.5, Ground:2, Flying:0.5, Bug:0.5, Rock:2, Dragon:0.5, Steel:0.5 },
  Electric:{ Water:2, Electric:0.5, Grass:0.5, Ground:0.0, Flying:2, Dragon:0.5 },
  Ice:     { Fire:0.5, Water:0.5, Grass:2, Ground:2, Flying:2, Dragon:2, Steel:0.5 },
  Fighting:{ Normal:2, Ice:2, Rock:2, Dark:2, Steel:2, Poison:0.5, Flying:0.5, Psychic:0.5, Bug:0.5, Fairy:0.5, Ghost:0.0 },
  Poison:  { Grass:2, Fairy:2, Poison:0.5, Ground:0.5, Rock:0.5, Ghost:0.5, Steel:0.0 },
  Ground:  { Fire:2, Electric:2, Poison:2, Rock:2, Steel:2, Grass:0.5, Bug:0.5, Flying:0.0 },
  Flying:  { Grass:2, Fighting:2, Bug:2, Electric:0.5, Rock:0.5, Steel:0.5 },
  Psychic: { Fighting:2, Poison:2, Psychic:0.5, Steel:0.5, Dark:0.0 },
  Bug:     { Grass:2, Psychic:2, Dark:2, Fire:0.5, Fighting:0.5, Poison:0.5, Flying:0.5, Ghost:0.5, Steel:0.5, Fairy:0.5 },
  Rock:    { Fire:2, Ice:2, Flying:2, Bug:2, Fighting:0.5, Ground:0.5, Steel:0.5 },
  Ghost:   { Psychic:2, Ghost:2, Dark:0.5, Normal:0.0 },
  Dragon:  { Dragon:2, Steel:0.5, Fairy:0.0 },
  Dark:    { Psychic:2, Ghost:2, Fighting:0.5, Dark:0.5, Fairy:0.5 },
  Steel:   { Rock:2, Ice:2, Fairy:2, Fire:0.5, Water:0.5, Electric:0.5, Steel:0.5 },
  Fairy:   { Fighting:2, Dragon:2, Dark:2, Fire:0.5, Poison:0.5, Steel:0.5 },
}
function effectivenessVs(defenderTypes, attackType){
  const arr = Array.isArray(defenderTypes) ? defenderTypes : [defenderTypes]
  return arr.reduce((mult, t) => {
    const row = TYPE_EFFECTIVENESS[attackType] || {}
    const m = row[t] ?? 1.0
    return mult * m
  }, 1.0)
}
function calcDamage({ level = 50, movePower, category, atk, def, moveType, attackerTypes, defenderTypes }) {
  const base = Math.floor(Math.floor((2*level)/5 + 2) * movePower * (atk/Math.max(1, def)) / 50) + 2
  const atkTypesArr = Array.isArray(attackerTypes) ? attackerTypes : [attackerTypes]
  const stab  = atkTypesArr.includes(moveType) ? 1.5 : 1.0
  const eff   = effectivenessVs(defenderTypes, moveType)
  const rand  = 0.85 + Math.random() * 0.15
  const dmg   = Math.max(1, Math.floor(base * stab * eff * rand))
  return { dmg, eff, stab }
}

/* ===================== HEALTH BAR ===================== */
function drawHealthBar(frame, centerX, aboveY, width, height, hp, maxHp) {
  const barW = width, barH = height
  const x = Math.round(centerX - barW/2)
  const y = Math.max(0, aboveY - barH - 8)
  const bg = new Jimp(barW, barH, Jimp.cssColorToHex('#2b1c14')); bg.opacity(0.8)
  frame.composite(bg, x, y)
  const pct = clamp(hp / Math.max(1,maxHp), 0, 1)
  const fillW = Math.max(1, Math.round(barW * pct))
  const fill = new Jimp(fillW, barH, Jimp.cssColorToHex('#E1B864'))
  frame.composite(fill, x, y)
}

/* ===================== AUDIO TIMELINE ===================== */
function makeAudioTimeline() {
  return {
    cues: [],
    push(kind, t) { this.cues.push({ kind, t: Math.max(0, t) }) }
  }
}
function normalizeTimelineForEmotes(timeline, videoDurationSec) {
  const cues = Array.isArray(timeline?.cues) ? [...timeline.cues] : []
  const hasA = cues.some(c=>c.kind==='emoteA')
  const hasB = cues.some(c=>c.kind==='emoteB')
  const statA = cues.find(c=>c.kind==='statA')
  const statB = cues.find(c=>c.kind==='statB')
  if (!hasA && statA) cues.push({ kind:'emoteA', t: clamp(statA.t||0, 0, videoDurationSec) })
  if (!hasB && statB) cues.push({ kind:'emoteB', t: clamp(statB.t||0, 0, videoDurationSec) })
  return { cues: cues.filter(c=>c.kind!=='statA' && c.kind!=='statB').sort((a,b)=>(a.t||0)-(b.t||0)) }
}

/* ===================== BLINK/POPUPS ===================== */
async function blinkTargetFrames({...args}) {
  let {
    frames,
    bg, axX, aY, A_sprite,
    bxX, bY, B_sprite,
    targetSide,
    outFramesDir,
    framesSoFar,
    hpA, maxHpA, hpB, maxHpB,
    barW=180, barH=16
  } = args
  let fIdx = framesSoFar
  for (let i=0;i<frames;i++){
    const frame = bg.clone()
    const visible = (Math.floor(i/3) % 2 === 0)
    if (targetSide === 'A') {
      frame.composite(B_sprite, bxX, bY)
      if (visible) frame.composite(A_sprite, axX, aY)
    } else {
      frame.composite(A_sprite, axX, aY)
      if (visible) frame.composite(B_sprite, bxX, bY)
    }
    drawHealthBar(frame, axX + Math.floor(A_sprite.bitmap.width/2), aY, barW, barH, hpA, maxHpA)
    drawHealthBar(frame, bxX + Math.floor(B_sprite.bitmap.width/2), bY, barW, barH, hpB, maxHpB)
    await saveFrame(outFramesDir, fIdx++, frame)
  }
  return fIdx
}
async function animateHealthDrop({...args}) {
  let {
    bg, axX, aY, A_sprite,
    bxX, bY, B_sprite,
    outFramesDir, framesSoFar,
    fromHp, toHp, maxHp,
    side,
    otherHp, otherMaxHp,
    barW=180, barH=16,
    frames=18,
    popupText,
    popupStartX, popupStartY,
    popupRisePx = 40
  } = args
  let fIdx = framesSoFar
  const fontWhite = await loadFontBuiltin(32, 'white')
  const fontBlack = await loadFontBuiltin(32, 'black')

  for (let i=0;i<frames;i++){
    const t = i/(frames-1)
    const hpNow = Math.round(fromHp + (toHp - fromHp)*t)
    const frame = bg.clone()
    frame.composite(A_sprite, axX, aY)
    frame.composite(B_sprite, bxX, bY)

    if (side === 'A') {
      drawHealthBar(frame, axX + Math.floor(A_sprite.bitmap.width/2), aY, barW, barH, hpNow, maxHp)
      drawHealthBar(frame, bxX + Math.floor(B_sprite.bitmap.width/2), bY, barW, barH, otherHp, otherMaxHp)
    } else {
      drawHealthBar(frame, axX + Math.floor(A_sprite.bitmap.width/2), aY, barW, barH, otherHp, otherMaxHp)
      drawHealthBar(frame, bxX + Math.floor(B_sprite.bitmap.width/2), bY, barW, barH, hpNow, maxHp)
    }

    if (popupText) {
      const dy = Math.round(popupRisePx * t)
      const px = popupStartX
      const py = popupStartY - dy
      frame.print(fontBlack, px+1, py+1, popupText)
      frame.print(fontWhite, px,   py,   popupText)
    }

    await saveFrame(outFramesDir, fIdx++, frame)
  }
  return fIdx
}

/* ===================== CAMERA ZOOM + STATS SEQUENCE ===================== */
async function zoomStatsSequence({...args}) {
  let {
    baseFrameBuilder,
    bgW, bgH,
    focusBox,
    statsPanelImage,
    movePanelImage,
    outFramesDir,
    framesSoFar,
    audioTimeline,
    emoteCueKind
  } = args
  let fIdx = framesSoFar
  const panelH = statsPanelImage.bitmap.height
  const moveH = movePanelImage.bitmap.height

  const placeBoards = (frame) => {
    const statsX = Math.round((bgW - statsPanelImage.bitmap.width)/2)
    frame.composite(statsPanelImage, statsX, STAT_BOARD_TOP_GAP)
    const moveX = Math.round((bgW - movePanelImage.bitmap.width)/2)
    const moveY = bgH - moveH - MOVE_BOARD_BOTTOM_GAP
    frame.composite(movePanelImage, moveX, moveY)
  }

  const zoomMax = ZOOM_MAX * (1 + STATS_ZOOM_BUMP)

  function computeCyForZoom(z) {
    const ch = Math.round(bgH / z)
    const cw = Math.round(bgW / z)
    const panelBottomCanvas = STAT_BOARD_TOP_GAP + panelH
    const requiredTopInCrop = panelBottomCanvas / z + STATS_PANEL_CLEARANCE
    const creatureTopWorld = focusBox.cy - focusBox.h / 2
    const maxCyToKeepClear = creatureTopWorld - requiredTopInCrop + ch / 2
    const preferredCy = focusBox.cy + Math.round(bgH * STATS_PREFERRED_OFFSET_FRACTION)
    const cy = clamp(Math.min(preferredCy, maxCyToKeepClear), ch / 2, bgH - ch / 2)
    const cx = clamp(focusBox.cx, cw / 2, bgW - cw / 2)
    return { cx, cy, ch, cw }
  }

  const doZoomStep = async (z, recordStart = false) => {
    const { cx, cy, ch, cw } = computeCyForZoom(z)
    const x0 = clamp(Math.round(cx - cw / 2), 0, bgW - cw)
    const y0 = clamp(Math.round(cy - ch / 2), 0, bgH - ch)
    const base = await baseFrameBuilder()
    const cropped = base.clone().crop(x0, y0, cw, ch).resize(bgW, bgH, Jimp.RESIZE_BICUBIC)
    placeBoards(cropped)
    if (recordStart && audioTimeline) {
      audioTimeline.push(emoteCueKind, fIdx / FIGHT_FPS)
    }
    await saveFrame(outFramesDir, fIdx++, cropped)
  }

  for (let i = 0; i < ZOOM_IN_FRAMES; i++) {
    const t = i / (ZOOM_IN_FRAMES - 1)
    const z = 1 + (zoomMax - 1) * (t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t+2,2)/2)
    await doZoomStep(z, i === 0)
  }
  for (let i = 0; i < STATS_HOLD_FRAMES; i++) {
    await doZoomStep(zoomMax)
  }
  for (let i = 0; i < ZOOM_OUT_FRAMES; i++) {
    const t = i / (ZOOM_OUT_FRAMES - 1)
    const z = zoomMax - (zoomMax - 1) * (t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t+2,2)/2)
    await doZoomStep(z)
  }

  return fIdx
}

/* ===================== PROJECTILES ===================== */
async function drawProjectileSequence({...args}) {
  let {
    bg,
    outFramesDir,
    startX, startY,
    endX, endY,
    framesSoFar,
    projectileImg,
    layerLeft, layerRight,
    bars,
    framesOverride=null
  } = args
  const total = framesOverride ?? PROJECTILE_FRAMES
  let fIdx = framesSoFar
  for (let i = 0; i < total; i++) {
    const t = easeOutCubic(i / (total - 1))
    const x = Math.round(startX + (endX - startX) * t)
    const y = Math.round(startY + (endY - startY) * t)
    const frame = bg.clone()
    await layerLeft(frame)
    await layerRight(frame)
    frame.composite(projectileImg, x, y)

    if (bars) {
      const {
        axX, aY, A_sprite,
        bxX, bY, B_sprite,
        A_HP, A_MAX, B_HP, B_MAX,
        barW=180, barH=16
      } = bars
      drawHealthBar(frame, axX + Math.floor(A_sprite.bitmap.width/2), aY, barW, barH, A_HP, A_MAX)
      drawHealthBar(frame, bxX + Math.floor(B_sprite.bitmap.width/2), bY, barW, barH, B_HP, B_MAX)
    }

    await saveFrame(outFramesDir, fIdx++, frame)
  }
  return fIdx
}

/* ===================== VICTORY ===================== */
async function victorySequence({...args}) {
  let {
    bg, bgW, bgH,
    winner,
    axFinalX, aY, A_idle, A_emote,
    bxFinalX, bY, B_idle, B_emote,
    outFramesDir, framesSoFar,
    audioTimeline,
    winnerName
  } = args
  let fIdx = framesSoFar

  const winSpriteIdle  = (winner === 'A') ? A_idle  : B_idle
  const winSpriteEmote = (winner === 'A') ? A_emote : B_emote
  const winX = (winner === 'A') ? axFinalX : bxFinalX
  const winY = (winner === 'A') ? aY      : bY
  const emoteCenter = {
    cx: winX + Math.floor(winSpriteEmote.bitmap.width/2),
    cy: winY + Math.floor(winSpriteEmote.bitmap.height*0.55),
    w:  winSpriteEmote.bitmap.width,
    h:  winSpriteEmote.bitmap.height
  }

  const baseEmoteFrame = async () => {
    const frame = bg.clone()
    frame.composite(winSpriteEmote, winX, winY)
    return frame
  }

  audioTimeline.push(winner === 'A' ? 'emoteA' : 'emoteB', fIdx / FIGHT_FPS)

  for (let i=0; i<VICTORY_ZOOM_IN_FR; i++){
    const t = easeInOut(i/(VICTORY_ZOOM_IN_FR-1))
    const z = 1 + (VICTORY_ZOOM_MAX-1)*t
    const cw = Math.round(bgW / z)
    const ch = Math.round(bgH / z)
    const x0 = clamp(Math.round(emoteCenter.cx - cw/2), 0, bgW - cw)
    const y0 = clamp(Math.round(emoteCenter.cy - ch/2), 0, bgH - ch)
    const base = await baseEmoteFrame()
    const cropped = base.clone().crop(x0, y0, cw, ch).resize(bgW, bgH, Jimp.RESIZE_BICUBIC)
    await saveFrame(outFramesDir, fIdx++, cropped)
  }

  for (let i=0; i<VICTORY_HOLD_FRAMES; i++){
    const z = VICTORY_ZOOM_MAX
    const cw = Math.round(bgW / z)
    const ch = Math.round(bgH / z)
    const x0 = clamp(Math.round(emoteCenter.cx - cw/2), 0, bgW - cw)
    const y0 = clamp(Math.round(emoteCenter.cy - ch/2), 0, bgH - ch)
    const base = await baseEmoteFrame()
    const cropped = base.clone().crop(x0, y0, cw, ch).resize(bgW, bgH, Jimp.RESIZE_BICUBIC)

    await saveFrame(outFramesDir, fIdx++, cropped)
  }

  const bannerW = Math.round(bgW * 0.9)
  const bannerH = 96
  const banner = new Jimp(bannerW, bannerH, Jimp.cssColorToHex('#0e0a08'))
  banner.opacity(0.82)
  const GOLD_HEX = Jimp.cssColorToHex('rgba(225,184,100,0.9)')
  for (let x=0;x<bannerW;x++){ banner.setPixelColor(GOLD_HEX, x, 0); banner.setPixelColor(GOLD_HEX, x, bannerH-1) }
  for (let y=0;y<bannerH;y++){ banner.setPixelColor(GOLD_HEX, 0, y); banner.setPixelColor(GOLD_HEX, bannerW-1, y) }

  const titleFont = await loadFontBuiltin(64, 'white')
  const msg = `${winnerName} is victorious!`

  for (let i=0; i<VICTORY_BANNER_FRAMES; i++){
    const z = VICTORY_ZOOM_MAX
    const cw = Math.round(bgW / z)
    const ch = Math.round(bgH / z)
    const x0 = clamp(Math.round(emoteCenter.cx - cw/2), 0, bgW - cw)
    const y0 = clamp(Math.round(emoteCenter.cy - ch/2), 0, bgH - ch)
    const base = await baseEmoteFrame()
    const cropped = base.clone().crop(x0, y0, cw, ch).resize(bgW, bgH, Jimp.RESIZE_BICUBIC)

    const bx = Math.round((bgW - bannerW)/2)
    const by = VICTORY_BANNER_TOP
    const frame = cropped
    frame.composite(banner, bx, by)
    frame.print(titleFont, bx + 12, by + 12, {
      text: msg,
      alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
      alignmentY: Jimp.VERTICAL_ALIGN_MIDDLE
    }, bannerW - 24, bannerH - 24)

    await saveFrame(outFramesDir, fIdx++, frame)
  }

  return fIdx
}

/* ===================== FIGHT SCENE ===================== */
async function createFightFrames({...args}) {
  let {
    aName, bName,
    backgroundPath,
    spriteAPath,
    spriteBPath,
    spriteAEmotePath,
    spriteBEmotePath,
    spriteAMoveAPath,
    spriteBMoveAPath,
    spriteAMoveBPath,
    spriteBMoveBPath,
    moveAVisualAPath,
    moveAVisualBPath,
    moveBVisualAPath,
    moveBVisualBPath,
    statsPanelAPath,
    statsPanelBPath,
    movePanelAPath,
    movePanelBPath,
    outFramesDir,
    scaleFraction,
    aStats,
    bStats,
    aTypes,
    bTypes,
    aMoveMetaA,
    aMoveMetaB,
    bMoveMetaA,
    bMoveMetaB,
    audioTimeline
  } = args
  ensureDir(outFramesDir)
  await emptyDir(outFramesDir)

  const bg = await Jimp.read(backgroundPath)
  const bgW = bg.bitmap.width
  const bgH = bg.bitmap.height

  // Load sprites
  let A_idle   = await Jimp.read(spriteAPath)
  let B_idle   = await Jimp.read(spriteBPath)
  let A_emote  = await Jimp.read(spriteAEmotePath)
  let B_emote  = await Jimp.read(spriteBEmotePath)
  let A_moveA  = await Jimp.read(spriteAMoveAPath)
  let B_moveA  = await Jimp.read(spriteBMoveAPath)
  let A_moveB  = await Jimp.read(spriteAMoveBPath)
  let B_moveB  = await Jimp.read(spriteBMoveBPath)

  const targetH = Math.max(64, Math.round(bgH * scaleFraction))
  const scaleToHeight = (img, h) => img.resize(Math.round(img.bitmap.width * (h / img.bitmap.height)), h)
  A_idle=scaleToHeight(A_idle,targetH); A_emote=scaleToHeight(A_emote,targetH)
  A_moveA=scaleToHeight(A_moveA,targetH); A_moveB=scaleToHeight(A_moveB,targetH)
  B_idle=scaleToHeight(B_idle,targetH); B_emote=scaleToHeight(B_emote,targetH)
  B_moveA=scaleToHeight(B_moveA,targetH); B_moveB=scaleToHeight(B_moveB,targetH)

  // Projectiles
  const projTargetH = Math.max(32, Math.round(bgH * PROJECTILE_HEIGHT_FRACTION))
  let projA_A = (await Jimp.read(moveAVisualAPath)).resize(Jimp.AUTO, projTargetH, Jimp.RESIZE_BILINEAR)
  let projB_A = (await Jimp.read(moveAVisualBPath)).resize(Jimp.AUTO, projTargetH, Jimp.RESIZE_BILINEAR)
  let projA_B = (await Jimp.read(moveBVisualAPath)).resize(Jimp.AUTO, projTargetH, Jimp.RESIZE_BILINEAR)
  let projB_B = (await Jimp.read(moveBVisualBPath)).resize(Jimp.AUTO, projTargetH, Jimp.RESIZE_BILINEAR)

  // Vertical layout
  const centerY = Math.floor(bgH * 0.72)
  const aY = centerY - A_idle.bitmap.height
  const bY = centerY - B_idle.bitmap.height

  const edgeMargin = Math.max(16, Math.round(bgW * 0.08))
  const axFinalX = edgeMargin
  const bxFinalX = bgW - edgeMargin - B_idle.bitmap.width

  const axStartX = -A_idle.bitmap.width - 40
  const bxStartX = bgW + 40

  const statsPanelA = await Jimp.read(statsPanelAPath)
  const statsPanelB = await Jimp.read(statsPanelBPath)
  const movePanelA  = await Jimp.read(movePanelAPath)
  const movePanelB  = await Jimp.read(movePanelBPath)

  let fIdx = 0

  const buildFrameAEmote = async () => {
    const frame = bg.clone()
    frame.composite(A_emote, axFinalX, aY)
    return frame
  }
  const buildFrameBEmote = async () => {
    const frame = bg.clone()
    frame.composite(A_idle, axFinalX, aY)
    frame.composite(B_emote, bxFinalX, bY)
    return frame
  }

  // A floats in
  for (let i = 0; i < FIGHT_FRAMES_A; i++) {
    const t = easeOutCubic(i / (FIGHT_FRAMES_A - 1))
    const ax = Math.round(axStartX + (axFinalX - axStartX) * t)
    const frame = bg.clone()
    frame.composite(A_idle, ax, aY)
    await saveFrame(outFramesDir, fIdx++, frame)
  }

  // A stats zoom (B not visible)
  {
    const focusBoxA = {
      cx: axFinalX + Math.floor(A_emote.bitmap.width/2),
      cy: aY + Math.floor(A_emote.bitmap.height*0.55),
      w: A_emote.bitmap.width,
      h: A_emote.bitmap.height
    }
    fIdx = await zoomStatsSequence({
      baseFrameBuilder: buildFrameAEmote,
      bgW, bgH,
      focusBox: focusBoxA,
      statsPanelImage: statsPanelA,
      movePanelImage: movePanelA,
      outFramesDir,
      framesSoFar: fIdx,
      audioTimeline,
      emoteCueKind: 'emoteA'
    })
  }

  // A emotes briefly
  for (let i = 0; i < EMOTE_FRAMES; i++) {
    const frame = bg.clone()
    frame.composite(A_emote, axFinalX, aY)
    await saveFrame(outFramesDir, fIdx++, frame)
  }

  // B floats in
  for (let i = 0; i < FIGHT_FRAMES_B; i++) {
    const t = easeOutCubic(i / (FIGHT_FRAMES_B - 1))
    const bx = Math.round(bxStartX + (bxFinalX - bxStartX) * t)
    const frame = bg.clone()
    frame.composite(A_idle, axFinalX, aY)
    frame.composite(B_idle, bx, bY)
    await saveFrame(outFramesDir, fIdx++, frame)
  }

  // B stats zoom
  {
    const focusBoxB = {
      cx: bxFinalX + Math.floor(B_emote.bitmap.width/2),
      cy: bY + Math.floor(B_emote.bitmap.height*0.55),
      w: B_emote.bitmap.width,
      h: B_emote.bitmap.height
    }
    fIdx = await zoomStatsSequence({
      baseFrameBuilder: buildFrameBEmote,
      bgW, bgH,
      focusBox: focusBoxB,
      statsPanelImage: statsPanelB,
      movePanelImage: movePanelB,
      outFramesDir,
      framesSoFar: fIdx,
      audioTimeline,
      emoteCueKind: 'emoteB'
    })
  }

  // B emotes briefly
  for (let i = 0; i < EMOTE_FRAMES; i++) {
    const frame = bg.clone()
    frame.composite(A_idle, axFinalX, aY)
    frame.composite(B_emote, bxFinalX, bY)
    await saveFrame(outFramesDir, fIdx++, frame)
  }

  /* ===== TURN-BASED DUEL ===== */
  let A_HP = Math.max(1, Math.round(aStats.hp))
  let B_HP = Math.max(1, Math.round(bStats.hp))
  const A_MAX = A_HP, B_MAX = B_HP

  let attacker = (aStats.spe >= bStats.spe) ? 'A' : 'B'

  const pickMove = (side) => {
    if (side === 'A') {
      const useA = Math.random() < 0.5
      return {
        meta: useA ? aMoveMetaA : aMoveMetaB,
        spritePose: useA ? A_moveA : A_moveB,
        visualImg:  useA ? projA_A : projA_B
      }
    } else {
      const useA = Math.random() < 0.5
      return {
        meta: useA ? bMoveMetaA : bMoveMetaB,
        spritePose: useA ? B_moveA : B_moveB,
        visualImg:  useA ? projB_A : projB_B
      }
    }
  }

  const barW = 180, barH = 16

  const drawNeutral = async () => {
    const frame = bg.clone()
    frame.composite(A_idle, axFinalX, aY)
    frame.composite(B_idle, bxFinalX, bY)
    drawHealthBar(frame, axFinalX + Math.floor(A_idle.bitmap.width/2), aY, barW, barH, A_HP, A_MAX)
    drawHealthBar(frame, bxFinalX + Math.floor(B_idle.bitmap.width/2), bY, barW, barH, B_HP, B_MAX)
    await saveFrame(outFramesDir, fIdx++, frame)
  }

  for (let i=0;i<6;i++) await drawNeutral()

  // Lunge positions for physical attacks
  const lungeTargetPositions = () => {
    const gap = Math.round(Math.min(A_idle.bitmap.width, B_idle.bitmap.width) * 0.08)
    const attackX_A = bxFinalX - gap - A_idle.bitmap.width
    const baseAttackX_B = axFinalX + A_idle.bitmap.width + gap - B_idle.bitmap.width
    const offsetRight   = Math.floor(B_idle.bitmap.width * 1.0)
    const capped        = Math.min(bxFinalX - Math.floor(B_idle.bitmap.width*0.1), baseAttackX_B + offsetRight)
    const attackX_B     = Math.max(axFinalX + A_idle.bitmap.width + 10, capped)
    return { attackX_A, attackX_B }
  }

  duel:
  while (A_HP > 0 && B_HP > 0) {
    const isA = attacker === 'A'
    const defender = isA ? 'B' : 'A'
    const { meta, spritePose, visualImg } = pickMove(attacker)
    const category = String(meta.category||'Physical')

    if (category === 'Physical') {
      const { attackX_A, attackX_B } = lungeTargetPositions()
      const attStartX = isA ? axFinalX : bxFinalX
      const attEndX   = isA ? attackX_A : attackX_B
      const attY      = isA ? aY : bY

      // Approach (bars drawn at original anchors)
      for (let i=0;i<PHYS_APPROACH_FRAMES;i++){
        const t = easeOutCubic(i/(PHYS_APPROACH_FRAMES-1))
        const ax = isA ? Math.round(attStartX + (attEndX - attStartX)*t) : axFinalX
        const bx = isA ? bxFinalX : Math.round(attStartX + (attEndX - attStartX)*t)
        const frame = bg.clone()
        if (isA) { frame.composite(spritePose, ax, attY); frame.composite(B_idle, bxFinalX, bY) }
        else     { frame.composite(A_idle, axFinalX, aY); frame.composite(spritePose, bx, attY) }
        drawHealthBar(frame, axFinalX + Math.floor(A_idle.bitmap.width/2), aY, barW, barH, A_HP, A_MAX)
        drawHealthBar(frame, bxFinalX + Math.floor(B_idle.bitmap.width/2), bY, barW, barH, B_HP, B_MAX)
        await saveFrame(outFramesDir, fIdx++, frame)
      }

      // === PHYSICAL PROJECTILE TRAVEL ===
      const unitW = spritePose.bitmap.width
      let startX, endX

      if (isA) {
        startX = attEndX
        endX   = startX + (unitW * 0.5)
      } else {
        startX = attEndX - unitW
        endX   = startX - (unitW * 0.5)
      }

      const projY  = attY + Math.floor(spritePose.bitmap.height*0.5) - Math.floor(visualImg.bitmap.height / 2)

      const layerLeft  = async (frame) => { frame.composite(isA ? spritePose : A_idle, isA ? attEndX : axFinalX, aY) }
      const layerRight = async (frame) => { frame.composite(isA ? B_idle : spritePose, isA ? bxFinalX : attEndX, bY) }

      const projStartFrame = fIdx
      fIdx = await drawProjectileSequence({
        bg, outFramesDir,
        startX, startY: projY,
        endX,   endY:   projY,
        framesSoFar: fIdx,
        projectileImg: visualImg,
        layerLeft, layerRight,
        bars: {
          axX: axFinalX, aY, A_sprite: A_idle,
          bxX: bxFinalX, bY, B_sprite: B_idle,
          A_HP, A_MAX, B_HP, B_MAX,
          barW, barH
        },
        framesOverride: PHYS_PROJECTILE_FRAMES
      })
      const impactTimeSec = (projStartFrame + PHYS_PROJECTILE_FRAMES - 1) / FIGHT_FPS

      // Accuracy
      const hitRoll = Math.random()*100
      const hits = hitRoll <= (Number(meta.accuracy)||100)
      audioTimeline.push(hits ? 'hit' : 'miss', impactTimeSec)

      if (!hits) {
        for (let i=0;i<6;i++){
          const frame = bg.clone()
          if (isA) { frame.composite(spritePose, attEndX, aY); frame.composite(B_idle, bxFinalX, bY) }
          else     { frame.composite(A_idle, axFinalX, aY);   frame.composite(spritePose, attEndX, bY) }
          drawHealthBar(frame, axFinalX + Math.floor(A_idle.bitmap.width/2), aY, barW, barH, A_HP, A_MAX)
          drawHealthBar(frame, bxFinalX + Math.floor(B_idle.bitmap.width/2), bY, barW, barH, B_HP, B_MAX)
          await saveFrame(outFramesDir, fIdx++, frame)
        }
      } else {
        const atkStat   = isA ? aStats.atk : bStats.atk
        const defStat   = isA ? bStats.def : aStats.def
        const movePower = clamp(Number(meta.power)||40, 1, 250)
        const moveType  = meta.type
        const attackerTypes = isA ? aTypes : bTypes
        const defenderTypes = isA ? bTypes : aTypes
        const { dmg } = calcDamage({ level:50, movePower, category, atk:atkStat, def:Math.max(1,defStat), moveType, attackerTypes, defenderTypes })

        fIdx = await blinkTargetFrames({
          frames: 18,
          bg,
          axX: isA ? attEndX : axFinalX, aY, A_sprite: isA ? spritePose : A_idle,
          bxX: isA ? bxFinalX : attEndX, bY, B_sprite: isA ? B_idle : spritePose,
          targetSide: defender,
          outFramesDir, framesSoFar: fIdx,
          hpA: A_HP, maxHpA: A_MAX, hpB: B_HP, maxHpB: B_MAX,
          barW, barH
        })

        if (defender === 'A') {
          const newHp = Math.max(0, A_HP - dmg)
          const popupX = axFinalX + Math.floor(A_idle.bitmap.width/2) - 10
          const popupY = aY - 10
          fIdx = await animateHealthDrop({
            bg,
            axX: isA ? attEndX : axFinalX, aY, A_sprite: isA ? spritePose : A_idle,
            bxX: isA ? bxFinalX : attEndX, bY, B_sprite: isA ? B_idle : spritePose,
            outFramesDir, framesSoFar: fIdx,
            fromHp: A_HP, toHp: newHp, maxHp: A_MAX,
            side: 'A',
            otherHp: B_HP, otherMaxHp: B_MAX,
            barW, barH, frames: 20,
            popupText: `-${dmg}`,
            popupStartX: popupX, popupStartY: popupY,
            popupRisePx: 36
          })
          A_HP = newHp
        } else {
          const newHp = Math.max(0, B_HP - dmg)
          const popupX = bxFinalX + Math.floor(B_idle.bitmap.width/2) - 10
          const popupY = bY - 10
          fIdx = await animateHealthDrop({
            bg,
            axX: isA ? attEndX : axFinalX, aY, A_sprite: isA ? spritePose : A_idle,
            bxX: isA ? bxFinalX : attEndX, bY, B_sprite: isA ? B_idle : spritePose,
            outFramesDir, framesSoFar: fIdx,
            fromHp: B_HP, toHp: newHp, maxHp: B_MAX,
            side: 'B',
            otherHp: A_HP, otherMaxHp: A_MAX,
            barW, barH, frames: 20,
            popupText: `-${dmg}`,
            popupStartX: popupX, popupStartY: popupY,
            popupRisePx: 36
          })
          B_HP = newHp
        }

        if (A_HP <= 0 || B_HP <= 0) break duel
      }

      // Retreat
      for (let i=0;i<PHYS_RETREAT_FRAMES;i++){
        const t = easeInOut(i/(PHYS_RETREAT_FRAMES-1))
        const ax = isA ? Math.round(attEndX + (axFinalX - attEndX)*t) : axFinalX
        const bx = isA ? bxFinalX : Math.round(attEndX + (bxFinalX - attEndX)*t)
        const frame = bg.clone()
        if (isA) { frame.composite(spritePose, ax, aY); frame.composite(B_idle, bxFinalX, bY) }
        else     { frame.composite(A_idle, axFinalX, aY); frame.composite(spritePose, bx, bY) }
        drawHealthBar(frame, axFinalX + Math.floor(A_idle.bitmap.width/2), aY, barW, barH, A_HP, A_MAX)
        drawHealthBar(frame, bxFinalX + Math.floor(B_idle.bitmap.width/2), bY, barW, barH, B_HP, B_MAX)
        await saveFrame(outFramesDir, fIdx++, frame)
      }

      for (let i=0;i<6;i++) await drawNeutral()
      attacker = defender
      continue
    }

    // ===== SPECIAL =====
    {
      const frame = bg.clone()
      const poseA = isA ? spritePose : A_idle
      const poseB = isA ? B_idle : spritePose
      frame.composite(poseA, axFinalX, aY)
      frame.composite(poseB, bxFinalX, bY)
      drawHealthBar(frame, axFinalX + Math.floor(A_idle.bitmap.width/2), aY, barW, barH, A_HP, A_MAX)
      drawHealthBar(frame, bxFinalX + Math.floor(B_idle.bitmap.width/2), bY, barW, barH, B_HP, B_MAX)
      await saveFrame(outFramesDir, fIdx++, frame)

      const hitRoll = Math.random()*100
      const hits = hitRoll <= (Number(meta.accuracy)||100)

      const startX = isA
        ? axFinalX + spritePose.bitmap.width - Math.floor(spritePose.bitmap.width * 0.15)
        : bxFinalX + Math.floor(spritePose.bitmap.width * 0.15)
      let endX = isA
        ? (bxFinalX + Math.floor(B_idle.bitmap.width * 0.2) - A_idle.bitmap.width)
        : (axFinalX + A_idle.bitmap.width - Math.floor(A_idle.bitmap.width * 0.2))
      if (!isA) endX -= Math.round(B_idle.bitmap.width)

      const projY = isA
        ? (aY + Math.floor(spritePose.bitmap.height * 0.5) - Math.floor(visualImg.bitmap.height / 2))
        : (bY + Math.floor(spritePose.bitmap.height * 0.5) - Math.floor(visualImg.bitmap.height / 2))

      const layerLeft  = async (frame) => { frame.composite(isA ? spritePose : A_idle, axFinalX, aY) }
      const layerRight = async (frame) => { frame.composite(isA ? B_idle : spritePose, bxFinalX, bY) }

      const projStartFrame = fIdx
      fIdx = await drawProjectileSequence({
        bg, outFramesDir,
        startX, startY: projY,
        endX,   endY:   projY,
        framesSoFar: fIdx,
        projectileImg: visualImg,
        layerLeft, layerRight,
        bars: {
          axX: axFinalX, aY, A_sprite: A_idle,
          bxX: bxFinalX, bY, B_sprite: B_idle,
          A_HP, A_MAX, B_HP, B_MAX,
          barW, barH
        }
      })
      const impactTimeSec = (projStartFrame + PROJECTILE_FRAMES - 1) / FIGHT_FPS
      audioTimeline.push(hits ? 'hit' : 'miss', impactTimeSec)

      if (!hits) {
        for (let i=0;i<6;i++) await drawNeutral()
        attacker = defender
        continue
      }

      const movePower = clamp(Number(meta.power)||40, 1, 250)
      const moveType  = meta.type
      const realAtk   = isA ? (meta.category==='Physical'?aStats.atk:aStats.spa) : (meta.category==='Physical'?bStats.atk:bStats.spa)
      const realDef   = isA ? (meta.category==='Physical'?bStats.def:bStats.spd) : (meta.category==='Physical'?aStats.def:aStats.spd)
      const attackerTypes = isA ? aTypes : bTypes
      const defenderTypes = isA ? bTypes : aTypes
      const { dmg } = calcDamage({
        level: 50, movePower, category,
        atk: realAtk, def: Math.max(1,realDef),
        moveType, attackerTypes, defenderTypes
      })

      fIdx = await blinkTargetFrames({
        frames: 18,
        bg,
        axX: axFinalX, aY, A_sprite: A_idle,
        bxX: bxFinalX, bY, B_sprite: B_idle,
        targetSide: defender,
        outFramesDir,
        framesSoFar: fIdx,
        hpA: A_HP, maxHpA: A_MAX,
        hpB: B_HP, maxHpB: B_MAX,
        barW, barH
      })

      if (defender === 'A') {
        const newHp = Math.max(0, A_HP - dmg)
        const popupX = axFinalX + Math.floor(A_idle.bitmap.width/2) - 10
        const popupY = aY - 10
        fIdx = await animateHealthDrop({
          bg, axX: axFinalX, aY, A_sprite: A_idle,
          bxX: bxFinalX, bY, B_sprite: B_idle,
          outFramesDir, framesSoFar: fIdx,
          fromHp: A_HP, toHp: newHp, maxHp: A_MAX,
          side: 'A',
          otherHp: B_HP, otherMaxHp: B_MAX,
          barW, barH, frames: 20,
          popupText: `-${dmg}`,
          popupStartX: popupX, popupStartY: popupY,
          popupRisePx: 36
        })
        A_HP = newHp
      } else {
        const newHp = Math.max(0, B_HP - dmg)
        const popupX = bxFinalX + Math.floor(B_idle.bitmap.width/2) - 10
        const popupY = bY - 10
        fIdx = await animateHealthDrop({
          bg, axX: axFinalX, aY, A_sprite: A_idle,
          bxX: bxFinalX, bY, B_sprite: B_idle,
          outFramesDir, framesSoFar: fIdx,
          fromHp: B_HP, toHp: newHp, maxHp: B_MAX,
          side: 'B',
          otherHp: A_HP, otherMaxHp: A_MAX,
          barW, barH, frames: 20,
          popupText: `-${dmg}`,
          popupStartX: popupX, popupStartY: popupY,
          popupRisePx: 36
        })
        B_HP = newHp
      }

      if (A_HP <= 0 || B_HP <= 0) break duel
      for (let i=0;i<6;i++) await drawNeutral()
      attacker = defender
    }
  }

  const loser = (A_HP <= 0) ? 'A' : 'B'
  fIdx = await fadeOutDefeated({
    bg, axFinalX, aY, A_sprite: A_idle,
    bxFinalX, bY, B_sprite: B_idle,
    outFramesDir,
    framesSoFar: fIdx,
    loser
  })

  const winner = (loser === 'A') ? 'B' : 'A'
  const winnerName = winner === 'A' ? aName : bName
  fIdx = await victorySequence({
    bg, bgW, bgH,
    winner,
    axFinalX, aY, A_idle, A_emote,
    bxFinalX, bY, B_idle, B_emote,
    outFramesDir, framesSoFar: fIdx,
    audioTimeline,
    winnerName
  })

  return { frames: fIdx }
}

async function fadeOutDefeated({ bg, axFinalX, aY, A_sprite, bxFinalX, bY, B_sprite, outFramesDir, framesSoFar, loser }) {
  let fIdx = framesSoFar
  const steps = 20
  for (let i=0;i<steps;i++){
    const frame = bg.clone()
    const alpha = 1 - i/(steps-1)
    if (loser === 'A') {
      frame.composite(A_sprite.clone().opacity(alpha), axFinalX, aY)
      frame.composite(B_sprite, bxFinalX, bY)
    } else {
      frame.composite(A_sprite, axFinalX, aY)
      frame.composite(B_sprite.clone().opacity(alpha), bxFinalX, bY)
    }
    await saveFrame(outFramesDir, fIdx++, frame)
  }
  return fIdx
}

/* ===================== VIDEO/AUDIO STITCH ===================== */
async function stitchFramesToVideo(framesDir, outVideoPath, fps = FIGHT_FPS) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(path.join(framesDir, 'frame_%04d.png'))
      .withInputFPS(fps)
      .outputOptions(['-pix_fmt yuv420p', `-r ${fps}`])
      .videoCodec('libx264')
      .noAudio()
      .output(outVideoPath)
      .on('end', () => resolve(outVideoPath))
      .on('error', reject)
      .run()
  })
}

/* ===================== MUSIC & SFX ===================== */
async function renderSongWav(outPath, targetSeconds) {
  const SR = 44100
  const N  = Math.max(1, Math.ceil(targetSeconds * SR))
  const L = new Float32Array(N), R = new Float32Array(N)

  const roots = [220, 233.08, 246.94, 261.63, 277.18, 293.66, 311.13, 329.63]
  const root = roots[Math.floor(Math.random()*roots.length)]
  const scales = { major:[0,2,4,5,7,9,11], pentMaj:[0,2,4,7,9], pentMin:[0,3,5,7,10] }
  const scale = scales[Object.keys(scales).length * Math.random() | 0] || scales.major
  const progChoices = [[0,5,3,4],[0,3,4,3],[0,4,5,3],[0,5,1,4]]
  const prog = progChoices[Math.floor(Math.random()*progChoices.length)]
  const bpm = 100 + Math.floor(Math.random()*60)
  const spb = 60 / bpm
  const barBeats = 4
  const bars = Math.ceil(targetSeconds / (spb*barBeats))
  const totalBeats = bars * barBeats
  const tri = (p)=>2*Math.abs(((p/Math.PI)%2)-1)-1
  const sq  = (p)=> (Math.sin(p)>=0?1:-1)
  function hz(semi){ return root * Math.pow(2, semi/12) }
  function scaleHz(deg, octave=0){ return hz([0,2,4,7,9][deg%5] + 12*octave) }
  const melPool = []
  for (let i=0;i<totalBeats;i++){
    const deg = [0,1,2,3,4][Math.floor(Math.random()*5)]
    const oct = Math.random()<0.5 ? 1 : 2
    melPool.push(scaleHz(deg, oct))
  }
  for (let n=0;n<N;n++){
    const t = n/SR
    const beat = Math.floor(t / spb)
    const bar  = Math.floor(beat / barBeats)
    const beatInBar = beat % barBeats
    const chordIdx = prog[bar % prog.length]
    const chordSemi = [0,4,7]
    const chordFund = hz(chordIdx*2)
    const pad = chordSemi.reduce((s,off)=> s + tri(2*Math.PI*(chordFund*Math.pow(2, off/12))/2 * t), 0) * 0.06
    const bass = sq(2*Math.PI*(chordFund/4)*t) * 0.08
    const melFreq = melPool[beat] || scaleHz(0,2)
    const swing = (beatInBar%2===1) ? 0.58 : 0.42
    const beatPhase = (t % spb) / spb
    const envMel = beatPhase < swing ? (beatPhase/swing) : Math.max(0, 1 - (beatPhase - swing)/(1-swing))
    const mel = tri(2*Math.PI*melFreq*t) * 0.12 * envMel
    const beatPos = (t % spb)
    const kick = ((beatInBar===0 || beatInBar===2) && beatPos < 0.08)
      ? Math.sin(2*Math.PI*(120 - 90*beatPos/0.08)*beatPos) * Math.exp(-18*beatPos) * 0.35
      : 0
    const snare = ((beatInBar===1 || beatInBar===3) && beatPos < 0.06)
      ? (Math.random()*2-1) * Math.exp(-40*beatPos) * 0.25
      : 0
    const hat = (beatPos < 0.02) ? (Math.random()*2-1) * 0.12 : 0
    const v = pad + bass + mel + kick + snare + hat
    L[n] += v; R[n] += v
  }
  let peak = 0; for (let i=0;i<N;i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]))
  const gain = peak>0 ? 0.9/peak : 1
  const fadeS = Math.floor(0.25*SR)
  for (let i=0;i<N;i++){
    const f = i > N - fadeS ? (N - i)/fadeS : 1
    L[i] *= gain*f; R[i] *= gain*f
  }
  writeWavStereoInt16(outPath, L, R, SR)
}
function floatTo16LE(f32){ const out=new Int16Array(f32.length); for(let i=0;i<f32.length;i++){ const x=Math.max(-1,Math.min(1,f32[i])); out[i]=x<0? x*0x8000 : x*0x7fff } return out }
function writeWavStereoInt16(pathOut, leftF32, rightF32, sr=44100){
  const L16=floatTo16LE(leftF32), R16=floatTo16LE(rightF32)
  const inter=new Int16Array(L16.length*2); for(let i=0,j=0;i<L16.length;i++,j+=2){ inter[j]=L16[i]; inter[j+1]=R16[i] }
  const byteRate=sr*2*2, blockAlign=4, dataSize=inter.length*2
  const h=Buffer.alloc(44)
  h.write('RIFF',0); h.writeUInt32LE(36+dataSize,4); h.write('WAVE',8)
  h.write('fmt ',12); h.writeUInt32LE(16,16); h.writeUInt16LE(1,20)
  h.writeUInt16LE(2,22); h.writeUInt32LE(sr,24); h.writeUInt32LE(byteRate,28)
  h.writeUInt16LE(blockAlign,32); h.writeUInt16LE(16,34); h.write('data',36)
  h.writeUInt32LE(dataSize,40)
  fs.writeFileSync(pathOut, Buffer.concat([h, Buffer.from(inter.buffer)]))
}
async function renderCreatureCallWav(outPath) {
  const duration = 0.9 + Math.random()*0.25
  const waves = [
    (p)=>2*Math.abs(((p/Math.PI)%2)-1)-1,
    (p)=> (Math.sin(p)>=0?1:-1),
    (p)=> ((p%(2*Math.PI))<(0.25*Math.PI)?1:-1),
    (p)=> ((p%(2*Math.PI))<(0.12*Math.PI)?1:-1),
  ]
  const wave = waves[Math.floor(Math.random()*waves.length)]
  const base = 300 + Math.random()*500
  const vibHz = 5 + Math.random()*5
  const depth = 0.005 + Math.random()*0.015
  const chirps = 2 + Math.floor(Math.random()*2)

  const { Ls, Rs, sr } = renderToBuffers(duration, (L,R,SR,total)=>{
    const dur = total/SR
    const seg = dur / chirps
    for(let c=0;c<chirps;c++){
      const t0 = c*seg
      const t1 = t0 + seg*0.9
      const f0 = base * (0.7 + Math.random()*0.6)
      const f1 = f0 * (0.7 + Math.random()*0.9)
      for(let i=0;i<total;i++){
        const t = i/SR
        if (t < t0 || t > t1) continue
        const x = (t - t0) / Math.max(1e-6, (t1 - t0))
        const f = f0 * Math.pow(f1/f0, x)
        const vib = 1 + depth * Math.sin(2*Math.PI*vibHz*(t-t0))
        const ph = 2*Math.PI*f*vib*(t - t0)
        const a = Math.min(1, (t - t0)/0.02)
        const r = Math.min(1, (t1 - t)/0.12)
        const env = Math.max(0, Math.min(a, r))
        const v = wave(ph) * env * 0.55
        L[i]+=v; R[i]+=v
      }
    }
  })
  writeWavStereoInt16(outPath, Ls, Rs, sr)
}
function renderToBuffers(durationSec, renderFn, sr = 44100) {
  const total = Math.max(1, Math.ceil(durationSec * sr))
  const Ls = new Float32Array(total)
  const Rs = new Float32Array(total)
  renderFn(Ls, Rs, sr, total)
  let peak=0; for(let i=0;i<total;i++) peak=Math.max(peak, Math.abs(Ls[i]), Math.abs(Rs[i]))
  const gain = peak>0 ? 0.95/peak : 1
  const fade = Math.floor(0.02*sr)
  for (let i=0;i<total;i++){ const f=i>total-fade? (total-i)/fade : 1; Ls[i]*=gain*f; Rs[i]*=gain*f }
  return { Ls, Rs, sr }
}
async function renderHitWav(outPath) {
  const { Ls, Rs, sr } = renderToBuffers(0.35 + Math.random()*0.15, (L,R,SR,total)=>{
    const dur = total/SR
    const th0 = 140 + Math.random()*80
    const th1 = 50 + Math.random()*40
    const ringParts = [600,900,1200,1500].filter(()=>Math.random()<0.7)
    let seed = Math.floor(Math.random()*1e9)
    const rnd=()=> (seed=(seed*1103515245+12345)>>>0)/0xFFFFFFFF
    for(let i=0;i<total;i++){
      const t=i/SR
      const f=th0*Math.pow(th1/th0,t/dur)
      const th=Math.sin(2*Math.PI*f*t)*Math.exp(-12*t)*(0.6+Math.random()*0.2)
      const noise=(rnd()*2-1)*Math.exp(-60*t)*0.45
      let ring=0
      for(const p of ringParts) ring += Math.sin(2*Math.PI*p*t)*Math.exp(-6*t)
      const v=th+noise+ring*0.12
      L[i]+=v; R[i]+=v
    }
  })
  writeWavStereoInt16(outPath, Ls, Rs, sr)
}
async function renderMissWav(outPath) {
  const { Ls, Rs, sr } = renderToBuffers(0.25 + Math.random()*0.15, (L,R,SR,total)=>{
    let s = Math.floor(Math.random()*1e7)
    const rnd=()=> (s=(s*48271)%2147483647)/2147483647
    const tilt = 300 + Math.random()*500
    for(let i=0;i<total;i++){
      const t=i/SR
      const env=Math.exp(-18*t)
      const n=(rnd()*2-1)
      const hp = n - 0.96*(L[i-1]||0)
      const w = Math.sin(2*Math.PI*(tilt + 400*t)*t)*0.08
      const v = hp*0.33*env + w*env
      L[i]+=v; R[i]+=v
    }
  })
  writeWavStereoInt16(outPath, Ls, Rs, sr)
}

/* ===================== VIDEO AUDIO MUX ===================== */
async function buildAndMuxAudio({
  videoPath,
  outFinalPath,
  durationSec,
  timeline,
  songWavPath,
  callAPath,
  callBPath,
  hitPath,
  missPath
}) {
  const SR = 48000
  const dur = Math.max(0.1, Number(durationSec || 0))
  const totalFrames = Math.ceil(dur * SR)
  const clamp1 = (x) => Math.max(-1, Math.min(1, x))

  function resampleLinear(src, fromSR, toSR) {
    if (fromSR === toSR || src.length === 0) return src
    const ratio = toSR / fromSR
    const outLen = Math.max(1, Math.floor(src.length * ratio))
    const out = new Float32Array(outLen)
    for (let i = 0; i < outLen; i++) {
      const x = i / ratio
      const i0 = Math.floor(x)
      const i1 = Math.min(src.length - 1, i0 + 1)
      const t = x - i0
      out[i] = (1 - t) * src[i0] + t * src[i1]
    }
    return out
  }
  const toStereoResampled = (dec) => ({
    L: resampleLinear(dec.L, dec.sampleRate, SR),
    R: resampleLinear(dec.R, dec.sampleRate, SR)
  })

  const songRS = toStereoResampled(await decodeWav(songWavPath))
  const callARS = toStereoResampled(await decodeWav(callAPath))
  const callBRS = toStereoResampled(await decodeWav(callBPath))
  const hitRS   = toStereoResampled(await decodeWav(hitPath))
  const missRS  = toStereoResampled(await decodeWav(missPath))

  const outL = new Float32Array(totalFrames)
  const outR = new Float32Array(totalFrames)

  // music bed, looped
  if (songRS.L.length > 0) {
    let idx = 0
    while (idx < totalFrames) {
      const chunk = Math.min(songRS.L.length, totalFrames - idx)
      for (let i = 0; i < chunk; i++) {
        outL[idx + i] = clamp1(outL[idx + i] + songRS.L[i] * MASTER_GAIN)
        outR[idx + i] = clamp1(outR[idx + i] + songRS.R[i] * MASTER_GAIN)
      }
      idx += chunk
    }
  }

  const norm = normalizeTimelineForEmotes(timeline, dur)
  const filteredCues = norm.cues
  const byKind = { emoteA: callARS, emoteB: callBRS, hit: hitRS, miss: missRS }
  const baseCueGains = { emoteA: 0.85, emoteB: 0.85, hit: 0.90, miss: 0.85 }

  const addAt = (bufL, bufR, startFrame, gainMul = 1.0) => {
    const g = gainMul * MASTER_GAIN
    const len = Math.min(bufL.length, totalFrames - startFrame)
    if (len <= 0) return
    for (let i = 0; i < len; i++) {
      const j = startFrame + i
      outL[j] = clamp1(outL[j] + bufL[i] * g)
      outR[j] = clamp1(outR[j] + bufR[i] * g)
    }
  }

  for (const cue of filteredCues) {
    const kind = cue.kind
    the: {
      const t = Math.max(0, Math.min(dur, Number(cue.t) || 0))
      const start = Math.floor(t * SR)
      const s = byKind[kind]
      if (!s) break the
      const g = (baseCueGains[kind] ?? 0.85) * EFFECT_ATTEN
      addAt(s.L, s.R, start, g)
    }
  }

  const mixedBuf = WAV.encode([outL, outR], { sampleRate: SR, float: true, bitDepth: 32 })
  const mixedPath = path.join(path.dirname(outFinalPath), 'mixed.wav')
  await fsp.writeFile(mixedPath, mixedBuf)

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(mixedPath)
      .outputOptions([
        '-map 0:v:0',
        '-map 1:a:0',
        '-c:v copy',
        '-c:a aac',
        '-shortest'
      ])
      .output(outFinalPath)
      .on('end', resolve)
      .on('error', reject)
      .run()
  })
}

/* ===================== MAIN (single run) ===================== */
async function mainOnce() {
  ensureDir(OUT_DIR)

  const A = await runCreaturePipeline(SEED1, 'creatureA')
  const B = await runCreaturePipeline(SEED2, 'creatureB')

  await flipAllSpritesHorizontally(B.spritesDir)

  const fightDir = path.join(OUT_DIR, 'fight_scene')
  ensureDir(fightDir)
  await emptyDir(fightDir)

  const bgPath = await generateFightBackground(A.creature_name, B.creature_name, fightDir)
  const { W: bgW, H: bgH } = parseSize(FIGHT_BG_SIZE)

  const statIcons = await loadStatIcons()
  const typeIcons = await loadTypeIcons()

  const moveAVisualA = moveAVisualPath(A.baseDir, A.moveA.name)
  const moveAVisualB = moveAVisualPath(B.baseDir, B.moveA.name)
  const moveBVisualA = moveBVisualPath(A.baseDir, A.moveB.name)
  const moveBVisualB = moveBVisualPath(B.baseDir, B.moveB.name)

  // Build centered boards (stats + separate move board)
  const statsPanelAPath = path.join(fightDir, 'stats_A.png')
  const statsPanelBPath = path.join(fightDir, 'stats_B.png')
  await renderStatsPanel({
    outPath: statsPanelAPath,
    creatureName: A.creature_name,
    types: A.types,
    stats: A.stats,
    bgW, bgH,
    statIcons,
    typeIcons
  })
  await renderStatsPanel({
    outPath: statsPanelBPath,
    creatureName: B.creature_name,
    types: B.types,
    stats: B.stats,
    bgW, bgH,
    statIcons,
    typeIcons
  })

  const movePanelAPath = path.join(fightDir, 'moves_A.png')
  const movePanelBPath = path.join(fightDir, 'moves_B.png')
  await renderMoveBoardPanel({
    outPath: movePanelAPath,
    moveA: A.moveA, moveB: A.moveB,
    moveImgAPath: moveAVisualA, moveImgBPath: moveBVisualA,
    bgW, bgH, statIcons, typeIcons
  })
  await renderMoveBoardPanel({
    outPath: movePanelBPath,
    moveA: B.moveA, moveB: B.moveB,
    moveImgAPath: moveAVisualB, moveImgBPath: moveBVisualB,
    bgW, bgH, statIcons, typeIcons
  })

  const spriteAIdle    = findIdleSpritePath(A.spritesDir)
  const spriteAEmote   = findEmoteSpritePath(A.spritesDir)
  const spriteAMoveA   = findMoveASpritePath(A.spritesDir)
  const spriteAMoveB   = findMoveBSpritePath(A.spritesDir)

  const spriteBIdle    = findIdleSpritePath(B.spritesDir)
  const spriteBEmote   = findEmoteSpritePath(B.spritesDir)
  const spriteBMoveA   = findMoveASpritePath(B.spritesDir)
  const spriteBMoveB   = findMoveBSpritePath(B.spritesDir)

  const framesDir = path.join(fightDir, 'frames')
  const audioTimeline = makeAudioTimeline()
  const { frames } = await createFightFrames({
    aName: A.creature_name,
    bName: B.creature_name,
    backgroundPath: bgPath,
    spriteAPath:        spriteAIdle,
    spriteBPath:        spriteBIdle,
    spriteAEmotePath:   spriteAEmote,
    spriteBEmotePath:   spriteBEmote,
    spriteAMoveAPath:   spriteAMoveA,
    spriteBMoveAPath:   spriteBMoveA,
    spriteAMoveBPath:   spriteAMoveB,
    spriteBMoveBPath:   spriteBMoveB,
    moveAVisualAPath:   moveAVisualA,
    moveAVisualBPath:   moveAVisualB,
    moveBVisualAPath:   moveBVisualA,
    moveBVisualBPath:   moveBVisualB,
    statsPanelAPath,
    statsPanelBPath,
    movePanelAPath,
    movePanelBPath,
    outFramesDir: framesDir,
    scaleFraction: FIGHT_SCALE_FRACTION,
    aStats: A.stats,
    bStats: B.stats,
    aTypes: A.types,
    bTypes: B.types,
    aMoveMetaA: A.moveA,
    aMoveMetaB: A.moveB,
    bMoveMetaA: B.moveA,
    bMoveMetaB: B.moveB,
    audioTimeline
  })
  console.log(`Fight frames created: ${frames} frames at ${FIGHT_FPS} fps`)

  const silentVideo = path.join(fightDir, 'creature_duel.mp4')
  await stitchFramesToVideo(framesDir, silentVideo, FIGHT_FPS)

  const durationSec = frames / FIGHT_FPS
  const songPath = path.join(fightDir, 'song.wav')
  await renderSongWav(songPath, durationSec)

  const callAPath = path.join(fightDir, 'callA.wav')
  const callBPath = path.join(fightDir, 'callB.wav')
  await renderCreatureCallWav(callAPath)
  await renderCreatureCallWav(callBPath)

  const hitPath  = path.join(fightDir, 'hit.wav')
  const missPath = path.join(fightDir, 'miss.wav')
  await renderHitWav(hitPath)
  await renderMissWav(missPath)

  const finalVideo = path.join(fightDir, 'creature_duel_with_audio.mp4')
  await buildAndMuxAudio({
    videoPath: silentVideo,
    outFinalPath: finalVideo,
    durationSec,
    timeline: audioTimeline,
    songWavPath: songPath,
    callAPath,
    callBPath,
    hitPath,
    missPath
  })

  console.log('\n=== Summary ===')
  console.log(`Creature A: ${A.creature_name} [${A.types.join('/')}]`)
  console.log(`  Sheet: ${A.sheet}`)
  console.log(`  Sprites: ${A.spritesDir}`)
  console.log(`Creature B: ${B.creature_name} [${B.types.join('/')}]`)
  console.log(`  Sheet: ${B.sheet}`)
  console.log(`  Sprites (flipped): ${B.spritesDir}`)
  console.log(`Fight BG (outdoor): ${bgPath}`)
  console.log(`Video: ${finalVideo}`)

  // === Upload to YouTube Shorts with required title prefix ===
  try {
    const meta = makeYouTubeMetadataShorts({
      aName: A.creature_name,
      aTypes: A.types,
      aMoves: [A.moveA, A.moveB],
      bName: B.creature_name,
      bTypes: B.types,
      bMoves: [B.moveA, B.moveB],
      durationSec
    })
    const videoId = await uploadToYouTube({
      filePath: finalVideo,
      title: meta.title,
      description: meta.description,
      tags: meta.tags,
      categoryId: meta.categoryId,
      privacyStatus: 'public',
      madeForKids: false
    })
    if (videoId) {
      const manifest = {
        uploaded: true,
        videoId,
        url: `https://youtu.be/${videoId}`,
        title: meta.title,
        descriptionPreview: meta.description.slice(0, 140) + (meta.description.length > 140 ? '…' : ''),
        a: { name: A.creature_name, types: A.types, moves: [A.moveA, A.moveB] },
        b: { name: B.creature_name, types: B.types, moves: [B.moveA, B.moveB] },
        durationSec
      }
      await fsp.writeFile(path.join(fightDir, 'upload_manifest.json'), JSON.stringify(manifest, null, 2))
      console.log('📝 Upload manifest saved:', path.join(fightDir, 'upload_manifest.json'))
    }
  } catch (e) {
    console.warn('⚠️ YouTube upload step failed:', e?.message || e)
  }
}

/* ===================== SCHEDULER (run now + every 3 hours, keep going on errors) ===================== */
async function runLoop() {
  const THREE_HOURS_MS = 3 * 60 * 60 * 1000

  const runSafely = async () => {
    try {
      await mainOnce()
    } catch (err) {
      console.error('❌ Run failed:', err?.stack || err?.message || err)
      // Intentionally DO NOT exit; continue the schedule.
    }
  }

  // Run immediately once:
  await runSafely()

  // Then every 3 hours:
  setInterval(runSafely, THREE_HOURS_MS)
}

runLoop()
  .catch(err => {
    // This catch is for scheduling setup only; per request, do not exit the process on errors.
    console.error('Scheduler failed to initialize:', err?.stack || err?.message || err)
  })
