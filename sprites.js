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
const WAV = wavPkg?.default ?? wavPkg

ffmpeg.setFfmpegPath(ffmpegInstaller.path)
ffmpeg.setFfprobePath(ffprobeInstaller.path)

/* ===================== CONFIG ===================== */
const THEME = process.env.THEME || 'original, cute elemental creature suitable for a creature-collecting RPG'
const SEED1 = process.env.SEED1 || ''   // leave empty for extra randomness
const SEED2 = process.env.SEED2 || ''

const OUT_DIR          = path.resolve('./out')
const TARGET_SIZE      = '1024x1024'
const OUTER_MARGIN     = 32
const SEPARATOR_GAP    = 32
const BOX_INNER_PAD    = 16
const AUTOCROP_TOL     = 8
const EXTRACT_PADDING  = 8

// Move visuals (wide)
const MOVE_VISUAL_SIZE = '1536x1024'

// Fight scene setup
const FIGHT_BG_SIZE    = '1536x1024'
const FIGHT_FPS        = 30
const FIGHT_FRAMES_A   = 45
const FIGHT_FRAMES_B   = 45
const EMOTE_DURATION_SEC = 1.0
const EMOTE_FRAMES       = Math.max(1, Math.round(EMOTE_DURATION_SEC * FIGHT_FPS))
const ZOOM_IN_FRAMES     = 20
const STATS_HOLD_FRAMES  = 90
const ZOOM_OUT_FRAMES    = 20
const ZOOM_MAX           = 1.8
const PANEL_WIDTH_PCT    = 0.36
const PANEL_MARGIN_PX    = 28
const PROJECTILE_DURATION_SEC = 1.6
const PROJECTILE_FRAMES       = Math.max(1, Math.round(PROJECTILE_DURATION_SEC * FIGHT_FPS))
const PROJECTILE_HEIGHT_FRACTION = 0.18
const FIGHT_SCALE_FRACTION = 0.24

// Victory scene
const VICTORY_ZOOM_MAX      = 2.0
const VICTORY_ZOOM_IN_FR    = 24
const VICTORY_HOLD_FRAMES   = 60
const VICTORY_BANNER_FRAMES = 90

// Audio
const MASTER_GAIN = 0.5                // Background music
const EFFECT_ATTEN = 0.5               // 50% of previous SFX loudness (emotes, hit, miss)

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

/* ===================== TYPES / STATS ===================== */
const POKEMON_TYPES = [
  'Normal','Fire','Water','Grass','Electric','Ice','Fighting','Poison','Ground','Flying',
  'Psychic','Bug','Rock','Ghost','Dragon','Dark','Steel','Fairy'
]
const TYPE_COLORS = {
  Normal:'#A8A77A', Fire:'#EE8130', Water:'#6390F0', Grass:'#7AC74C',
  Electric:'#F7D02C', Ice:'#96D9D6', Fighting:'#C22E28', Poison:'#A33EA1',
  Ground:'#E2BF65', Flying:'#A98FF3', Psychic:'#F95587', Bug:'#A6B91A',
  Rock:'#B6A136', Ghost:'#735797', Dragon:'#6F35FC', Dark:'#705746',
  Steel:'#B7B7CE', Fairy:'#D685AD'
}
const STAT_BOUNDS = {
  hp:   { min: 35, max: 130, label: 'HP'   },
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

/* Randomly choose one or two distinct types (not from a preset creature pool) */
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
  const val = Math.round(min + r*(max - min))
  return clamp(val, min, max)
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

Constraints:
- Never reference existing franchises or trademarks.
- NON-HUMAN creature. All sprites face RIGHT with transparent backgrounds.
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
- The visual must depict only the move's energy/effect (projectile, aura, burst, trail, etc.).
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
  const colW = Math.floor((W - 2 * OUTER_MARGIN - SEPARATOR_GAP) / 2)
  const rowH = Math.floor((H - 2 * OUTER_MARGIN - SEPARATOR_GAP) / 2)
  const typesArr = Array.isArray(creatureTypes) ? creatureTypes : [creatureTypes]
  const typeColor = TYPE_COLORS[typesArr[0]] || '#cccccc'
  const extraColor = typesArr[1] ? TYPE_COLORS[typesArr[1]] || '#bbbbbb' : null

  return `
Create ONE transparent PNG of size ${TARGET_SIZE} that is a 2×2 sprite sheet for a SINGLE, ORIGINAL creature.

Global rules:
- Transparent background ONLY. No floor, props, text, UI, or separate FX layers.
- The creature’s design must be EXACTLY consistent across all four sprites (colors, markings, silhouette, proportions).
- **Orientation**: ALL four sprites face RIGHT.
- Neutral, even lighting.
- Full body fully in frame with breathing room; DO NOT touch the image edges.
- Each sprite centered inside its cell with ~${BOX_INNER_PAD}px inner padding; do not cross separators.

Type visual linkage (IMPORTANT):
- The creature has type(s): "${typeListString(typesArr)}".
- Its design should clearly communicate these type(s) via shapes/motifs/materials.
- Harmonize accents with ${typeColor}${extraColor ? ` and ${extraColor}` : ''}.

Layout rules (follow pixel layout so we can cut by quadrants):
- Overall canvas: ${W}×${H}px.
- OUTER MARGIN: exactly ${OUTER_MARGIN}px on all sides.
- SEPARATOR (vertical + horizontal between cells): exactly ${SEPARATOR_GAP}px.
- Each cell (sprite box) about ${colW}×${rowH}px.
- Place sprites:
  TL: IDLE stance.
  TR: EMOTE — ${emoteBrief}.
  BL: MOVE A (“${moveA.name}”) — ${moveA.pose_brief}.
  BR: MOVE B (“${moveB.name}”) — ${moveB.pose_brief}.

Creature identity (keep identical across all four):
- Species: ${identity.species}
- Colors: ${identity.palette.primary} (primary), ${identity.palette.secondary} (secondary); eyes ${identity.palette.eyes}
- Silhouette: ${identity.silhouette}
- Ears: ${identity.ears}
- Tail: ${identity.tail}
- Markings: ${identity.markings}
- Element vibe: ${identity.vibe}
- Notes: ${identity.notes}

Return ONE image: the 2×2 sheet. No borders or guides; we will cut by the known grid.
`.trim()
}

