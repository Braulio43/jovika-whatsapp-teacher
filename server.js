// server.js — Kito (Jovika Academy) — versão enxuta e “professor de verdade”
// Objetivo desta versão:
// ✅ Corrigir o bug do “ok = respondeu bem” (NUNCA elogiar/avançar com “ok/sim/certo”)
// ✅ Reduzir drasticamente o código (mantém só o essencial)
// ✅ Proteger partes críticas: Paywall Premium, Firestore, Stripe webhook, Hotmart/Stripe link por país
// ✅ Aula guiada (A0) com estado “awaitingRepeat” (só avança quando o aluno envia a frase)
// ✅ Áudio (TTS) só Premium e só quando o aluno pedir com a frase explícita

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

/** ------------ Util ------------ **/
function nowDate() {
  return new Date();
}

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
  // ACK curto que NÃO pode significar “respondeu bem”
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
    "👍",
    "✅",
    "👌",
    "hmm",
    "hm",
    "aham",
  ]);
  if (!t) return true;
  if (t.length <= 3 && acks.has(t)) return true;
  if (acks.has(t)) return true;
  // “ok” dentro de frase maior não é ack-only; só ack-only quando é basicamente isso.
  if (t.replace(/[^a-z0-9]/g, "") === "ok") return true;
  return false;
}

function canSendAgain(lastAt, cooldownHours, now = new Date()) {
  const last = safeToDate(lastAt);
  if (!last) return true;
  const diffH = (now.getTime() - last.getTime()) / (1000 * 60 * 60);
  return diffH >= cooldownHours;
}

/** ------------ Professor: trilha de A0 (enxuta) ------------ **/
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
  let partIdx = Number(aluno.partIndex || 0) + 1;
  if (partIdx >= lesson.parts.length) {
    // terminou a lição -> próxima lição (se existir) e reinicia partes
    aluno.lessonIndex = Number(aluno.lessonIndex || 0) + 1;
    aluno.partIndex = 0;
  } else {
    aluno.partIndex = partIdx;
  }
}

function similarityScore(expected, user) {
  // score simples por overlap de tokens (bom o suficiente p/ A0)
  const e = normalizarTexto(expected).split(/\s+/).filter(Boolean);
  const u = normalizarTexto(user).split(/\s+/).filter(Boolean);

  if (u.length === 0) return 0;

  const setE = new Set(e);
  let hit = 0;
  for (const tok of u) if (setE.has(tok)) hit++;

  // bônus se a frase do aluno contém o começo do esperado
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
      createdAt: safeToDate(d.createdAt) || nowDate(),
      lastMessageAt: safeToDate(d.lastMessageAt) || nowDate(),
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

    // ✅ anti-downgrade: se Firestore já tem premium ativo, não deixar RAM “free” sobrescrever
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

        // trilha
        lessonIndex: aluno.lessonIndex ?? 0,
        partIndex: aluno.partIndex ?? 0,
        awaitingRepeat: aluno.awaitingRepeat ?? null,

        // premium
        plan: aluno.plan ?? "free",
        paymentProvider: aluno.paymentProvider ?? null,
        premiumUntil: safeToDate(aluno.premiumUntil) || null,

        // anti-spam
        lastSalesMessageAt: safeToDate(aluno.lastSalesMessageAt) || null,
        lastPremiumExpiredNoticeAt: safeToDate(aluno.lastPremiumExpiredNoticeAt) || null,

        createdAt: safeToDate(aluno.createdAt) || nowDate(),
        lastMessageAt: safeToDate(aluno.lastMessageAt) || nowDate(),
        updatedAt: nowDate(),
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
    // reconcilia premium
    if (isPremiumActiveFromData(fromDb, now)) {
      mem.plan = "premium";
      mem.paymentProvider = fromDb.paymentProvider || mem.paymentProvider || "manual";
      mem.premiumUntil = safeToDate(fromDb.premiumUntil) || mem.premiumUntil || null;
    } else {
      // só rebaixa se memória também não está premium ativo
      if (!isPremium(mem, now)) {
        mem.plan = fromDb.plan || mem.plan || "free";
        mem.paymentProvider = fromDb.paymentProvider ?? mem.paymentProvider ?? null;
        mem.premiumUntil = safeToDate(fromDb.premiumUntil) ?? mem.premiumUntil ?? null;
      }
    }

    // completa campos “safe”
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

/** ------------ Áudio (Premium, Z-API send-audio) ------------ **/
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
    if (!audioBase64) return;

    const instanceId = process.env.ZAPI_INSTANCE_ID;
    const instanceToken = process.env.ZAPI_INSTANCE_TOKEN;
    const clientToken = process.env.ZAPI_CLIENT_TOKEN;

    if (!instanceId || !instanceToken) {
      console.error("❌ Z-API: falta ZAPI_INSTANCE_ID ou ZAPI_INSTANCE_TOKEN");
      return;
    }

    const url = `https://api.z-api.io/instances/${instanceId}/token/${instanceToken}/send-audio`;

    // base64 puro
    const pure = String(audioBase64).trim().replace(/^data:audio\/\w+;base64,/, "").replace(/\s+/g, "");
    if (!pure) return;

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
        await axios.post(url, attempts[i], { headers });
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    console.error("❌ send-audio falhou:", lastErr?.response?.data || lastErr?.message);
  } catch (e) {
    console.error("❌ enviarAudioWhatsApp error:", e?.response?.data || e?.message || e);
  }
}

