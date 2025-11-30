// integrated-duel-generator.js
// Firebase + Algorand ARENA characters ONLY
// Uses your advanced vertical fight pipeline (frames, stats/move panels, audio, YouTube, scheduler)
// but pulls characters, stats, moves, and sprites from Firestore + on-chain arena app.

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
import algosdk from 'algosdk'

// === Firebase (client SDK lite) ===
import { initializeApp, getApps } from 'firebase/app'
import { getFirestore, doc, getDoc } from 'firebase/firestore/lite'

const WAV = wavPkg?.default ?? wavPkg

ffmpeg.setFfmpegPath(ffmpegInstaller.path)
ffmpeg.setFfprobePath(ffprobeInstaller.path)

/* ===================== CONFIG ===================== */

// Theme – used for background / music vibes only now
const THEME =
  process.env.THEME ||
  'medieval fantasy hero duel in an old-school castle RPG arena'

// Seeds are no longer used for character gen, but kept for music randomness if you want
const SEED1 = process.env.SEED1 || ''
const SEED2 = process.env.SEED2 || ''

const OUT_DIR = path.resolve('./out')
const TARGET_SIZE = '1024x1024'
const OUTER_MARGIN = 32
const SEPARATOR_GAP = 32
const BOX_INNER_PAD = 16
const AUTOCROP_TOL = 8
const EXTRACT_PADDING = 8

// Visuals (wide) – kept for completeness (not used by arena version)
const MOVE_VISUAL_SIZE = '1536x1024'

// Fight / cinematics (VERTICAL for YouTube Shorts)
const FIGHT_BG_SIZE = '1024x1536'
const FIGHT_FPS = 30
const FIGHT_FRAMES_A = 45
const FIGHT_FRAMES_B = 45
const EMOTE_DURATION_SEC = 1.0
const EMOTE_FRAMES = Math.max(1, Math.round(EMOTE_DURATION_SEC * FIGHT_FPS))

// Camera timings
const ZOOM_IN_FRAMES = 20
const STATS_HOLD_FRAMES = 90
const ZOOM_OUT_FRAMES = 20

// Zoom levels
const ZOOM_MAX = 1.8
const STATS_ZOOM_BUMP = 0.15
const VICTORY_ZOOM_MAX = 2.25

// Boards placement
const STAT_BOARD_TOP_GAP = 48
const MOVE_BOARD_BOTTOM_GAP = 48
const STATS_PANEL_CLEARANCE = 16
const PANEL_SIDE_MARGIN_PX = 24

// Pan down less when showing stats
const STATS_PREFERRED_OFFSET_FRACTION = 0.005

// Extra spacing between name and types
const NAME_TYPES_EXTRA_VGAP = 16

// Creature placement / fight layout
const PROJECTILE_DURATION_SEC = 1.6
const PROJECTILE_FRAMES = Math.max(1, Math.round(PROJECTILE_DURATION_SEC * FIGHT_FPS))
const PROJECTILE_HEIGHT_FRACTION = 0.18
const FIGHT_SCALE_FRACTION = 0.12

// Physical move timings
const PHYS_APPROACH_FRAMES = 24
const PHYS_RETREAT_FRAMES = 18
const PHYS_PROJECTILE_FRAMES = 12

// Victory scene
const VICTORY_ZOOM_IN_FR = 24
const VICTORY_HOLD_FRAMES = 60
const VICTORY_BANNER_FRAMES = 90
const VICTORY_BANNER_TOP = 48

// Bars
const HEALTH_BAR_W = 180
const HEALTH_BAR_H = 16
const COOLDOWN_BAR_W = HEALTH_BAR_W
const COOLDOWN_BAR_H = 6

// Audio
const MASTER_GAIN = 0.5
const EFFECT_ATTEN = 0.5
const MUSIC_GAIN = 0.5

/* ===================== YOUTUBE/OAUTH CONFIG ===================== */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
let GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN

// Firebase public config (to fetch creds/creds.GOOGLE_REFRESH_TOKEN and chars)
const firebaseConfig = {

}
const firebase_app =
  getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0]
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
  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    'http://localhost/unused'
  )
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN })
  _youtubeClient = google.youtube({ version: 'v3', auth: oauth2Client })
  return _youtubeClient
}

function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return []
  const seen = new Set()
  const out = []
  let totalLen = 0
  for (const raw of tags) {
    const t = String(raw).trim().replace(/^#/, '')
    if (!t || seen.has(t)) continue
    if (t.length > 60) continue
    if (out.length >= 15) break
    if (totalLen + t.length > 450) break
    out.push(t)
    seen.add(t)
    totalLen += t.length
  }
  return out
}

async function uploadToYouTube({
  filePath,
  title,
  description,
  tags = [],
  categoryId = '20',
  privacyStatus = 'public',
  madeForKids = false,
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
      status: { privacyStatus, selfDeclaredMadeForKids: madeForKids },
    },
    media: { body: fs.createReadStream(filePath) },
  })
  const videoId = res?.data?.id
  if (!videoId) throw new Error('YouTube upload failed (no video ID in response).')
  console.log(`✅ YouTube video ID: ${videoId}`)
  console.log(`🔗 https://youtu.be/${videoId}`)
  return videoId
}

function makeYouTubeMetadataShorts({
  aName,
  aTypes,
  aMoves,
  bName,
  bTypes,
  bMoves,
  durationSec,
}) {
  const aTypeStr = Array.isArray(aTypes)
    ? aTypes.join('/')
    : String(aTypes || 'Unknown')
  const bTypeStr = Array.isArray(bTypes)
    ? bTypes.join('/')
    : String(bTypes || 'Unknown')

  const title = `Dark Coin arena duel: ${aName} vs ${bName}`.slice(0, 100)

  const lines = []
  lines.push(
    `${aName} (${aTypeStr}) vs ${bName} (${bTypeStr}) — blockchain warriors from the Dark Coin arena.`
  )
  lines.push('')
  lines.push(`${aName} moves:`)
  lines.push(
    ` • ${aMoves[0].name} — ${aMoves[0].type} (${aMoves[0].category}) P${aMoves[0].power}/A${aMoves[0].accuracy}% · CD ${aMoves[0].cooldown_seconds}s`
  )
  lines.push(
    ` • ${aMoves[1].name} — ${aMoves[1].type} (${aMoves[1].category}) P${aMoves[1].power}/A${aMoves[1].accuracy}% · CD ${aMoves[1].cooldown_seconds}s`
  )
  lines.push('')
  lines.push(`${bName} moves:`)
  lines.push(
    ` • ${bMoves[0].name} — ${bMoves[0].type} (${bMoves[0].category}) P${bMoves[0].power}/A${bMoves[0].accuracy}% · CD ${bMoves[0].cooldown_seconds}s`
  )
  lines.push(
    ` • ${bMoves[1].name} — ${bMoves[1].type} (${bMoves[1].category}) P${bMoves[1].power}/A${bMoves[1].accuracy}% · CD ${bMoves[1].cooldown_seconds}s`
  )
  lines.push('')
  lines.push(
    `Render: ${Math.round(
      durationSec
    )}s @ ${FIGHT_FPS}fps · Old-school castle RPG arena · Sprites and stats from on-chain Dark Coin characters.`
  )
  lines.push('')
  lines.push('#shorts #algorand #darkcoin #gamedev #blockchaingaming')

  const tags = sanitizeTags([
    'shorts',
    'Dark Coin',
    'Algorand',
    'blockchain gaming',
    'medieval duel',
    'AI animation',
    'gamedev',
    'indie dev',
    'openai',
    'nodejs',
    'ffmpeg',
  ])

  return {
    title,
    description: lines.join('\n').slice(0, 4900),
    tags,
    categoryId: '20',
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
  WAV.encode(
    [L || new Float32Array(0), R || L || new Float32Array(0)],
    { sampleRate: sr, float: true, bitDepth: 32 }
  )

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true })
}
async function emptyDir(p) {
  await fsp.mkdir(p, { recursive: true })
  const entries = await fsp.readdir(p).catch(() => [])
  await Promise.all(
    entries.map((e) =>
      fsp.rm(path.join(p, e), { recursive: true, force: true })
    )
  )
}
function parseSize(s) {
  const [w, h] = s.toLowerCase().split('x').map(Number)
  if (!Number.isFinite(w) || !Number.isFinite(h))
    throw new Error(`Bad size: ${s}`)
  return { W: w, H: h }
}
function safeJSON(str) {
  try {
    return JSON.parse(str)
  } catch {
    return null
  }
}
function slugify(s) {
  return (
    String(s || 'character')
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 64) || 'character'
  )
}
function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY || process.env.DALLE_KEY
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY / DALLE_KEY')
  return new OpenAI({ apiKey })
}
function sanitizeName(n) {
  return String(n || 'move').replace(/[^\w\-]+/g, '_')
}
function titleCase(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

/* ===== Jimp fonts ===== */
function nearestFontSize(size) {
  const sizes = [8, 16, 32, 64]
  const wanted = Number(size) || 32
  return sizes.reduce(
    (best, s) =>
      Math.abs(s - wanted) < Math.abs(best - wanted) ? s : best,
    32
  )
}
async function loadFontBuiltin(size = 32, color = 'white') {
  const sz = nearestFontSize(size)
  const palette =
    String(color).toLowerCase() === 'black' ? 'BLACK' : 'WHITE'
  const key = `FONT_SANS_${sz}_${palette}`
  if (!Jimp[key]) throw new Error(`Missing built-in Jimp font: ${key}`)
  return Jimp.loadFont(Jimp[key])
}

/* ===================== OUTPUT CANVAS (1080×1920 with edge-blended padding) ===================== */
const OUT_CANVAS_W = 1080
const OUT_CANVAS_H = 1920

function _avgEdgeColor(img, band = 10) {
  const W = img.bitmap.width,
    H = img.bitmap.height
  const clampBand = Math.max(
    1,
    Math.min(band, Math.floor(Math.min(W, H) * 0.05))
  )
  let r = 0,
    g = 0,
    b = 0,
    n = 0
  const data = img.bitmap.data
  const push = (x, y) => {
    const idx = (W * y + x) << 2
    const a = data[idx + 3]
    if (a === 0) return
    r += data[idx + 0]
    g += data[idx + 1]
    b += data[idx + 2]
    n++
  }
  for (let y = 0; y < clampBand; y++)
    for (let x = 0; x < W; x++) push(x, y)
  for (let y = H - clampBand; y < H; y++)
    for (let x = 0; x < W; x++) push(x, y)
  for (let x = 0; x < clampBand; x++)
    for (let y = 0; y < H; y++) push(x, y)
  for (let x = W - clampBand; x < W; x++)
    for (let y = 0; y < H; y++) push(x, y)

  if (n === 0) return Jimp.rgbaToInt(14, 10, 8, 255)
  const rr = Math.round(r / n),
    gg = Math.round(g / n),
    bb = Math.round(b / n)
  return Jimp.rgbaToInt(rr, gg, bb, 255)
}

/** Scale any frame to fit inside 1080×1920 and pad with an edge-blended color. */
async function writePaddedFrameTo1080x1920(img, outPath) {
  const inW = img.bitmap.width,
    inH = img.bitmap.height
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
  const fname = `frame_${String(fIdx).padStart(4, '0')}.png`
  await writePaddedFrameTo1080x1920(
    frame,
    path.join(outFramesDir, fname)
  )
}

/* ===================== TYPES / COLORS ===================== */
const TYPES = [
  'Normal',
  'Steel',
  'Fire',
  'Ice',
  'Nature',
  'Holy',
  'Dark',
  'Arcane',
  'Earth',
  'Water',
  'Poison',
  'Undead',
]
const TYPE_COLORS = {
  Normal: '#A8A77A',
  Steel: '#B7B7CE',
  Fire: '#EE8130',
  Ice: '#96D9D6',
  Nature: '#7AC74C',
  Holy: '#F9E27D',
  Dark: '#705746',
  Arcane: '#7C3AED',
  Earth: '#E2BF65',
  Water: '#6390F0',
  Poison: '#A33EA1',
  Undead: '#6B7280',
}

/* ===================== RPG STATS BOUNDS (for UI only) ===================== */
const STAT_BOUNDS = {
  strength: { min: 0, max: 50, label: 'STR' },
  dexterity: { min: 0, max: 50, label: 'DEX' },
  intelligence: { min: 0, max: 50, label: 'INT' },
  speed: { min: 0, max: 200, label: 'SPD' },
  resist: { min: 0, max: 50, label: 'RES' },
  health: { min: 0, max: 400, label: 'HP' },
}

function hash32(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h =
      (h +
        ((h << 1) +
          (h << 4) +
          (h << 7) +
          (h << 8) +
          (h << 24))) >>>
      0
  }
  return h >>> 0
}

/* ===================== MOVE META (cooldowns + categories) ===================== */
/** Bias category selection by class; may override model category probabilistically.
 *  Still used in some helpers; for Firebase chars we mostly rely on their move.type strings.
 */
function biasedCategoryForClass(klass, current) {
  const k = String(klass || '').toLowerCase()
  const cur = String(current || '').toLowerCase()
  const primary = k.includes('warrior')
    ? 'melee'
    : k.includes('ranger')
    ? 'ranged'
    : k.includes('mage')
    ? 'magic'
    : null
  if (!primary) return cur || 'melee'
  if (cur === primary) return cur
  return Math.random() < 0.7 ? primary : cur || primary
}

function balanceMoveAccuracy(move) {
  const p = clamp(Number(move.power) || 40, 20, 150)
  const targetAcc = clamp(
    Math.round(95 - ((p - 20) * (40 / 130))),
    55,
    95
  )
  const given = clamp(Number(move.accuracy) || targetAcc, 50, 100)
  const balanced = Math.round(targetAcc * 0.7 + given * 0.3)
  return { ...move, power: p, accuracy: balanced }
}

function powerToCooldownSeconds(power) {
  const p = clamp(Number(power) || 40, 20, 150)
  const t = (p - 20) / (150 - 20)
  return +(0.8 + t * (6.0 - 0.8)).toFixed(2)
}
function normalizeMoveCooldown(move) {
  const baseCd = Number(move.cooldown_seconds)
  const wantCd = powerToCooldownSeconds(move.power)
  const cd =
    0.6 * wantCd + 0.4 * (Number.isFinite(baseCd) ? baseCd : wantCd)
  return {
    ...move,
    cooldown_seconds: +clamp(cd, 0.8, 6.0).toFixed(2),
  }
}

/* ===== Stat-based “moderate” power buff ===== */
function computePowerBuff(category, stats) {
  let stat = 0
  if (category === 'melee') stat = stats.strength
  else if (category === 'ranged') stat = stats.dexterity
  else stat = stats.intelligence
  const extra = clamp(Math.round((stat - 60) * 0.3), 0, 36)
  return extra
}
function applyMoveStatBuff(move, stats) {
  const base = clamp(Number(move.power) || 40, 20, 150)
  const buff = computePowerBuff(
    String(move.category || 'melee').toLowerCase(),
    stats
  )
  const power = clamp(base + buff, 20, 200)
  return {
    ...move,
    base_power: base,
    power,
    power_buff_from_stat: buff,
  }
}

/* ===================== EFFECT-DRIVEN STAT ADJUSTMENTS & DOT ===================== */

function computeAttackerStatAdjustments(effects = {}) {
  const get = (name) => Number(effects?.[name] || 0)

  let strengthAdj = 0
  let dexterityAdj = 0
  let intelligenceAdj = 0
  let accuracyAdj = 0
  let resistAdj = 0 // kept for symmetry

  // 🔻 Debuffs
  const bleed = get('bleed')
  if (bleed) strengthAdj -= bleed * 0.1

  const burn = get('burn')
  if (burn) {
    intelligenceAdj -= burn * 0.1
    strengthAdj += burn * 0.1
  }

  const freeze = get('freeze')
  if (freeze) dexterityAdj -= freeze * 0.2

  const slow = get('slow')
  if (slow) dexterityAdj -= slow * 0.1

  const paralyze = get('paralyze')
  if (paralyze) accuracyAdj -= paralyze * 0.2

  const drown = get('drown')
  if (drown) {
    dexterityAdj -= drown * 0.3
    accuracyAdj -= drown * 0.1
  }

  const doomA = get('doom')
  if (doomA) intelligenceAdj -= doomA * 0.2

  // 🔺 Buffs
  const strengthen = get('strengthen')
  if (strengthen) strengthAdj += strengthen * 0.3

  const empower = get('empower')
  if (empower) intelligenceAdj += empower * 0.3

  const hasten = get('hasten')
  if (hasten) dexterityAdj += hasten * 0.3

  const blessA = get('bless')
  if (blessA) {
    strengthAdj += blessA * 0.2
    intelligenceAdj += blessA * 0.2
  }

  const focus = get('focus')
  if (focus) accuracyAdj += focus * 0.3

  return {
    strengthAdj,
    dexterityAdj,
    intelligenceAdj,
    accuracyAdj,
    resistAdj,
  }
}

