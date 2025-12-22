// server.js – Kito (Jovika Academy)
// Z-API + Firestore (fonte da verdade) + Paywall 30/dia + Oferta por país + Stripe webhook opcional
// + Áudio sob pedido (TTS) + Transcrição + Lembretes consultando Firestore (sem depender de RAM)
// + Corrige "ambos" (prioridade EN/FR) + Logs fortes + Admin reset

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import axios from "axios";
import OpenAI from "openai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { db } from "./firebaseAdmin.js";

dotenv.config();

console.log(
  "🔥 KITO v6.2 – Firestore fonte da verdade + PAYWALL 30/DIA persistente + OFERTA por país + LEMBRETES via Firestore + AMBOS OK + ÁUDIO SAFE 🔥"
);

const app = express();
const PORT = process.env.PORT || 10000;

// ⚠️ Importante: Stripe webhook precisa raw body. Vamos colocar rota raw antes do json global.
const stripeRawParser = bodyParser.raw({ type: "application/json" });

// JSON normal (Z-API)
app.use(bodyParser.json());

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Stripe (opcional)
const stripe =
  process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.trim()
    ? new Stripe(process.env.STRIPE_SECRET_KEY.trim(), { apiVersion: "2024-06-20" })
    : null;

/** =======================
 *  CONFIG
 *  ======================= */

// Paywall
const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 30);
const PAYWALL_COOLDOWN_HOURS = Number(process.env.PAYWALL_COOLDOWN_HOURS || 20);

// Preços
const PT_PRICE_EUR = process.env.PT_PRICE_EUR || "9,99€";
const INT_PRICE_EUR = process.env.INT_PRICE_EUR || PT_PRICE_EUR;

// Link Stripe Payment Link
const STRIPE_PAYMENT_LINK_URL = (process.env.STRIPE_PAYMENT_LINK_URL || "").trim();

// BR PIX (manual)
const BR_PIX_NAME = process.env.BR_PIX_NAME || "";
const BR_PIX_BANK = process.env.BR_PIX_BANK || "";
const BR_PIX_KEY = process.env.BR_PIX_KEY || "";
const BR_PIX_AMOUNT = process.env.BR_PIX_AMOUNT || "R$ 49,90";

// AO (manual)
const AO_BANK_NAME = process.env.AO_BANK_NAME || "";
const AO_IBAN = process.env.AO_IBAN || "";
const AO_AMOUNT = process.env.AO_AMOUNT || "13.000 Kz";

// Áudio / TTS
const ENABLE_TTS = String(process.env.ENABLE_TTS || "true").toLowerCase() !== "false";

// Lembretes
const REMINDER_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5min
const MIN_NUDGE_GAP_MS = 20 * 60 * 60 * 1000; // 20h
const DEFAULT_NUDGE_HOUR = Number(process.env.DEFAULT_NUDGE_HOUR || 19); // 19h

// Admin
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// Memória (cache)
const students = {}; // cache por phone
const processedMessages = new Set();
const lastMomentByPhone = {};
const lastTextByPhone = {};

function strongDbCheck(where = "") {
  if (!db) {
    console.error(`❌❌❌ Firestore NÃO está ativo (${where}). Nada será persistido. Corrige Secret File/ENV.`);
    return false;
  }
  return true;
}

/** =======================
 *  Trilhas (exemplo)
 *  ======================= */

const learningPath = {
  ingles: [
    { id: "en_a0_1", title: "Cumprimentos e apresentações", level: "A0", steps: 4, goal: "Cumprimentos e apresentação." },
    { id: "en_a0_2", title: "Idade, cidade e país", level: "A0", steps: 4, goal: "Falar de idade e origem." },
    { id: "en_a1_1", title: "Rotina diária simples", level: "A1", steps: 4, goal: "Descrever rotina (present simple)." },
  ],
  frances: [
    { id: "fr_a0_1", title: "Cumprimentos básicos", level: "A0", steps: 4, goal: "Cumprimentos em francês." },
    { id: "fr_a0_2", title: "Apresentar-se", level: "A0", steps: 4, goal: "Nome/idade/país em francês." },
    { id: "fr_a1_1", title: "Rotina simples", level: "A1", steps: 4, goal: "Descrever rotina com verbos básicos." },
  ],
};

/** =======================
 *  Helpers gerais
 *  ======================= */

