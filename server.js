// server.js — Kito (Jovika Academy) — versão enxuta e “professor de verdade”
// FIXES nesta versão:
// ✅ Wake word: quando aluno diz "Kito" -> responde como professor (não entra em loop da lição)
// ✅ Áudio inteligente:
//    - "envia áudio" sem frase => usa a frase atual da lição (se existir)
//    - "como se diz X em inglês/francês por áudio" => traduz X e envia áudio da tradução
// ✅ Deploy: removido bug de syntax (0.35_toggle...)
// ✅ Anti-spam paywall + Firestore + Stripe webhook (essencial)

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import axios from "axios";
import OpenAI from "openai";
import Stripe from "stripe";
import { db } from "./firebaseAdmin.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

/**
 * Stripe webhook precisa de RAW body, então:
 * - json parser em tudo EXCETO /stripe/webhook
 */
const jsonParser = bodyParser.json({ limit: "2mb" });
app.use((req, res, next) => {
  if (req.originalUrl === "/stripe/webhook") return next();
  return jsonParser(req, res, next);
});
const stripeRawParser = bodyParser.raw({ type: "application/json" });

/** ------------ Config ------------ **/
const HARD_PAYWALL = String(process.env.HARD_PAYWALL || "1") === "1";

const STRIPE_PAYMENT_LINK_URL = String(
  process.env.STRIPE_PAYMENT_LINK_URL || "https://buy.stripe.com/00w28qchVgVQdfm1eS9ws01"
).trim();

const HOTMART_PAYMENT_LINK_URL = String(
  process.env.HOTMART_PAYMENT_LINK_URL || "https://pay.hotmart.com/X103770007F"
).trim();

const PREMIUM_PRICE_EUR = String(process.env.PREMIUM_PRICE_EUR || "9,99€").trim();
const PREMIUM_PERIOD_TEXT = String(process.env.PREMIUM_PERIOD_TEXT || "mês").trim();

const SALES_MESSAGE_COOLDOWN_HOURS = Number(process.env.SALES_MESSAGE_COOLDOWN_HOURS || 72);
const PREMIUM_EXPIRED_NOTICE_COOLDOWN_HOURS = Number(
  process.env.PREMIUM_EXPIRED_NOTICE_COOLDOWN_HOURS || 24
);

const MAX_PROCESSED_IDS = Number(process.env.MAX_PROCESSED_IDS || 6000);

// Áudio
const AUDIO_MAX_CHARS = Number(process.env.AUDIO_MAX_CHARS || 180);
const AUDIO_REQUIRE_EXPLICIT_TEXT = String(process.env.AUDIO_REQUIRE_EXPLICIT_TEXT || "1") === "1";

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OPENAI_CHAT_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "onyx";
const OPENAI_TTS_VOICE_FALLBACK = process.env.OPENAI_TTS_VOICE_FALLBACK || "alloy";

const stripe =
  process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.trim()
    ? new Stripe(process.env.STRIPE_SECRET_KEY.trim(), { apiVersion: "2024-06-20" })
    : null;

/** ------------ Memória runtime (mínima) ------------ **/
const students = {}; // cache simples em RAM
const processedMessages = new Set();
const lastTextByPhone = {}; // anti-dupe por texto rápido