/** ------------ Chat “humano” (opcional, professor) ------------ **/
async function gerarRespostaProfessor(aluno, userText) {
  const idioma = aluno.idioma === "frances" ? "francês" : "inglês";

  const system = `
Tu és o Kito, professor da Jovika Academy no WhatsApp.

REGRAS CRÍTICAS:
- Nunca responda apenas "ok".
- Nunca elogie como "mandou bem" se o aluno escreveu só: ok/sim/certo/entendi.
- Se a mensagem for um ACK curto, peça educadamente a frase/áudio que você precisa.
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

/** ------------ Aula guiada (núcleo do fix) ------------ **/
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
    `Pode ser por texto ou por áudio.`,
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
    // aviso de expiração 1x/24h (se aplicável)
    if (premiumExpired && canSendAgain(aluno.lastPremiumExpiredNoticeAt, PREMIUM_EXPIRED_NOTICE_COOLDOWN_HOURS, agora)) {
      aluno.lastPremiumExpiredNoticeAt = agora;
      const msg = montarMensagemPremiumExpirou(phone);
      await enviarMensagemWhatsApp(phone, msg);
      await saveStudentToFirestore(phone, aluno);
      return;
    }

    // 1ª mensagem de venda
    if (!aluno.lastSalesMessageAt) {
      aluno.lastSalesMessageAt = agora;
      const msg = montarMensagemHardPaywall(phone);
      await enviarMensagemWhatsApp(phone, msg);
      await saveStudentToFirestore(phone, aluno);
      return;
    }

    // repete venda só com intenção explícita e cooldown
    if (isSalesIntent(textRaw) && canSendAgain(aluno.lastSalesMessageAt, SALES_MESSAGE_COOLDOWN_HOURS, agora)) {
      aluno.lastSalesMessageAt = agora;
      const msg = montarMensagemHardPaywall(phone);
      await enviarMensagemWhatsApp(phone, msg);
      await saveStudentToFirestore(phone, aluno);
      return;
    }

    // sem spam
    await saveStudentToFirestore(phone, aluno);
    return;
  }

  /** --- Premium: daqui pra baixo --- **/

  // 1) Onboarding
  if (aluno.stage === "ask_name" && !aluno.nome) {
    // Se o aluno mandar só “ok”, não aceita como nome
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

  /** --- 2) Pedido de áudio (Premium) --- **/
  const audioReq = parseAudioRequest(textRaw);
  if (audioReq.asked) {
    if (AUDIO_REQUIRE_EXPLICIT_TEXT && !audioReq.requestedText) {
      await enviarMensagemWhatsApp(phone, "Claro ✅\nMe diga a *palavra ou frase*.\nExemplo: *áudio: bonjour*");
      await saveStudentToFirestore(phone, aluno);
      return;
    }

    const idiomaAudio = getLangKey(aluno) === "frances" ? "frances" : "ingles";
    const b64 = await gerarAudioRespostaKito(audioReq.requestedText, idiomaAudio);
    await enviarAudioWhatsApp(phone, b64);

    // resposta texto de professor (sem dizer “enviei” com certeza absoluta)
    await enviarMensagemWhatsApp(phone, "Perfeito ✅ Aqui vai a pronúncia. Quer que eu corrija sua repetição também?");
    await saveStudentToFirestore(phone, aluno);
    return;
  }

  /** --- 3) Aula guiada com awaitingRepeat (FIX DO OK) --- **/
  if (aluno.stage === "learning") {
    // Se estamos aguardando repetição, “ok” NÃO pode avançar
    if (aluno.awaitingRepeat?.expected) {
      if (isAckOnly(textRaw)) {
        const expected = aluno.awaitingRepeat.expected;
        await enviarMensagemWhatsApp(
          phone,
          `Beleza 😊 Agora manda a frase *de verdade* para eu corrigir.\n\nEscreve ou manda áudio repetindo:\n“${expected}”`
        );
        await saveStudentToFirestore(phone, aluno);
        return;
      }

      const expected = aluno.awaitingRepeat.expected;
      const score = similarityScore(expected, textRaw);

      if (score < 0.35) {
        // não bateu o suficiente -> tenta de novo
        await enviarMensagemWhatsApp(
          phone,
          `Quase 😊 Tenta mais uma vez *igualzinho*:\n“${expected}”\n\nSe preferir, manda em áudio.`
        );
        await saveStudentToFirestore(phone, aluno);
        return;
      }

      // ✅ sucesso -> elogia de forma pedagógica e avança
      clearAwaitingRepeat(aluno);
      advancePart(aluno);

      // Se acabou as partes da lição, recomeça com próxima (se existir)
      const lesson = getCurrentLesson(aluno);
      const part = getCurrentPart(aluno);

      // Se avançou para uma lição que não existe (fim), mantém última
      const lang = getLangKey(aluno);
      const list = LESSONS[lang] || LESSONS.ingles;
      const maxLessonIndex = list.length - 1;
      if (Number(aluno.lessonIndex || 0) > maxLessonIndex) aluno.lessonIndex = maxLessonIndex;

      // prepara próxima repetição
      const msg = [
        `Mandou bem ✅ (boa consistência)`,
        ``,
        `Agora a próxima parte:`,
        `“${part.text}”`,
        `(${part.hint})`,
        ``,
        `Repete por texto ou áudio.`,
      ].join("\n");

      setAwaitingRepeat(aluno);
      await enviarMensagemWhatsApp(phone, msg);
      await saveStudentToFirestore(phone, aluno);
      return;
    }

    // Se por algum motivo não estava awaitingRepeat, inicia prompt
    const msg = montarPromptRepeticao(aluno);
    setAwaitingRepeat(aluno);
    await enviarMensagemWhatsApp(phone, msg);
    await saveStudentToFirestore(phone, aluno);
    return;
  }

  /** --- 4) Fallback: professor humano via OpenAI (sem “ok”) --- **/
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

    // texto
    let texto = data.text?.message || "";

    // se não tem texto, tenta pegar algum campo “fallback” simples
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