function normalizarTexto(txt = "") {
  return String(txt || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function extrairNome(frase) {
  if (!frase) return null;
  const partes = String(frase).trim().split(/\s+/);
  if (!partes.length) return null;
  return partes[0].replace(/[^\p{L}]/gu, "");
}

function detectarIdioma(frase) {
  const t = normalizarTexto(frase);
  const querIngles = t.includes("ingles") || t.includes("inglês");
  const querFrances = t.includes("frances") || t.includes("francês");
  const querAmbos = t.includes("os dois") || t.includes("ambos") || (querIngles && querFrances);

  if (querAmbos) return "ambos";
  if (querIngles) return "ingles";
  if (querFrances) return "frances";
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeToDate(val) {
  if (!val) return null;
  if (typeof val.toDate === "function") return val.toDate();
  const d = val instanceof Date ? val : new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function formatDate(d) {
  if (!d) return "-";
  try {
    return new Date(d).toLocaleString("pt-PT");
  } catch {
    return String(d);
  }
}

function todayKeyUTC(now = new Date()) {
  return now.toISOString().slice(0, 10); // yyyy-mm-dd
}

function detectarPaisPorTelefone(phone = "") {
  const p = String(phone || "").replace(/\D/g, "");
  if (p.startsWith("351")) return "PT";
  if (p.startsWith("55")) return "BR";
  if (p.startsWith("244")) return "AO";
  return "INT";
}

function gerarStripeLinkParaTelefone(phone) {
  if (!STRIPE_PAYMENT_LINK_URL) return null;
  const ref = `whatsapp:${String(phone || "").replace(/\D/g, "")}`;
  const glue = STRIPE_PAYMENT_LINK_URL.includes("?") ? "&" : "?";
  return `${STRIPE_PAYMENT_LINK_URL}${glue}client_reference_id=${encodeURIComponent(ref)}`;
}

function isConfirmMessage(texto = "") {
  const t = normalizarTexto(texto);
  const palavras = ["sim", "bora", "vamos", "quero", "claro", "ok", "tá bem", "esta bem", "ta bem", "pronto"];
  return palavras.some((p) => t === p || t.includes(p));
}

/** =======================
 *  Perfil pedagógico (simples)
 *  ======================= */

function inferirNivelPercebido(texto) {
  const t = normalizarTexto(texto);
  if (t.includes("nunca") || t.includes("zero") || t.includes("do zero")) return { nivelPercebido: "iniciante", nivelCEFR: "A0" };
  if (t.includes("basico") || t.includes("básico") || t.includes("pouco")) return { nivelPercebido: "básico", nivelCEFR: "A1" };
  if (t.includes("intermediario") || t.includes("intermediário")) return { nivelPercebido: "intermediário", nivelCEFR: "A2/B1" };
  if (t.includes("avancado") || t.includes("avançado") || t.includes("fluente")) return { nivelPercebido: "avançado", nivelCEFR: "B2+" };
  return { nivelPercebido: "iniciante", nivelCEFR: "A0" };
}

function inferirMaiorDificuldade(texto) {
  const t = normalizarTexto(texto);
  if (t.includes("pronuncia") || t.includes("pronúncia") || t.includes("falar")) return "pronúncia / fala";
  if (t.includes("gramatica") || t.includes("gramática")) return "gramática";
  if (t.includes("vocabulario") || t.includes("vocabulário")) return "vocabulário";
  if (t.includes("escuta") || t.includes("ouvir") || t.includes("listening")) return "escuta / compreensão";
  if (t.includes("vergonha") || t.includes("timido") || t.includes("tímido") || t.includes("medo")) return "medo / vergonha";
  return texto;
}

function inferirPreferenciaFormato(texto) {
  const t = normalizarTexto(texto);
  if (t.includes("audio") || t.includes("áudio") || t.includes("voz")) return "audio";
  if (t.includes("escrita") || t.includes("texto") || t.includes("mensagem")) return "texto";
  return "misto";
}

function inferirFrequenciaPreferida(texto) {
  const t = normalizarTexto(texto);
  if (t.includes("todo dia") || t.includes("todos os dias") || t.includes("diario") || t.includes("diário")) return "diario";
  if (t.includes("5x") || t.includes("5 vezes") || t.includes("cinco vezes")) return "5x";
  if (t.includes("3x") || t.includes("3 vezes") || t.includes("tres vezes") || t.includes("três vezes")) return "3x";
  if (t.includes("so quando") || t.includes("só quando") || t.includes("quando eu falar")) return "livre";
  return "3x";
}

/** =======================
 *  Modo conversa/aprender
 *  ======================= */

function detectarComandoModo(texto = "") {
  const t = normalizarTexto(texto);
  const querConversa =
    t.includes("modo conversa") || t === "conversa" || t.includes("quero conversar") || t.includes("só conversar") || t.includes("so conversar");
  const querAprender = t.includes("modo aprender") || t.includes("modo aula") || t === "aprender" || t.includes("quero aprender") || t.includes("me corrija");
  if (querConversa) return "conversa";
  if (querAprender) return "aprender";
  return null;
}

/** =======================
 *  Tipo de mensagem
 *  ======================= */

function detectarTipoMensagem(textoNorm = "") {
  if (!textoNorm) return "geral";

  const isPedidoTraducao =
    textoNorm.includes("como se diz") ||
    textoNorm.includes("traduz") ||
    textoNorm.includes("traduza") ||
    textoNorm.includes("translate") ||
    textoNorm.includes("em ingles") ||
    textoNorm.includes("em inglês") ||
    textoNorm.includes("em frances") ||
    textoNorm.includes("em francês");

  if (isPedidoTraducao) return "pedido_traducao";

  const isPerguntaSobreKito =
    textoNorm.includes("qual e o seu nome") ||
    textoNorm.includes("qual o seu nome") ||
    textoNorm.includes("teu nome") ||
    textoNorm.includes("seu nome") ||
    textoNorm.includes("como te chamas") ||
    textoNorm.includes("quem e voce") ||
    textoNorm.includes("quem é você") ||
    textoNorm.includes("who are you") ||
    textoNorm.includes("what is your name") ||
    textoNorm.includes("voce e humano") ||
    textoNorm.includes("você é humano");

  if (isPerguntaSobreKito) return "pergunta_sobre_kito";

  if (textoNorm.includes("premium") || textoNorm.includes("assinar") || textoNorm.includes("pagar")) return "pedido_premium";

  return "geral";
}

/** =======================
 *  Paywall / Planos
 *  ======================= */

function isPremium(aluno, now = new Date()) {
  const plan = aluno?.plan || "free";
  const until = safeToDate(aluno?.premiumUntil);
  if (until && until.getTime() > now.getTime()) return true;
  return plan === "premium" && !until;
}

function updateDailyCounter(aluno, now = new Date()) {
  const key = todayKeyUTC(now);
  if (!aluno.dailyDate || aluno.dailyDate !== key) {
    aluno.dailyDate = key;
    aluno.dailyCount = 0;
  }
  aluno.dailyCount = (aluno.dailyCount || 0) + 1;
  return aluno.dailyCount;
}

function canSendPaywallPrompt(aluno, now = new Date()) {
  const last = safeToDate(aluno.lastPaywallPromptAt);
  if (!last) return true;
  const diffH = (now.getTime() - last.getTime()) / (1000 * 60 * 60);
  return diffH >= PAYWALL_COOLDOWN_HOURS;
}

function montarMensagemOfertaPremium(phone) {
  const pais = detectarPaisPorTelefone(phone);

  const priceLine =
    pais === "BR"
      ? `por apenas **${BR_PIX_AMOUNT}** / 30 dias`
      : pais === "AO"
      ? `por apenas **${AO_AMOUNT}** / 30 dias`
      : `por apenas **${pais === "PT" ? PT_PRICE_EUR : INT_PRICE_EUR}** / mês`;

  const base = [
    `Você atingiu o limite do **plano grátis (${FREE_DAILY_LIMIT} mensagens hoje)**.`,
    ``,
    `Com o **Acesso Premium**, você desbloqueia ${priceLine}:`,
    `✅ Mensagens **ilimitadas** todos os dias`,
    `✅ Prática de **conversa real**, sem interrupções`,
    `✅ **Áudios** para treinar pronúncia quando quiser`,
    `✅ Correções personalizadas no seu nível`,
    ``,
    `*Sem fidelização. Cancele quando quiser.*`,
    ``,
  ].join("\n");

  if (pais === "PT" || pais === "INT") {
    const link = gerarStripeLinkParaTelefone(phone);
    if (!link) {
      return base + `👉 Para ativar o Premium, fale com o suporte (Stripe ainda não configurado).`;
    }
    return base + `👉 **Ativar Premium agora (Stripe):**\n${link}\n\nAssim que o pagamento confirmar, eu libero automaticamente ✅`;
  }

  if (pais === "BR") {
    // Se não preencheste os ENV no Render, ele não vai mostrar dados.
    if (!BR_PIX_KEY || !BR_PIX_NAME || !BR_PIX_BANK) {
      return base + `👉 Para ativar no Brasil, fale com o suporte (PIX ainda não configurado).`;
    }
    return (
      base +
      `👉 **Ativar Premium por 30 dias (${BR_PIX_AMOUNT})**\n` +
      `**Pix (CPF/Chave):** ${BR_PIX_KEY}\n` +
      `**Nome:** ${BR_PIX_NAME}\n` +
      `**Banco:** ${BR_PIX_BANK}\n\n` +
      `Após o pagamento, envie aqui o **comprovativo** que eu libero seu acesso ✅`
    );
  }

  // AO
  if (!AO_BANK_NAME || !AO_IBAN) {
    return base + `👉 Para ativar em Angola, fale com o suporte (dados bancários ainda não configurados).`;
  }
  return (
    base +
    `👉 **Ativar Premium por 30 dias (${AO_AMOUNT})**\n` +
    `**Nome:** ${AO_BANK_NAME}\n` +
    `**IBAN:** ${AO_IBAN}\n\n` +
    `Após o pagamento, envie aqui o **comprovativo** que eu libero seu acesso ✅`
  );
}

/** =======================
 *  ÁUDIO (pedido + safe)
 *  ======================= */

function userQuerAudio(texto = "", isAudio = false) {
  const t = normalizarTexto(texto || "");
  const gatilhos = ["manda audio", "manda áudio", "envia audio", "mensagem de voz", "fala por audio", "responde em audio", "pronuncia", "pronúncia", "áudio", "audio"];
  const pediuPorTexto = gatilhos.some((p) => t.includes(p));
  const pediuPorAudio = isAudio && (t.includes("pronun") || t.includes("corrig") || gatilhos.some((p) => t.includes(p)));
  return pediuPorTexto || pediuPorAudio;
}

function limparTextoResposta(txt = "") {
  if (!txt) return "";
  let r = String(txt);

  r = r.replace(/\[\s*áudio enviado\s*\]/gi, "");
  r = r.replace(/\[\s*audio enviado\s*\]/gi, "");
  r = r.replace(/áudio enviado/gi, "");
  r = r.replace(/audio enviado/gi, "");

  r = r.replace(/\n{3,}/g, "\n\n").trim();
  return r.trim();
}

function extrairTrechoParaAudio(texto = "", idiomaAlvo = null) {
  const t = String(texto || "").trim();
  if (!t) return "";
  return t.length > 700 ? t.slice(0, 700) : t; // evita TTS enorme
}

async function gerarAudioRespostaKito(texto, idiomaAlvo = null) {
  try {
    if (!ENABLE_TTS) return null;

    const input = String(texto || "").trim();
    if (!input) return null; // ✅ evita erro 400 empty string

    let instructions;
    if (process.env.OPENAI_TTS_INSTRUCTIONS) {
      instructions = process.env.OPENAI_TTS_INSTRUCTIONS;
    } else if (idiomaAlvo === "ingles") {
      instructions =
        "Speak in clear, neutral English with a natural MALE voice. Talk slowly and clearly, ideal for beginners. Do NOT switch to Portuguese or French.";
    } else if (idiomaAlvo === "frances") {
      instructions =
        "Parle en français standard de France, avec une voix masculine naturelle. Parle lentement et très clairement, idéal pour les débutants. Ne parle pas portugais ou anglais.";
    } else {
      instructions =
        "When the text is in Portuguese, speak Brazilian Portuguese with a clear, natural MALE voice. When the text is in French, pronounce it with a standard metropolitan French accent (France), slow and very clear, ideal for language learners.";
    }

    const speech = await openai.audio.speech.create({
      model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
      voice: process.env.OPENAI_TTS_VOICE || "onyx",
      instructions,
      input,
      response_format: "mp3",
    });

    const buffer = Buffer.from(await speech.arrayBuffer());
    const base64 = buffer.toString("base64");
    return `data:audio/mpeg;base64,${base64}`;
  } catch (err) {
    console.error("❌ Erro ao gerar áudio de resposta:", err.response?.data || err.message);
    return null;
  }
}

/** =======================
 *  ÁUDIO: transcrição
 *  ======================= */

async function downloadToTempFile(fileUrl) {
  const cleanUrl = String(fileUrl || "").split("?")[0];
  const ext = cleanUrl.split(".").pop() || "ogg";
  const tmpPath = path.join(os.tmpdir(), `kito-audio-${randomUUID()}.${ext}`);
  const resp = await axios.get(fileUrl, { responseType: "arraybuffer" });
  await fs.promises.writeFile(tmpPath, Buffer.from(resp.data));
  return tmpPath;
}

async function transcreverAudio(audioUrl) {
  try {
    const tempPath = await downloadToTempFile(audioUrl);
    const transcription = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file: fs.createReadStream(tempPath),
    });
    fs.promises.unlink(tempPath).catch(() => {});
    return transcription.text;
  } catch (err) {
    console.error("❌ Erro ao transcrever áudio:", err.response?.data || err.message);
    return null;
  }
}

/** =======================
 *  Z-API envio (texto/áudio)
 *  ======================= */

async function enviarMensagemWhatsApp(phone, message) {
  try {
    const msg = String(message || "").trim();
    if (!msg) {
      console.error("❌ Z-API: tentei enviar message vazia — bloqueado.");
      return;
    }

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

    const resp = await axios.post(url, payload, { headers });
    console.log("📤 Texto enviado via Z-API para", phone, "resp:", resp.data);
  } catch (err) {
    console.error("❌ Erro ao enviar mensagem via Z-API:", err.response?.data || err.message);
  }
}

async function enviarAudioWhatsApp(phone, audioBase64) {
  try {
    const a = String(audioBase64 || "").trim();
    if (!a) return;

    const instanceId = process.env.ZAPI_INSTANCE_ID;
    const instanceToken = process.env.ZAPI_INSTANCE_TOKEN;
    const clientToken = process.env.ZAPI_CLIENT_TOKEN;

    if (!instanceId || !instanceToken) {
      console.error("❌ Z-API: falta ZAPI_INSTANCE_ID ou ZAPI_INSTANCE_TOKEN (áudio)");
      return;
    }

    const url = `https://api.z-api.io/instances/${instanceId}/token/${instanceToken}/send-audio`;
    const payload = { phone, audio: a, viewOnce: false, waveform: true };

    const headers = { "Content-Type": "application/json" };
    if (clientToken) headers["Client-Token"] = clientToken;

    const resp = await axios.post(url, payload, { headers });
    console.log("📤 Áudio enviado via Z-API para", phone, "resp:", resp.data);
  } catch (err) {
    console.error("❌ Erro ao enviar áudio via Z-API:", err.response?.data || err.message);
  }
}

/** =======================
 *  Firestore (fonte da verdade)
 *  ======================= */

function docId(phone) {
  return `whatsapp:${String(phone || "").replace(/\D/g, "")}`;
}

function isAlunoIncompleto(a) {
  if (!a) return true;
  // se não terminou onboarding, OK, mas não pode voltar para ask_name do nada
  // aqui tratamos “incompleto perigoso”:
  if (a.stage === "learning" && (!a.nome || !a.idioma)) return true;
  if (!a.stage) return true;
  return false;
}

async function loadStudentFromFirestore(phone) {
  try {
    if (!strongDbCheck("loadStudentFromFirestore")) return null;
    const ref = db.collection("students").doc(docId(phone));
    const snap = await ref.get();
    if (!snap.exists) return null;
    const data = snap.data();

    return {
      ...data,
      createdAt: safeToDate(data.createdAt) || new Date(),
      lastMessageAt: safeToDate(data.lastMessageAt) || new Date(),
      lastPaywallPromptAt: safeToDate(data.lastPaywallPromptAt),
      premiumUntil: safeToDate(data.premiumUntil),
      lastNudgeAt: safeToDate(data.lastNudgeAt),
      nextLessonAt: safeToDate(data.nextLessonAt),
      lastLessonAt: safeToDate(data.lastLessonAt),
    };
  } catch (err) {
    console.error("❌ Firestore load error:", err.message);
    return { __loadError: true };
  }
}

async function saveStudentToFirestore(phone, aluno) {
  try {
    if (!strongDbCheck("saveStudentToFirestore")) return false;

    const ref = db.collection("students").doc(docId(phone));
    const payload = {
      ...aluno,
      updatedAt: new Date(),
    };

    // não salva history gigante
    delete payload.history;

    await ref.set(payload, { merge: true });
    return true;
  } catch (err) {
    console.error("❌ Firestore save error:", err.message);
    return false;
  }
}

async function persistAndCache(phone, aluno) {
  students[phone] = aluno;
  await saveStudentToFirestore(phone, aluno);
}

/** =======================
 *  Agenda (nextLessonAt)
 *  ======================= */

function weekdayPtToIso1_7(jsGetDay0_6) {
  if (jsGetDay0_6 === 0) return 7;
  return jsGetDay0_6;
}

function getDefaultStudyDays(frequenciaPreferida) {
  if (frequenciaPreferida === "diario") return [1, 2, 3, 4, 5, 6, 7];
  if (frequenciaPreferida === "5x") return [1, 2, 3, 4, 5];
  if (frequenciaPreferida === "3x") return [1, 3, 5];
  return null;
}

function computeNextLessonAt(aluno, now = new Date()) {
  const freq = aluno.frequenciaPreferida || "3x";
  if (freq === "livre") return null;

  const days =
    Array.isArray(aluno.preferredStudyDays) && aluno.preferredStudyDays.length
      ? aluno.preferredStudyDays
      : getDefaultStudyDays(freq);

  if (!days) return null;

  const targetHour = Number.isFinite(aluno.preferredStudyHour) ? aluno.preferredStudyHour : DEFAULT_NUDGE_HOUR;

  // começa a procurar a partir de amanhã (para não “puxar” logo após msg)
  for (let add = 1; add <= 14; add++) {
    const d = new Date(now.getTime() + add * 24 * 60 * 60 * 1000);
    const isoDay = weekdayPtToIso1_7(d.getDay());
    if (days.includes(isoDay)) {
      d.setHours(targetHour, 0, 0, 0);
      return d;
    }
  }
  return null;
}

function gerarMicroVitoria(aluno) {
  const c = aluno.messagesCount || 0;
  if (c >= 30) return "Você já está criando consistência de verdade 👏";
  if (c >= 15) return "Você já evoluiu mais do que imagina 👊";
  if (c >= 7) return "Você já está pegando o ritmo, parabéns!";
  if (c >= 3) return "Boa! Você já começou do jeito certo.";
  return "Começar já foi uma vitória.";
}

function getIdiomaTexto(idioma) {
  if (idioma === "ingles") return "inglês";
  if (idioma === "frances") return "francês";
  if (idioma === "ambos") return "inglês e francês";
  return "o idioma";
}

function montarMensagemNudge(aluno) {
  const nome = aluno.nome || "por aqui";
  const idiomaTexto = getIdiomaTexto(aluno.primaryLanguage || aluno.idioma);
  const micro = gerarMicroVitoria(aluno);
  return `Oi, ${nome}! 😊\n${micro}\n\nQuer praticar ${idiomaTexto} comigo agora? É rapidinho (3 min).`;
}

/** =======================
 *  Resposta OpenAI (Kito)
 *  ======================= */

async function gerarRespostaKito(aluno, moduloAtual, tipoMensagem = "geral") {
  const history = aluno.history || [];
  const ultimoUser = history.filter((m) => m.role === "user").slice(-1)[0];
  const textoDoAluno = ultimoUser ? ultimoUser.content : "(sem mensagem recente)";

  const idiomaAlvo =
    (aluno.primaryLanguage || aluno.idioma) === "frances"
      ? "FRANCÊS"
      : (aluno.primaryLanguage || aluno.idioma) === "ingles"
      ? "INGLÊS"
      : "INGLÊS E FRANCÊS";

  const idiomaChave = aluno.primaryLanguage || aluno.idioma || "ingles";
  const trilha = learningPath[idiomaChave] || learningPath.ingles;
  const moduloIndex = aluno.moduleIndex ?? 0;
  const modulo = moduloAtual || trilha[moduloIndex] || trilha[0];

  const step = aluno.moduleStep ?? 0;
  const totalSteps = modulo?.steps ?? 4;

  const modo = aluno.chatMode || "conversa";

  const systemPrompt = `
Tu és o **Kito**, professor oficial da **Jovika Academy**, uma escola moderna de inglês e francês.

MODO DO ALUNO:
- chatMode: "${modo}"
- Se chatMode = "conversa": responda como humano (natural), sem correção automática. No final, opcional: "Quer que eu corrija?"
- Se chatMode = "aprender": ensine e corrija com explicação curta e exemplos curtos.

IDENTIDADE:
- Nome: Kito

IDIOMA:
- Escreva em português do Brasil, usando "você".
- Quando escrever frases em inglês ou francês: 1ª linha na língua; 2ª linha tradução.

PERFIL:
- Nome: ${aluno.nome || "não informado"}
- Idioma alvo: ${idiomaAlvo}
- Nível: ${aluno.nivel || "A0"}
- Objetivo: ${aluno.objetivo || "não definido"}

MÓDULO:
- Título: ${modulo?.title || "Introdução"}
- Objetivo: ${modulo?.goal || "comunicação básica"}
- Passo: ${step} de ${totalSteps}

TIPO:
- ${tipoMensagem}

REGRAS IMPORTANTES:
- pergunta_sobre_kito: responda direto e humano (não traduza, não dê lição).
- pedido_traducao: traduza e explique curto.
- pedido_premium: responda curto e ofereça Premium.

ESTILO:
- Mensagens curtas estilo WhatsApp.
- Máximo 2 blocos + 1 pergunta.
`.trim();

  const mensagens = [{ role: "system", content: systemPrompt }, ...history.slice(-10)];

  const resposta = await openai.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    input: mensagens,
  });

  const textoGerado = resposta.output?.[0]?.content?.[0]?.text || "";
  return limparTextoResposta(textoGerado);
}