function computeDefenderStatAdjustments(effects = {}) {
  const get = (name) => Number(effects?.[name] || 0)
  let resistAdj = 0

  const blessD = get('bless')
  if (blessD) resistAdj += blessD * 0.1

  const doomD = get('doom')
  if (doomD) resistAdj -= doomD * 0.2

  return { resistAdj }
}

/** Per-turn HP delta from ongoing effects (bleed, burn, poison, doom, nurture). */
function computeOngoingEffectHpDelta(effects = {}) {
  const get = (name) => Number(effects?.[name] || 0)
  let delta = 0

  const bleed = get('bleed')
  if (bleed) delta -= bleed * 0.7

  const burn = get('burn')
  if (burn) delta -= burn * 0.5

  const poison = get('poison')
  if (poison) delta -= poison * 1.0

  const doom = get('doom')
  if (doom) delta -= doom * 0.3

  const nurture = get('nurture')
  if (nurture) delta += nurture * 0.5

  return delta
}

/* ===================== DAMAGE (TYPELESS, BUT STAT + EFFECT AWARE) ===================== */
/**
 * RPG damage:
 * - melee   ⇒ uses strength
 * - ranged  ⇒ uses dexterity
 * - magic   ⇒ uses intelligence
 *
 * We also fold in defender.resist, and attacker/defender stats should already
 * have effect adjustments applied (see computeAttackerAdjustedStats /
 * computeDefenderAdjustedStats).
 *
 * If attackerStats/defenderStats/category are missing, we fall back to the
 * old “power + randomness only” behavior.
 */
function calcDamageRPG({
  movePower,
  category,
  attackerStats,
  defenderStats,
}) {
  const p = clamp(Number(movePower) || 40, 1, 400)

  // Fallback: original simple formula if we don't have stat context
  if (!attackerStats || !defenderStats || !category) {
    const randSimple = 0.7 + Math.random() * 0.6 // 0.7x – 1.3x
    const dmgSimple = Math.max(
      1,
      Math.round(p * randSimple)
    )
    return { dmg: dmgSimple, eff: 1.0, stab: 1.0 }
  }

  const cat = String(category || 'melee').toLowerCase()
  let offensiveStat = attackerStats.strength || 0
  if (cat === 'ranged') offensiveStat = attackerStats.dexterity || 0
  else if (cat === 'magic') offensiveStat = attackerStats.intelligence || 0

  const resist = defenderStats.resist || 0

  // Normalize stats into modest multipliers
  const offFactor = 0.7 + clamp(offensiveStat, 0, 300) / 120 // ~0.7–3.2 in extreme cases
  const resFactor = 1 - clamp(resist, 0, 300) / 250          // up to ~60% reduction

  const rand = 0.85 + Math.random() * 0.3 // 0.85–1.15

  const dmg = Math.max(
    1,
    Math.round(p * offFactor * resFactor * rand)
  )
  return { dmg, eff: 1.0, stab: 1.0 }
}



/* ===================== BUFF / CURSE DETECTION ===================== */
function isBuffMove(move = {}) {
  const p = Number(move.power)
  // Power <= 0 is very likely a buff/utility
  if (Number.isFinite(p) && p <= 0) return true

  const fields = [
    move.type,
    move.category,
    move.effect,
    move.trait,
    move.description,
    move.name,
  ]
  const s = fields
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  if (!s) return false

  // Treat anything that looks like a buff/boost/heal as a buff move
  if (
    s.includes('buff') ||
    s.includes('boost') ||
    s.includes('increase') ||
    s.includes('regen') ||
    s.includes('regeneration') ||
    s.includes('heal') ||
    s.includes('shield') ||
    s.includes('protect')
  ) {
    return true
  }

  return false
}


/** Detect curse-style moves by text/type */
function isCurseMove(move = {}) {
  const fields = [
    move.type,
    move.category,
    move.effect,
    move.trait,
    move.description,
    move.name,
  ]
  const s = fields
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  if (!s) return false
  return s.includes('curse')
}

/**
 * Safely read an effect stack (we store them lower-case in A_effectTotals/B_effectTotals).
 */
function getEffect(effects, key) {
  if (!effects) return 0
  const v = effects[key] ?? effects[key.toLowerCase()]
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Attacker stat adjustments based on current effects.
 * Mirrors your on-chain logic:
 *
 *  - bleed, burn, freeze, slow, paralyze, drown, doom   (debuffs)
 *  - strengthen, empower, hasten, bless, focus          (buffs)
 *  - plus the separate speed adjustments block
 */
function computeAttackerAdjustedStats(baseStats, effects) {
  const eff = effects || {}

  let strengthAdj = 0
  let dexterityAdj = 0
  let intelligenceAdj = 0
  let accuracyAdj = 0
  let speedAdj = 0

  const bleed = getEffect(eff, 'bleed')
  const burn = getEffect(eff, 'burn')
  const freeze = getEffect(eff, 'freeze')
  const slow = getEffect(eff, 'slow')
  const paralyze = getEffect(eff, 'paralyze')
  const drown = getEffect(eff, 'drown')
  const doom = getEffect(eff, 'doom')
  const strengthen = getEffect(eff, 'strengthen')
  const empower = getEffect(eff, 'empower')
  const hasten = getEffect(eff, 'hasten')
  const bless = getEffect(eff, 'bless')
  const focus = getEffect(eff, 'focus')

  // === Debuff side (from your snippet) ===
  if (bleed) {
    strengthAdj -= bleed * 0.1
  }
  if (burn) {
    intelligenceAdj -= burn * 0.1
    strengthAdj += burn * 0.1
  }
  if (freeze) {
    dexterityAdj -= freeze * 0.2
  }
  if (slow) {
    dexterityAdj -= slow * 0.1
  }
  if (paralyze) {
    accuracyAdj -= paralyze * 0.2
  }
  if (drown) {
    dexterityAdj -= drown * 0.3
    accuracyAdj -= drown * 0.1
  }
  if (doom) {
    intelligenceAdj -= doom * 0.2
  }

  // === Buff side (from your snippet) ===
  if (strengthen) {
    strengthAdj += strengthen * 0.3
  }
  if (empower) {
    intelligenceAdj += empower * 0.3
  }
  if (hasten) {
    dexterityAdj += hasten * 0.3
  }
  if (bless) {
    strengthAdj += bless * 0.2
    intelligenceAdj += bless * 0.2
  }
  if (focus) {
    accuracyAdj += focus * 0.3
  }

  // === Speed specific adjustments (second block you sent) ===
  if (burn) {
    speedAdj += burn * 0.2
  }
  if (freeze) {
    speedAdj -= freeze * 0.2
  }
  if (slow) {
    speedAdj -= slow * 0.3
  }
  if (hasten) {
    speedAdj += hasten * 0.1
  }

  // Turn the "Adj" values into multiplicative factors, then clamp.
  const strength = clamp(
    (baseStats.strength || 0) * (1 + strengthAdj),
    0,
    999
  )
  const dexterity = clamp(
    (baseStats.dexterity || 0) * (1 + dexterityAdj),
    0,
    999
  )
  const intelligence = clamp(
    (baseStats.intelligence || 0) * (1 + intelligenceAdj),
    0,
    999
  )
  const speed = clamp(
    (baseStats.speed || 0) * (1 + speedAdj),
    0,
    999
  )

  // Accuracy is a scale factor applied to the move's accuracy %
  const accScale = clamp(1 + accuracyAdj, 0.1, 2.0)

  return { strength, dexterity, intelligence, speed, accScale }
}

/**
 * Defender stat adjustments (resist) based on effects.
 * From your snippet:
 *   if (defender.effects["bless"]) resistAdj += bless * 0.1
 *   if (defender.effects["doom"])  resistAdj -= doom * 0.2
 */
function computeDefenderAdjustedStats(baseStats, effects) {
  const eff = effects || {}
  const bless = getEffect(eff, 'bless')
  const doom = getEffect(eff, 'doom')

  let resistAdj = 0
  if (bless) resistAdj += bless * 0.1
  if (doom) resistAdj -= doom * 0.2

  const resist = clamp(
    (baseStats.resist || 0) * (1 + resistAdj),
    0,
    999
  )

  return { resist }
}

/**
 * Apply DOT/HoT from effects once, before an action.
 * Mirrors your constants:
 *
 *   bleed   ⇒ - bleed * 0.7
 *   burn    ⇒ - burn * 0.5
 *   poison  ⇒ - poison * 1
 *   doom    ⇒ - doom * 0.3
 *   nurture ⇒ + nurture * 0.5
 *
 * Returns { newHp, delta } (delta can be negative or positive).
 */
function applyOngoingEffectsOnce(effects, currentHp, maxHp) {
  const eff = effects || {}
  let delta = 0

  const bleed = getEffect(eff, 'bleed')
  if (bleed > 0) delta -= bleed * 0.7

  const burn = getEffect(eff, 'burn')
  if (burn > 0) delta -= burn * 0.5

  const poison = getEffect(eff, 'poison')
  if (poison > 0) delta -= poison * 1.0

  const doom = getEffect(eff, 'doom')
  if (doom > 0) delta -= doom * 0.3

  const nurture = getEffect(eff, 'nurture')
  if (nurture > 0) delta += nurture * 0.5

  const raw = Number(currentHp) + delta
  const newHp = clamp(raw, 0, Number(maxHp) || raw)

  return { newHp, delta }
}


/**
 * Draw a horizontal row of effect icons + total stack numbers above a bar.
 * - centerX: center of the HP bar
 * - barY: y of the top of the HP bar
 * - effectsMap: { effectName: totalAmount }
 */
function drawEffectTotalsRow(
  frame,
  centerX,
  barY,
  effectsMap,
  effectIcons,
  font
) {
  const entries = Object.entries(effectsMap || {}).filter(
    ([, v]) => Number(v) > 0
  )
  if (!entries.length || !font) return

  const iconSize = 20
  const iconTextGap = 4
  const perEntryExtra = 10
  let totalW = 0

  for (const [, value] of entries) {
    const label = String(value)
    const approxTextW = label.length * 8
    totalW += iconSize + iconTextGap + approxTextW + perEntryExtra
  }
  totalW = Math.max(iconSize, totalW - perEntryExtra)

  let x = Math.round(centerX - totalW / 2)
  const y = Math.max(0, barY - iconSize - 6)

  for (const [effName, value] of entries) {
    const icon = effectIcons?.[effName] || null
    let ix = x
    if (icon) {
      const scaled = icon
        .clone()
        .contain(iconSize, iconSize, Jimp.RESIZE_BILINEAR)
      frame.composite(scaled, ix, y)
      ix += iconSize + iconTextGap
    }

    const label = String(value)
    frame.print(font, ix, y + 2, label)

    const approxTextW = label.length * 8
    x = ix + approxTextW + perEntryExtra
  }
}

/* ===================== ICONS & DRAW HELPERS ===================== */
const STAT_ICON_FILENAMES = {
  strength: 'attack.png',
  dexterity: 'speed.png',
  intelligence: 'magicAttack.png',
  speed: 'speed.png',
  resist: 'defence.png',
  health: 'heart.png',
  power: 'power.png',
  accuracy: 'accuracy.png',
  cooldown: 'hourglass.png',
  nature: 'nature.png',
}
async function loadStatIcons(
  iconsDirRoot = path.resolve('./icons/stats')
) {
  const result = {}
  await Promise.all(
    Object.entries(STAT_ICON_FILENAMES).map(
      async ([key, fname]) => {
        const p = path.join(iconsDirRoot, fname)
        try {
          result[key] = fs.existsSync(p) ? await Jimp.read(p) : null
        } catch {
          result[key] = null
        }
      }
    )
  )
  return result
}
async function loadTypeIcons(
  typesDirRoot = path.resolve('./icons/types')
) {
  const map = {}
  for (const t of TYPES) {
    const fname = `${t.toLowerCase()}.png`
    const p = path.join(typesDirRoot, fname)
    try {
      map[t] = fs.existsSync(p) ? await Jimp.read(p) : null
    } catch {
      map[t] = null
    }
  }
  return map
}
/* ===================== EFFECT ICONS ===================== */

async function loadEffectIcons(
  effectsDirRoot = path.resolve('./effects') // folder with <effectName>.png
) {
  const result = {}
  if (!fs.existsSync(effectsDirRoot)) return result
  const files = await fsp.readdir(effectsDirRoot).catch(() => [])
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.png')) continue
    const base = path.basename(f, path.extname(f))
    const key = base.toLowerCase()
    try {
      result[key] = await Jimp.read(path.join(effectsDirRoot, f))
    } catch {
      result[key] = null
    }
  }
  return result
}

let EFFECT_FONT_16 = null
async function getEffectFont16() {
  if (!EFFECT_FONT_16) {
    EFFECT_FONT_16 = await loadFontBuiltin(16, 'white')
  }
  return EFFECT_FONT_16
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
    const icon = tIcon
      .clone()
      .contain(iconH, iconH, Jimp.RESIZE_BILINEAR)
    const iy = y + Math.round((h - iconH) / 2)
    const ix = x + 8
    panel.composite(icon, ix, iy)
    leftTextX = ix + iconH + 8
  }
  return { leftTextX }
}
function drawStatBar(
  panel,
  x,
  y,
  width,
  height,
  pct,
  bgColor = '#332417',
  fillColor = '#E1B864'
) {
  const bgBar = new Jimp(width, height, Jimp.cssColorToHex(bgColor))
  bgBar.opacity(0.95)
  panel.composite(bgBar, x, y)
  const fillW = Math.max(6, Math.round(width * clamp(pct, 0, 1)))
  const fill = new Jimp(
    fillW,
    height,
    Jimp.cssColorToHex(fillColor)
  )
  panel.composite(fill, x, y)
}

function drawHealthBar(
  frame,
  centerX,
  aboveY,
  width,
  height,
  hp,
  maxHp
) {
  const barW = width,
    barH = height
  const x = Math.round(centerX - barW / 2)
  const y = Math.max(0, aboveY - barH - 8)
  const bg = new Jimp(
    barW,
    barH,
    Jimp.cssColorToHex('#2b1c14')
  )
  bg.opacity(0.8)
  frame.composite(bg, x, y)
  const pct = clamp(hp / Math.max(1, maxHp), 0, 1)
  const fillW = Math.max(1, Math.round(barW * pct))
  const fill = new Jimp(
    fillW,
    barH,
    Jimp.cssColorToHex('#E1B864')
  )
  frame.composite(fill, x, y)
}

/* ===== Cooldown bars (white) ===== */
function drawCooldownBar(
  frame,
  centerX,
  aboveY,
  width,
  height,
  cdRemaining,
  cdTotal
) {
  if (!cdTotal || cdTotal <= 0) return
  const barW = width,
    barH = height
  const x = Math.round(centerX - barW / 2)
  const y = Math.max(0, aboveY - barH - 4)
  const bg = new Jimp(barW, barH, Jimp.cssColorToHex('#ffffff'))
  bg.opacity(0.25)
  frame.composite(bg, x, y)
  const pct = clamp(cdRemaining / cdTotal, 0, 1)
  const fillW = Math.max(1, Math.round(barW * pct))
  const fill = new Jimp(
    fillW,
    barH,
    Jimp.cssColorToHex('#ffffff')
  )
  frame.composite(fill, x, y)
}

/* ===== Effect icons + totals above health bars ===== */
/* ===== Effect icons + totals above health bars ===== */
async function drawEffectSummaryRow({
  frame,
  centerX,
  barTopY,
  effects,
  effectIcons,
}) {
  if (!effects || !effectIcons) return
  const entries = Object.entries(effects).filter(
    ([, v]) => Number(v) > 0
  )
  if (!entries.length) return

  // Bigger font now
  const font = await getEffectFont16() // internally loads a larger size now
  const ICON_SIZE = 48  // bigger icons above player
  const GAP = 8
  const maxIcons = 3

  // Sort most stacked effects first
  entries.sort((a, b) => Number(b[1]) - Number(a[1]))
  const selected = entries.slice(0, maxIcons)

  const totalW =
    selected.length * ICON_SIZE + (selected.length - 1) * GAP
  let x = Math.round(centerX - totalW / 2)

  // base position above the HP bar
  const baseY = Math.max(0, barTopY - ICON_SIZE - 12)
  // bump everything 50px higher than before
  const y = Math.max(0, baseY - 50)

  for (const [name, amount] of selected) {
    const key = String(name).toLowerCase()
    const iconSrc = effectIcons[key] || null

    if (iconSrc) {
      const icon = iconSrc
        .clone()
        .contain(ICON_SIZE, ICON_SIZE, Jimp.RESIZE_BILINEAR)
      frame.composite(icon, x, y)
    } else {
      const placeholder = new Jimp(
        ICON_SIZE,
        ICON_SIZE,
        Jimp.cssColorToHex('#332417')
      )
      placeholder.opacity(0.9)
      frame.composite(placeholder, x, y)
    }

    const label = String(amount)
    // Taller text area under icon
    frame.print(
      font,
      x,
      y + ICON_SIZE + 4,
      {
        text: label,
        alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
        alignmentY: Jimp.VERTICAL_ALIGN_TOP,
      },
      ICON_SIZE,
      28
    )

    x += ICON_SIZE + GAP
  }
}