/** ------------ Util ------------ **/
function safeToDate(val) {
  if (!val) return null;
  if (typeof val.toDate === "function") return val.toDate();
  const d = val instanceof Date ? val : new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function normalizarTexto(txt = "") {
  return String(txt)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function phoneDigits(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function isAngolaOrBrazilPhone(phone) {
  const d = phoneDigits(phone);
  return d.startsWith("244") || d.startsWith("55");
}

function gerarStripeLinkParaTelefone(phone) {
  const ref = `whatsapp:${phoneDigits(phone)}`;
  const glue = STRIPE_PAYMENT_LINK_URL.includes("?") ? "&" : "?";
  return `${STRIPE_PAYMENT_LINK_URL}${glue}client_reference_id=${encodeURIComponent(ref)}`;
}

function getPaymentLinkForPhone(phone) {
  if (isAngolaOrBrazilPhone(phone)) {
    return { provider: "hotmart", link: HOTMART_PAYMENT_LINK_URL, canal: "Hotmart (PIX/cartão)" };
  }
  return { provider: "stripe", link: gerarStripeLinkParaTelefone(phone), canal: "Stripe (cartão)" };
}

function isSalesIntent(texto = "") {
  const t = normalizarTexto(texto);
  const gatilhos = [
    "link",
    "preco",
    "preço",
    "pagar",
    "pagamento",
    "premium",
    "assinar",
    "ativar",
    "stripe",
    "hotmart",
    "pix",
    "quanto custa",
    "como pagar",
    "quero pagar",
    "manda link",
  ];
  return gatilhos.some((g) => t.includes(g));
}

function isAckOnly(texto = "") {
  const t = normalizarTexto(texto);
  const acks = new Set([
    "ok",
    "okay",
    "kk",
    "k",
    "sim",
    "certo",
    "entendi",
    "blz",
    "beleza",
    "ta",
    "tá",
    "show",
    "hmm",
    "hm",
    "aham",
    "👍",
    "✅",
    "👌",
  ]);

  if (!t) return true;
  if (acks.has(t)) return true;

  const compact = t.replace(/[^a-z0-9]/g, "");
  if (compact === "ok") return true;

  return false;
}

function canSendAgain(lastAt, cooldownHours, now = new Date()) {
  const last = safeToDate(lastAt);
  if (!last) return true;
  const diffH = (now.getTime() - last.getTime()) / (1000 * 60 * 60);
  return diffH >= cooldownHours;
}

/** ------------ Wake word (Kito) ------------ **/
function isWakeWord(texto = "") {
  const t = normalizarTexto(texto);
  // "kito" puro, ou começando com "kito", "kito," "kito:" etc.
  if (!t) return false;
  if (t === "kito") return true;
  if (t.startsWith("kito ")) return true;
  if (t.startsWith("kito,") || t.startsWith("kito:")) return true;
  return false;
}

/** ------------ Professor: trilha A0 (enxuta) ------------ **/
const LESSONS = {
  frances: [
    {
      id: "fr_a0_1",
      title: "Apresentação (partes curtas)",
      parts: [
        { text: "Je travaille comme", hint: "juh tra-vaiy kum" },
        { text: "créatrice de contenu", hint: "kré-a-triss de kon-te-nu" },
        { text: "UGC", hint: "u-jé-sé" },
      ],
    },
  ],
  ingles: [
    {
      id: "en_a0_1",
      title: "Apresentação (partes curtas)",
      parts: [
        { text: "I work as a", hint: "ai work as a" },
        { text: "content creator", hint: "kon-tent kri-ei-ter" },
        { text: "UGC creator", hint: "u-jí-sí kri-ei-ter" },
      ],
    },
  ],
};

function getLangKey(aluno) {
  if (aluno?.idioma === "frances") return "frances";
  return "ingles";
}

function getCurrentLesson(aluno) {
  const lang = getLangKey(aluno);
  const idx = Number(aluno.lessonIndex || 0);
  const list = LESSONS[lang] || LESSONS.ingles;
  return list[Math.min(idx, list.length - 1)];
}

function getCurrentPart(aluno) {
  const lesson = getCurrentLesson(aluno);
  const partIdx = Number(aluno.partIndex || 0);
  return lesson.parts[Math.min(partIdx, lesson.parts.length - 1)];
}

function advancePart(aluno) {
  const lesson = getCurrentLesson(aluno);
  const next = Number(aluno.partIndex || 0) + 1;
  if (next >= lesson.parts.length) {
    aluno.lessonIndex = Number(aluno.lessonIndex || 0) + 1;
    aluno.partIndex = 0;
  } else {
    aluno.partIndex = next;
  }
}

function similarityScore(expected, user) {
  const e = normalizarTexto(expected).split(/\s+/).filter(Boolean);
  const u = normalizarTexto(user).split(/\s+/).filter(Boolean);
  if (u.length === 0) return 0;

  const setE = new Set(e);
  let hit = 0;
  for (const tok of u) if (setE.has(tok)) hit++;

  const eStr = normalizarTexto(expected);
  const uStr = normalizarTexto(user);
  const prefixBonus = uStr.startsWith(eStr.slice(0, Math.min(6, eStr.length))) ? 0.15 : 0;

  const base = hit / Math.max(1, setE.size);
  return Math.min(1, base + prefixBonus);
}

/** ------------ Nome (mínimo e seguro) ------------ **/
function extrairNome(frase) {
  if (!frase) return null;
  const cleaned = String(frase)
    .trim()
    .replace(/[.,!?;:()[\]{}"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const patterns = [
    { re: /\bchamo[- ]me\s+([^\s]+)/i, group: 1 },
    { re: /\bme\s+chamo\s+([^\s]+)/i, group: 1 },
    { re: /\beu\s+sou\s+([^\s]+)/i, group: 1 },
    { re: /\bsou\s+o\s+([^\s]+)/i, group: 1 },
    { re: /\bsou\s+a\s+([^\s]+)/i, group: 1 },
    { re: /\bmeu\s+nome\s+e\s+([^\s]+)/i, group: 1 },
    { re: /\bmy\s+name\s+is\s+([^\s]+)/i, group: 1 },
    { re: /\bi\s*'?m\s+([^\s]+)/i, group: 1 },
  ];

  for (const p of patterns) {
    const m = cleaned.match(p.re);
    if (m && m[p.group]) {
      const c = String(m[p.group]).replace(/[^\p{L}\-]/gu, "");
      if (c && c.length >= 2) return c;
    }
  }

  const tokens = cleaned
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\-]/gu, ""))
    .filter(Boolean);

  const stop = new Set(["eu", "me", "chamo", "chamo-me", "sou", "o", "a", "nome", "meu", "minha", "e", "é", "se"]);
  for (const tok of tokens) {
    const tnorm = normalizarTexto(tok);
    if (stop.has(tnorm)) continue;
    if (tok.length < 2) continue;
    return tok;
  }
  return null;
}

function detectarIdioma(frase) {
  const t = normalizarTexto(frase);
  const querIngles = t.includes("ingles") || t.includes("inglês");
  const querFrances = t.includes("frances") || t.includes("francês");
  if (querIngles && querFrances) return "ambos";
  if (querIngles) return "ingles";
  if (querFrances) return "frances";
  return null;
}

/** ------------ Premium ------------ **/
function isPremium(aluno, now = new Date()) {
  const plan = aluno?.plan || "free";
  const until = safeToDate(aluno?.premiumUntil);
  if (until && until.getTime() > now.getTime()) return true;
  return plan === "premium" && !until ? true : false;
}

function isPremiumExpired(aluno, now = new Date()) {
  const until = safeToDate(aluno?.premiumUntil);
  return Boolean(until && until.getTime() <= now.getTime());
}

function montarMensagemHardPaywall(phone) {
  const { canal, link } = getPaymentLinkForPhone(phone);
  return [
    `Olá! 😊 Eu sou o *Kito*, professor de inglês e francês da *Jovika Academy*.`,
    ``,
    `Para usar minhas aulas no WhatsApp, você precisa do *Acesso Premium*.`,
    `💰 *${PREMIUM_PRICE_EUR}/${PREMIUM_PERIOD_TEXT}* — sem fidelização.`,
    ``,
    `👉 Ativar agora (${canal}):`,
    `${link}`,
    ``,
    `Assim que confirmar, eu libero automaticamente ✅`,
  ].join("\n");
}

function montarMensagemPremiumExpirou(phone) {
  const { canal, link } = getPaymentLinkForPhone(phone);
  return [
    `Oi 😊 Só um aviso rápido: seu *Acesso Premium expirou*.`,
    `Para continuar com as aulas e áudios, reative:`,
    ``,
    `💰 *${PREMIUM_PRICE_EUR}/${PREMIUM_PERIOD_TEXT}*`,
    `👉 Link (${canal}):`,
    `${link}`,
  ].join("\n");
}

/** ------------ Firestore (mínimo + anti-downgrade) ------------ **/
async function loadStudentFromFirestore(phone) {
  try {
    if (!db) return null;
    const ref = db.collection("students").doc(`whatsapp:${phone}`);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const d = snap.data() || {};
    return {
      ...d,
      createdAt: safeToDate(d.createdAt) || new Date(),
      lastMessageAt: safeToDate(d.lastMessageAt) || new Date(),
      premiumUntil: safeToDate(d.premiumUntil),
      lastSalesMessageAt: safeToDate(d.lastSalesMessageAt),
      lastPremiumExpiredNoticeAt: safeToDate(d.lastPremiumExpiredNoticeAt),
      updatedAt: safeToDate(d.updatedAt),
    };
  } catch (e) {
    console.error("❌ Firestore load error:", e?.message || e);
    return null;
  }
}

function isPremiumActiveFromData(data, now = new Date()) {
  const plan = data?.plan || "free";
  const until = safeToDate(data?.premiumUntil);
  if (plan !== "premium") return false;
  if (!until) return true;
  return until.getTime() > now.getTime();
}

async function saveStudentToFirestore(phone, aluno) {
  try {
    if (!db) return;

    // ✅ anti-downgrade
    if ((aluno?.plan || "free") !== "premium") {
      try {
        const snap = await db.collection("students").doc(`whatsapp:${phone}`).get();
        if (snap.exists) {
          const existing = snap.data();
          if (isPremiumActiveFromData(existing, new Date())) {
            aluno.plan = "premium";
            aluno.paymentProvider = existing.paymentProvider || aluno.paymentProvider || "manual";
            aluno.premiumUntil = safeToDate(existing.premiumUntil) || aluno.premiumUntil || null;
          }
        }
      } catch (e) {
        console.warn("⚠️ anti-downgrade get falhou:", e?.message || e);
      }
    }

    const ref = db.collection("students").doc(`whatsapp:${phone}`);
    await ref.set(
      {
        nome: aluno.nome ?? null,
        idioma: aluno.idioma ?? null,
        stage: aluno.stage ?? "ask_name",
        chatMode: aluno.chatMode ?? "aprender",

        lessonIndex: aluno.lessonIndex ?? 0,
        partIndex: aluno.partIndex ?? 0,
        awaitingRepeat: aluno.awaitingRepeat ?? null,

        plan: aluno.plan ?? "free",
        paymentProvider: aluno.paymentProvider ?? null,
        premiumUntil: safeToDate(aluno.premiumUntil) || null,

        lastSalesMessageAt: safeToDate(aluno.lastSalesMessageAt) || null,
        lastPremiumExpiredNoticeAt: safeToDate(aluno.lastPremiumExpiredNoticeAt) || null,

        createdAt: safeToDate(aluno.createdAt) || new Date(),
        lastMessageAt: safeToDate(aluno.lastMessageAt) || new Date(),
        updatedAt: new Date(),
      },
      { merge: true }
    );
  } catch (e) {
    console.error("❌ Firestore save error:", e?.message || e);
  }
}

async function ensureStudentLoaded(phone) {
  const mem = students[phone] || null;
  const fromDb = await loadStudentFromFirestore(phone);

  if (!mem && fromDb) {
    students[phone] = { ...fromDb };
    return students[phone];
  }

  if (mem && fromDb) {
    const now = new Date();

    if (isPremiumActiveFromData(fromDb, now)) {
      mem.plan = "premium";
      mem.paymentProvider = fromDb.paymentProvider || mem.paymentProvider || "manual";
      mem.premiumUntil = safeToDate(fromDb.premiumUntil) || mem.premiumUntil || null;
    } else {
      if (!isPremium(mem, now)) {
        mem.plan = fromDb.plan || mem.plan || "free";
        mem.paymentProvider = fromDb.paymentProvider ?? mem.paymentProvider ?? null;
        mem.premiumUntil = safeToDate(fromDb.premiumUntil) ?? mem.premiumUntil ?? null;
      }
    }

    mem.stage = mem.stage || fromDb.stage || "ask_name";
    mem.nome = mem.nome || fromDb.nome || null;
    mem.idioma = mem.idioma || fromDb.idioma || null;
    mem.chatMode = mem.chatMode || fromDb.chatMode || "aprender";

    mem.lessonIndex = Number(mem.lessonIndex ?? fromDb.lessonIndex ?? 0);
    mem.partIndex = Number(mem.partIndex ?? fromDb.partIndex ?? 0);
    mem.awaitingRepeat = mem.awaitingRepeat ?? fromDb.awaitingRepeat ?? null;

    mem.lastSalesMessageAt = mem.lastSalesMessageAt || fromDb.lastSalesMessageAt || null;
    mem.lastPremiumExpiredNoticeAt =
      mem.lastPremiumExpiredNoticeAt || fromDb.lastPremiumExpiredNoticeAt || null;

    students[phone] = mem;
    return mem;
  }

  return mem;
}

/** ------------ Z-API (texto) ------------ **/
async function enviarMensagemWhatsApp(phone, message) {
  try {
    const msg = String(message || "").trim();
    if (!msg) return;

    const instanceId = process.env.ZAPI_INSTANCE_ID;
    const instanceToken = process.env.ZAPI_INSTANCE_TOKEN;
    const clientToken = process.env.ZAPI_CLIENT_TOKEN;

    if (!instanceId || !instanceToken) {
      console.error("❌ Z-API: falta ZAPI_INSTANCE_ID ou ZAPI_INSTANCE_TOKEN");
      return;
    }

    const url = `https://api.z-api.io/instances/${instanceId}/token/${instanceToken}/send-text`;
    const payload = { phone, message: msg };

    const headers = { "Content-Type": "application/json" };
    if (clientToken) headers["Client-Token"] = clientToken;

    await axios.post(url, payload, { headers });
  } catch (err) {
    console.error("❌ Erro ao enviar mensagem via Z-API:", err.response?.data || err.message);
  }
}

/** ------------ Áudio (Premium) ------------ **/
function parseAudioRequest(texto = "") {
  const raw = String(texto || "").trim();
  if (!raw) return { asked: false, requestedText: null };

  const t = normalizarTexto(raw);

  const asked =
    t.includes("audio") ||
    t.includes("áudio") ||
    t.includes("voz") ||
    t.includes("voice") ||
    t.includes("pronuncia") ||
    t.includes("pronúncia") ||
    t.includes("fala isso") ||
    t.includes("falar isso") ||
    t.includes("manda audio") ||
    t.includes("manda áudio") ||
    t.includes("envia audio") ||
    t.includes("envia áudio");

  if (!asked) return { asked: false, requestedText: null };

  const patterns = [
    /(?:audio|áudio|voz|voice)\s*[:\-]\s*(.+)$/i,
    /(?:pronuncia|pronúncia)\s*(?:de|da|do)?\s*[:\-]?\s*(.+)$/i,
    /(?:manda|envia)\s+(?:um\s+)?(?:audio|áudio)\s*(?:de|da|do|pra|para)?\s*[:\-]?\s*(.+)$/i,
  ];

  let extracted = null;
  for (const re of patterns) {
    const m = raw.match(re);
    if (m && m[1]) {
      extracted = String(m[1]).trim();
      break;
    }
  }

  if (extracted) {
    extracted = extracted.replace(/^[“"'\s]+/, "").replace(/[”"'\s]+$/, "").trim();
    if (extracted.length > AUDIO_MAX_CHARS) extracted = extracted.slice(0, AUDIO_MAX_CHARS);
    if (!extracted) extracted = null;
  }

  return { asked: true, requestedText: extracted };
}

function detectTargetLangFromText(texto = "") {
  const t = normalizarTexto(texto);
  if (t.includes("em frances") || t.includes("em francês") || t.includes("frances") || t.includes("francês")) return "frances";
  if (t.includes("em ingles") || t.includes("em inglês") || t.includes("ingles") || t.includes("inglês")) return "ingles";
  return null;
}

function extractPhraseAfterComoSeDiz(texto = "") {
  // "como se diz X em inglês/francês"
  const raw = String(texto || "");
  const t = normalizarTexto(raw);

  // remove "audio:" se existir no começo
  const cleaned = raw.replace(/^\s*(audio|áudio)\s*:\s*/i, "").trim();

  // tenta capturar entre "como se diz" e "em ingles/frances"
  const m = cleaned.match(/como\s+se\s+diz\s+(.+?)\s+em\s+(ingles|inglês|frances|francês)\b/i);
  if (m && m[1]) return String(m[1]).trim();

  // fallback: "como se diz X" (sem idioma)
  const m2 = cleaned.match(/como\s+se\s+diz\s+(.+)$/i);
  if (m2 && m2[1]) return String(m2[1]).trim();

  return null;
}

async function translateShort(phrase, targetLang) {
  const target = targetLang === "frances" ? "francês" : "inglês";
  const system = `Você é um professor. Traduza a frase para ${target}. Responda APENAS com a tradução final, sem explicações, sem aspas.`;
  const input = [
    { role: "system", content: system },
    { role: "user", content: String(phrase || "").trim() },
  ];
  const r = await openai.responses.create({ model: OPENAI_CHAT_MODEL, input });
  const text = r.output?.[0]?.content?.[0]?.text || "";
  return String(text).trim().replace(/^["“”']+|["“”']+$/g, "").trim();
}

async function gerarAudioRespostaKito(texto, idiomaAlvo = "ingles") {
  try {
    let clean = String(texto || "").trim();
    if (!clean) return null;
    if (clean.length > AUDIO_MAX_CHARS) clean = clean.slice(0, AUDIO_MAX_CHARS);

    const instructions =
      idiomaAlvo === "frances"
        ? "Parle en français standard de France, voix masculine naturelle, lent et très clair pour débutants."
        : "Speak in clear, neutral English with a natural MALE voice. Talk slowly and clearly for beginners.";

    const makeSpeech = async (voice) =>
      openai.audio.speech.create({
        model: OPENAI_TTS_MODEL,
        voice,
        instructions,
        input: clean,
        response_format: "mp3",
      });

    let speech;
    try {
      speech = await makeSpeech(OPENAI_TTS_VOICE);
    } catch {
      speech = await makeSpeech(OPENAI_TTS_VOICE_FALLBACK);
    }

    const buffer = Buffer.from(await speech.arrayBuffer());
    return buffer.toString("base64"); // base64 PURO
  } catch (e) {
    console.error("❌ TTS error:", e?.response?.data || e?.message || e);
    return null;
  }
}

async function enviarAudioWhatsApp(phone, audioBase64) {
  try {
    if (!audioBase64) return { ok: false, error: "missing_base64" };

    const instanceId = process.env.ZAPI_INSTANCE_ID;
    const instanceToken = process.env.ZAPI_INSTANCE_TOKEN;
    const clientToken = process.env.ZAPI_CLIENT_TOKEN;

    if (!instanceId || !instanceToken) {
      console.error("❌ Z-API: falta ZAPI_INSTANCE_ID ou ZAPI_INSTANCE_TOKEN");
      return { ok: false, error: "missing_zapi_env" };
    }

    const url = `https://api.z-api.io/instances/${instanceId}/token/${instanceToken}/send-audio`;

    const pure = String(audioBase64).trim().replace(/^data:audio\/\w+;base64,/, "").replace(/\s+/g, "");
    if (!pure) return { ok: false, error: "empty_base64" };

    const headers = { "Content-Type": "application/json" };
    if (clientToken) headers["Client-Token"] = clientToken;

    const attempts = [
      { phone, audio: pure },
      { phone, audioBase64: pure },
      { phone, base64: pure },
      { phone, audio: `data:audio/mpeg;base64,${pure}` },
    ];

    let lastErr = null;
    for (let i = 0; i < attempts.length; i++) {
      try {
        const resp = await axios.post(url, attempts[i], { headers });
        console.log("✅ send-audio ok attempt", i + 1, resp?.data || "ok");
        return { ok: true };
      } catch (e) {
        lastErr = e;
        console.warn("⚠️ send-audio fail attempt", i + 1, e?.response?.data || e?.message);
      }
    }

    console.error("❌ send-audio falhou:", lastErr?.response?.data || lastErr?.message);
    return { ok: false, error: String(lastErr?.response?.data?.error || lastErr?.message || "send_audio_failed") };
  } catch (e) {
    console.error("❌ enviarAudioWhatsApp error:", e?.response?.data || e?.message || e);
    return { ok: false, error: String(e?.message || "send_audio_failed") };
  }
}

/** ------------ Chat “humano” (fallback) ------------ **/
async function gerarRespostaProfessor(aluno, userText) {
  const idioma = aluno.idioma === "frances" ? "francês" : "inglês";

  const system = `
Tu és o Kito, professor da Jovika Academy no WhatsApp.

REGRAS:
- Nunca responda apenas "ok".
- Nunca elogie como "mandou bem" se o aluno escreveu só: ok/sim/certo/entendi.
- Se a mensagem for curta/solta, pergunte o que o aluno quer fazer.
- Seja professor: curto, claro, com 1 pergunta no final.
- Só traduza se o aluno pedir explicitamente.
- Idioma alvo do aluno: ${idioma}.
`.trim();

  const input = [
    { role: "system", content: system },
    { role: "user", content: userText },
  ];

  const r = await openai.responses.create({ model: OPENAI_CHAT_MODEL, input });
  const text = r.output?.[0]?.content?.[0]?.text || "Entendi. Me manda a frase para eu te ajudar melhor 🙂";
  return String(text).trim();
}

/** ------------ Aula guiada (núcleo) ------------ **/
function montarPromptRepeticao(aluno) {
  const lesson = getCurrentLesson(aluno);
  const part = getCurrentPart(aluno);
  const lang = getLangKey(aluno);

  const titulo = `${lesson.title}`;
  const exemplo = lang === "frances" ? "Exemplo: Je travaille comme" : "Exemplo: I work as a";

  return [
    `Vamos por partes ✅ (${titulo})`,
    ``,
    `Repete *exatamente* assim:`,
    `“${part.text}”`,
    `(${part.hint})`,
    ``,
    `Se quiser, eu também posso mandar a pronúncia em áudio.`,
    `${exemplo}`,
  ].join("\n");
}

function setAwaitingRepeat(aluno) {
  const part = getCurrentPart(aluno);
  aluno.awaitingRepeat = {
    expected: part.text,
    at: new Date().toISOString(),
  };
}

function clearAwaitingRepeat(aluno) {
  aluno.awaitingRepeat = null;
}

/** ------------ Fluxo principal ------------ **/
async function processarMensagemAluno({ numeroAluno, texto, msgId }) {
  const agora = new Date();
  const phone = phoneDigits(numeroAluno);
  const textRaw = String(texto || "").trim();

  // Dedupe (por msgId)
  if (msgId) {
    if (processedMessages.has(msgId)) return;
    processedMessages.add(msgId);
    if (processedMessages.size > MAX_PROCESSED_IDS) processedMessages.clear();
  }

  // Anti-dupe por texto em janela curta (muito comum em webhooks)
  {
    const nowMs = Date.now();
    const last = lastTextByPhone[phone];
    if (last && last.text === textRaw && nowMs - last.time < 2000) return;
    lastTextByPhone[phone] = { text: textRaw, time: nowMs };
  }

  // Carrega/aloca aluno
  let aluno = await ensureStudentLoaded(phone);
  if (!aluno) {
    aluno = {
      stage: "ask_name",
      nome: null,
      idioma: null,
      chatMode: "aprender",

      lessonIndex: 0,
      partIndex: 0,
      awaitingRepeat: null,

      plan: "free",
      premiumUntil: null,
      paymentProvider: null,

      lastSalesMessageAt: null,
      lastPremiumExpiredNoticeAt: null,

      createdAt: agora,
      lastMessageAt: agora,
    };
    students[phone] = aluno;
    await saveStudentToFirestore(phone, aluno);
  }

  aluno.lastMessageAt = agora;

  const premium = isPremium(aluno, agora);
  const premiumExpired = isPremiumExpired(aluno, agora);

  /** --- HARD PAYWALL --- **/
  if (HARD_PAYWALL && !premium) {
    if (
      premiumExpired &&
      canSendAgain(aluno.lastPremiumExpiredNoticeAt, PREMIUM_EXPIRED_NOTICE_COOLDOWN_HOURS, agora)
    ) {
      aluno.lastPremiumExpiredNoticeAt = agora;
      const msg = montarMensagemPremiumExpirou(phone);
      await enviarMensagemWhatsApp(phone, msg);
      await saveStudentToFirestore(phone, aluno);
      return;
    }

    if (!aluno.lastSalesMessageAt) {
      aluno.lastSalesMessageAt = agora;
      const msg = montarMensagemHardPaywall(phone);
      await enviarMensagemWhatsApp(phone, msg);
      await saveStudentToFirestore(phone, aluno);
      return;
    }

    if (
      isSalesIntent(textRaw) &&
      canSendAgain(aluno.lastSalesMessageAt, SALES_MESSAGE_COOLDOWN_HOURS, agora)
    ) {
      aluno.lastSalesMessageAt = agora;
      const msg = montarMensagemHardPaywall(phone);
      await enviarMensagemWhatsApp(phone, msg);
      await saveStudentToFirestore(phone, aluno);
      return;
    }

    await saveStudentToFirestore(phone, aluno);
    return;
  }

  /** --- Premium: daqui pra baixo --- **/

  // ✅ Wake word sempre tem prioridade
  if (isWakeWord(textRaw)) {
    await enviarMensagemWhatsApp(
      phone,
      `Sim 😊 Sou o Kito.\nVocê quer:\n1) *áudio* de uma palavra/frase\n2) *traduzir* ("como se diz...")\n3) *continuar a lição*?`
    );
    await saveStudentToFirestore(phone, aluno);
    return;
  }

  /** 1) Onboarding */
  if (aluno.stage === "ask_name" && !aluno.nome) {
    if (isAckOnly(textRaw)) {
      await enviarMensagemWhatsApp(phone, "Antes de começarmos 😊 Como você quer que eu te chame? (ex: “Sou a Ana”)");
      await saveStudentToFirestore(phone, aluno);
      return;
    }

    aluno.nome = extrairNome(textRaw) || "Aluno";
    aluno.stage = "ask_language";
    await enviarMensagemWhatsApp(
      phone,
      `Perfeito, ${aluno.nome}! 😊\nVocê quer começar por *inglês* ou *francês*?`
    );
    await saveStudentToFirestore(phone, aluno);
    return;
  }

  if (aluno.stage === "ask_language") {
    const idioma = detectarIdioma(textRaw);
    if (!idioma || idioma === "ambos") {
      await enviarMensagemWhatsApp(phone, "Responde só com: *inglês* ou *francês* 😊");
      await saveStudentToFirestore(phone, aluno);
      return;
    }
    aluno.idioma = idioma;
    aluno.stage = "learning";
    aluno.lessonIndex = 0;
    aluno.partIndex = 0;
    clearAwaitingRepeat(aluno);

    const msg = `Fechado ✅ Vamos começar ${idioma === "frances" ? "francês" : "inglês"} por partes.\n\n` + montarPromptRepeticao(aluno);
    setAwaitingRepeat(aluno);
    await enviarMensagemWhatsApp(phone, msg);
    await saveStudentToFirestore(phone, aluno);
    return;
  }

  /** 2) Pedido de áudio (Premium) - inteligente */
  const audioReq = parseAudioRequest(textRaw);
  if (audioReq.asked) {
    // Se não veio frase explícita, mas estamos na lição aguardando repetição, usa a frase do passo atual
    let requested = audioReq.requestedText;
    if (!requested && aluno.awaitingRepeat?.expected) {
      requested = aluno.awaitingRepeat.expected;
    }

    // Se ainda não tem texto, pede
    if (AUDIO_REQUIRE_EXPLICIT_TEXT && !requested) {
      await enviarMensagemWhatsApp(
        phone,
        "Claro ✅\nMe diga a *palavra ou frase*.\nExemplo: *áudio: bonjour*\n\n(Se você estiver na lição, também posso mandar o áudio do passo atual.)"
      );
      await saveStudentToFirestore(phone, aluno);
      return;
    }

    // ✅ Se o pedido for "como se diz ... em inglês/francês", traduz antes e manda áudio da tradução
    const targetFromReq = detectTargetLangFromText(requested || textRaw) || (getLangKey(aluno) === "frances" ? "frances" : "ingles");
    const phraseToTranslate = extractPhraseAfterComoSeDiz(requested || "");
    let finalToSpeak = requested;

    if (phraseToTranslate) {
      const translated = await translateShort(phraseToTranslate, targetFromReq);
      if (translated) finalToSpeak = translated;
    }

    // Segurança: limita
    finalToSpeak = String(finalToSpeak || "").trim();
    if (finalToSpeak.length > AUDIO_MAX_CHARS) finalToSpeak = finalToSpeak.slice(0, AUDIO_MAX_CHARS);

    const b64 = await gerarAudioRespostaKito(finalToSpeak, targetFromReq);
    const send = await enviarAudioWhatsApp(phone, b64);

    // Resposta texto “professor” + se falhar, avisa sem quebrar UX
    if (phraseToTranslate) {
      await enviarMensagemWhatsApp(
        phone,
        `✅ Tradução: *${finalToSpeak}*\nQuer que eu te passe 2 variações bem naturais também?`
      );
    } else {
      await enviarMensagemWhatsApp(
        phone,
        `Perfeito ✅ Vou te mandar a pronúncia.\nDepois você repete e eu corrijo.`
      );
    }

    if (!send.ok) {
      await enviarMensagemWhatsApp(
        phone,
        `⚠️ Tive um problema para enviar o áudio agora.\nMe diga: você quer que eu te mande a pronúncia escrita (tipo: *ai’m táierd*) enquanto eu tento de novo?`
      );
    }

    await saveStudentToFirestore(phone, aluno);
    return;
  }

  /** 3) Aula guiada com awaitingRepeat (sem loop do “Kito/ok”) */
  if (aluno.stage === "learning") {
    // se aluno mandar ack-only, não avança
    if (aluno.awaitingRepeat?.expected) {
      // Se o aluno escreveu algo curto tipo "envia audio" (sem parse) ou "ok", pede a frase
      if (isAckOnly(textRaw)) {
        const expected = aluno.awaitingRepeat.expected;
        await enviarMensagemWhatsApp(
          phone,
          `Beleza 😊 Agora manda a frase para eu corrigir.\n\nRepete:\n“${expected}”\n\nSe quiser áudio, diga: *áudio*`
        );
        await saveStudentToFirestore(phone, aluno);
        return;
      }

      const expected = aluno.awaitingRepeat.expected;
      const score = similarityScore(expected, textRaw);

      // ✅ score fix (sem lixo de token)
      if (score < 0.35) {
        await enviarMensagemWhatsApp(
          phone,
          `Quase 😊 Tenta mais uma vez igualzinho:\n“${expected}”\n\nSe preferir, diga: *áudio* (que eu mando a pronúncia).`
        );
        await saveStudentToFirestore(phone, aluno);
        return;
      }

      // sucesso -> avança
      clearAwaitingRepeat(aluno);
      advancePart(aluno);

      const lang = getLangKey(aluno);
      const list = LESSONS[lang] || LESSONS.ingles;
      const maxLessonIndex = list.length - 1;
      if (Number(aluno.lessonIndex || 0) > maxLessonIndex) aluno.lessonIndex = maxLessonIndex;

      const part = getCurrentPart(aluno);

      const msg = [
        `✅ Certo! Agora a próxima parte:`,
        `“${part.text}”`,
        `(${part.hint})`,
        ``,
        `Repete por texto ou diga: *áudio*`,
      ].join("\n");

      setAwaitingRepeat(aluno);
      await enviarMensagemWhatsApp(phone, msg);
      await saveStudentToFirestore(phone, aluno);
      return;
    }

    // se não estava awaitingRepeat, reinicia passo atual
    const msg = montarPromptRepeticao(aluno);
    setAwaitingRepeat(aluno);
    await enviarMensagemWhatsApp(phone, msg);
    await saveStudentToFirestore(phone, aluno);
    return;
  }

  /** 4) Fallback humano */
  if (isAckOnly(textRaw)) {
    await enviarMensagemWhatsApp(phone, "Certo 😊 Me diga a frase que você quer treinar (ou escolha: inglês / francês).");
    await saveStudentToFirestore(phone, aluno);
    return;
  }

  const resposta = await gerarRespostaProfessor(aluno, textRaw);
  await enviarMensagemWhatsApp(phone, resposta);
  await saveStudentToFirestore(phone, aluno);
}

/** ------------ Stripe webhook (auto-unlock) ------------ **/
app.post("/stripe/webhook", stripeRawParser, async (req, res) => {
  try {
    if (!stripe) return res.status(400).send("stripe_not_configured");
    if (!db) return res.status(500).send("firestore_off");

    const whsec = process.env.STRIPE_WEBHOOK_SECRET;
    if (!whsec) return res.status(400).send("missing_STRIPE_WEBHOOK_SECRET");

    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, whsec);
    } catch (err) {
      console.error("❌ Stripe signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const ref = session.client_reference_id || "";
      const phone = ref.startsWith("whatsapp:") ? ref.replace("whatsapp:", "") : null;

      if (phone) {
        const now = new Date();
        let premiumUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        if (session.subscription) {
          try {
            const sub = await stripe.subscriptions.retrieve(session.subscription);
            if (sub?.current_period_end) premiumUntil = new Date(sub.current_period_end * 1000);
          } catch (e) {
            console.warn("⚠️ não consegui buscar subscription:", e?.message || e);
          }
        }

        await db.collection("students").doc(`whatsapp:${phone}`).set(
          {
            plan: "premium",
            paymentProvider: "stripe",
            premiumUntil,
            updatedAt: new Date(),
          },
          { merge: true }
        );

        if (students[phone]) {
          students[phone].plan = "premium";
          students[phone].paymentProvider = "stripe";
          students[phone].premiumUntil = premiumUntil;
        }

        await enviarMensagemWhatsApp(
          phone,
          `🎉 Pagamento confirmado! Seu *Acesso Premium* foi ativado.\n\nComo você quer que eu te chame?`
        );
      }
    }

    return res.json({ received: true });
  } catch (e) {
    console.error("❌ Stripe webhook error:", e?.message || e);
    return res.status(500).send("webhook_error");
  }
});

/** ------------ Webhook Z-API ------------ **/
app.post("/zapi-webhook", async (req, res) => {
  const data = req.body;

  try {
    if (data.type !== "ReceivedCallback") return res.status(200).send("ignored");

    const msgId = data.messageId;
    const numeroAluno = String(data.phone || "").replace(/\D/g, "");
    if (!numeroAluno) return res.status(200).send("no_phone");

    let texto = data.text?.message || "";
    if (!texto && data.message?.text) texto = String(data.message.text);

    if (!texto) return res.status(200).send("no_text");

    await processarMensagemAluno({ numeroAluno, texto, msgId });
    return res.status(200).send("ok");
  } catch (e) {
    console.error("❌ zapi-webhook error:", e?.response?.data || e?.message || e);
    return res.status(500).send("error");
  }
});

/** ------------ Admin minimal: unlock/lock/status ------------ **/
app.get("/admin/unlock", async (req, res) => {
  try {
    const token = req.query.token;
    if (!token || token !== process.env.ADMIN_TOKEN) return res.status(401).send("Não autorizado");

    const phone = String(req.query.phone || "").replace(/\D/g, "");
    const days = Number(req.query.days || 30);
    if (!phone) return res.status(400).send("missing_phone");
    if (!db) return res.status(500).send("firestore_off");

    const now = new Date();
    const premiumUntil = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    await db.collection("students").doc(`whatsapp:${phone}`).set(
      {
        plan: "premium",
        paymentProvider: "manual",
        premiumUntil,
        updatedAt: new Date(),
      },
      { merge: true }
    );

    if (students[phone]) {
      students[phone].plan = "premium";
      students[phone].paymentProvider = "manual";
      students[phone].premiumUntil = premiumUntil;
    }

    await enviarMensagemWhatsApp(
      phone,
      `✅ Seu Premium foi liberado.\nVálido até: ${premiumUntil.toISOString().slice(0, 10)}.\n\nComo você quer que eu te chame?`
    );

    return res.json({ ok: true, phone, premiumUntil });
  } catch (e) {
    console.error("❌ unlock error:", e?.message || e);
    return res.status(500).send("unlock_error");
  }
});

app.get("/admin/lock", async (req, res) => {
  try {
    const token = req.query.token;
    if (!token || token !== process.env.ADMIN_TOKEN) return res.status(401).send("Não autorizado");

    const phone = String(req.query.phone || "").replace(/\D/g, "");
    if (!phone) return res.status(400).send("missing_phone");
    if (!db) return res.status(500).send("firestore_off");

    await db.collection("students").doc(`whatsapp:${phone}`).set(
      { plan: "free", premiumUntil: new Date(0), updatedAt: new Date() },
      { merge: true }
    );

    if (students[phone]) {
      students[phone].plan = "free";
      students[phone].premiumUntil = new Date(0);
    }

    return res.json({ ok: true, phone });
  } catch (e) {
    console.error("❌ lock error:", e?.message || e);
    return res.status(500).send("lock_error");
  }
});

app.get("/admin/status", async (req, res) => {
  try {
    const token = req.query.token;
    if (!token || token !== process.env.ADMIN_TOKEN) return res.status(401).send("Não autorizado");

    const phone = String(req.query.phone || "").replace(/\D/g, "");
    if (!phone) return res.status(400).send("missing_phone");
    if (!db) return res.status(500).send("firestore_off");

    const snap = await db.collection("students").doc(`whatsapp:${phone}`).get();
    if (!snap.exists) return res.json({ ok: true, exists: false });

    const aluno = snap.data() || {};
    const until = safeToDate(aluno.premiumUntil);
    const premiumActive = isPremium({ plan: aluno.plan, premiumUntil: until }, new Date());

    return res.json({
      ok: true,
      exists: true,
      phone,
      plan: aluno.plan,
      premiumUntil: until ? until.toISOString() : null,
      premiumActive,
    });
  } catch (e) {
    console.error("❌ status error:", e?.message || e);
    return res.status(500).send("status_error");
  }
});

/** ------------ Root ------------ **/
app.get("/", (req, res) => res.send("Kito (Jovika Academy) está a correr ✅"));

/** ------------ Start ------------ **/
app.listen(PORT, () => {
  console.log(`🚀 Kito no ar na porta ${PORT}`);
  if (!db) console.log("⚠️ Firestore OFF — verifica firebaseAdmin.js / secrets do Render");
  if (!stripe) console.log("⚠️ Stripe OFF — sem STRIPE_SECRET_KEY (ok se usares Hotmart p/ todos)");
});