/** =======================
 *  Lógica principal
 *  ======================= */

async function processarMensagemAluno({ numeroAluno, texto, profileName, isAudio }) {
  const agora = new Date();
  const phone = String(numeroAluno || "").replace(/\D/g, "");
  if (!phone) return;

  // 1) Carrega SEMPRE do Firestore (fonte da verdade), e usa cache só como fallback
  let alunoDb = await loadStudentFromFirestore(phone);

  if (alunoDb?.__loadError) {
    // Falha real de banco: não tratar como "novo aluno"
    console.error("❌ Falha ao carregar perfil do aluno no Firestore.");
    await enviarMensagemWhatsApp(phone, "Tive um problema para carregar seu perfil 😅\nMe diga seu nome de novo, por favor.");
    return;
  }

  let alunoCache = students[phone] || null;

  // decide qual usar
  let aluno = alunoDb || alunoCache;

  // Se existe cache mas está “incompleto perigoso”, força DB se houver
  if (alunoDb && alunoCache && isAlunoIncompleto(alunoCache)) {
    aluno = alunoDb;
  }

  // Se não existe em lugar nenhum: cria novo
  if (!aluno) {
    aluno = {
      stage: "ask_name",
      nome: null,
      idioma: null,
      primaryLanguage: null,
      secondaryLanguage: null,

      nivel: "A0",
      nivelPercebido: null,
      maiorDificuldade: null,
      preferenciaFormato: null,
      frequenciaPreferida: null,
      objetivo: null,
      chatMode: null,

      messagesCount: 0,
      moduleIndex: 0,
      moduleStep: 0,

      plan: "free",
      premiumUntil: null,
      paymentProvider: null,

      dailyCount: 0,
      dailyDate: null,
      lastPaywallPromptAt: null,

      lastNudgeAt: null,
      nudgeCount: 0,
      preferredStudyDays: null,
      preferredStudyHour: DEFAULT_NUDGE_HOUR,
      nextLessonAt: null,
      lastLessonAt: null,

      createdAt: agora,
      lastMessageAt: agora,
      updatedAt: agora,

      history: [],
    };

    await persistAndCache(phone, aluno);

    const primeiroNome = extrairNome(profileName) || "Aluno";
    await enviarMensagemWhatsApp(
      phone,
      `Olá, ${primeiroNome}! 😄 Eu sou o Kito, professor de inglês e francês da Jovika Academy.\nComo você quer que eu chame você?`
    );
    return;
  }

  // garante campos mínimos
  aluno.history = aluno.history || [];
  aluno.createdAt = safeToDate(aluno.createdAt) || agora;
  aluno.lastMessageAt = agora;

  // stats
  aluno.messagesCount = (aluno.messagesCount || 0) + 1;

  // contador diário persistente
  const dailyCount = updateDailyCounter(aluno, agora);

  const prefix = isAudio ? "[ÁUDIO] " : "";
  aluno.history.push({ role: "user", content: `${prefix}${texto}` });

  // salva já (ponto 3)
  await persistAndCache(phone, aluno);

  // PAYWALL antes de tudo (mas deixa passar onboarding básico? aqui vale para todos)
  const premium = isPremium(aluno, agora);
  if (!premium && dailyCount > FREE_DAILY_LIMIT) {
    if (canSendPaywallPrompt(aluno, agora)) {
      const offer = montarMensagemOfertaPremium(phone);
      aluno.lastPaywallPromptAt = agora;
      aluno.history.push({ role: "assistant", content: offer });
      await persistAndCache(phone, aluno);
      await enviarMensagemWhatsApp(phone, offer);
    } else {
      await enviarMensagemWhatsApp(
        phone,
        `Você já atingiu o limite do **plano grátis (${FREE_DAILY_LIMIT} mensagens hoje)**.\nVolte amanhã ou ative o Premium para continuar agora.`
      );
    }
    return;
  }

  // atalho premium
  const textoNormQuick = normalizarTexto(texto || "");
  const tipoQuick = detectarTipoMensagem(textoNormQuick);
  if (tipoQuick === "pedido_premium") {
    const offer = montarMensagemOfertaPremium(phone);
    aluno.lastPaywallPromptAt = agora;
    aluno.history.push({ role: "assistant", content: offer });
    await persistAndCache(phone, aluno);
    await enviarMensagemWhatsApp(phone, offer);
    return;
  }

  // troca de modo
  const comandoModo = detectarComandoModo(texto || "");
  if (comandoModo && aluno.stage !== "ask_name" && aluno.stage !== "ask_language") {
    aluno.chatMode = comandoModo;
    const msgModo =
      comandoModo === "conversa"
        ? "Perfeito 😊 A partir de agora a gente conversa para você praticar. Se quiser correção completa, diga: modo aprender."
        : "Combinado 💪 A partir de agora eu vou te ensinar e corrigir enquanto a gente conversa. Se quiser só praticar, diga: modo conversa.";
    aluno.history.push({ role: "assistant", content: msgModo });
    await persistAndCache(phone, aluno);
    await enviarMensagemWhatsApp(phone, msgModo);
    return;
  }

  /** ===== Onboarding ===== */

  if (aluno.stage === "ask_name" && !aluno.nome) {
    aluno.nome = extrairNome(texto) || "Aluno";
    aluno.stage = "ask_language";
    await persistAndCache(phone, aluno);
    await enviarMensagemWhatsApp(phone, `Perfeito, ${aluno.nome}! 😄 Agora me conta: você quer começar por inglês, francês ou os dois?`);
    return;
  }

  if (aluno.stage === "ask_language") {
    const idioma = detectarIdioma(texto);
    if (!idioma) {
      await enviarMensagemWhatsApp(phone, "Acho que não entendi 😅\nResponda só com: inglês, francês ou os dois.");
      return;
    }

    aluno.idioma = idioma;

    if (idioma === "ambos") {
      aluno.stage = "ask_language_priority";
      await persistAndCache(phone, aluno);
      await enviarMensagemWhatsApp(
        phone,
        "Perfeito! ✅ Você quer aprender os dois.\nPara eu organizar melhor: você quer começar por qual primeiro?\n\nResponda só:\n1) inglês\n2) francês"
      );
      return;
    }

    aluno.primaryLanguage = idioma;
    aluno.secondaryLanguage = null;

    aluno.stage = "ask_experience";
    aluno.moduleIndex = 0;
    aluno.moduleStep = 0;
    aluno.nivel = "A0";

    await persistAndCache(phone, aluno);

    const idiomaTexto = idioma === "ingles" ? "inglês" : "francês";
    await enviarMensagemWhatsApp(
      phone,
      `Ótimo, ${aluno.nome}! Vamos trabalhar ${idiomaTexto} juntos 💪✨\nAntes de começar, quero adaptar ao seu perfil.\n\nVocê já estudou ${idiomaTexto} antes?`
    );
    return;
  }

  if (aluno.stage === "ask_language_priority") {
    const t = normalizarTexto(texto);
    const escolheuIngles = t.includes("1") || t.includes("ingl");
    const escolheuFrances = t.includes("2") || t.includes("fran");

    if (!escolheuIngles && !escolheuFrances) {
      await enviarMensagemWhatsApp(phone, "Só para eu acertar 😊\nResponda com:\n1) inglês\n2) francês");
      return;
    }

    aluno.primaryLanguage = escolheuFrances ? "frances" : "ingles";
    aluno.secondaryLanguage = escolheuFrances ? "ingles" : "frances";
    aluno.stage = "ask_experience";
    aluno.moduleIndex = 0;
    aluno.moduleStep = 0;
    aluno.nivel = "A0";

    await persistAndCache(phone, aluno);

    const idiomaTexto = aluno.primaryLanguage === "ingles" ? "inglês" : "francês";
    await enviarMensagemWhatsApp(
      phone,
      `Combinado! ✅ Vamos começar por ${idiomaTexto}.\n\nVocê já estudou ${idiomaTexto} antes?`
    );
    return;
  }

  if (aluno.stage === "ask_experience") {
    const { nivelPercebido, nivelCEFR } = inferirNivelPercebido(texto);
    aluno.nivelPercebido = nivelPercebido;
    aluno.nivel = aluno.nivel || nivelCEFR;
    aluno.stage = "ask_difficulty";
    await persistAndCache(phone, aluno);

    await enviarMensagemWhatsApp(
      phone,
      `Perfeito 😊\nAgora me conta: em ${aluno.primaryLanguage === "frances" ? "francês" : "inglês"}, o que é mais difícil hoje?\n\nPronúncia, gramática, vocabulário, escutar, vergonha...`
    );
    return;
  }

  if (aluno.stage === "ask_difficulty") {
    aluno.maiorDificuldade = inferirMaiorDificuldade(texto);
    aluno.stage = "ask_preference_format";
    await persistAndCache(phone, aluno);
    await enviarMensagemWhatsApp(phone, "Ótimo 😊\nVocê prefere que eu explique mais por áudio, por mensagem escrita ou misturando os dois?");
    return;
  }

  if (aluno.stage === "ask_preference_format") {
    aluno.preferenciaFormato = inferirPreferenciaFormato(texto);
    aluno.stage = "ask_frequency";
    await persistAndCache(phone, aluno);
    await enviarMensagemWhatsApp(
      phone,
      "Show! Para eu organizar seus estudos:\nVocê prefere que eu te puxe todos os dias, 3x por semana, 5x por semana ou só quando você falar comigo?"
    );
    return;
  }

  if (aluno.stage === "ask_frequency") {
    aluno.frequenciaPreferida = inferirFrequenciaPreferida(texto);
    aluno.preferredStudyDays = getDefaultStudyDays(aluno.frequenciaPreferida);
    aluno.preferredStudyHour = DEFAULT_NUDGE_HOUR;
    aluno.stage = "ask_mode";
    await persistAndCache(phone, aluno);

    await enviarMensagemWhatsApp(
      phone,
      "Antes de começarmos: você quer que eu seja mais como parceiro de conversa (praticar) ou professor corrigindo?\n\nResponda:\n1) conversar\n2) aprender\n\nVocê pode mudar quando quiser: modo conversa / modo aprender."
    );
    return;
  }

  if (aluno.stage === "ask_mode") {
    const t = normalizarTexto(texto);
    const escolheuConversa = t.includes("1") || t.includes("convers") || t.includes("pratic");
    const escolheuAprender = t.includes("2") || t.includes("aprender") || t.includes("corrig");

    if (!escolheuConversa && !escolheuAprender) {
      await enviarMensagemWhatsApp(phone, "Só para eu acertar 😊\nResponda:\n1) conversar\n2) aprender");
      return;
    }

    aluno.chatMode = escolheuAprender ? "aprender" : "conversa";
    aluno.stage = "learning";

    // agenda nextLessonAt
    aluno.nextLessonAt = computeNextLessonAt(aluno, agora);

    await persistAndCache(phone, aluno);

    const idiomaTexto = aluno.primaryLanguage === "ingles" ? "inglês" : "francês";
    await enviarMensagemWhatsApp(
      phone,
      aluno.chatMode === "conversa"
        ? `Perfeito 😊 A gente vai conversar para você praticar ${idiomaTexto}.\nSe quiser correção completa, diga: modo aprender.\n\nAgora me conte: qual é o seu principal objetivo com ${idiomaTexto}?`
        : `Combinado 💪 Eu vou te ensinar e corrigir enquanto a gente conversa em ${idiomaTexto}.\nSe quiser só praticar sem correção, diga: modo conversa.\n\nAgora me conte: qual é o seu principal objetivo com ${idiomaTexto}?`
    );
    return;
  }

  /** ===== Learning ===== */

  if (aluno.stage !== "learning") aluno.stage = "learning";

  if (!aluno.objetivo) aluno.objetivo = texto;

  const tipoMensagem = detectarTipoMensagem(normalizarTexto(texto || ""));

  const idiomaChave = aluno.primaryLanguage || aluno.idioma || "ingles";
  const trilha = learningPath[idiomaChave] || learningPath.ingles;

  let moduleIndex = aluno.moduleIndex ?? 0;
  let moduleStep = aluno.moduleStep ?? 0;

  if (moduleIndex >= trilha.length) moduleIndex = trilha.length - 1;
  const moduloAtual = trilha[moduleIndex] || trilha[0];

  const confirmacao = isConfirmMessage(texto);

  const querAudioPorPedido = userQuerAudio(texto, isAudio);
  const chatMode = aluno.chatMode || "conversa";
  const espelharAudio = isAudio && chatMode === "conversa";
  const deveMandarAudio = espelharAudio || querAudioPorPedido;

  const idiomaAudioAlvo = idiomaChave === "ingles" || idiomaChave === "frances" ? idiomaChave : null;

  // gera resposta
  let respostaKito = await gerarRespostaKito(aluno, moduloAtual, tipoMensagem);

  // ✅ nunca enviar vazio
  if (!respostaKito || !respostaKito.trim()) {
    respostaKito = "Entendi. 😊 Pode me dizer isso de outra forma? Assim eu te ajudo melhor.";
  }

  // progress simples
  if (confirmacao) {
    moduleStep += 1;
    const totalSteps = moduloAtual.steps || 4;
    if (moduleStep >= totalSteps) {
      moduleIndex += 1;
      moduleStep = 0;
      if (moduleIndex >= trilha.length) moduleIndex = trilha.length - 1;
    }
  }

  aluno.moduleIndex = moduleIndex;
  aluno.moduleStep = moduleStep;

  aluno.history.push({ role: "assistant", content: respostaKito });

  // agenda próxima aula
  aluno.nextLessonAt = computeNextLessonAt(aluno, agora);

  await persistAndCache(phone, aluno);

  // áudio se necessário (safe)
  if (deveMandarAudio) {
    const trecho = extrairTrechoParaAudio(respostaKito, idiomaAudioAlvo);
    const audioBase64 = await gerarAudioRespostaKito(trecho, idiomaAudioAlvo);
    if (audioBase64) await enviarAudioWhatsApp(phone, audioBase64);
  }

  await sleep(800);
  await enviarMensagemWhatsApp(phone, respostaKito);
}