/* ===================== STATS PANEL (centered) ===================== */
async function renderStatsPanel({
  outPath,
  creatureName,
  identity, // now unused but kept for signature
  types,    // now unused but kept for signature
  stats,
  bgW,
  bgH,
  statIcons,
  typeIcons,
}) {
  const panelW = Math.max(320, bgW - PANEL_SIDE_MARGIN_PX * 2)
  const panelH = Math.round(bgH * 0.3)
  const panel = new Jimp(panelW, panelH, 0x00000000)

  const card = new Jimp(
    panelW,
    panelH,
    Jimp.cssColorToHex('#0e0a08')
  )
  card.opacity(0.78)
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
  const font32 = await loadFontBuiltin(32, 'white')

  const leftX = 18
  const topPad = 12

  // Just the name at the top
  panel.print(fontTitle, leftX, topPad, creatureName)

  // Separator line under name
  let y = topPad + 36
  drawHorizontalLine(panel, leftX, panelW - leftX, y, GOLD_HEX)
  y += 12

  const nameAreaW = 200
  const rightValuePad = 90
  const barW = panelW - leftX * 2 - nameAreaW - rightValuePad
  const barH = 22
  const rowH = 40

  const keys = [
    'health',
    'strength',
    'dexterity',
    'intelligence',
    'resist',
    'speed',
  ]

  for (const k of keys) {
    const bounds = STAT_BOUNDS[k]
    if (!bounds) continue
    const { label, min, max } = bounds
    const v = stats[k]
    const pct = (v - min) / (max - min)

    let labelX = leftX
    if (statIcons?.[k]) {
      const ico = statIcons[k]
        .clone()
        .contain(24, 24, Jimp.RESIZE_BILINEAR)
      panel.composite(
        ico,
        labelX,
        y + Math.round((barH - 24) / 2)
      )
      labelX += 24 + 8
    }
    panel.print(font32, labelX, y - 2, label)

    drawStatBar(panel, leftX + nameAreaW, y - 2, barW, barH, pct)
    panel.print(
      font32,
      leftX + nameAreaW + barW + 10,
      y - 4,
      String(v)
    )
    y += rowH
  }

  await panel.writeAsync(outPath)
  return { path: outPath, width: panelW, height: panelH }
}

/* ===================== MOVE BOARD (bottom) ===================== */
async function renderMoveBoardPanel({
  outPath,
  moves,          // array of move meta (expecting length >= 3)
  moveImgPaths,   // array of image paths matching moves
  bgW,
  bgH,
  statIcons,
  typeIcons,
  effectIcons,
}) {
  const panelW = Math.max(320, bgW - PANEL_SIDE_MARGIN_PX * 2)
  const panelH = Math.round(bgH * 0.28)
  const panel = new Jimp(panelW, panelH, 0x00000000)

  const card = new Jimp(
    panelW,
    panelH,
    Jimp.cssColorToHex('#0e0a08')
  )
  card.opacity(0.78)
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
  const count = Math.min(
    3,
    Array.isArray(moves) ? moves.length : 0,
    Array.isArray(moveImgPaths) ? moveImgPaths.length : 0
  )

  if (count === 0) {
    await panel.writeAsync(outPath)
    return { path: outPath, width: panelW, height: panelH }
  }

  const tileW = Math.floor((panelW - gapX * (count + 1)) / count)
  const tileH = panelH - innerPad * 2

  const tiles = []
  for (let i = 0; i < count; i++) {
    tiles.push({
      move: moves[i],
      imgPath: moveImgPaths[i],
      x: gapX * (i + 1) + tileW * i,
      y: innerPad,
      w: tileW,
      h: tileH,
    })
  }

  const maxCD = tiles.reduce((acc, t) => {
    const cd = Number(t.move?.cooldown_seconds)
    return Math.max(acc, Number.isFinite(cd) ? cd : 0)
  }, 6.0)

  for (const t of tiles) {
    // Tile border
    for (let x = 0; x < t.w; x++) {
      panel.setPixelColor(GOLD_HEX, t.x + x, t.y)
      panel.setPixelColor(GOLD_HEX, t.x + x, t.y + t.h - 1)
    }
    for (let y = 0; y < t.h; y++) {
      panel.setPixelColor(GOLD_HEX, t.x, y + t.y)
      panel.setPixelColor(GOLD_HEX, t.x + t.w - 1, y + t.y)
    }

    const move = t.move || {}
    const imgPadTop = 8
    const imgSidePad = 8

    // Reserve room for:
    // - name
    // - type chip
    // - POW/ACC/CD rows
    // - effect row (icon + amount)
    const reservedHForText =
      28 + 8 + // name
      24 + 8 + // type chip
      22 + 8 + // POW
      22 + 8 + // ACC
      22 + 8 + // CD
      40       // effect row

    const imgMaxH = Math.max(
      24,
      Math.min(t.h * 0.48, t.h - reservedHForText)
    )

    // Move art
    try {
      const mvImg = await Jimp.read(t.imgPath)
      const scale = Math.min(
        (t.w - imgSidePad * 2) / mvImg.bitmap.width,
        imgMaxH / mvImg.bitmap.height
      )
      const iw = Math.max(1, Math.round(mvImg.bitmap.width * scale))
      const ih = Math.max(1, Math.round(mvImg.bitmap.height * scale))
      const ix = t.x + Math.round((t.w - iw) / 2)
      const iy = t.y + imgPadTop
      const scaled = mvImg
        .clone()
        .resize(iw, ih, Jimp.RESIZE_BILINEAR)
      panel.composite(scaled, ix, iy)
    } catch {
      const ph = new Jimp(
        t.w - imgSidePad * 2,
        Math.round(imgMaxH),
        Jimp.cssColorToHex('#332417')
      )
      ph.opacity(0.6)
      panel.composite(
        ph,
        t.x + imgSidePad,
        t.y + imgPadTop
      )
    }

    const nameFont = await loadFontBuiltin(16, 'white')

    // Name
    const nameY = t.y + imgPadTop + Math.round(imgMaxH) + 6
    const nameLeftX = t.x + 8
    panel.print(
      nameFont,
      nameLeftX,
      nameY,
      move.name || 'Unknown Move'
    )

    // TYPE CHIP
    const smallFont = await loadFontBuiltin(16, 'white')
    const chipY = nameY + 28 + 8
    const chipH = 24
    const chipW = Math.min(200, t.w - 16)
    const moveType = move.type || 'Normal'
    const chipRes = await drawTypeChip(
      panel,
      t.x + 8,
      chipY,
      chipW,
      chipH,
      moveType,
      typeIcons
    )
    panel.print(
      smallFont,
      chipRes.leftTextX,
      chipY + 4,
      String(moveType).toUpperCase()
    )

    // STAT BARS
    const labelAreaW = 56
    const BAR_SHIFT_RIGHT = 6
    const statBarLeft =
      t.x + 8 + labelAreaW + BAR_SHIFT_RIGHT
    const statBarW =
      t.w - 16 - labelAreaW - BAR_SHIFT_RIGHT - 48
    const statBarH = 20

    // --- POW ---
    let rowY = chipY + chipH + 6
    let labelX = t.x + 8
    if (statIcons?.power) {
      const pIco = statIcons.power
        .clone()
        .contain(18, 18, Jimp.RESIZE_BILINEAR)
      panel.composite(
        pIco,
        labelX,
        rowY + Math.round((statBarH - 18) / 2)
      )
      labelX += 18 + 6
    }
    panel.print(smallFont, labelX, rowY + 2, 'POW')
    const pMin = 0,
      pMax = 400
    const pVal = clamp(Number(move.power) || 0, pMin, pMax)
    const pPct = (pVal - pMin) / Math.max(1, pMax - pMin)
    drawStatBar(
      panel,
      statBarLeft,
      rowY,
      statBarW,
      statBarH,
      pPct
    )
    panel.print(
      smallFont,
      statBarLeft + statBarW + 6,
      rowY + 2,
      String(pVal)
    )

    // --- ACC ---
    rowY += statBarH + 6
    labelX = t.x + 8
    if (statIcons?.accuracy) {
      const aIco = statIcons.accuracy
        .clone()
        .contain(18, 18, Jimp.RESIZE_BILINEAR)
      panel.composite(
        aIco,
        labelX,
        rowY + Math.round((statBarH - 18) / 2)
      )
      labelX += 18 + 6
    }
    panel.print(smallFont, labelX, rowY + 2, 'ACC')
    const aMin = 0,
      aMax = 100
    const aVal = clamp(Number(move.accuracy) || 0, aMin, aMax)
    const aPct = (aVal - aMin) / Math.max(1, aMax - aMin)
    drawStatBar(
      panel,
      statBarLeft,
      rowY,
      statBarW,
      statBarH,
      aPct
    )
    panel.print(
      smallFont,
      statBarLeft + statBarW + 6,
      rowY + 2,
      `${aVal}%`
    )

    // --- CD ---
    rowY += statBarH + 6
    labelX = t.x + 8
    if (statIcons?.cooldown) {
      const cIco = statIcons.cooldown
        .clone()
        .contain(18, 18, Jimp.RESIZE_BILINEAR)
      panel.composite(
        cIco,
        labelX,
        rowY + Math.round((statBarH - 18) / 2)
      )
      labelX += 18 + 6
    }
    panel.print(smallFont, labelX, rowY + 2, 'CD')
    const cdVal = clamp(
      Number(move.cooldown_seconds) || 0,
      0.8,
      Math.max(6.0, maxCD)
    )
    const cdPct = cdVal / Math.max(0.8, maxCD)
    drawStatBar(
      panel,
      statBarLeft,
      rowY,
      statBarW,
      statBarH,
      cdPct,
      '#2a2018',
      '#ffffff'
    )
    panel.print(
      smallFont,
      statBarLeft + statBarW + 6,
      rowY + 2,
      `${cdVal.toFixed(2)}s`
    )

    // --- EFFECT ICON + POTENCY ---
    rowY += statBarH + 6
    const effectName = String(
      move.effect_name || move.effect || ''
    ).trim()
    if (effectName) {
      const effKey = effectName.toLowerCase()
      let pot = Number(move.effect_potency_base) || 0

      const isBuff = isBuffMove(move)
      const isCurse = isCurseMove(move)

      // For curse and buff moves, double the amount shown
      if (isBuff || isCurse) pot *= 2

      if (pot !== 0) {
        const effFont = await loadFontBuiltin(16, 'white')
        const ICON_SIZE = 36 // bigger icons on move board
        const effY = rowY + 2
        const effX = t.x + 8
        const iconSrc = effectIcons?.[effKey] || null

        if (iconSrc) {
          const icon = iconSrc
            .clone()
            .contain(ICON_SIZE, ICON_SIZE, Jimp.RESIZE_BILINEAR)
          panel.composite(icon, effX, effY)
        }

        const textX = effX + ICON_SIZE + 6
        const label = `${effectName} ${
          pot > 0 ? '+' : ''
        }${pot}`
        panel.print(
          effFont,
          textX,
          effY + 8,
          label
        )
      }
    }
  }

  await panel.writeAsync(outPath)
  return { path: outPath, width: panelW, height: panelH }
}


/* ===================== B-SIDE: FLIP SPRITES FOR CREATURE B ===================== */
async function flipAllPngsHorizontally(dir) {
  const files = (await fsp.readdir(dir)).filter((f) =>
    f.toLowerCase().endsWith('.png')
  )
  for (const f of files) {
    const p = path.join(dir, f)
    const img = await Jimp.read(p)
    img.mirror(true, false)
    await img.writeAsync(p)
  }
}

/* ===================== AUDIO TIMELINE ===================== */
function makeAudioTimeline() {
  return {
    cues: [],
    push(kind, t) {
      this.cues.push({ kind, t: Math.max(0, t) })
    },
  }
}
function normalizeTimelineForEmotes(timeline, videoDurationSec) {
  const cues = Array.isArray(timeline?.cues)
    ? [...timeline.cues]
    : []
  const hasA = cues.some((c) => c.kind === 'emoteA')
  const hasB = cues.some((c) => c.kind === 'emoteB')
  const statA = cues.find((c) => c.kind === 'statA')
  const statB = cues.find((c) => c.kind === 'statB')
  if (!hasA && statA)
    cues.push({
      kind: 'emoteA',
      t: clamp(statA.t || 0, 0, videoDurationSec),
    })
  if (!hasB && statB)
    cues.push({
      kind: 'emoteB',
      t: clamp(statB.t || 0, 0, videoDurationSec),
    })
  return {
    cues: cues
      .filter((c) => c.kind !== 'statA' && c.kind !== 'statB')
      .sort((a, b) => (a.t || 0) - (b.t || 0)),
  }
}

/* ===================== BLINK/POPUPS ===================== */
async function blinkTargetFrames({
  frames,
  bg,
  axX,
  aY,
  A_sprite,
  bxX,
  bY,
  B_sprite,
  targetSide,
  outFramesDir,
  framesSoFar,
  hpA,
  maxHpA,
  hpB,
  maxHpB,
  barW = HEALTH_BAR_W,
  barH = HEALTH_BAR_H,
  effectIcons,
  effectTotalsFont,
  A_effectTotals,
  B_effectTotals,
  cdA = 0,
  totalCdA = 1,
  cdB = 0,
  totalCdB = 1,
}) {
  let fIdx = framesSoFar
  for (let i = 0; i < frames; i++) {
    const frame = bg.clone()
    const visible = Math.floor(i / 3) % 2 === 0

    if (targetSide === 'A') {
      frame.composite(B_sprite, bxX, bY)
      if (visible) frame.composite(A_sprite, axX, aY)
    } else {
      frame.composite(A_sprite, axX, aY)
      if (visible) frame.composite(B_sprite, bxX, bY)
    }

    // Health bars
    drawHealthBar(
      frame,
      axX + Math.floor(A_sprite.bitmap.width / 2),
      aY,
      barW,
      barH,
      hpA,
      maxHpA
    )
    drawHealthBar(
      frame,
      bxX + Math.floor(B_sprite.bitmap.width / 2),
      bY,
      barW,
      barH,
      hpB,
      maxHpB
    )

    // Cooldown bars (both sides)
    drawCooldownBar(
      frame,
      axX + Math.floor(A_sprite.bitmap.width / 2),
      aY - 18,
      COOLDOWN_BAR_W,
      COOLDOWN_BAR_H,
      cdA,
      totalCdA
    )
    drawCooldownBar(
      frame,
      bxX + Math.floor(B_sprite.bitmap.width / 2),
      bY - 18,
      COOLDOWN_BAR_W,
      COOLDOWN_BAR_H,
      cdB,
      totalCdB
    )

    // Effect totals (above HP)
    const barYA = Math.max(0, aY - barH - 8)
    const barYB = Math.max(0, bY - barH - 8)
    const centerAx = axX + Math.floor(A_sprite.bitmap.width / 2)
    const centerBx = bxX + Math.floor(B_sprite.bitmap.width / 2)

    await drawEffectSummaryRow({
      frame,
      centerX: centerAx,
      barTopY: barYA,
      effects: A_effectTotals,
      effectIcons,
    })
    await drawEffectSummaryRow({
      frame,
      centerX: centerBx,
      barTopY: barYB,
      effects: B_effectTotals,
      effectIcons,
    })

    await saveFrame(outFramesDir, fIdx++, frame)
  }
  return fIdx
}