function makeMoveVisualPrompt(creatureName, move, identity) {
  return `
Effect-only render for the move "${move.name}" from creature "${creatureName}".
Render ONLY the move's energy/effect (projectile, aura, burst, beam, wave, particles, trails).
Do NOT render the creature, characters, scenery, sky, floor, UI, borders, or text.
Canvas background MUST be fully transparent (alpha=0). No gradients or shapes behind the effect.
Center the effect nicely with clean silhouette and leave modest transparent margins.

Match palette accents:
- Primary: ${identity.palette.primary}
- Secondary: ${identity.palette.secondary}
- Eyes/accent: ${identity.palette.eyes}

Resolution: ${MOVE_VISUAL_SIZE}
Move Type: ${move.type || 'Unknown'} | Category: ${move.category || 'Unknown'}
Brief: ${move.visual}
Theme: ${THEME}
`.trim()
}
function makeFightBackgroundPrompt(creatureAName, creatureBName) {
  return `
Create a cinematic battle arena background for a 2D creature duel between "${creatureAName}" and "${creatureBName}".
- Style: polished game arena, mild parallax hints, no text or UI, no logos.
- Middle ground should have a neutral, unobtrusive area where two sprites can stand.
- Colors should not clash with the sprites (favor medium contrast, soft vignette).
- No characters present, background only.
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
    n: 1
  })
  const b64 = res.data?.[0]?.b64_json
  if (!b64) throw new Error('Image generation failed')
  return Buffer.from(b64, 'base64')
}

/* ===================== SHEET (SINGLE IMAGE WITH 4 SPRITES) ===================== */
async function generateFourSpriteSheetImage(baseDir, identityPack, creatureTypes) {
  const { identity, emote_brief, moveA, moveB } = identityPack
  const SOURCES_DIR = path.join(baseDir, 'sources')
  ensureDir(SOURCES_DIR)
  await emptyDir(SOURCES_DIR)

  const prompt = makeFourSpriteSheetPrompt(identity, emote_brief, moveA, moveB, creatureTypes)
  const buf = await genImage(prompt, TARGET_SIZE, true)
  const SHEET_PATH = path.join(baseDir, 'four_sprites_sheet.png')
  await fsp.writeFile(SHEET_PATH, buf)
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

  // Save in combat-friendly order
  const order = [TR, TL, BR, BL] // (1) TR emote, (2) TL idle, (3) BR moveB, (4) BL moveA

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

/* ===================== MOVE VISUALS (WIDE, EFFECT-ONLY) ===================== */
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

/* ===================== ICONS ===================== */
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

/* ===================== STATS PANEL ===================== */
async function renderStatsPanelWithMoves({
  outPath,
  creatureName,
  types, stats,
  moveA, moveB,
  moveImgAPath, moveImgBPath,
  bgW, bgH,
  statIcons,
  typeIcons
}) {
  const panelW = Math.round(bgW * PANEL_WIDTH_PCT)
  const panelH = Math.round(bgH * 0.9)
  const panel = new Jimp(panelW, panelH, 0x00000000)

  const card = new Jimp(panelW, panelH, Jimp.cssColorToHex('#0e0a08'))
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
  const fontType  = await loadFontBuiltin(32, 'white')
  const font32    = await loadFontBuiltin(32, 'white')
  const font16    = await loadFontBuiltin(16, 'white')

  panel.print(fontTitle, 18, 14, creatureName)
  if (statIcons?.nature) {
    const deco = statIcons.nature.clone().contain(26, 26, Jimp.RESIZE_BILINEAR)
    panel.composite(deco, panelW - 18 - 26, 12)
  }

  const badgeY = 58
  const badgeH = 48
  const gap = 14
  const chipW = Math.min(Math.floor((panelW - 36 - gap) / (Array.isArray(types) && types.length === 2 ? 2 : 1)), 220)

  const typesArr = Array.isArray(types) ? types : [types]
  let chipX = 18
  for (const t of typesArr) {
    const { leftTextX } = await drawTypeChip(panel, chipX, badgeY, chipW, badgeH, t, typeIcons)
    panel.print(fontType, leftTextX, badgeY + 8, String(t).toUpperCase())
    chipX += chipW + gap
  }

  // Divider
  let y = badgeY + badgeH + 18
  drawHorizontalLine(panel, 18, panelW - 18, y, GOLD_HEX)

  // Base stats
  y += 22
  const keys = ['hp','atk','def','spa','spd','spe']
  const barLeft = 18
  const nameAreaW = 170
  const barW = panelW - barLeft - nameAreaW - 60 - 64
  const barH = 22
  const rowH = 50

  for (const k of keys) {
    const { label, min, max } = STAT_BOUNDS[k]
    const v = stats[k]
    const pct = (v - min) / (max - min)

    let labelX = barLeft
    if (statIcons?.[k]) {
      const ico = statIcons[k].clone().contain(28, 28, Jimp.RESIZE_BILINEAR)
      panel.composite(ico, labelX, y + Math.round((barH - 28)/2))
      labelX += 28 + 10
    }
    panel.print(font32, labelX, y + 2, label)
    drawStatBar(panel, barLeft + nameAreaW, y, barW, barH, pct)
    panel.print(font32, barLeft + nameAreaW + barW + 10, y - 2, String(v))
    y += rowH
  }

  // Divider before moves
  y += 10
  drawHorizontalLine(panel, 18, panelW - 18, y, GOLD_HEX)
  panel.print(font16, 18, y + 10, 'MOVES')

  // Moves tiles
  const movesTop = y + 44
  const gap2 = 18
  const colW = Math.floor((panelW - 18 - 18 - gap2) / 2)
  const colH = Math.min(Math.floor(panelH * 0.46), 400)
  const cols = [
    { x: 18,              y: movesTop, w: colW, h: colH, move: moveA, imgPath: moveImgAPath },
    { x: 18 + colW + gap2, y: movesTop, w: colW, h: colH, move: moveB, imgPath: moveImgBPath },
  ]

  for (const c of cols) {
    const tile = new Jimp(c.w, c.h, Jimp.cssColorToHex('#140e08'))
    tile.opacity(0.78)
    panel.composite(tile, c.x, c.y)
    for (let ix = 0; ix < c.w; ix++) {
      panel.setPixelColor(GOLD_HEX, c.x + ix, c.y)
      panel.setPixelColor(GOLD_HEX, c.x + ix, c.y + c.h - 1)
    }
    for (let iy = 0; iy < c.h; iy++) {
      panel.setPixelColor(GOLD_HEX, c.x, c.y + iy)
      panel.setPixelColor(GOLD_HEX, c.x + c.w - 1, c.y + iy)
    }

    const imgPadTop = 12
    const imgSidePad = 10
    const reservedHForText = 28 + 12 + 28 + 8 + (24*2) + 10 + 18
    const imgMaxH = Math.min(c.h * 0.5, c.h - reservedHForText)

    try {
      const mvImg = await Jimp.read(c.imgPath)
      const scale = Math.min((c.w - imgSidePad*2) / mvImg.bitmap.width, imgMaxH / mvImg.bitmap.height)
      const iw = Math.max(1, Math.round(mvImg.bitmap.width * scale))
      const ih = Math.max(1, Math.round(mvImg.bitmap.height * scale))
      const ix = c.x + Math.round((c.w - iw)/2)
      const iy3 = c.y + imgPadTop
      const scaled = mvImg.clone().resize(iw, ih, Jimp.RESIZE_BILINEAR)
      panel.composite(scaled, ix, iy3)
    } catch {
      const ph = new Jimp(c.w - imgSidePad*2, Math.round(imgMaxH), Jimp.cssColorToHex('#332417'))
      ph.opacity(0.6)
      panel.composite(ph, c.x + imgSidePad, c.y + imgPadTop)
    }

    const nameY = c.y + imgPadTop + Math.round(imgMaxH) + 8
    panel.print(await loadFontBuiltin(32,'white'), c.x + 10, nameY, c.move.name)

    const extraSpace = 12
    const chipY = nameY + 28 + extraSpace
    const chipH = 28
    const chipW2 = Math.min(180, c.w - 20)
    const chipRes = await drawTypeChip(panel, c.x + 10, chipY, chipW2, chipH, c.move.type || 'Normal', typeIcons)
    panel.print(await loadFontBuiltin(16,'white'), chipRes.leftTextX, chipY + 6, (c.move.type || 'Normal').toUpperCase())

    const labelGapX = 6
    const labelAreaW = 64
    const BAR_SHIFT_RIGHT = 8
    const statBarLeft = c.x + 10 + labelAreaW + BAR_SHIFT_RIGHT
    const statBarW = c.w - 20 - labelAreaW - BAR_SHIFT_RIGHT - 56
    const statBarH = 24
    const rowGap = 8

    // POWER
    let rowY = chipY + chipH + 8
    let labelX = c.x + 10
    if (statIcons?.power) {
      const pIco = statIcons.power.clone().contain(22, 22, Jimp.RESIZE_BILINEAR)
      panel.composite(pIco, labelX, rowY + Math.round((statBarH - 22)/2))
      labelX += 22 + labelGapX
    }
    panel.print(await loadFontBuiltin(16,'white'), labelX, rowY + 3, 'POW')
    const pMin = 20, pMax = 150
    const pVal = clamp(Number(c.move.power) || 0, 0, pMax)
    const pPct = (pVal - pMin) / Math.max(1, (pMax - pMin))
    drawStatBar(panel, statBarLeft, rowY, statBarW, statBarH, pPct)
    panel.print(await loadFontBuiltin(16,'white'), statBarLeft + statBarW + 6, rowY + 3, String(pVal))

    // ACC
    rowY += statBarH + rowGap
    labelX = c.x + 10
    if (statIcons?.accuracy) {
      const aIco = statIcons.accuracy.clone().contain(22, 22, Jimp.RESIZE_BILINEAR)
      panel.composite(aIco, labelX, rowY + Math.round((statBarH - 22)/2))
      labelX += 22 + labelGapX
    }
    panel.print(await loadFontBuiltin(16,'white'), labelX, rowY + 3, 'ACC')
    const aMin = 0, aMax = 100
    const aVal = clamp(Number(c.move.accuracy) || 0, aMin, aMax)
    const aPct = (aVal - aMin) / Math.max(1, (aMax - aMin))
    drawStatBar(panel, statBarLeft, rowY, statBarW, statBarH, aPct)
    panel.print(await loadFontBuiltin(16,'white'), statBarLeft + statBarW + 6, rowY + 3, `${aVal}%`)

    rowY += statBarH + 10
    panel.print(await loadFontBuiltin(16,'white'), c.x + 10, rowY, titleCase(c.move.category || 'Physical'))
  }

  await panel.writeAsync(outPath)
  return { path: outPath, width: panelW, height: panelH }
}

/* ===================== ONE CREATURE PIPELINE ===================== */
async function runCreaturePipeline(seed, indexLabel = 'creature') {
  const idPack = await generateIdentityAndMoves(seed)
  const { creature_name, identity, emote_brief } = idPack

  // Random 1–2 types + stats
  const { types, stats } = generateTypesAndStats(seed || creature_name)

  // Moves meta (bias to one of the creature's types)
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

  // 2×2 sheet
  await generateFourSpriteSheetImage(baseDir, { identity, emote_brief, moveA, moveB }, types)
  // Extract sprites
  await extractByQuadrants(baseDir)
  // Wide move visuals
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

/* ===================== MUSIC & SFX ===================== */
async function renderSongWav(outPath, targetSeconds) {
  // (kept lightweight; still a bit randomized per run)
  const sampleRate = 44100
  const totalSamples = Math.max(1, Math.ceil(targetSeconds * sampleRate))
  const L = new Float32Array(totalSamples)
  const R = new Float32Array(totalSamples)
  const bpm = 100 + Math.floor(Math.random() * 40)
  const spb = 60 / bpm
  const beats = Math.ceil(targetSeconds / spb)
  const tri = (p)=>2*Math.abs(((p/Math.PI)%2)-1)-1
  const sq  = (p)=> (Math.sin(p)>=0?1:-1)

  const root = [220, 246.94, 261.63, 293.66, 329.63][Math.floor(Math.random()*5)]
  const modeOffsets = [[0,4,7],[0,3,7],[0,5,7]][Math.floor(Math.random()*3)]
  const melodyPool = [0,2,4,5,7,9,11].map(s=>root*Math.pow(2,s/12))

  function toneAt(freq, t, wave='square'){ const ph = 2*Math.PI*freq*t; const w = wave==='triangle'?tri(ph):sq(ph); return w }
  for (let b=0;b<beats;b++){
    const t0 = b*spb
    // kick/snare
    for (let i=0;i<Math.floor(spb*sampleRate);i++){
      const t = t0 + i/sampleRate
      const envK = Math.exp(-12*(i/sampleRate))
      const k = Math.sin(2*Math.PI*(120 - 60*(i/sampleRate))* (i/sampleRate)) * envK * 0.25
      const envH = Math.exp(-50*(i/sampleRate))
      const n = (Math.random()*2-1) * envH * 0.07
      const idx = Math.floor(t*sampleRate)
      if (idx<totalSamples){ L[idx]+=k+n; R[idx]+=k+n }
    }
    // pad + bass + tiny melody ticks
    const chord = modeOffsets.map(o => root*Math.pow(2,o/12))
    for (let i=0;i<Math.floor(spb*sampleRate);i++){
      const t = t0 + i/sampleRate
      const pad = chord.reduce((s,f)=> s + toneAt(f/2, t, 'triangle'), 0) * 0.06
      const bass = toneAt(root/4, t, 'square') * 0.07
      const mel = toneAt(melodyPool[Math.floor(Math.random()*melodyPool.length)], t, 'triangle') * 0.02
      const idx = Math.floor(t*sampleRate)
      if (idx<totalSamples){ L[idx]+=pad+bass+mel; R[idx]+=pad+bass+mel }
    }
  }
  // normalize + fade
  let peak=0; for(let i=0;i<totalSamples;i++) peak=Math.max(peak, Math.abs(L[i]), Math.abs(R[i]))
  const gain = peak>0?0.95/peak:1
  const fadeS = Math.floor(0.25*sampleRate)
  for (let i=0;i<totalSamples;i++){ const f=i>totalSamples-fadeS ? (totalSamples-i)/fadeS : 1; L[i]*=gain*f; R[i]*=gain*f }

  writeWavStereoInt16(outPath, L, R, sampleRate)
}

/** Utilities to write WAV */
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

/** Small helper for randomized rendering */
function renderToBuffers(durationSec, renderFn, sr = 44100) {
  const total = Math.max(1, Math.ceil(durationSec * sr))
  const Ls = new Float32Array(total)
  const Rs = new Float32Array(total)
  renderFn(Ls, Rs, sr, total)
  // normalize + tiny fade
  let peak=0; for(let i=0;i<total;i++) peak=Math.max(peak, Math.abs(Ls[i]), Math.abs(Rs[i]))
  const gain = peak>0 ? 0.95/peak : 1
  const fade = Math.floor(0.02*sr)
  for (let i=0;i<total;i++){ const f=i>total-fade? (total-i)/fade : 1; Ls[i]*=gain*f; Rs[i]*=gain*f }
  return { Ls, Rs, sr }
}

/** More-random creature emote chirp (varies waveform, base, sweeps) */
async function renderCreatureCallWav(outPath) {
  const duration = 0.9 + Math.random()*0.25
  const waves = [
    (p)=>2*Math.abs(((p/Math.PI)%2)-1)-1, // triangle
    (p)=> (Math.sin(p)>=0?1:-1),          // square
    (p)=> ((p%(2*Math.PI))<(0.25*Math.PI)?1:-1), // pulse25
    (p)=> ((p%(2*Math.PI))<(0.12*Math.PI)?1:-1), // pulse12
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
        // ADSR-ish
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

/** Randomized hit and miss variations */
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

/* ===================== FIGHT HELPERS ===================== */
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
async function generateFightBackground(creatureAName, creatureBName, outDir) {
  ensureDir(outDir)
  const buf = await genImage(makeFightBackgroundPrompt(creatureAName, creatureBName), FIGHT_BG_SIZE, false)
  const p = path.join(outDir, 'fight_background.png')
  await fsp.writeFile(p, buf)
  return p
}
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
function calcDamage({
  level = 50,
  movePower,
  category,
  atk, def,
  moveType,
  attackerTypes,
  defenderTypes,
}) {
  const base = Math.floor(Math.floor((2*level)/5 + 2) * movePower * (atk/Math.max(1, def)) / 50) + 2
  const atkTypesArr = Array.isArray(attackerTypes) ? attackerTypes : [attackerTypes]
  const stab  = atkTypesArr.includes(moveType) ? 1.5 : 1.0
  const eff   = effectivenessVs(defenderTypes, moveType)
  const rand  = 0.85 + Math.random() * 0.15
  const dmg   = Math.max(1, Math.floor(base * stab * eff * rand))
  return { dmg, eff, stab }
}

/* ===================== HEALTH BARS & VFX ===================== */
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

/* ===== Audio Timeline ===== */
function makeAudioTimeline() {
  return {
    cues: [], // { t: seconds, kind: 'emoteA'|'emoteB'|'hit'|'miss' }
    push(kind, t) { this.cues.push({ kind, t: Math.max(0, t) }) }
  }
}

/* ===== optional: convert any lingering stat cues -> emote cues ===== */
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

/* ===== Blink and health drop helpers ===== */
async function blinkTargetFrames({
  frames,
  bg, axFinalX, aY, A_sprite,
  bxFinalX, bY, B_sprite,
  targetSide,
  outFramesDir,
  framesSoFar,
  hpA, maxHpA, hpB, maxHpB,
  barW=180, barH=16
}) {
  let fIdx = framesSoFar
  for (let i=0;i<frames;i++){
    const frame = bg.clone()
    const visible = (Math.floor(i/3) % 2 === 0)
    if (targetSide === 'A') {
      frame.composite(B_sprite, bxFinalX, bY)
      if (visible) frame.composite(A_sprite, axFinalX, aY)
    } else {
      frame.composite(A_sprite, axFinalX, aY)
      if (visible) frame.composite(B_sprite, bxFinalX, bY)
    }
    drawHealthBar(frame, axFinalX + Math.floor(A_sprite.bitmap.width/2), aY, barW, barH, hpA, maxHpA)
    drawHealthBar(frame, bxFinalX + Math.floor(B_sprite.bitmap.width/2), bY, barW, barH, hpB, maxHpB)
    await frame.writeAsync(path.join(outFramesDir, `frame_${String(fIdx++).padStart(4,'0')}.png`))
  }
  return fIdx
}
async function animateHealthDrop({
  bg, axFinalX, aY, A_sprite,
  bxFinalX, bY, B_sprite,
  outFramesDir, framesSoFar,
  fromHp, toHp, maxHp,
  side,
  otherHp, otherMaxHp,
  barW=180, barH=16,
  frames=18,
  popupText,
  popupStartX, popupStartY,
  popupRisePx = 40
}) {
  let fIdx = framesSoFar
  const fontWhite = await loadFontBuiltin(32, 'white')
  const fontBlack = await loadFontBuiltin(32, 'black')

  for (let i=0;i<frames;i++){
    const t = i/(frames-1)
    const hpNow = Math.round(fromHp + (toHp - fromHp)*t)
    const frame = bg.clone()
    frame.composite(A_sprite, axFinalX, aY)
    frame.composite(B_sprite, bxFinalX, bY)

    if (side === 'A') {
      drawHealthBar(frame, axFinalX + Math.floor(A_sprite.bitmap.width/2), aY, barW, barH, hpNow, maxHp)
      drawHealthBar(frame, bxFinalX + Math.floor(B_sprite.bitmap.width/2), bY, barW, barH, otherHp, otherMaxHp)
    } else {
      drawHealthBar(frame, axFinalX + Math.floor(A_sprite.bitmap.width/2), aY, barW, barH, otherHp, otherMaxHp)
      drawHealthBar(frame, bxFinalX + Math.floor(B_sprite.bitmap.width/2), bY, barW, barH, hpNow, maxHp)
    }

    if (popupText) {
      const dy = Math.round(popupRisePx * t)
      const px = popupStartX
      const py = popupStartY - dy
      frame.print(fontBlack, px+1, py+1, popupText)
      frame.print(fontWhite, px,   py,   popupText)
    }

    await frame.writeAsync(path.join(outFramesDir, `frame_${String(fIdx++).padStart(4,'0')}.png`))
  }
  return fIdx
}

/* ===================== ZOOM + STAT SEQUENCE ===================== */
/* CHANGED: push emote cues directly at the start of the stats zoom */
async function zoomStatsSequence({
  baseFrameBuilder,
  bgW, bgH,
  focusBox,
  panelImage,
  panelSide,
  outFramesDir,
  framesSoFar,
  audioTimeline,    // record when the panel first appears
  emoteCueKind      // 'emoteA' | 'emoteB'
}) {
  let fIdx = framesSoFar
  const panelW = panelImage.bitmap.width
  const panelH = panelImage.bitmap.height

  const placePanel = (frame) => {
    const y = Math.round((bgH - panelH)/2)
    const x = panelSide === 'right'
      ? bgW - panelW - PANEL_MARGIN_PX
      : PANEL_MARGIN_PX
    frame.composite(panelImage, x, y)
  }

  const doZoomStep = async (z, recordStart=false) => {
    const cw = Math.round(bgW / z)
    const ch = Math.round(bgH / z)

    const biasX = (panelSide === 'right') ? -panelW*0.25 : panelW*0.25
    const cx = clamp(focusBox.cx + biasX, cw/2, bgW - cw/2)
    const cy = clamp(focusBox.cy,         ch/2, bgH - ch/2)

    const x0 = clamp(Math.round(cx - cw/2), 0, bgW - cw)
    const y0 = clamp(Math.round(cy - ch/2), 0, bgH - ch)

    const base = await baseFrameBuilder()
    const cropped = base.clone().crop(x0, y0, cw, ch).resize(bgW, bgH, Jimp.RESIZE_BICUBIC)
    placePanel(cropped)
    if (recordStart && audioTimeline) {
      // EXACT moment the stats panel "pops"
      audioTimeline.push(emoteCueKind, fIdx / FIGHT_FPS)
    }
    await cropped.writeAsync(path.join(outFramesDir, `frame_${String(fIdx++).padStart(4,'0')}.png`))
  }

  for (let i=0;i<ZOOM_IN_FRAMES;i++){
    const t = easeInOut(i/(ZOOM_IN_FRAMES-1))
    const z = 1 + (ZOOM_MAX-1)*t
    await doZoomStep(z, i===0)
  }
  for (let i=0;i<STATS_HOLD_FRAMES;i++){
    await doZoomStep(ZOOM_MAX)
  }
  for (let i=0;i<ZOOM_OUT_FRAMES;i++){
    const t = easeInOut(i/(ZOOM_OUT_FRAMES-1))
    const z = ZOOM_MAX - (ZOOM_MAX-1)*t
    await doZoomStep(z)
  }

  return fIdx
}

/* ===================== PROJECTILE UTILS ===================== */
async function drawProjectileSequence({
  bg,
  outFramesDir,
  startX, startY,
  endX, endY,
  framesSoFar,
  projectileImg,
  layerLeft, layerRight,
  bars
}) {
  const total = PROJECTILE_FRAMES
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
        axFinalX, aY, A_sprite,
        bxFinalX, bY, B_sprite,
        A_HP, A_MAX, B_HP, B_MAX,
        barW=180, barH=16
      } = bars
      drawHealthBar(frame, axFinalX + Math.floor(A_sprite.bitmap.width/2), aY, barW, barH, A_HP, A_MAX)
      drawHealthBar(frame, bxFinalX + Math.floor(B_sprite.bitmap.width/2), bY, barW, barH, B_HP, B_MAX)
    }

    await frame.writeAsync(path.join(outFramesDir, `frame_${String(fIdx++).padStart(4, '0')}.png`))
  }
  return fIdx
}

/* ===================== VICTORY SEQUENCE ===================== */
/* CHANGED: loser is never drawn again; banner pinned to top */
async function victorySequence({
  bg, bgW, bgH,
  winner, // 'A' | 'B'
  axFinalX, aY, A_idle, A_emote,
  bxFinalX, bY, B_idle, B_emote,
  outFramesDir, framesSoFar,
  audioTimeline,
  winnerName
}) {
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
    // Only draw the WINNER; loser stays gone
    frame.composite(winSpriteEmote, winX, winY)
    return frame
  }

  // Winner emote cue at start of victory zoom
  audioTimeline.push(winner === 'A' ? 'emoteA' : 'emoteB', fIdx / FIGHT_FPS)

  // Zoom into winner while emote plays
  for (let i=0; i<VICTORY_ZOOM_IN_FR; i++){
    const t = easeInOut(i/(VICTORY_ZOOM_IN_FR-1))
    const z = 1 + (VICTORY_ZOOM_MAX-1)*t
    const cw = Math.round(bgW / z)
    const ch = Math.round(bgH / z)
    const x0 = clamp(Math.round(emoteCenter.cx - cw/2), 0, bgW - cw)
    const y0 = clamp(Math.round(emoteCenter.cy - ch/2), 0, bgH - ch)
    const base = await baseEmoteFrame()
    const cropped = base.clone().crop(x0, y0, cw, ch).resize(bgW, bgH, Jimp.RESIZE_BICUBIC)
    await cropped.writeAsync(path.join(outFramesDir, `frame_${String(fIdx++).padStart(4,'0')}.png`))
  }

  // Hold on emote (zoomed)
  for (let i=0; i<VICTORY_HOLD_FRAMES; i++){
    const z = VICTORY_ZOOM_MAX
    const cw = Math.round(bgW / z)
    const ch = Math.round(bgH / z)
    const x0 = clamp(Math.round(emoteCenter.cx - cw/2), 0, bgW - cw)
    const y0 = clamp(Math.round(emoteCenter.cy - ch/2), 0, bgH - ch)
    const base = await baseEmoteFrame()
    const cropped = base.clone().crop(x0, y0, cw, ch).resize(bgW, bgH, Jimp.RESIZE_BICUBIC)
    await cropped.writeAsync(path.join(outFramesDir, `frame_${String(fIdx++).padStart(4,'0')}.png`))
  }

  // Banner overlay (TOP of the screen)
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
    const by = 16 // TOP
    const frame = cropped
    frame.composite(banner, bx, by)
    frame.print(titleFont, bx + 12, by + 12, {
      text: msg,
      alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
      alignmentY: Jimp.VERTICAL_ALIGN_MIDDLE
    }, bannerW - 24, bannerH - 24)

    await frame.writeAsync(path.join(outFramesDir, `frame_${String(fIdx++).padStart(4,'0')}.png`))
  }

  return fIdx
}

/* ===================== FIGHT SCENE BUILD ===================== */
async function createFightFrames({
  aName, bName,
  backgroundPath,
  // Idle sprites
  spriteAPath,
  spriteBPath,
  // Emote sprites
  spriteAEmotePath,
  spriteBEmotePath,
  // Move A pose sprites
  spriteAMoveAPath,
  spriteBMoveAPath,
  // Move B pose sprites
  spriteAMoveBPath,
  spriteBMoveBPath,
  // Move visuals
  moveAVisualAPath,
  moveAVisualBPath,
  // Move B visuals
  moveBVisualAPath,
  moveBVisualBPath,
  // Stat panels
  statsPanelAPath,
  statsPanelBPath,
  outFramesDir,
  scaleFraction,
  gapBetween,
  aStats,
  bStats,
  aTypes,
  bTypes,
  aMoveMetaA,
  aMoveMetaB,
  bMoveMetaA,
  bMoveMetaB,
  audioTimeline
}) {
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

  // Scale
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

  const centerX = Math.floor(bgW / 2)
  const centerY = Math.floor(bgH * 0.72)

  const axFinalX = centerX - gapBetween - Math.floor(A_idle.bitmap.width / 2)
  const bxFinalX = centerX + gapBetween - Math.floor(B_idle.bitmap.width / 2)
  const aY = centerY - A_idle.bitmap.height
  const bY = centerY - B_idle.bitmap.height

  const axStartX = -A_idle.bitmap.width - 40
  const bxStartX = bgW + 40

  const panelA = await Jimp.read(statsPanelAPath)
  const panelB = await Jimp.read(statsPanelBPath)

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
    await frame.writeAsync(path.join(outFramesDir, `frame_${String(fIdx++).padStart(4, '0')}.png`))
  }

  // A stats zoom (play emote A SFX at start)
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
      panelImage: panelA,
      panelSide: 'right',
      outFramesDir,
      framesSoFar: fIdx,
      audioTimeline,
      emoteCueKind: 'emoteA'
    })
  }

  // A emotes (visual only)
  for (let i = 0; i < EMOTE_FRAMES; i++) {
    const frame = bg.clone()
    frame.composite(A_emote, axFinalX, aY)
    await frame.writeAsync(path.join(outFramesDir, `frame_${String(fIdx++).padStart(4, '0')}.png`))
  }

  // B floats in
  for (let i = 0; i < FIGHT_FRAMES_B; i++) {
    const t = easeOutCubic(i / (FIGHT_FRAMES_B - 1))
    const bx = Math.round(bxStartX + (bxFinalX - bxStartX) * t)
    const frame = bg.clone()
    frame.composite(A_idle, axFinalX, aY)
    frame.composite(B_idle, bx, bY)
    await frame.writeAsync(path.join(outFramesDir, `frame_${String(fIdx++).padStart(4, '0')}.png`))
  }

  // B stats zoom (play emote B SFX at start) — **explicit to satisfy requirement**
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
      panelImage: panelB,
      panelSide: 'left',
      outFramesDir,
      framesSoFar: fIdx,
      audioTimeline,
      emoteCueKind: 'emoteB'
    })
  }

  // B emotes (visual only)
  for (let i = 0; i < EMOTE_FRAMES; i++) {
    const frame = bg.clone()
    frame.composite(A_idle, axFinalX, aY)
    frame.composite(B_emote, bxFinalX, bY)
    await frame.writeAsync(path.join(outFramesDir, `frame_${String(fIdx++).padStart(4, '0')}.png`))
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
    await frame.writeAsync(path.join(outFramesDir, `frame_${String(fIdx++).padStart(4,'0')}.png`))
  }

  for (let i=0;i<6;i++) await drawNeutral()

  duel:
  while (A_HP > 0 && B_HP > 0) {
    const isA = attacker === 'A'
    const defender = isA ? 'B' : 'A'
    const { meta, spritePose, visualImg } = pickMove(attacker)

    // Wind-up pose
    {
      const frame = bg.clone()
      if (isA) { frame.composite(spritePose, axFinalX, aY); frame.composite(B_idle, bxFinalX, bY) }
      else { frame.composite(A_idle, axFinalX, aY); frame.composite(spritePose, bxFinalX, bY) }
      drawHealthBar(frame, axFinalX + Math.floor(A_idle.bitmap.width/2), aY, barW, barH, A_HP, A_MAX)
      drawHealthBar(frame, bxFinalX + Math.floor(B_idle.bitmap.width/2), bY, barW, barH, B_HP, B_MAX)
      await frame.writeAsync(path.join(outFramesDir, `frame_${String(fIdx++).padStart(4,'0')}.png`))
    }

    // Accuracy
    const hitRoll = Math.random()*100
    const hits = hitRoll <= (Number(meta.accuracy)||100)

    // Projectile path
    const startX = isA
      ? axFinalX + spritePose.bitmap.width - Math.floor(spritePose.bitmap.width * 0.15)
      : bxFinalX + Math.floor(spritePose.bitmap.width * 0.15)
    let endX = isA
      ? (bxFinalX + Math.floor(B_idle.bitmap.width * 0.2))
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
        axFinalX, aY, A_sprite: A_idle,
        bxFinalX, bY, B_sprite: B_idle,
        A_HP, A_MAX, B_HP, B_MAX,
        barW, barH
      }
    })
    // Audio cue at impact/miss time
    const impactTimeSec = (projStartFrame + PROJECTILE_FRAMES - 1) / FIGHT_FPS
    audioTimeline.push(hits ? 'hit' : 'miss', impactTimeSec)

    if (!hits) {
      for (let i=0;i<6;i++) await drawNeutral()
      attacker = defender
      continue
    }

    // Damage
    const category = String(meta.category||'Physical')
    const movePower = clamp(Number(meta.power)||40, 1, 250)
    const moveType  = meta.type
    const atkStat   = isA ? (category==='Physical' ? aStats.atk : aStats.spa)
                          : (category==='Physical' ? bStats.atk : bStats.spa)
    const defStat   = isA ? (category==='Physical' ? bStats.def : bStats.spd)
                          : (category==='Physical' ? aStats.def : aStats.spd)
    const attackerTypes = isA ? aTypes : bTypes
    const defenderTypes = isA ? bTypes : aTypes

    const { dmg } = calcDamage({
      level: 50, movePower, category,
      atk: atkStat, def: Math.max(1, defStat),
      moveType, attackerTypes, defenderTypes
    })

    // Blink target
    fIdx = await blinkTargetFrames({
      frames: 18,
      bg,
      axFinalX, aY, A_sprite: A_idle,
      bxFinalX, bY, B_sprite: B_idle,
      targetSide: defender,
      outFramesDir,
      framesSoFar: fIdx,
      hpA: A_HP, maxHpA: A_MAX,
      hpB: B_HP, maxHpB: B_MAX,
      barW, barH
    })

    // Floating dmg & HP bar
    if (defender === 'A') {
      const newHp = Math.max(0, A_HP - dmg)
      const popupX = axFinalX + Math.floor(A_idle.bitmap.width/2) - 10
      const popupY = aY - 10
      fIdx = await animateHealthDrop({
        bg, axFinalX, aY, A_sprite: A_idle,
        bxFinalX, bY, B_sprite: B_idle,
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
        bg, axFinalX, aY, A_sprite: A_idle,
        bxFinalX, bY, B_sprite: B_idle,
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

  const loser = (A_HP <= 0) ? 'A' : 'B'
  fIdx = await fadeOutDefeated({
    bg, axFinalX, aY, A_sprite: A_idle,
    bxFinalX, bY, B_sprite: B_idle,
    outFramesDir,
    framesSoFar: fIdx,
    loser
  })

  // Victory scene (winner emote + top banner), loser stays gone
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

async function fadeOutDefeated({
  bg, axFinalX, aY, A_sprite,
  bxFinalX, bY, B_sprite,
  outFramesDir, framesSoFar,
  loser
}) {
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
    await frame.writeAsync(path.join(outFramesDir, `frame_${String(fIdx++).padStart(4,'0')}.png`))
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

/** Build an audio mix with: base song + (quieter) emotes + hit/miss, then mux into the mp4 */
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

  // decode
  const songRS = toStereoResampled(await decodeWav(songWavPath))
  const callARS = toStereoResampled(await decodeWav(callAPath))
  const callBRS = toStereoResampled(await decodeWav(callBPath))
  const hitRS   = toStereoResampled(await decodeWav(hitPath))
  const missRS  = toStereoResampled(await decodeWav(missPath))

  // output buffers
  const outL = new Float32Array(totalFrames)
  const outR = new Float32Array(totalFrames)

  // 1) Base song looped + MASTER_GAIN
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

  // 2) (Optional) convert any leftover stat cues → emote cues; otherwise passthrough
  const norm = normalizeTimelineForEmotes(timeline, dur)
  const filteredCues = norm.cues

  const byKind = {
    emoteA: callARS,
    emoteB: callBRS,
    hit:    hitRS,
    miss:   missRS
  }

  // 50% quieter than previous: multiply prior cue gains by EFFECT_ATTEN
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
    const t = Math.max(0, Math.min(dur, Number(cue.t) || 0))
    const start = Math.floor(t * SR)
    const s = byKind[kind]
    if (!s) continue
    const g = (baseCueGains[kind] ?? 0.85) * EFFECT_ATTEN
    addAt(s.L, s.R, start, g)
  }

  // 3) Encode mix and mux
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

/* ===================== MAIN ===================== */
async function main() {
  ensureDir(OUT_DIR)

  const A = await runCreaturePipeline(SEED1, 'creatureA')
  const B = await runCreaturePipeline(SEED2, 'creatureB')

  // Flip all extracted sprites for Creature B so it faces LEFT in the fight
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

  const statsPanelAPath = path.join(fightDir, 'stats_A.png')
  const statsPanelBPath = path.join(fightDir, 'stats_B.png')
  await renderStatsPanelWithMoves({
    outPath: statsPanelAPath,
    creatureName: A.creature_name,
    types: A.types,
    stats: A.stats,
    moveA: A.moveA,
    moveB: A.moveB,
    moveImgAPath: moveAVisualA,
    moveImgBPath: moveBVisualA,
    bgW: bgW, bgH: bgH,
    statIcons,
    typeIcons
  })
  await renderStatsPanelWithMoves({
    outPath: statsPanelBPath,
    creatureName: B.creature_name,
    types: B.types,
    stats: B.stats,
    moveA: B.moveA,
    moveB: B.moveB,
    moveImgAPath: moveAVisualB,
    moveImgBPath: moveBVisualB,
    bgW: bgW, bgH: bgH,
    statIcons,
    typeIcons
  })

  const spriteAIdle    = findIdleSpritePath(A.spritesDir)   // RIGHT
  const spriteAEmote   = findEmoteSpritePath(A.spritesDir)  // RIGHT
  const spriteAMoveA   = findMoveASpritePath(A.spritesDir)  // RIGHT (BL)
  const spriteAMoveB   = findMoveBSpritePath(A.spritesDir)  // RIGHT (BR)

  const spriteBIdle    = findIdleSpritePath(B.spritesDir)   // LEFT (flipped)
  const spriteBEmote   = findEmoteSpritePath(B.spritesDir)  // LEFT (flipped)
  const spriteBMoveA   = findMoveASpritePath(B.spritesDir)  // LEFT (flipped, BL)
  const spriteBMoveB   = findMoveBSpritePath(B.spritesDir)  // LEFT (flipped, BR)

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
    outFramesDir: framesDir,
    scaleFraction: FIGHT_SCALE_FRACTION,
    gapBetween: 500,
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

  // === AUDIO BUILD ===
  const durationSec = frames / FIGHT_FPS
  const songPath = path.join(fightDir, 'song.wav')
  await renderSongWav(songPath, durationSec)

  // SFX: more-random per run; each creature gets its own unique call
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
  console.log(`  Sheet: ${A.sheet} (2×2, all RIGHT-facing)`)
  console.log(`  Sprites: ${A.spritesDir}`)
  console.log(`Creature B: ${B.creature_name} [${B.types.join('/')}]`)
  console.log(`  Sheet: ${B.sheet} (2×2, all RIGHT-facing)`)
  console.log(`  Sprites (flipped for fight): ${B.spritesDir}`)
  console.log(`Fight BG: ${bgPath}`)
  console.log(`Video: ${finalVideo}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