/** =======================
 *  Lembretes via Firestore (sem RAM)
 *  ======================= */

async function verificarELancarLembretesFirestore() {
  const now = new Date();
  if (!strongDbCheck("verificarELancarLembretesFirestore")) return;

  try {
    // buscamos alunos em learning com frequência ativa
    // (pode precisar de index dependendo do Firestore)
    const snap = await db
      .collection("students")
      .where("stage", "==", "learning")
      .where("frequenciaPreferida", "in", ["diario", "3x", "5x"])
      .limit(300)
      .get();

    for (const doc of snap.docs) {
      const aluno = doc.data();
      const phone = String(doc.id || "").replace("whatsapp:", "");

      const lastMessageAt = safeToDate(aluno.lastMessageAt);
      if (!lastMessageAt) continue;

      // não manda se falou nas últimas 12h
      if (now - lastMessageAt < 12 * 60 * 60 * 1000) continue;

      const nextLessonAt = safeToDate(aluno.nextLessonAt);
      if (!nextLessonAt) continue;

      // só manda se venceu
      if (nextLessonAt.getTime() > now.getTime()) continue;

      // gap mínimo de nudge
      const lastNudgeAt = safeToDate(aluno.lastNudgeAt);
      if (lastNudgeAt && now - lastNudgeAt < MIN_NUDGE_GAP_MS) continue;

      const msg = montarMensagemNudge(aluno);
      await enviarMensagemWhatsApp(phone, msg);

      // atualiza estado
      const updated = {
        lastNudgeAt: now,
        nudgeCount: (aluno.nudgeCount || 0) + 1,
        lastLessonAt: now,
        nextLessonAt: computeNextLessonAt(aluno, now),
        updatedAt: now,
      };

      await db.collection("students").doc(doc.id).set(updated, { merge: true });
    }
  } catch (e) {
    console.error("❌ Lembretes Firestore error:", e.message);
  }
}