async function animateEffectPopup({
  bg,
  axX,
  aY,
  A_sprite,
  bxX,
  bY,
  B_sprite,
  outFramesDir,
  framesSoFar,
  targetSide,             // 'A' or 'B'
  effectName,
  amountApplied,
  A_HP,
  A_MAX,
  B_HP,
  B_MAX,
  cdA = 0,
  totalCdA = 1,
  cdB = 0,
  totalCdB = 1,
  effectsA = {},
  effectsB = {},
  effectIcons = null,
  barW = HEALTH_BAR_W,
  barH = HEALTH_BAR_H,
  popupRisePx = 32,
  frames = 16,
}) {
  let fIdx = framesSoFar
  const font = await getEffectFont16()
  const key = String(effectName || '').toLowerCase()
  const iconSrc = effectIcons?.[key] || null
  const ICON_SIZE = 40 // nice and big for popup

  const centerX =
    targetSide === 'A'
      ? axX + Math.floor(A_sprite.bitmap.width / 2)
      : bxX + Math.floor(B_sprite.bitmap.width / 2)
  const baseY = (targetSide === 'A' ? aY : bY) - 10

  for (let i = 0; i < frames; i++) {
    const t = i / Math.max(1, frames - 1)
    const dy = Math.round(popupRisePx * t)

    const frame = bg.clone()
    frame.composite(A_sprite, axX, aY)
    frame.composite(B_sprite, bxX, bY)

    // Bars
    drawHealthBar(
      frame,
      axX + Math.floor(A_sprite.bitmap.width / 2),
      aY,
      barW,
      barH,
      A_HP,
      A_MAX
    )
    drawHealthBar(
      frame,
      bxX + Math.floor(B_sprite.bitmap.width / 2),
      bY,
      barW,
      barH,
      B_HP,
      B_MAX
    )
    drawCooldownBar(
      frame,
      axX + Math.floor(A_sprite.bitmap.width / 2),
      aY - 18,
      COOLDOWN_BAR_W,
      COOLDOWN_BAR_H,
      cdA,
      totalCdA
    )
    drawCooldownBar(
      frame,
      bxX + Math.floor(B_sprite.bitmap.width / 2),
      bY - 18,
      COOLDOWN_BAR_W,
      COOLDOWN_BAR_H,
      cdB,
      totalCdB
    )

    // Running totals above HP
    await drawEffectSummaryRow({
      frame,
      centerX:
        axX + Math.floor(A_sprite.bitmap.width / 2),
      barTopY: aY,
      effects: effectsA,
      effectIcons,
    })
    await drawEffectSummaryRow({
      frame,
      centerX:
        bxX + Math.floor(B_sprite.bitmap.width / 2),
      barTopY: bY,
      effects: effectsB,
      effectIcons,
    })

    const y = baseY - dy
    let iconX = centerX - ICON_SIZE / 2

    if (iconSrc) {
      const icon = iconSrc
        .clone()
        .contain(ICON_SIZE, ICON_SIZE, Jimp.RESIZE_BILINEAR)
      frame.composite(icon, iconX, y)
      iconX += ICON_SIZE + 6
    }

    const label =
      amountApplied >= 0
        ? `+${amountApplied}`
        : String(amountApplied)
    frame.print(font, iconX, y + 8, label)

    await saveFrame(outFramesDir, fIdx++, frame)
  }

  return fIdx
}


async function animateHealthDrop({
  bg,
  axX,
  aY,
  A_sprite,
  bxX,
  bY,
  B_sprite,
  outFramesDir,
  framesSoFar,
  fromHp,
  toHp,
  maxHp,
  side,
  otherHp,
  otherMaxHp,
  barW = HEALTH_BAR_W,
  barH = HEALTH_BAR_H,
  frames = 18,
  popupText,
  popupStartX,
  popupStartY,
  popupRisePx = 40,
  effectIcons,
  effectTotalsFont,
  A_effectTotals,
  B_effectTotals,
  cdA = 0,
  totalCdA = 1,
  cdB = 0,
  totalCdB = 1,
}) {
  let fIdx = framesSoFar
  const fontWhite = await loadFontBuiltin(32, 'white')
  const fontBlack = await loadFontBuiltin(32, 'black')

  for (let i = 0; i < frames; i++) {
    const t = i / (frames - 1)
    const hpNow = Math.round(fromHp + (toHp - fromHp) * t)
    const frame = bg.clone()
    frame.composite(A_sprite, axX, aY)
    frame.composite(B_sprite, bxX, bY)

    let A_HP_now = A_effectTotals
    let B_HP_now = B_effectTotals

    if (side === 'A') {
      drawHealthBar(
        frame,
        axX + Math.floor(A_sprite.bitmap.width / 2),
        aY,
        barW,
        barH,
        hpNow,
        maxHp
      )
      drawHealthBar(
        frame,
        bxX + Math.floor(B_sprite.bitmap.width / 2),
        bY,
        barW,
        barH,
        otherHp,
        otherMaxHp
      )
    } else {
      drawHealthBar(
        frame,
        axX + Math.floor(A_sprite.bitmap.width / 2),
        aY,
        barW,
        barH,
        otherHp,
        otherMaxHp
      )
      drawHealthBar(
        frame,
        bxX + Math.floor(B_sprite.bitmap.width / 2),
        bY,
        barW,
        barH,
        hpNow,
        maxHp
      )
    }

    // Cooldown bars (always both characters)
    const centerAx = axX + Math.floor(A_sprite.bitmap.width / 2)
    const centerBx = bxX + Math.floor(B_sprite.bitmap.width / 2)

    drawCooldownBar(
      frame,
      centerAx,
      aY - 18,
      COOLDOWN_BAR_W,
      COOLDOWN_BAR_H,
      cdA,
      totalCdA
    )
    drawCooldownBar(
      frame,
      centerBx,
      bY - 18,
      COOLDOWN_BAR_W,
      COOLDOWN_BAR_H,
      cdB,
      totalCdB
    )

    // Effect totals with bigger icons
    const barYA = Math.max(0, aY - barH - 8)
    const barYB = Math.max(0, bY - barH - 8)

    await drawEffectSummaryRow({
      frame,
      centerX: centerAx,
      barTopY: barYA,
      effects: A_effectTotals,
      effectIcons,
    })
    await drawEffectSummaryRow({
      frame,
      centerX: centerBx,
      barTopY: barYB,
      effects: B_effectTotals,
      effectIcons,
    })

    if (popupText) {
      const dy = Math.round(popupRisePx * t)
      const px = popupStartX
      const py = popupStartY - dy
      frame.print(fontBlack, px + 1, py + 1, popupText)
      frame.print(fontWhite, px, py, popupText)
    }

    await saveFrame(outFramesDir, fIdx++, frame)
  }
  return fIdx
}


async function animateHealRise({
  bg,
  axX,
  aY,
  A_sprite,
  bxX,
  bY,
  B_sprite,
  outFramesDir,
  framesSoFar,
  fromHp,
  toHp,
  maxHp,
  side,
  otherHp,
  otherMaxHp,
  barW = HEALTH_BAR_W,
  barH = HEALTH_BAR_H,
  frames = 18,
  popupText,
  popupStartX,
  popupStartY,
  popupRisePx = 40,
  effectIcons,
  effectTotalsFont,
  A_effectTotals,
  B_effectTotals,
  cdA = 0,
  totalCdA = 1,
  cdB = 0,
  totalCdB = 1,
}) {
  let fIdx = framesSoFar
  const fontWhite = await loadFontBuiltin(32, 'white')
  const fontBlack = await loadFontBuiltin(32, 'black')

  for (let i = 0; i < frames; i++) {
    const t = i / (frames - 1)
    const hpNow = Math.round(fromHp + (toHp - fromHp) * t)
    const frame = bg.clone()
    frame.composite(A_sprite, axX, aY)
    frame.composite(B_sprite, bxX, bY)

    if (side === 'A') {
      drawHealthBar(
        frame,
        axX + Math.floor(A_sprite.bitmap.width / 2),
        aY,
        barW,
        barH,
        hpNow,
        maxHp
      )
      drawHealthBar(
        frame,
        bxX + Math.floor(B_sprite.bitmap.width / 2),
        bY,
        barW,
        barH,
        otherHp,
        otherMaxHp
      )
    } else {
      drawHealthBar(
        frame,
        axX + Math.floor(A_sprite.bitmap.width / 2),
        aY,
        barW,
        barH,
        otherHp,
        otherMaxHp
      )
      drawHealthBar(
        frame,
        bxX + Math.floor(B_sprite.bitmap.width / 2),
        bY,
        barW,
        barH,
        hpNow,
        maxHp
      )
    }

    // Cooldown bars
    const centerAx = axX + Math.floor(A_sprite.bitmap.width / 2)
    const centerBx = bxX + Math.floor(B_sprite.bitmap.width / 2)

    drawCooldownBar(
      frame,
      centerAx,
      aY - 18,
      COOLDOWN_BAR_W,
      COOLDOWN_BAR_H,
      cdA,
      totalCdA
    )
    drawCooldownBar(
      frame,
      centerBx,
      bY - 18,
      COOLDOWN_BAR_W,
      COOLDOWN_BAR_H,
      cdB,
      totalCdB
    )

    // Effect totals
    const barYA = Math.max(0, aY - barH - 8)
    const barYB = Math.max(0, bY - barH - 8)

    await drawEffectSummaryRow({
      frame,
      centerX: centerAx,
      barTopY: barYA,
      effects: A_effectTotals,
      effectIcons,
    })
    await drawEffectSummaryRow({
      frame,
      centerX: centerBx,
      barTopY: barYB,
      effects: B_effectTotals,
      effectIcons,
    })

    if (popupText) {
      const dy = Math.round(popupRisePx * t)
      const px = popupStartX
      const py = popupStartY - dy
      frame.print(fontBlack, px + 1, py + 1, popupText)
      frame.print(fontWhite, px, py, popupText)
    }

    await saveFrame(outFramesDir, fIdx++, frame)
  }
  return fIdx
}


/* ===================== CAMERA ZOOM + STATS ===================== */
async function zoomStatsSequence({
  baseFrameBuilder,
  bgW,
  bgH,
  focusBox,
  statsPanelImage,
  movePanelImage,
  outFramesDir,
  framesSoFar,
  audioTimeline,
  emoteCueKind,
}) {
  let fIdx = framesSoFar
  const panelH = statsPanelImage.bitmap.height
  const moveH = movePanelImage.bitmap.height

  const placeBoards = (frame) => {
    const statsX = Math.round(
      (bgW - statsPanelImage.bitmap.width) / 2
    )
    frame.composite(statsPanelImage, statsX, STAT_BOARD_TOP_GAP)
    const moveX = Math.round(
      (bgW - movePanelImage.bitmap.width) / 2
    )
    const moveY = bgH - moveH - MOVE_BOARD_BOTTOM_GAP
    frame.composite(movePanelImage, moveX, moveY)
  }

  const zoomMax = ZOOM_MAX * (1 + STATS_ZOOM_BUMP)

  function computeCyForZoom(z) {
    const ch = Math.round(bgH / z)
    const cw = Math.round(bgW / z)
    const panelBottomCanvas =
      STAT_BOARD_TOP_GAP + panelH
    const requiredTopInCrop =
      panelBottomCanvas / z + STATS_PANEL_CLEARANCE
    const creatureTopWorld = focusBox.cy - focusBox.h / 2
    const maxCyToKeepClear =
      creatureTopWorld -
      requiredTopInCrop +
      ch / 2
    const preferredCy =
      focusBox.cy +
      Math.round(bgH * STATS_PREFERRED_OFFSET_FRACTION)
    const cy = clamp(
      Math.min(preferredCy, maxCyToKeepClear),
      ch / 2,
      bgH - ch / 2
    )
    const cx = clamp(focusBox.cx, cw / 2, bgW - cw / 2)
    return { cx, cy, ch, cw }
  }

  const doZoomStep = async (z, recordStart = false) => {
    const { cx, cy, ch, cw } = computeCyForZoom(z)
    const x0 = clamp(Math.round(cx - cw / 2), 0, bgW - cw)
    const y0 = clamp(Math.round(cy - ch / 2), 0, bgH - ch)
    const base = await baseFrameBuilder()
    const cropped = base
      .clone()
      .crop(x0, y0, cw, ch)
      .resize(bgW, bgH, Jimp.RESIZE_BICUBIC)
    placeBoards(cropped)
    if (recordStart && audioTimeline) {
      audioTimeline.push(emoteCueKind, fIdx / FIGHT_FPS)
    }
    await saveFrame(outFramesDir, fIdx++, cropped)
  }

  for (let i = 0; i < ZOOM_IN_FRAMES; i++) {
    const t = i / (ZOOM_IN_FRAMES - 1)
    const z =
      1 +
      (zoomMax - 1) *
        (t < 0.5
          ? 2 * t * t
          : 1 - Math.pow(-2 * t + 2, 2) / 2)
    await doZoomStep(z, i === 0)
  }
  for (let i = 0; i < STATS_HOLD_FRAMES; i++) {
    await doZoomStep(zoomMax)
  }
  for (let i = 0; i < ZOOM_OUT_FRAMES; i++) {
    const t = i / (ZOOM_OUT_FRAMES - 1)
    const z =
      zoomMax -
      (zoomMax - 1) *
        (t < 0.5
          ? 2 * t * t
          : 1 - Math.pow(-2 * t + 2, 2) / 2)
    await doZoomStep(z)
  }

  return fIdx
}

/* ===================== PROJECTILES ===================== */
async function drawProjectileSequence({
  bg,
  outFramesDir,
  startX,
  startY,
  endX,
  endY,
  framesSoFar,
  projectileImg,
  layerLeft,
  layerRight,
  bars,
  framesOverride = null,
  effectIcons,
  effectTotalsFont,
  A_effectTotals,
  B_effectTotals,
}) {
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
        axX,
        aY,
        A_sprite,
        bxX,
        bY,
        B_sprite,
        A_HP,
        A_MAX,
        B_HP,
        B_MAX,
        barW = HEALTH_BAR_W,
        barH = HEALTH_BAR_H,
        cdA = 0,
        cdB = 0,
        totalCdA = 1,
        totalCdB = 1,
      } = bars

      // Health bars
      drawHealthBar(
        frame,
        axX + Math.floor(A_sprite.bitmap.width / 2),
        aY,
        barW,
        barH,
        A_HP,
        A_MAX
      )
      drawHealthBar(
        frame,
        bxX + Math.floor(B_sprite.bitmap.width / 2),
        bY,
        barW,
        barH,
        B_HP,
        B_MAX
      )

      // Cooldown bars (both visible)
      drawCooldownBar(
        frame,
        axX + Math.floor(A_sprite.bitmap.width / 2),
        aY - 18,
        COOLDOWN_BAR_W,
        COOLDOWN_BAR_H,
        cdA,
        Math.max(0.8, totalCdA || cdA || 0.8)
      )
      drawCooldownBar(
        frame,
        bxX + Math.floor(B_sprite.bitmap.width / 2),
        bY - 18,
        COOLDOWN_BAR_W,
        COOLDOWN_BAR_H,
        cdB,
        Math.max(0.8, totalCdB || cdB || 0.8)
      )

      // Effects (big icons)
      const barYA = Math.max(0, aY - barH - 8)
      const barYB = Math.max(0, bY - barH - 8)
      const centerAx =
        axX + Math.floor(A_sprite.bitmap.width / 2)
      const centerBx =
        bxX + Math.floor(B_sprite.bitmap.width / 2)

      await drawEffectSummaryRow({
        frame,
        centerX: centerAx,
        barTopY: barYA,
        effects: A_effectTotals,
        effectIcons,
      })
      await drawEffectSummaryRow({
        frame,
        centerX: centerBx,
        barTopY: barYB,
        effects: B_effectTotals,
        effectIcons,
      })
    }

    await saveFrame(outFramesDir, fIdx++, frame)
  }
  return fIdx
}