setInterval(verificarELancarLembretesFirestore, REMINDER_CHECK_INTERVAL_MS);

/** =======================
 *  Stripe webhook (opcional)
 *  ======================= */

app.post("/stripe/webhook", stripeRawParser, async (req, res) => {
  try {
    if (!stripe) return res.status(400).send("stripe_not_configured");
    const whsec = process.env.STRIPE_WEBHOOK_SECRET;
    if (!whsec) return res.status(400).send("missing_STRIPE_WEBHOOK_SECRET");

    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, whsec);
    } catch (err) {
      console.error("❌ Stripe webhook signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const ref = session.client_reference_id || "";
      const phone = ref.startsWith("whatsapp:") ? ref.replace("whatsapp:", "").replace(/\D/g, "") : null;

      if (phone && strongDbCheck("stripe webhook")) {
        const now = new Date();

        let premiumUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        if (session.subscription) {
          try {
            const sub = await stripe.subscriptions.retrieve(session.subscription);
            if (sub?.current_period_end) premiumUntil = new Date(sub.current_period_end * 1000);
          } catch (e) {
            console.warn("⚠️ Não consegui buscar subscription:", e.message);
          }
        }

        await db.collection("students").doc(docId(phone)).set(
          {
            plan: "premium",
            paymentProvider: "stripe",
            premiumUntil,
            updatedAt: new Date(),
          },
          { merge: true }
        );

        // cache
        if (students[phone]) {
          students[phone].plan = "premium";
          students[phone].paymentProvider = "stripe";
          students[phone].premiumUntil = premiumUntil;
        }

        await enviarMensagemWhatsApp(
          phone,
          "🎉 Pagamento confirmado! Seu **Acesso Premium** foi ativado.\nAgora você pode praticar sem limites ✅\n\nO que você quer praticar agora?"
        );
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error("❌ Erro no Stripe webhook:", err.message);
    res.status(500).send("webhook_error");
  }
});

/** =======================
 *  Admin: ativar premium manual (BR/AO) + reset diário
 *  ======================= */

// /admin/activate?token=XXX&phone=244...&days=30&provider=manual
app.get("/admin/activate", async (req, res) => {
  try {
    if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) return res.status(401).send("Não autorizado");

    const phone = String(req.query.phone || "").replace(/\D/g, "");
    const days = Number(req.query.days || 30);
    const provider = String(req.query.provider || "manual");

    if (!phone) return res.status(400).send("phone_required");
    if (!strongDbCheck("admin/activate")) return res.status(500).send("firestore_off");

    const now = new Date();
    const premiumUntil = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    await db.collection("students").doc(docId(phone)).set(
      {
        plan: "premium",
        paymentProvider: provider,
        premiumUntil,
        updatedAt: new Date(),
      },
      { merge: true }
    );

    if (students[phone]) {
      students[phone].plan = "premium";
      students[phone].paymentProvider = provider;
      students[phone].premiumUntil = premiumUntil;
    }

    await enviarMensagemWhatsApp(
      phone,
      "🎉 Pronto! Seu **Acesso Premium** foi ativado.\nAgora você pode praticar sem limites ✅\n\nO que você quer praticar agora?"
    );

    res.json({ ok: true, phone, premiumUntil, provider });
  } catch (err) {
    console.error("❌ admin/activate error:", err.message);
    res.status(500).send("error");
  }
});