/* ===================== VICTORY ===================== */
async function victorySequence({
  bg,
  bgW,
  bgH,
  winner,
  axFinalX,
  aY,
  A_idle,
  A_emote,
  bxFinalX,
  bY,
  B_idle,
  B_emote,
  outFramesDir,
  framesSoFar,
  audioTimeline,
  winnerName,
}) {
  let fIdx = framesSoFar

  const winSpriteIdle = winner === 'A' ? A_idle : B_idle
  const winSpriteEmote = winner === 'A' ? A_emote : B_emote
  const winX = winner === 'A' ? axFinalX : bxFinalX
  const winY = winner === 'A' ? aY : bY
  const emoteCenter = {
    cx: winX + Math.floor(winSpriteEmote.bitmap.width / 2),
    cy: winY + Math.floor(winSpriteEmote.bitmap.height * 0.55),
    w: winSpriteEmote.bitmap.width,
    h: winSpriteEmote.bitmap.height,
  }

  const baseEmoteFrame = async () => {
    const frame = bg.clone()
    frame.composite(winSpriteEmote, winX, winY)
    return frame
  }

  audioTimeline.push(
    winner === 'A' ? 'emoteA' : 'emoteB',
    fIdx / FIGHT_FPS
  )

  for (let i = 0; i < VICTORY_ZOOM_IN_FR; i++) {
    const t = easeInOut(i / (VICTORY_ZOOM_IN_FR - 1))
    const z = 1 + (VICTORY_ZOOM_MAX - 1) * t
    const cw = Math.round(bgW / z)
    const ch = Math.round(bgH / z)
    const x0 = clamp(
      Math.round(emoteCenter.cx - cw / 2),
      0,
      bgW - cw
    )
    const y0 = clamp(
      Math.round(emoteCenter.cy - ch / 2),
      0,
      bgH - ch
    )
    const base = await baseEmoteFrame()
    const cropped = base
      .clone()
      .crop(x0, y0, cw, ch)
      .resize(bgW, bgH, Jimp.RESIZE_BICUBIC)
    await saveFrame(outFramesDir, fIdx++, cropped)
  }

  for (let i = 0; i < VICTORY_HOLD_FRAMES; i++) {
    const z = VICTORY_ZOOM_MAX
    const cw = Math.round(bgW / z)
    const ch = Math.round(bgH / z)
    const x0 = clamp(
      Math.round(emoteCenter.cx - cw / 2),
      0,
      bgW - cw
    )
    const y0 = clamp(
      Math.round(emoteCenter.cy - ch / 2),
      0,
      bgH - ch
    )
    const base = await baseEmoteFrame()
    const cropped = base
      .clone()
      .crop(x0, y0, cw, ch)
      .resize(bgW, bgH, Jimp.RESIZE_BICUBIC)

    await saveFrame(outFramesDir, fIdx++, cropped)
  }

  const bannerW = Math.round(bgW * 0.92)
  const bannerH = 132
  const banner = new Jimp(
    bannerW,
    bannerH,
    Jimp.cssColorToHex('#0e0a08')
  )
  banner.opacity(0.82)
  const GOLD_HEX = Jimp.cssColorToHex(
    'rgba(225,184,100,0.9)'
  )
  for (let x = 0; x < bannerW; x++) {
    banner.setPixelColor(GOLD_HEX, x, 0)
    banner.setPixelColor(GOLD_HEX, x, bannerH - 1)
  }
  for (let y = 0; y < bannerH; y++) {
    banner.setPixelColor(GOLD_HEX, 0, y)
    banner.setPixelColor(GOLD_HEX, bannerW - 1, y)
  }

  const titleFont = await loadFontBuiltin(64, 'white')
  const msg = `${winnerName} is victorious!`

  for (let i = 0; i < VICTORY_BANNER_FRAMES; i++) {
    const z = VICTORY_ZOOM_MAX
    const cw = Math.round(bgW / z)
    const ch = Math.round(bgH / z)
    const x0 = clamp(
      Math.round(emoteCenter.cx - cw / 2),
      0,
      bgW - cw
    )
    const y0 = clamp(
      Math.round(emoteCenter.cy - ch / 2),
      0,
      bgH - ch
    )
    const base = await baseEmoteFrame()
    const cropped = base
      .clone()
      .crop(x0, y0, cw, ch)
      .resize(bgW, bgH, Jimp.RESIZE_BICUBIC)

    const bx = Math.round((bgW - bannerW) / 2)
    const by = VICTORY_BANNER_TOP
    const frame = cropped
    frame.composite(banner, bx, by)
    frame.print(
      titleFont,
      bx + 24,
      by + 18,
      {
        text: msg,
        alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
        alignmentY: Jimp.VERTICAL_ALIGN_MIDDLE,
      },
      bannerW - 48,
      bannerH - 36
    )

    await saveFrame(outFramesDir, fIdx++, frame)
  }

  return fIdx
}

async function fadeOutDefeated({
  bg,
  axFinalX,
  aY,
  A_sprite,
  bxFinalX,
  bY,
  B_sprite,
  outFramesDir,
  framesSoFar,
  loser,
  A_HP,
  B_HP,
  A_MAX,
  B_MAX,
  cdA = 0,
  cdB = 0,
  totalCdA = 1,
  totalCdB = 1,
  A_effectTotals = {},
  B_effectTotals = {},
  effectIcons,
  barW = HEALTH_BAR_W,
  barH = HEALTH_BAR_H,
}) {
  let fIdx = framesSoFar
  const steps = 20

  const centerAx =
    axFinalX + Math.floor(A_sprite.bitmap.width / 2)
  const centerBx =
    bxFinalX + Math.floor(B_sprite.bitmap.width / 2)

  for (let i = 0; i < steps; i++) {
    const frame = bg.clone()
    const alpha = 1 - i / (steps - 1)

    if (loser === 'A') {
      frame.composite(
        A_sprite.clone().opacity(alpha),
        axFinalX,
        aY
      )
      frame.composite(B_sprite, bxFinalX, bY)
    } else {
      frame.composite(A_sprite, axFinalX, aY)
      frame.composite(
        B_sprite.clone().opacity(alpha),
        bxFinalX,
        bY
      )
    }

    // Health bars
    drawHealthBar(
      frame,
      centerAx,
      aY,
      barW,
      barH,
      A_HP,
      A_MAX
    )
    drawHealthBar(
      frame,
      centerBx,
      bY,
      barW,
      barH,
      B_HP,
      B_MAX
    )

    // Cooldown bars
    drawCooldownBar(
      frame,
      centerAx,
      aY - 18,
      COOLDOWN_BAR_W,
      COOLDOWN_BAR_H,
      cdA,
      Math.max(0.8, totalCdA || cdA || 0.8)
    )
    drawCooldownBar(
      frame,
      centerBx,
      bY - 18,
      COOLDOWN_BAR_W,
      COOLDOWN_BAR_H,
      cdB,
      Math.max(0.8, totalCdB || cdB || 0.8)
    )

    // Effect stacks (same “always on” behavior)
    await drawEffectSummaryRow({
      frame,
      centerX: centerAx,
      barTopY: aY,
      effects: A_effectTotals,
      effectIcons,
    })
    await drawEffectSummaryRow({
      frame,
      centerX: centerBx,
      barTopY: bY,
      effects: B_effectTotals,
      effectIcons,
    })

    await saveFrame(outFramesDir, fIdx++, frame)
  }
  return fIdx
}


/* ===================== EASING ===================== */
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3)
}
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}