// ✅ Reset para testes: zera dailyCount/dailyDate e (opcional) volta onboarding
// /admin/reset?token=XXX&phone=351...&mode=daily   OR  mode=full
app.get("/admin/reset", async (req, res) => {
  try {
    if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) return res.status(401).send("Não autorizado");
    const phone = String(req.query.phone || "").replace(/\D/g, "");
    const mode = String(req.query.mode || "daily");

    if (!phone) return res.status(400).send("phone_required");
    if (!strongDbCheck("admin/reset")) return res.status(500).send("firestore_off");

    const patch =
      mode === "full"
        ? {
            stage: "ask_name",
            nome: null,
            idioma: null,
            primaryLanguage: null,
            secondaryLanguage: null,
            chatMode: null,
            objetivo: null,
            moduleIndex: 0,
            moduleStep: 0,
            dailyCount: 0,
            dailyDate: null,
            lastPaywallPromptAt: null,
            nextLessonAt: null,
            lastNudgeAt: null,
            updatedAt: new Date(),
          }
        : {
            dailyCount: 0,
            dailyDate: null,
            lastPaywallPromptAt: null,
            updatedAt: new Date(),
          };

    await db.collection("students").doc(docId(phone)).set(patch, { merge: true });

    if (students[phone]) {
      Object.assign(students[phone], patch);
    }

    res.json({ ok: true, phone, mode });
  } catch (e) {
    console.error("❌ admin/reset error:", e.message);
    res.status(500).send("error");
  }
});

/** =======================
 *  Z-API Webhook
 *  ======================= */

app.post("/zapi-webhook", async (req, res) => {
  const data = req.body;
  console.log("📩 Webhook Z-API recebido:", JSON.stringify(data, null, 2));

  try {
    if (data.type !== "ReceivedCallback") return res.status(200).send("ignored_non_received");

    const msgId = data.messageId;
    const numeroAluno = String(data.phone || "").replace(/\D/g, "");
    const momentVal = data.momment;
    const texto = data.text?.message || null;

    let audioUrl =
      data.audioUrl || data.audio?.url || data.media?.url || data.voice?.url || data.audio?.audioUrl || null;

    if (!numeroAluno) return res.status(200).send("no_phone");

    // dedupe
    if (processedMessages.has(msgId)) return res.status(200).send("duplicate_ignored");
    processedMessages.add(msgId);

    if (momentVal && lastMomentByPhone[numeroAluno] === momentVal) return res.status(200).send("duplicate_moment_ignored");
    if (momentVal) lastMomentByPhone[numeroAluno] = momentVal;

    const now = Date.now();
    const ultimo = lastTextByPhone[numeroAluno];
    if (texto && ultimo && ultimo.text === texto && now - ultimo.time < 3000) return res.status(200).send("duplicate_text_recent");
    if (texto) lastTextByPhone[numeroAluno] = { text: texto, time: now };

    const profileName = data.senderName || data.chatName || "Aluno";

    if (!texto && !audioUrl) return res.status(200).send("no_text_or_audio");

    if (audioUrl && !texto) {
      const transcricao = await transcreverAudio(audioUrl);
      if (!transcricao) {
        await enviarMensagemWhatsApp(
          numeroAluno,
          "Tentei ouvir o seu áudio mas não consegui transcrever bem 😅\nVocê pode falar um pouco mais perto do microfone e enviar de novo?"
        );
        return res.status(200).send("audio_transcription_failed");
      }
      await processarMensagemAluno({ numeroAluno, texto: transcricao, profileName, isAudio: true });
      return res.status(200).send("ok_audio");
    }

    await processarMensagemAluno({ numeroAluno, texto, profileName, isAudio: false });
    res.status(200).send("ok");
  } catch (erro) {
    console.error("❌ Erro no webhook Z-API:", erro?.response?.data || erro.message);
    return res.status(500).send("erro");
  }
});

/** =======================
 *  Dashboard simples
 *  ======================= */

app.get("/", (req, res) => {
  res.send("Servidor Kito (Jovika Academy) está a correr ✅");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    firestore: !!db,
    freeDailyLimit: FREE_DAILY_LIMIT,
    stripeEnabled: !!stripe,
    ttsEnabled: ENABLE_TTS,
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Kito no ar em http://localhost:${PORT}`);
  if (!db) console.error("❌ Firestore está OFF. Corrige Render Secret Files / ENV!");
});