/* ===================== FIGHT SCENE ===================== */
async function createFightFrames({
  aName,
  bName,
  backgroundPath,
  spriteAPath,
  spriteBPath,
  spriteAEmotePath,
  spriteBEmotePath,
  spriteAMoveAPath,
  spriteBMoveAPath,
  spriteAMoveBPath,
  spriteBMoveBPath,
  spriteAMoveCPath,
  spriteBMoveCPath, // currently unused but accepted
  moveAVisualAPath,
  moveAVisualBPath,
  moveBVisualAPath,
  moveBVisualBPath,
  moveCVisualAPath,
  moveCVisualBPath, // currently unused but accepted
  statsPanelAPath,
  statsPanelBPath,
  movePanelAPath,
  movePanelBPath,
  outFramesDir,
  scaleFraction,
  aStats,
  bStats,
  aTypes,
  bTypes, // kept for metadata/UI
  aMoveMetaA,
  aMoveMetaB,
  aMoveMetaC, // currently unused
  bMoveMetaA,
  bMoveMetaB,
  bMoveMetaC, // currently unused
  audioTimeline,
  effectIcons,
}) {
  ensureDir(outFramesDir)
  await emptyDir(outFramesDir)

  const bg = await Jimp.read(backgroundPath)
  const bgW = bg.bitmap.width
  const bgH = bg.bitmap.height

  let A_idle = await Jimp.read(spriteAPath)
  let B_idle = await Jimp.read(spriteBPath)
  let A_emote = await Jimp.read(spriteAEmotePath)
  let B_emote = await Jimp.read(spriteBEmotePath)
  let A_moveA = await Jimp.read(spriteAMoveAPath)
  let B_moveA = await Jimp.read(spriteBMoveAPath)
  let A_moveB = await Jimp.read(spriteAMoveBPath)
  let B_moveB = await Jimp.read(spriteBMoveBPath)
  let A_moveC = await Jimp.read(spriteAMoveCPath)
  let B_moveC = await Jimp.read(spriteBMoveCPath)


  // Characters 2× larger
  const targetH = Math.max(64, Math.round(bgH * scaleFraction * 2))
  const scaleToHeight = (img, h) =>
    img.resize(
      Math.round(img.bitmap.width * (h / img.bitmap.height)),
      h
    )
  A_idle = scaleToHeight(A_idle, targetH)
  A_emote = scaleToHeight(A_emote, targetH)
  A_moveA = scaleToHeight(A_moveA, targetH)
  A_moveB = scaleToHeight(A_moveB, targetH)
  A_moveC = scaleToHeight(A_moveC, targetH)
  B_idle = scaleToHeight(B_idle, targetH)
  B_emote = scaleToHeight(B_emote, targetH)
  B_moveA = scaleToHeight(B_moveA, targetH)
  B_moveB = scaleToHeight(B_moveB, targetH)
  B_moveC = scaleToHeight(B_moveC, targetH)


  // Move images / projectiles – half size vs previous 2× version
  const projTargetH = Math.max(
    32,
    Math.round(bgH * PROJECTILE_HEIGHT_FRACTION)
  )
  let projA_A = (await Jimp.read(moveAVisualAPath)).resize(
    Jimp.AUTO,
    projTargetH,
    Jimp.RESIZE_BILINEAR
  )
  let projB_A = (await Jimp.read(moveAVisualBPath)).resize(
    Jimp.AUTO,
    projTargetH,
    Jimp.RESIZE_BILINEAR
  )
  let projA_B = (await Jimp.read(moveBVisualAPath)).resize(
    Jimp.AUTO,
    projTargetH,
    Jimp.RESIZE_BILINEAR
  )
  let projB_B = (await Jimp.read(moveBVisualBPath)).resize(
    Jimp.AUTO,
    projTargetH,
    Jimp.RESIZE_BILINEAR
  )

    let projA_C = (await Jimp.read(moveCVisualAPath)).resize(
    Jimp.AUTO,
    projTargetH,
    Jimp.RESIZE_BILINEAR
  )
  let projB_C = (await Jimp.read(moveCVisualBPath)).resize(
    Jimp.AUTO,
    projTargetH,
    Jimp.RESIZE_BILINEAR
  )


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
  const movePanelA = await Jimp.read(movePanelAPath)
  const movePanelB = await Jimp.read(movePanelBPath)

  // Effect stacks state
  const A_effectTotals = {}
  const B_effectTotals = {}
  const effectTotalsFont = await loadFontBuiltin(16, 'white')

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

      async function drawBarsAndEffects(
    frame,
    cdA,
    cdB,
    A_HP,
    A_MAX,
    B_HP,
    B_MAX
  ) {
    // Health bars
    drawHealthBar(
      frame,
      axFinalX + Math.floor(A_idle.bitmap.width / 2),
      aY,
      HEALTH_BAR_W,
      HEALTH_BAR_H,
      A_HP,
      A_MAX
    )
    drawHealthBar(
      frame,
      bxFinalX + Math.floor(B_idle.bitmap.width / 2),
      bY,
      HEALTH_BAR_W,
      HEALTH_BAR_H,
      B_HP,
      B_MAX
    )

    // Cooldown bars (both sides, always)
    drawCooldownBar(
      frame,
      axFinalX + Math.floor(A_idle.bitmap.width / 2),
      aY - 18,
      COOLDOWN_BAR_W,
      COOLDOWN_BAR_H,
      cdA,
      Math.max(0.8, totalCdA || cdA || 0.8)
    )
    drawCooldownBar(
      frame,
      bxFinalX + Math.floor(B_idle.bitmap.width / 2),
      bY - 18,
      COOLDOWN_BAR_W,
      COOLDOWN_BAR_H,
      cdB,
      Math.max(0.8, totalCdB || cdB || 0.8)
    )

    // Effect icons + stacks (big) – ALWAYS visible
    const barYA = Math.max(0, aY - HEALTH_BAR_H - 8)
    const barYB = Math.max(0, bY - HEALTH_BAR_H - 8)
    const centerAx =
      axFinalX + Math.floor(A_idle.bitmap.width / 2)
    const centerBx =
      bxFinalX + Math.floor(B_idle.bitmap.width / 2)

    await drawEffectSummaryRow({
      frame,
      centerX: centerAx,
      barTopY: barYA,
      effects: A_effectTotals,
      effectIcons,
    })
    await drawEffectSummaryRow({
      frame,
      centerX: centerBx,
      barTopY: barYB,
      effects: B_effectTotals,
      effectIcons,
    })
  }



    /**
   * Apply effect stacks after a move resolves.
   * - Uses effect_potency_base from charObj.
   * - Buffs & curses apply 2× potency.
   * - Buffs target self, curses & normal damage target the opponent.
   * - Stores stacks keyed by lower-case effect name for icon lookup.
   */
  function applyEffectStacksForMove(meta, moveKind, isActorA) {
    const effectNameRaw = String(
      meta.effect_name || meta.effect || ''
    ).trim()
    const basePotency = Number(
      meta.effect_potency_base ?? meta.effect_potency ?? 0
    )

    if (!effectNameRaw || !basePotency) return null

    const isBuffK = moveKind === 'buff' || isBuffMove(meta)
    const isCurseK = moveKind === 'curse' || isCurseMove(meta)

    const multiplier = isBuffK || isCurseK ? 2 : 1
    const amount = basePotency * multiplier

    // Buff ⇒ self, everything else ⇒ opponent
    const targetSide = isBuffK
      ? (isActorA ? 'A' : 'B')
      : (isActorA ? 'B' : 'A')

    const key = effectNameRaw.toLowerCase()
    const bucket = targetSide === 'A'
      ? A_effectTotals
      : B_effectTotals

    bucket[key] = (bucket[key] || 0) + amount

    return {
      effectName: key, // for icon lookup
      amount,
      targetSide,
    }
  }


    async function animateEffectPopup({
    targetSide,
    effectName,
    amount,
    framesSoFar,
    cdA,
    cdB,
    A_HP,
    A_MAX,
    B_HP,
    B_MAX,
  }) {
    if (!effectName || !amount) return framesSoFar

    const popupFont = await loadFontBuiltin(32, 'white')
    const popupFontOutline = await loadFontBuiltin(32, 'black')
    const icon = effectIcons?.[effectName] || null

    let fIdxLocal = framesSoFar
    const frames = 18
    const risePx = 40

    const isA = targetSide === 'A'
    const centerX = isA
      ? axFinalX + Math.floor(A_idle.bitmap.width / 2)
      : bxFinalX + Math.floor(B_idle.bitmap.width / 2)
    const spriteTopY = isA ? aY : bY
    const baseY = spriteTopY - 20

    for (let i = 0; i < frames; i++) {
      const t = i / Math.max(1, frames - 1)
      const dy = Math.round(risePx * t)
      const y = baseY - dy

      const frame = bg.clone()
      frame.composite(A_idle, axFinalX, aY)
      frame.composite(B_idle, bxFinalX, bY)

      // 🔒 ALWAYS draw HP, cooldowns, and ALL applied stacks
      await drawBarsAndEffects(
        frame,
        cdA,
        cdB,
        A_HP,
        A_MAX,
        B_HP,
        B_MAX
      )

      let ix = centerX
      if (icon) {
        const size = 24
        const scaled = icon
          .clone()
          .contain(size, size, Jimp.RESIZE_BILINEAR)
        ix = centerX - Math.floor(size / 2) - 12
        frame.composite(scaled, ix, y)
        ix += size + 4
      }

      const text = `+${amount}`
      frame.print(popupFontOutline, ix + 1, y + 1, text)
      frame.print(popupFont, ix, y, text)

      await saveFrame(outFramesDir, fIdxLocal++, frame)
    }

    return fIdxLocal
  }

    /**
   * Simple floating "MISS" popup above the target.
   */
  async function animateMissPopup({
    targetSide,   // 'A' or 'B' (the side that was attacked / dodged)
    framesSoFar,
    cdA,
    cdB,
    A_HP,
    A_MAX,
    B_HP,
    B_MAX,
  }) {
    let fIdxLocal = framesSoFar
    const fontWhite = await loadFontBuiltin(32, 'white')
    const fontBlack = await loadFontBuiltin(32, 'black')

    const frames = 18
    const risePx = 40
    const text = 'MISS'

    const isTargetA = targetSide === 'A'
    const centerX = isTargetA
      ? axFinalX + Math.floor(A_idle.bitmap.width / 2)
      : bxFinalX + Math.floor(B_idle.bitmap.width / 2)
    const baseY = (isTargetA ? aY : bY) - 10

    for (let i = 0; i < frames; i++) {
      const t = i / Math.max(1, frames - 1)
      const dy = Math.round(risePx * t)
      const y = baseY - dy

      const frame = bg.clone()
      frame.composite(A_idle, axFinalX, aY)
      frame.composite(B_idle, bxFinalX, bY)

      // Bars + always-on effects
      await drawBarsAndEffects(
        frame,
        cdA,
        cdB,
        A_HP,
        A_MAX,
        B_HP,
        B_MAX
      )

      const approxTextW = text.length * 16
      const x = centerX - Math.round(approxTextW / 2)

      frame.print(fontBlack, x + 1, y + 1, text)
      frame.print(fontWhite, x, y, text)

      await saveFrame(outFramesDir, fIdxLocal++, frame)
    }

    return fIdxLocal
  }


      // Apply DOT / HoT from effects ONLY to the side that is about to act.
  async function applyOngoingEffectsForSide(side) {
    const isA = side === 'A'
    const effects = isA ? A_effectTotals : B_effectTotals
    const delta = computeOngoingEffectHpDelta(effects)
    if (!delta) return

    const prevHp = isA ? A_HP : B_HP
    const maxHp = isA ? A_MAX : B_MAX
    const otherHp = isA ? B_HP : A_HP
    const otherMaxHp = isA ? B_MAX : A_MAX

    const newHp = clamp(prevHp + delta, 0, maxHp)
    const popupText =
      delta < 0
        ? `-${Math.abs(delta).toFixed(1)}`
        : `+${Math.abs(delta).toFixed(1)}`

    const centerX = isA
      ? axFinalX + Math.floor(A_idle.bitmap.width / 2)
      : bxFinalX + Math.floor(B_idle.bitmap.width / 2)
    const spriteY = isA ? aY : bY
    const popupX = centerX - 10
    const popupY = spriteY - 10

    if (delta < 0) {
      // Effect damage
      fIdx = await animateHealthDrop({
        bg,
        axX: axFinalX,
        aY,
        A_sprite: A_idle,
        bxX: bxFinalX,
        bY,
        B_sprite: B_idle,
        outFramesDir,
        framesSoFar: fIdx,
        fromHp: prevHp,
        toHp: newHp,
        maxHp,
        side: isA ? 'A' : 'B',
        otherHp,
        otherMaxHp,
        barW: HEALTH_BAR_W,
        barH: HEALTH_BAR_H,
        frames: 20,
        popupText,
        popupStartX: popupX,
        popupStartY: popupY,
        popupRisePx: 36,
        effectIcons,
        effectTotalsFont,
        A_effectTotals,
        B_effectTotals,
        cdA,
        totalCdA,
        cdB,
        totalCdB,
      })
    } else {
      // Effect healing (nurture)
      fIdx = await animateHealRise({
        bg,
        axX: axFinalX,
        aY,
        A_sprite: A_idle,
        bxX: bxFinalX,
        bY,
        B_sprite: B_idle,
        outFramesDir,
        framesSoFar: fIdx,
        fromHp: prevHp,
        toHp: newHp,
        maxHp,
        side: isA ? 'A' : 'B',
        otherHp,
        otherMaxHp,
        barW: HEALTH_BAR_W,
        barH: HEALTH_BAR_H,
        frames: 20,
        popupText,
        popupStartX: popupX,
        popupStartY: popupY,
        popupRisePx: 36,
        effectIcons,
        effectTotalsFont,
        A_effectTotals,
        B_effectTotals,
        cdA,
        totalCdA,
        cdB,
        totalCdB,
      })
    }

    if (isA) A_HP = newHp
    else B_HP = newHp
  }




  // A floats in
  for (let i = 0; i < FIGHT_FRAMES_A; i++) {
    const t = easeOutCubic(i / (FIGHT_FRAMES_A - 1))
    const ax = Math.round(axStartX + (axFinalX - axStartX) * t)
    const frame = bg.clone()
    frame.composite(A_idle, ax, aY)
    await saveFrame(outFramesDir, fIdx++, frame)
  }

  // A stats zoom
  {
    const focusBoxA = {
      cx: axFinalX + Math.floor(A_emote.bitmap.width / 2),
      cy: aY + Math.floor(A_emote.bitmap.height * 0.55),
      w: A_emote.bitmap.width,
      h: A_emote.bitmap.height,
    }
    fIdx = await zoomStatsSequence({
      baseFrameBuilder: buildFrameAEmote,
      bgW,
      bgH,
      focusBox: focusBoxA,
      statsPanelImage: statsPanelA,
      movePanelImage: movePanelA,
      outFramesDir,
      framesSoFar: fIdx,
      audioTimeline,
      emoteCueKind: 'emoteA',
    })
  }

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
      cx: bxFinalX + Math.floor(B_emote.bitmap.width / 2),
      cy: bY + Math.floor(B_emote.bitmap.height * 0.55),
      w: B_emote.bitmap.width,
      h: B_emote.bitmap.height,
    }
    fIdx = await zoomStatsSequence({
      baseFrameBuilder: buildFrameBEmote,
      bgW,
      bgH,
      focusBox: focusBoxB,
      statsPanelImage: statsPanelB,
      movePanelImage: movePanelB,
      outFramesDir,
      framesSoFar: fIdx,
      audioTimeline,
      emoteCueKind: 'emoteB',
    })
  }

  for (let i = 0; i < EMOTE_FRAMES; i++) {
    const frame = bg.clone()
    frame.composite(A_idle, axFinalX, aY)
    frame.composite(B_emote, bxFinalX, bY)
    await saveFrame(outFramesDir, fIdx++, frame)
  }

  /* ===== COOLDOWN-BASED DUEL ===== */
  let A_HP = Math.max(1, Math.round(aStats.health))
  let B_HP = Math.max(1, Math.round(bStats.health))
  const A_MAX = A_HP
  const B_MAX = B_HP


  let cdA = 0
  let cdB = 0
  let totalCdA = 1
  let totalCdB = 1
  const dt = 1 / FIGHT_FPS

    // Apply DOT/HoT from all current stacks once before a move resolves.
  function applyOngoingEffectsBeforeTurn() {
    const resA = applyOngoingEffectsOnce(
      A_effectTotals,
      A_HP,
      A_MAX
    )
    A_HP = resA.newHp

    const resB = applyOngoingEffectsOnce(
      B_effectTotals,
      B_HP,
      B_MAX
    )
    B_HP = resB.newHp
  }


  // Draw an idle frame and tick cooldown bars down toward 0
    const drawIdleFrameAndTick = async () => {
    if (cdA > 0) cdA = Math.max(0, cdA - dt)
    if (cdB > 0) cdB = Math.max(0, cdB - dt)

    const frame = bg.clone()
    frame.composite(A_idle, axFinalX, aY)
    frame.composite(B_idle, bxFinalX, bY)

    await drawBarsAndEffects(
      frame,
      cdA,
      cdB,
      A_HP,
      A_MAX,
      B_HP,
      B_MAX
    )

    await saveFrame(outFramesDir, fIdx++, frame)
  }



    const pickMoveFor = (side) => {
    if (side === 'A') {
      const options = [
        {
          meta: aMoveMetaA,
          spritePose: A_moveA,
          visualImg: projA_A,
        },
        {
          meta: aMoveMetaB,
          spritePose: A_moveB,
          visualImg: projA_B,
        },
        {
          meta: aMoveMetaC,
          spritePose: A_moveC,
          visualImg: projA_C,
        },
      ].filter(o => o.meta) // safeguard if any move is missing

      const idx = Math.floor(Math.random() * options.length)
      return options[idx]
    } else {
      const options = [
        {
          meta: bMoveMetaA,
          spritePose: B_moveA,
          visualImg: projB_A,
        },
        {
          meta: bMoveMetaB,
          spritePose: B_moveB,
          visualImg: projB_B,
        },
        {
          meta: bMoveMetaC,
          spritePose: B_moveC,
          visualImg: projB_C,
        },
      ].filter(o => o.meta)

      const idx = Math.floor(Math.random() * options.length)
      return options[idx]
    }
  }




  const decideNextActor = () => {
    if (cdA <= 0 && cdB <= 0) return speedFirst
    if (cdA <= 0 && cdB > 0) return 'A'
    if (cdB <= 0 && cdA > 0) return 'B'
    return null
  }

   for (let i = 0; i < 6; i++) await drawIdleFrameAndTick()

    duel_loop: while (A_HP > 0 && B_HP > 0) {
    // 1) While both are cooling down, just show idle frames and tick cd
    while (
      A_HP > 0 &&
      B_HP > 0 &&
      cdA > 0 &&
      cdB > 0
    ) {
      await drawIdleFrameAndTick()
    }



    if (A_HP <= 0 || B_HP <= 0) break duel_loop

    // 2) Decide who acts:
    let actor = null
    if (cdA <= 0 && cdB <= 0) {
      // Both ready: use EFFECT-ADJUSTED speed for the tiebreaker
      const adjA = computeAttackerAdjustedStats(
        aStats,
        A_effectTotals
      )
      const adjB = computeAttackerAdjustedStats(
        bStats,
        B_effectTotals
      )

      const speedA = adjA.speed || aStats.speed || 0
      const speedB = adjB.speed || bStats.speed || 0

      if (speedA === speedB) {
        actor = Math.random() < 0.5 ? 'A' : 'B'
      } else {
        actor = speedA > speedB ? 'A' : 'B'
      }
    } else if (cdA <= 0) {
      actor = 'A'
    } else if (cdB <= 0) {
      actor = 'B'
    }

    // Safety fallback (shouldn't normally happen)
    if (!actor) {
      await drawIdleFrameAndTick()
      continue
    }

    // 3) Apply all ongoing DOT/HoT before this actor uses a move
        // 3) Apply DOT/HoT only to this actor, right before they move
    await applyOngoingEffectsForSide(actor)
    if (A_HP <= 0 || B_HP <= 0) break duel_loop

    const { meta, spritePose, visualImg } = pickMoveFor(actor)

    const isA = actor === 'A'
    const actorIdle = isA ? A_idle : B_idle
    const defIdle = isA ? B_idle : A_idle
    const actorX = isA ? axFinalX : bxFinalX
    const actorY = isA ? aY : bY
    const defX = isA ? bxFinalX : axFinalX
    const defY = isA ? bY : aY
    const buff = isBuffMove(meta)
    const curse = isCurseMove(meta)
    const moveKind = buff ? 'buff' : curse ? 'curse' : 'damage'

    // "wind-up" frame
    {
      const frame = bg.clone()
      if (isA) {
        frame.composite(spritePose, actorX, actorY)
        frame.composite(defIdle, defX, defY)
      } else {
        frame.composite(A_idle, axFinalX, aY)
        frame.composite(spritePose, actorX, actorY)
      }

      await drawBarsAndEffects(frame, cdA, cdB, A_HP, A_MAX, B_HP, B_MAX)

      await saveFrame(outFramesDir, fIdx++, frame)
    }

    const category = String(meta.category || 'melee').toLowerCase()
    let impactTimeSec = null

        if (buff) {
      // ===== BUFF MOVE: SELF-CAST, FLOATING EFFECT FROM TOP, HEAL CASTER =====
      const framesBuff = PROJECTILE_FRAMES

      const charTopY = actorY
      const startX =
        actorX +
        Math.floor(spritePose.bitmap.width / 2) -
        Math.floor(visualImg.bitmap.width / 2)
      const startY = charTopY - visualImg.bitmap.height
      const endY =
        startY -
        Math.floor(spritePose.bitmap.height * 0.5)

      const buffStartFrame = fIdx

      for (let i = 0; i < framesBuff; i++) {
        const t = easeOutCubic(i / Math.max(1, framesBuff - 1))
        const y = Math.round(startY + (endY - startY) * t)
        const x = Math.round(startX)
        const frame = bg.clone()

        if (isA) {
          frame.composite(spritePose, actorX, actorY)
          frame.composite(defIdle, defX, defY)
        } else {
          frame.composite(A_idle, axFinalX, aY)
          frame.composite(spritePose, actorX, actorY)
        }

        await drawBarsAndEffects(frame, cdA, cdB, A_HP, A_MAX, B_HP, B_MAX)

        frame.composite(visualImg, x, y)

        await saveFrame(outFramesDir, fIdx++, frame)
      }

      impactTimeSec =
        (buffStartFrame + framesBuff - 1) / FIGHT_FPS

      audioTimeline.push(
        isA ? 'emoteA' : 'emoteB',
        impactTimeSec
      )

    // Heal for the damage this move would deal (same damage formula, with stats/effects)
      const { dmg: healAmountRaw } = calcDamageRPG({
        movePower: meta.power,
        category,
        attackerStats: isA ? aStats : bStats,
        defenderStats: isA ? bStats : aStats,
        attackerEffects: isA ? A_effectTotals : B_effectTotals,
        defenderEffects: isA ? B_effectTotals : A_effectTotals,
      })
      const healAmount = Math.max(1, healAmountRaw)


      if (isA) {
        const prev = A_HP
        const newHp = Math.min(A_MAX, prev + healAmount)
        const popupX =
          axFinalX +
          Math.floor(A_idle.bitmap.width / 2) -
          10
        const popupY = aY - 10
          fIdx = await animateHealRise({
          bg,
          axX: axFinalX,
          aY,
          A_sprite: A_idle,
          bxX: bxFinalX,
          bY,
          B_sprite: B_idle,
          outFramesDir,
          framesSoFar: fIdx,
          fromHp: prev,
          toHp: newHp,
          maxHp: A_MAX,
          side: 'A',
          otherHp: B_HP,
          otherMaxHp: B_MAX,
          barW: HEALTH_BAR_W,
          barH: HEALTH_BAR_H,
          frames: 20,
          popupText: `+${newHp - prev}`,
          popupStartX: popupX,
          popupStartY: popupY,
          popupRisePx: 36,
          effectIcons,
          effectTotalsFont,
          A_effectTotals,
          B_effectTotals,
          cdA,
          totalCdA,
          cdB,
          totalCdB,
        })

        A_HP = newHp

        // Apply buff effect to caster, 2× potency
        const effEv = applyEffectStacksForMove(meta, moveKind, true)
        if (effEv && effEv.amount > 0) {
          fIdx = await animateEffectPopup({
            targetSide: effEv.targetSide,
            effectName: effEv.effectName,
            amount: effEv.amount,
            framesSoFar: fIdx,
            cdA,
            cdB,
            A_HP,
            A_MAX,
            B_HP,
            B_MAX,
          })
        }
      } else {
      const prev = B_HP
      const newHp = Math.min(B_MAX, prev + healAmount)
      const popupX =
        bxFinalX +
        Math.floor(B_idle.bitmap.width / 2) -
        10
      const popupY = bY - 10

      fIdx = await animateHealRise({
        bg,
        axX: axFinalX,
        aY,
        A_sprite: A_idle,
        bxX: bxFinalX,
        bY,
        B_sprite: B_idle,
        outFramesDir,
        framesSoFar: fIdx,
        fromHp: prev,      // B old HP
        toHp: newHp,       // B new HP
        maxHp: B_MAX,      // ✅ B’s max
        side: 'B',         // ✅ animate B’s bar
        otherHp: A_HP,     // A stays fixed
        otherMaxHp: A_MAX,
        barW: HEALTH_BAR_W,
        barH: HEALTH_BAR_H,
        frames: 20,
        popupText: `+${newHp - prev}`,
        popupStartX: popupX,
        popupStartY: popupY,
        popupRisePx: 36,
        effectIcons,
        effectTotalsFont,
        A_effectTotals,
        B_effectTotals,
        cdA,
        totalCdA,
        cdB,
        totalCdB,
      })

      B_HP = newHp

      const effEv = applyEffectStacksForMove(meta, moveKind, false)
      if (effEv && effEv.amount > 0) {
        fIdx = await animateEffectPopup({
          targetSide: effEv.targetSide,
          effectName: effEv.effectName,
          amount: effEv.amount,
          framesSoFar: fIdx,
          cdA,
          cdB,
          A_HP,
          A_MAX,
          B_HP,
          B_MAX,
        })
      }
    }

               } else if (category === 'melee') {
      // ===== MELEE ATTACK (movement + short projectile) =====

      // Small horizontal gap between attacker and defender
      const gap = Math.round(
        Math.min(A_idle.bitmap.width, B_idle.bitmap.width) * 0.08
      )

      // Where the attacker ends up when they are "in melee range"
      const attackX_A =
        bxFinalX - gap - spritePose.bitmap.width      // A attacks from the left
      const attackX_B =
        axFinalX + A_idle.bitmap.width + gap         // B attacks from the right

      // Unified "melee position" for this actor
      const attackX = isA ? attackX_A : attackX_B

      // --- 1) Approach to melee range ---
      for (let i = 0; i < PHYS_APPROACH_FRAMES; i++) {
        const t = easeOutCubic(i / (PHYS_APPROACH_FRAMES - 1))

        // Actor slides from idleX → attackX
        const actorPosX = Math.round(actorX + (attackX - actorX) * t)

        const frame = bg.clone()
        if (isA) {
          frame.composite(spritePose, actorPosX, actorY)
          frame.composite(defIdle, defX, defY)
        } else {
          frame.composite(A_idle, axFinalX, aY)
          frame.composite(spritePose, actorPosX, actorY)
        }

        await drawBarsAndEffects(
          frame,
          cdA,
          cdB,
          A_HP,
          A_MAX,
          B_HP,
          B_MAX
        )

        await saveFrame(outFramesDir, fIdx++, frame)
      }

      // --- 2) Short melee "projectile"/impact close to defender ---
      // Melee VFX travels a short distance near the defender
      const projY =
        actorY +
        Math.floor(spritePose.bitmap.height * 0.5) -
        Math.floor(visualImg.bitmap.height / 2)

      // Start slightly offset from the attacker’s melee position
      const startX = isA
        ? attackX + Math.round(spritePose.bitmap.width * 0.2)
        : attackX - Math.round(spritePose.bitmap.width * 0.2)

      // Travel toward the defender.
      // Previously this was 0.5 × character width.
      // Now extend the path by an extra 0.5 ×, for a total of 1.0 × width.
      const meleeTravel = Math.round(spritePose.bitmap.width * 1.0)

      const endX = isA
        ? startX + meleeTravel
        : startX - meleeTravel

      const projStart = fIdx
      for (let i = 0; i < PHYS_PROJECTILE_FRAMES; i++) {
        const t = easeOutCubic(i / Math.max(1, PHYS_PROJECTILE_FRAMES - 1))
        const x = Math.round(startX + (endX - startX) * t)
        const y = projY

        const frame = bg.clone()

        if (isA) {
          // A is left, in melee position
          frame.composite(spritePose, attackX, actorY)
          frame.composite(B_idle, bxFinalX, bY)
        } else {
          // A idle on left, B is right attacker
          frame.composite(A_idle, axFinalX, aY)
          frame.composite(spritePose, attackX, actorY)
        }

        // Melee move visual (the move image) – always drawn
        frame.composite(visualImg, x, y)

        // Bars + ALWAYS-ON applied effects
        await drawBarsAndEffects(
          frame,
          cdA,
          cdB,
          A_HP,
          A_MAX,
          B_HP,
          B_MAX
        )

        await saveFrame(outFramesDir, fIdx++, frame)
      }

      impactTimeSec =
        (projStart + PHYS_PROJECTILE_FRAMES - 1) / FIGHT_FPS

      // --- 3) Retreat back to idle position ---
      for (let i = 0; i < PHYS_RETREAT_FRAMES; i++) {
        const t = easeInOut(i / (PHYS_RETREAT_FRAMES - 1))

        // Actor slides from attackX → actorX
        const actorPosX = Math.round(attackX + (actorX - attackX) * t)

        const frame = bg.clone()
        if (isA) {
          frame.composite(spritePose, actorPosX, actorY)
          frame.composite(defIdle, defX, defY)
        } else {
          frame.composite(A_idle, axFinalX, aY)
          frame.composite(spritePose, actorPosX, actorY)
        }

        await drawBarsAndEffects(
          frame,
          cdA,
          cdB,
          A_HP,
          A_MAX,
          B_HP,
          B_MAX
        )

        await saveFrame(outFramesDir, fIdx++, frame)
      }


             } else {
      // ===== RANGED / MAGIC ATTACK (projectile / curse) =====
      // Symmetric logic for both sides:
      // - Projectiles start one character-width in front of the caster
      //   toward the defender.
      // - They end one character-width before the defender.
            const actorCenterX =
        actorX + Math.floor(spritePose.bitmap.width / 2)
      const defCenterX =
        defX + Math.floor(defIdle.bitmap.width / 2)

      const dir = defCenterX >= actorCenterX ? 1 : -1

      const offsetActor = spritePose.bitmap.width      // "a character's width"
      const offsetDef   = defIdle.bitmap.width

      // Baseline start / end positions
      let startX = actorCenterX + dir * offsetActor
      let endX   = defCenterX - dir * offsetDef

      // 👉 When character B (right side) casts a ranged/magic/curse move,
      // make the projectile travel an EXTRA character-width further
      // toward the defender (i.e., further toward A).
      if (!isA) {
        const extra = spritePose.bitmap.width
        endX += dir * extra  // dir is -1 for B, so this pushes endX further left
      }

      // Safety fallback if offsets would cross or invert direction
      if (
        (dir === 1 && endX <= startX) ||
        (dir === -1 && endX >= startX)
      ) {
        const softActor = Math.round(spritePose.bitmap.width * 0.3)
        const softDef   = Math.round(defIdle.bitmap.width * 0.3)
        startX = actorCenterX + dir * softActor
        endX   = defCenterX - dir * softDef
      }

      // Extend projectile path by an extra half character width for all moves
      const extraHalf = Math.round(spritePose.bitmap.width * 0.5)
      endX += dir * extraHalf


      const projY =
        actorY +
        Math.floor(spritePose.bitmap.height * 0.5) -
        Math.floor(visualImg.bitmap.height / 2)

      const projStart = fIdx
      fIdx = await drawProjectileSequence({
        bg,
        outFramesDir,
        startX,
        startY: projY,
        endX,
        endY: projY,
        framesSoFar: fIdx,
        projectileImg: visualImg,
        layerLeft: async (frame) => {
          // Left side is always A’s side visually
          frame.composite(
            isA ? spritePose : A_idle,
            axFinalX,
            aY
          )
        },
        layerRight: async (frame) => {
          // Right side is always B’s side visually
          frame.composite(
            isA ? B_idle : spritePose,
            bxFinalX,
            bY
          )
        },
        bars: {
          axX: axFinalX,
          aY,
          A_sprite: A_idle,
          bxX: bxFinalX,
          bY,
          B_sprite: B_idle,
          A_HP,
          A_MAX,
          B_HP,
          B_MAX,
          barW: HEALTH_BAR_W,
          barH: HEALTH_BAR_H,
          cdA,
          cdB,
          totalCdA,
          totalCdB,
        },
        effectIcons,
        effectTotalsFont,
        A_effectTotals,
        B_effectTotals,
      })

      impactTimeSec =
        (projStart + PROJECTILE_FRAMES - 1) / FIGHT_FPS
    }



        // ===== AUDIO + DAMAGE/EFFECTS (non-buff only) =====
    if (!buff) {
      const hitRoll = Math.random() * 100

      // Accuracy adjusted by attacker effects (paralyze, drown, focus, etc.)
      const attackerEffs = isA ? A_effectTotals : B_effectTotals
      const atkAdj = computeAttackerStatAdjustments(attackerEffs)
      const baseAcc = Number(meta.accuracy) || 100
      const effAcc = clamp(
        baseAcc + (atkAdj.accuracyAdj || 0),
        5,
        100
      )

      const hits = hitRoll <= effAcc
      audioTimeline.push(hits ? 'hit' : 'miss', impactTimeSec)

      if (hits) {
        const movePower = clamp(Number(meta.power) || 40, 1, 250)
        const attackerEffects = attackerEffs
        const defenderEffects = isA ? B_effectTotals : A_effectTotals

        const { dmg } = calcDamageRPG({
          movePower,
          category,
          attackerStats: isA ? aStats : bStats,
          defenderStats: isA ? bStats : aStats,
          attackerEffects,
          defenderEffects,
        })


        // Hit flash (bars + effects are handled inside)
        fIdx = await blinkTargetFrames({
          frames: 18,
          bg,
          axX: axFinalX,
          aY,
          A_sprite: A_idle,
          bxX: bxFinalX,
          bY,
          B_sprite: B_idle,
          targetSide: isA ? 'B' : 'A',
          outFramesDir,
          framesSoFar: fIdx,
          hpA: A_HP,
          maxHpA: A_MAX,
          hpB: B_HP,
          maxHpB: B_MAX,
          barW: HEALTH_BAR_W,
          barH: HEALTH_BAR_H,
          effectIcons,
          effectTotalsFont,
          A_effectTotals,
          B_effectTotals,
          cdA,
          totalCdA,
          cdB,
          totalCdB,
        })

        if (isA) {
          // ✅ A is attacker, B is defender → animate B’s bar
          const prev = B_HP
          const newHp = Math.max(0, prev - dmg)
          const popupX =
            bxFinalX +
            Math.floor(B_idle.bitmap.width / 2) -
            10
          const popupY = bY - 10

          fIdx = await animateHealthDrop({
            bg,
            axX: axFinalX,
            aY,
            A_sprite: A_idle,
            bxX: bxFinalX,
            bY,
            B_sprite: B_idle,
            outFramesDir,
            framesSoFar: fIdx,
            fromHp: prev,       // B’s old HP
            toHp: newHp,        // B’s new HP
            maxHp: B_MAX,       // B’s max
            side: 'B',          // ✅ animate B’s bar
            otherHp: A_HP,      // A stays fixed
            otherMaxHp: A_MAX,
            barW: HEALTH_BAR_W,
            barH: HEALTH_BAR_H,
            frames: 20,
            popupText: `-${dmg}`,
            popupStartX: popupX,
            popupStartY: popupY,
            popupRisePx: 36,
            effectIcons,
            effectTotalsFont,
            A_effectTotals,
            B_effectTotals,
            cdA,
            totalCdA,
            cdB,
            totalCdB,
          })

          B_HP = newHp
        } else {
          // ✅ B is attacker, A is defender → animate A’s bar
          const prev = A_HP
          const newHp = Math.max(0, prev - dmg)
          const popupX =
            axFinalX +
            Math.floor(A_idle.bitmap.width / 2) -
            10
          const popupY = aY - 10

          fIdx = await animateHealthDrop({
            bg,
            axX: axFinalX,
            aY,
            A_sprite: A_idle,
            bxX: bxFinalX,
            bY,
            B_sprite: B_idle,
            outFramesDir,
            framesSoFar: fIdx,
            fromHp: prev,       // A’s old HP
            toHp: newHp,        // A’s new HP
            maxHp: A_MAX,       // A’s max
            side: 'A',          // ✅ animate A’s bar
            otherHp: B_HP,      // B stays fixed
            otherMaxHp: B_MAX,
            barW: HEALTH_BAR_W,
            barH: HEALTH_BAR_H,
            frames: 20,
            popupText: `-${dmg}`,
            popupStartX: popupX,
            popupStartY: popupY,
            popupRisePx: 36,
            effectIcons,
            effectTotalsFont,
            A_effectTotals,
            B_effectTotals,
            cdA,
            totalCdA,
            cdB,
            totalCdB,
          })

          A_HP = newHp
        }

        // Apply effect stacks *after* HP change
        const effEv = applyEffectStacksForMove(meta, moveKind, isA)
        if (effEv && effEv.amount > 0) {
          fIdx = await animateEffectPopup({
            targetSide: effEv.targetSide,
            effectName: effEv.effectName,
            amount: effEv.amount,
            framesSoFar: fIdx,
            cdA,
            cdB,
            A_HP,
            A_MAX,
            B_HP,
            B_MAX,
          })
        }
      }
      else {
        // Simple MISS popup over the defender
        fIdx = await animateMissPopup({
          targetSide: isA ? 'B' : 'A',
          framesSoFar: fIdx,
          cdA,
          cdB,
          A_HP,
          A_MAX,
          B_HP,
          B_MAX,
        })
      }
    }


    if (A_HP <= 0 || B_HP <= 0) break duel_loop

    // Cooldowns
    if (isA) {
      cdA =
        Number(meta.cooldown_seconds) ||
        powerToCooldownSeconds(meta.power)
      totalCdA = Math.max(0.8, cdA)
    } else {
      cdB =
        Number(meta.cooldown_seconds) ||
        powerToCooldownSeconds(meta.power)
      totalCdB = Math.max(0.8, cdB)
    }

    for (let i = 0; i < 6; i++) await drawIdleFrameAndTick()
  }

   const loser = A_HP <= 0 ? 'A' : 'B'
  let fIdx2 = await fadeOutDefeated({
    bg,
    axFinalX,
    aY,
    A_sprite: A_idle,
    bxFinalX,
    bY,
    B_sprite: B_idle,
    outFramesDir,
    framesSoFar: fIdx,
    loser,
    A_HP,
    B_HP,
    A_MAX,
    B_MAX,
    cdA,
    cdB,
    totalCdA,
    totalCdB,
    A_effectTotals,
    B_effectTotals,
    effectIcons,
  })


  const winner = loser === 'A' ? 'B' : 'A'
  const winnerName = winner === 'A' ? aName : bName
  fIdx2 = await victorySequence({
    bg,
    bgW,
    bgH,
    winner,
    axFinalX,
    aY,
    A_idle,
    A_emote,
    bxFinalX,
    bY,
    B_idle,
    B_emote,
    outFramesDir,
    framesSoFar: fIdx2,
    audioTimeline,
    winnerName,
  })

  return { frames: fIdx2 }
}

/* ===================== VIDEO STITCH ===================== */
async function stitchFramesToVideo(
  framesDir,
  outVideoPath,
  fps = FIGHT_FPS
) {
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
// (unchanged from your advanced script; using hash32 etc above)

function floatTo16LE(f32) {
  const out = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i++) {
    const x = Math.max(-1, Math.min(1, f32[i]))
    out[i] = x < 0 ? x * 0x8000 : x * 0x7fff
  }
  return out
}


/* ===================== ALGOD ARENA + FIREBASE CHARACTERS ===================== */

const APP_ID = 3339943603
const algodIndexer = new algosdk.Indexer(
  '',
  'https://mainnet-idx.algonode.cloud',
  443
)

/** Base64 key → big-endian uint (ASA ID) */
function decodeKeyToUint(b64Key) {
  const buf = Buffer.from(b64Key, 'base64')
  let value = 0n
  for (const byte of buf) {
    value = (value << 8n) + BigInt(byte)
  }
  return Number(value)
}

async function fetchGlobalState(appId) {
  const appInfo = await algodIndexer
    .lookupApplications(appId)
    .do()
  return appInfo.application.params['global-state']
}

/**
 * For each app global state entry:
 *   key (base64) => character assetId
 *   Firestore doc: chars/{assetId}object
 */
async function fetchArenaCharacters() {
  const globalState = await fetchGlobalState(APP_ID)
  const results = []

  for (const entry of globalState) {
    const assetId = decodeKeyToUint(entry.key)
    const docId = `${assetId}object`
    const charRef = doc(db, 'chars', docId)
    const charSnap = await getDoc(charRef)

    results.push({
      assetId,
      exists: charSnap.exists(),
      char: charSnap.exists() ? charSnap.data() : null,
      rawState: entry,
    })
  }

  return results
}

/** Types from Firebase charObj (move.type + move.effect, used only for UI) */
function extractTypesFromCharObj(charObj) {
  const out = new Set()
  if (Array.isArray(charObj?.moves)) {
    for (const mv of charObj.moves) {
      if (mv?.type) out.add(String(mv.type))
      if (mv?.effect) out.add(String(mv.effect))
    }
  }
  return [...out]
}

/** Simple category inference from move.type string */
function determineCategoryFromMoveType(typeStr = '') {
  const s = String(typeStr || '').toLowerCase()
  if (s.includes('melee')) return 'melee'
  if (s.includes('ranged')) return 'ranged'
  if (s.includes('magic') || s.includes('spell') || s.includes('curse'))
    return 'magic'
  return 'melee'
}

/** Map Firebase move into internal meta shape (no effect potency here). */
function arenaMoveToPipelineMove(
  arenaMove = {},
  fallbackCategory = 'melee'
) {
  const typeStr = String(arenaMove.type || 'skill')
  const category =
    determineCategoryFromMoveType(typeStr) || fallbackCategory
  const power = Number(arenaMove.power) || 40
  const accuracy = Number(arenaMove.accuracy) || 90
  const cdNum = Number(arenaMove.cooldown)

  const cooldown_seconds =
    Number.isFinite(cdNum) && cdNum > 0
      ? cdNum
      : powerToCooldownSeconds(power)

  const effectName = arenaMove.effect || ''

  return {
    name: arenaMove.name || 'Unnamed Move',
    type: typeStr,
    category,
    power,
    accuracy,
    cooldown_seconds,
    effect: effectName,
    trait: arenaMove.trait || '',
    description: arenaMove.description || '',
  }
}


/**
 * Turn a Firebase arena record into a runtime character object.
 * - Downloads standing / emote / move sprites from charObj URLs.
 * - Uses stats straight from charObj.
 * - Derives move meta from charObj.moves[0,1,2].
 */
async function prepareArenaCharacter(arenaRecord, indexLabel) {
  if (!arenaRecord?.char?.charObj) {
    throw new Error('Arena record missing charObj')
  }

  const charObj = arenaRecord.char.charObj

  const name = charObj.name || `Arena ${arenaRecord.assetId}`
  const slug = slugify(name)
  const baseDir = path.join(
    OUT_DIR,
    `${indexLabel}__arena_${slug}`
  )
  await emptyDir(baseDir)

  const spritesDir = path.join(baseDir, 'sprites')
  const moveVisualsDir = path.join(baseDir, 'move_visuals')
  ensureDir(spritesDir)
  ensureDir(moveVisualsDir)

  const idlePath = path.join(spritesDir, 'idle.png')
  const emotePath = path.join(spritesDir, 'emote.png')
  const moveASpritePath = path.join(
    spritesDir,
    'moveA_character.png'
  )
  const moveBSpritePath = path.join(
    spritesDir,
    'moveB_character.png'
  )
  const moveCSpritePath = path.join(
    spritesDir,
    'moveC_character.png'
  )

  const movesArr = Array.isArray(charObj.moves)
    ? charObj.moves
    : []
  const move0 = movesArr[0] || {}
  const move1 = movesArr[1] || movesArr[0] || {}
  const move2 = movesArr[2] || movesArr[1] || movesArr[0] || {}

  if (!charObj.standingUrl) {
    throw new Error(
      `charObj for ${name} has no standingUrl`
    )
  }

  // Standing / idle
  const idleImg = await Jimp.read(charObj.standingUrl)
  await idleImg.writeAsync(idlePath)

  // Emote + move sprites: use characterUrl if present, otherwise standingUrl
  const emoteUrl = move0.characterUrl || charObj.standingUrl
  const moveACharU = move0.characterUrl || charObj.standingUrl
  const moveBCharU =
    move1.characterUrl || move0.characterUrl || charObj.standingUrl
  const moveCCharU =
    move2.characterUrl ||
    move1.characterUrl ||
    move0.characterUrl ||
    charObj.standingUrl

  const emoteImg = await Jimp.read(emoteUrl)
  await emoteImg.writeAsync(emotePath)

  const moveACharImg = await Jimp.read(moveACharU)
  await moveACharImg.writeAsync(moveASpritePath)

  const moveBCharImg = await Jimp.read(moveBCharU)
  await moveBCharImg.writeAsync(moveBSpritePath)

  const moveCCharImg = await Jimp.read(moveCCharU)
  await moveCCharImg.writeAsync(moveCSpritePath)

  // Move effect images (projectiles / fx)
  const moveAEffectPath = path.join(
    moveVisualsDir,
    'moveA_effect.png'
  )
  const moveBEffectPath = path.join(
    moveVisualsDir,
    'moveB_effect.png'
  )
  const moveCEffectPath = path.join(
    moveVisualsDir,
    'moveC_effect.png'
  )

  const moveAEffectUrl = move0.moveUrl || charObj.standingUrl
  const moveBEffectUrl =
    move1.moveUrl || move0.moveUrl || charObj.standingUrl
  const moveCEffectUrl =
    move2.moveUrl ||
    move1.moveUrl ||
    move0.moveUrl ||
    charObj.standingUrl

  const moveAEffectImg = await Jimp.read(moveAEffectUrl)
  await moveAEffectImg.writeAsync(moveAEffectPath)

  const moveBEffectImg = await Jimp.read(moveBEffectUrl)
  await moveBEffectImg.writeAsync(moveBEffectPath)

  const moveCEffectImg = await Jimp.read(moveCEffectUrl)
  await moveCEffectImg.writeAsync(moveCEffectPath)

  const effectPotencies = {}
  if (Array.isArray(movesArr)) {
    for (const mv of movesArr) {
      if (!mv?.effect) continue
      const name = String(mv.effect).trim()
      if (!name) continue
      const lower = name.toLowerCase()
      let raw = charObj[name]
      if (raw === undefined) raw = charObj[lower]
      const val = Number(raw)
      effectPotencies[lower] = Number.isFinite(val) ? val : 0
    }
  }

  // Stats pulled from charObj (no randomization)
  const stats = {
    strength: Number(charObj.strength) || 50,
    dexterity: Number(charObj.dexterity) || 50,
    intelligence: Number(charObj.intelligence) || 50,
    speed: Number(charObj.speed) || 50,
    resist: Number(charObj.resist) || 50,
    health:
      Number(
        charObj.health ??
        charObj.currentHealth ??
        200
      ),
  }
  stats.total =
    stats.strength +
    stats.dexterity +
    stats.intelligence +
    stats.speed +
    stats.resist +
    stats.health

  // Move meta – power from Firebase, effect potency from charObj, accuracy/CD balanced
  const mapMove = (src) => {
    const m0 = arenaMoveToPipelineMove(src, 'melee')
    const effectName = String(src.effect || '').trim()
    const key = effectName.toLowerCase()
    const potencyBase = key
      ? Number(effectPotencies[key] || 0)
      : 0

    const withEffect = {
      ...m0,
      effect_name: effectName,
      effect_potency_base: potencyBase,
    }

    const m1 = balanceMoveAccuracy(withEffect)
    return normalizeMoveCooldown(m1)
  }

  const moveA = mapMove(move0)
  const moveB = mapMove(move1)
  const moveC = mapMove(move2)


  // Types are just flavors from Firebase
  const types = extractTypesFromCharObj(charObj)
  const identity = {
    race: charObj.race || 'unknown',
    class: charObj.class || 'unknown',
  }

  return {
    creature_name: name,
    identity,
    types,
    stats,
    moveA,
    moveB,
    moveC,
    baseDir,
    spritesDir,
    moveVisualsDir,
    sheet: idlePath,
    arena: {
      assetId: arenaRecord.assetId,
      charObj,
    },
    spriteIdlePath: idlePath,
    spriteEmotePath: emotePath,
    spriteMoveAPath: moveASpritePath,
    spriteMoveBPath: moveBSpritePath,
    spriteMoveCPath: moveCSpritePath,
    moveAEffectPath,
    moveBEffectPath,
    moveCEffectPath,
    effectPotencies,
  }
}

// Generate a vertical fight background using OpenAI images,
// then resize it to FIGHT_BG_SIZE (1024x1536).
async function generateFightBackground(aName, bName, outDir) {
  const openai = getOpenAI()
  const { W, H } = parseSize(FIGHT_BG_SIZE)
  const tmpPath = path.join(outDir, 'fight_bg_raw.png')
  const finalPath = path.join(outDir, 'fight_bg.png')

  const prompt = `
Old-school pixel-art style medieval castle arena, vertical scene.
Stone walls, banners, torches, and a dramatic dueling platform.
Cinematic lighting, room for two characters to face off.
No UI, no text, just the environment.
Mood: dark fantasy, Dark Coin arena, ${aName} vs ${bName}.
`

  try {
    // Use a model-supported size (e.g. 1024x1792) then downscale
    const resp = await openai.images.generate({
      model: 'gpt-image-1',
      prompt,
      n: 1,
      size: '1536x1024',
    })

    const b64 = resp.data[0].b64_json
    const raw = Buffer.from(b64, 'base64')
    await fsp.writeFile(tmpPath, raw)

    const img = await Jimp.read(tmpPath)
    img.resize(W, H, Jimp.RESIZE_BICUBIC)
    await img.writeAsync(finalPath)

    return finalPath
  } catch (err) {
    console.warn(
      '⚠️ generateFightBackground failed, using fallback gradient:',
      err?.message || err
    )

    // Fallback: simple dark castle-esque gradient background
    const bg = new Jimp(W, H, Jimp.cssColorToHex('#050309'))
    const topColor = Jimp.cssColorToHex('#1b1022')
    const bottomColor = Jimp.cssColorToHex('#050309')

    for (let y = 0; y < H; y++) {
      const t = y / (H - 1)
      const rTop = (topColor >> 24) & 0xff
      const gTop = (topColor >> 16) & 0xff
      const bTop = (topColor >> 8) & 0xff

      const rBot = (bottomColor >> 24) & 0xff
      const gBot = (bottomColor >> 16) & 0xff
      const bBot = (bottomColor >> 8) & 0xff

      const r = Math.round(rTop + (rBot - rTop) * t)
      const g = Math.round(gTop + (gBot - gTop) * t)
      const b = Math.round(bTop + (bBot - bTop) * t)

      const rowColor = Jimp.rgbaToInt(r, g, b, 255)
      for (let x = 0; x < W; x++) {
        bg.setPixelColor(rowColor, x, y)
      }
    }

    await bg.writeAsync(finalPath)
    return finalPath
  }
}


/* ===================== MAIN (single run) ===================== */
async function mainOnce() {
  ensureDir(OUT_DIR)

  // 1) Load arena characters from Algorand app + Firestore
  const arenaChars = await fetchArenaCharacters()
  const validArena = arenaChars.filter(
    (c) => c.exists && c.char && c.char.charObj
  )

  if (validArena.length < 2) {
    throw new Error(
      `Need at least 2 valid arena characters in Firebase; found ${validArena.length}`
    )
  }

  // 2) Pick two characters at random
  const shuffled = [...validArena].sort(
    () => Math.random() - 0.5
  )
  const arenaA = shuffled[0]
  const arenaB = shuffled[1]

  // 3) Build runtime characters from Firebase charObj
  const A = await prepareArenaCharacter(
    arenaA,
    'characterA'
  )
  const B = await prepareArenaCharacter(
    arenaB,
    'characterB'
  )

  console.log('Using arena characters:')
  console.log(
    `  A = ${A.creature_name} (assetId ${arenaA.assetId})`
  )
  console.log(
    `  B = ${B.creature_name} (assetId ${arenaB.assetId})`
  )

  // B faces left – flip character AND its move VFX
  await flipAllPngsHorizontally(B.spritesDir)
  await flipAllPngsHorizontally(B.moveVisualsDir)

  const fightDir = path.join(OUT_DIR, 'fight_scene')
  ensureDir(fightDir)
  await emptyDir(fightDir)

  const bgPath = await generateFightBackground(
    A.creature_name,
    B.creature_name,
    fightDir
  )
  const { W: bgW, H: bgH } = parseSize(FIGHT_BG_SIZE)

  const statIcons = await loadStatIcons()
  const typeIcons = await loadTypeIcons()
  const effectIcons = await loadEffectIcons()

  // Collect all effect names from both characters' moves
  const effectNameSet = new Set()
  for (const ch of [A, B]) {
    for (const mv of [ch.moveA, ch.moveB, ch.moveC]) {
      if (mv?.effect) effectNameSet.add(String(mv.effect))
    }
  }

  const statsPanelAPath = path.join(
    fightDir,
    'stats_A.png'
  )
  const statsPanelBPath = path.join(
    fightDir,
    'stats_B.png'
  )
  await renderStatsPanel({
    outPath: statsPanelAPath,
    creatureName: `${A.creature_name}`,
    identity: A.identity,
    types: A.types,
    stats: A.stats,
    bgW,
    bgH,
    statIcons,
    typeIcons,
  })
  await renderStatsPanel({
    outPath: statsPanelBPath,
    creatureName: `${B.creature_name}`,
    identity: B.identity,
    types: B.types,
    stats: B.stats,
    bgW,
    bgH,
    statIcons,
    typeIcons,
  })

  const movePanelAPath = path.join(
    fightDir,
    'moves_A.png'
  )
  const movePanelBPath = path.join(
    fightDir,
    'moves_B.png'
  )

  const moveAVisualA = A.moveAEffectPath
  const moveAVisualB = B.moveAEffectPath
  const moveBVisualA = A.moveBEffectPath
  const moveBVisualB = B.moveBEffectPath
  const moveCVisualA = A.moveCEffectPath
  const moveCVisualB = B.moveCEffectPath

  await renderMoveBoardPanel({
    outPath: movePanelAPath,
    moves: [A.moveA, A.moveB, A.moveC],
    moveImgPaths: [moveAVisualA, moveBVisualA, moveCVisualA],
    bgW,
    bgH,
    statIcons,
    typeIcons,
    effectIcons,
  })
  await renderMoveBoardPanel({
    outPath: movePanelBPath,
    moves: [B.moveA, B.moveB, B.moveC],
    moveImgPaths: [moveAVisualB, moveBVisualB, moveCVisualB],
    bgW,
    bgH,
    statIcons,
    typeIcons,
    effectIcons,
  })

  const spriteAIdle = A.spriteIdlePath
  const spriteAEmote = A.spriteEmotePath
  const spriteAMoveA = A.spriteMoveAPath
  const spriteAMoveB = A.spriteMoveBPath
  const spriteAMoveC = A.spriteMoveCPath

  const spriteBIdle = B.spriteIdlePath
  const spriteBEmote = B.spriteEmotePath
  const spriteBMoveA = B.spriteMoveAPath
  const spriteBMoveB = B.spriteMoveBPath
  const spriteBMoveC = B.spriteMoveCPath

  const framesDir = path.join(fightDir, 'frames')
  const audioTimeline = makeAudioTimeline()
  const { frames } = await createFightFrames({
    aName: A.creature_name,
    bName: B.creature_name,
    backgroundPath: bgPath,
    spriteAPath: spriteAIdle,
    spriteBPath: spriteBIdle,
    spriteAEmotePath: spriteAEmote,
    spriteBEmotePath: spriteBEmote,
    spriteAMoveAPath: spriteAMoveA,
    spriteBMoveAPath: spriteBMoveA,
    spriteAMoveBPath: spriteAMoveB,
    spriteBMoveBPath: spriteBMoveB,
    spriteAMoveCPath: spriteAMoveC,
    spriteBMoveCPath: spriteBMoveC,
    moveAVisualAPath: moveAVisualA,
    moveAVisualBPath: moveAVisualB,
    moveBVisualAPath: moveBVisualA,
    moveBVisualBPath: moveBVisualB,
    moveCVisualAPath: moveCVisualA,
    moveCVisualBPath: moveCVisualB,
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
    aMoveMetaC: A.moveC,
    bMoveMetaA: B.moveA,
    bMoveMetaB: B.moveB,
    bMoveMetaC: B.moveC,
    audioTimeline,
    effectIcons,
  })

  console.log(
    `Fight frames created: ${frames} frames at ${FIGHT_FPS} fps`
  )

  const silentVideo = path.join(
    fightDir,
    'character_duel.mp4'
  )
  await stitchFramesToVideo(
    framesDir,
    silentVideo,
    FIGHT_FPS
  )

  // If you later call buildAndMuxAudio, set finalVideo accordingly.
  const finalVideo = silentVideo

  console.log('\n=== Summary ===')
  console.log(
    `Character A: ${A.creature_name} (${A.identity.race} ${A.identity.class}) [${A.types.join(
      '/'
    )}]`
  )
  console.log(`  Sprites: ${A.spritesDir}`)
  console.log(
    `Character B: ${B.creature_name} (${B.identity.race} ${B.identity.class}) [${B.types.join(
      '/'
    )}]`
  )
  console.log(
    `  Sprites (flipped): ${B.spritesDir}`
  )
  console.log(
    `Fight BG (old-school castle RPG): ${bgPath}`
  )
  console.log(`Video: ${finalVideo}`)

  // === Optional YouTube upload ===
  // const durationSec = frames / FIGHT_FPS
  // try {
  //   const meta = makeYouTubeMetadataShorts({
  //     aName: A.creature_name,
  //     aTypes: A.types,
  //     aMoves: [A.moveA, A.moveB],
  //     bName: B.creature_name,
  //     bTypes: B.types,
  //     bMoves: [B.moveA, B.moveB],
  //     durationSec,
  //   })
  //   const videoId = await uploadToYouTube({
  //     filePath: finalVideo,
  //     title: meta.title,
  //     description: meta.description,
  //     tags: meta.tags,
  //     categoryId: meta.categoryId,
  //     privacyStatus: 'public',
  //     madeForKids: false,
  //   })
  //   if (videoId) {
  //     const manifest = {
  //       uploaded: true,
  //       videoId,
  //       url: `https://youtu.be/${videoId}`,
  //       title: meta.title,
  //       descriptionPreview:
  //         meta.description.slice(0, 140) +
  //         (meta.description.length > 140 ? '…' : ''),
  //       a: {
  //         name: A.creature_name,
  //         identity: A.identity,
  //         types: A.types,
  //         moves: [A.moveA, A.moveB],
  //       },
  //       b: {
  //         name: B.creature_name,
  //         identity: B.identity,
  //         types: B.types,
  //         moves: [B.moveA, B.moveB],
  //       },
  //       durationSec,
  //     }
  //     await fsp.writeFile(
  //       path.join(fightDir, 'upload_manifest.json'),
  //       JSON.stringify(manifest, null, 2)
  //     )
  //     console.log(
  //       '📝 Upload manifest saved:',
  //       path.join(fightDir, 'upload_manifest.json')
  //     )
  //   }
  // } catch (e) {
  //   console.warn(
  //     '⚠️ YouTube upload step failed:',
  //     e?.message || e
  //   )
  // }
}

/* ===================== SCHEDULER ===================== */
async function runLoop() {
  const THREE_HOURS_MS = 3 * 60 * 60 * 1000

  const runSafely = async () => {
    try {
      await mainOnce()
    } catch (err) {
      console.error(
        '❌ Run failed:',
        err?.stack || err?.message || err
      )
    }
  }

  await runSafely()
  setInterval(runSafely, THREE_HOURS_MS)
}

runLoop().catch((err) => {
  console.error(
    'Scheduler failed to initialize:',
    err?.stack || err?.message || err
  )
})
