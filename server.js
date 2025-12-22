// server.js – Kito, professor da Jovika Academy
// Z-API + memória + Firestore + módulos + Dashboard
// PAYWALL (FREE 30 msgs/dia) persistente
// OFERTA automática por país (PT/INT=Stripe, BR=Pix, AO=IBAN)
// ✅ ÁUDIO APENAS NO PREMIUM (se FREE pedir áudio -> oferta premium)
// Stripe webhook (opcional) para desbloquear automático

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import axios from "axios";
import OpenAI from "openai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "./firebaseAdmin.js"; // Firestore

import Stripe from "stripe";

dotenv.config();

console.log(
  "🔥 KITO v7.0 – ÁUDIO SÓ PREMIUM + PAYWALL 30/DIA + OFERTA por país + Stripe webhook opcional 🔥"
);

const app = express();
const PORT = process.env.PORT || 10000;

// JSON padrão (Z-API)
app.use(bodyParser.json({ limit: "2mb" }));

/** ---------- Stripe (opcional) ---------- **/
const stripe =
  process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.trim()
    ? new Stripe(process.env.STRIPE_SECRET_KEY.trim(), { apiVersion: "2024-06-20" })
    : null;

// Webhook Stripe precisa de RAW
const stripeRawParser = bodyParser.raw({ type: "application/json" });

/** ---------- Config PAYWALL / Planos ---------- **/
const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 30);
const PAYWALL_COOLDOWN_HOURS = Number(process.env.PAYWALL_COOLDOWN_HOURS || 20);

// Preço mostrado na mensagem (o Stripe já mostra o preço no checkout, mas aqui é o “copy”)
const PRICE_EUR = String(process.env.PRICE_EUR || "9,99€").trim();

// Link base do Stripe Payment Link (vai anexar client_reference_id)
const STRIPE_PAYMENT_LINK_URL = String(
  process.env.STRIPE_PAYMENT_LINK_URL || "https://buy.stripe.com/00w28qchVgVQdfm1eS9ws01"
).trim();

/** ---------- BR Pix (ENV no Render) ---------- **/
const BR_PIX_NAME = String(process.env.BR_PIX_NAME || "Ademandra Francisco").trim();
const BR_PIX_BANK = String(process.env.BR_PIX_BANK || "Nubank").trim();
const BR_PIX_KEY = String(process.env.BR_PIX_KEY || "23848408864").trim();
const BR_PIX_AMOUNT = String(process.env.BR_PIX_AMOUNT || "R$ 49,90").trim();

/** ---------- AO IBAN (ENV no Render) ---------- **/
const AO_BANK_NAME = String(process.env.AO_BANK_NAME || "Joana Bamba").trim();
const AO_IBAN = String(process.env.AO_IBAN || "AO06000500002771833310197").trim();
const AO_AMOUNT = String(process.env.AO_AMOUNT || "13.000 Kz").trim();

/** ---------- “Cache” em memória ---------- **/
const students = {}; // cache em RAM
const processedMessages = new Set();
const lastMomentByPhone = {};
const lastTextByPhone = {};

/** ---------- Trilhas de ensino ---------- **/
const learningPath = {
  ingles: [
    { id: "en_a0_1", title: "Cumprimentos e apresentações", level: "A0", steps: 4, goal: "Aprender a dizer olá e apresentar-se." },
    { id: "en_a0_2", title: "Idade, cidade e país", level: "A0", steps: 4, goal: "Dizer idade e de onde é." },
    { id: "en_a0_3", title: "Rotina diária", level: "A1", steps: 4, goal: "Descrever rotina com presente simples." },
  ],
  frances: [
    { id: "fr_a0_1", title: "Cumprimentos básicos", level: "A0", steps: 4, goal: "Cumprimentar e despedir-se." },
    { id: "fr_a0_2", title: "Apresentar-se", level: "A0", steps: 4, goal: "Nome, idade, país." },
    { id: "fr_a0_3", title: "Rotina simples", level: "A1", steps: 4, goal: "Descrever dia a dia." },
  ],
};

/** ---------- Helpers básicos ---------- **/
function normalizarTexto(txt = "") {
  return String(txt || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
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
  if (querIngles && querFrances) return "ambos";
  if (querIngles) return "ingles";
  if (querFrances) return "frances";
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isConfirmMessage(texto = "") {
  const t = normalizarTexto(texto);
  const palavras = ["sim", "bora", "vamos", "quero", "claro", "ok", "tá bem", "esta bem", "ta bem"];
  return palavras.some((p) => t === p || t.includes(p));
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

function safeToDate(val) {
  if (!val) return null;
  if (typeof val.toDate === "function") return val.toDate();
  const d = val instanceof Date ? val : new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

/** ---------- País por prefixo ---------- **/
function detectarPaisPorTelefone(phone = "") {
  const p = String(phone || "").replace(/\D/g, "");
  if (p.startsWith("351")) return "PT";
  if (p.startsWith("55")) return "BR";
  if (p.startsWith("244")) return "AO";
  return "INT";
}

/** ---------- Stripe link com client_reference_id ---------- **/
function gerarStripeLinkParaTelefone(phone) {
  const ref = `whatsapp:${String(phone || "").replace(/\D/g, "")}`;
  const glue = STRIPE_PAYMENT_LINK_URL.includes("?") ? "&" : "?";
  return `${STRIPE_PAYMENT_LINK_URL}${glue}client_reference_id=${encodeURIComponent(ref)}`;
}

/** ---------- Mensagem Premium (com preço + método por país) ---------- **/
function montarMensagemOfertaPremium(phone) {
  const pais = detectarPaisPorTelefone(phone);

  const base = [
    `Você atingiu o limite do **plano grátis (${FREE_DAILY_LIMIT} mensagens hoje)**.`,
    ``,
    `Com o **Acesso Premium** por apenas **${PRICE_EUR}/mês**, você desbloqueia:`,
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
    return (
      base +
      `👉 **Ativar Premium agora (Stripe):**\n${link}\n\n` +
      `Assim que o pagamento confirmar, eu libero automaticamente ✅`
    );
  }

  if (pais === "BR") {
    return (
      base +
      `👉 **Ativar Premium por 30 dias (${BR_PIX_AMOUNT})**\n` +
      `**Pix (chave):** ${BR_PIX_KEY}\n` +
      `**Nome:** ${BR_PIX_NAME}\n` +
      `**Banco:** ${BR_PIX_BANK}\n\n` +
      `Após o pagamento, envie aqui o **comprovativo** que eu libero seu acesso ✅`
    );
  }

  // AO
  return (
    base +
    `👉 **Ativar Premium por 30 dias (${AO_AMOUNT})**\n` +
    `**Nome:** ${AO_BANK_NAME}\n` +
    `**IBAN:** ${AO_IBAN}\n\n` +
    `Após o pagamento, envie aqui o **comprovativo** que eu libero seu acesso ✅`
  );
}

/** ---------- Plano Premium ---------- **/
function isPremium(aluno, now = new Date()) {
  const plan = aluno?.plan || "free";
  const until = safeToDate(aluno?.premiumUntil);
  if (until && until.getTime() > now.getTime()) return true;
  return plan === "premium" && !until ? true : false;
}

/** ---------- Contador diário persistente ---------- **/
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

/** ---------- Detecta pedidos ---------- **/
function userQuerAudio(texto = "", isAudio = false) {
  const t = normalizarTexto(texto || "");
  const gatilhos = [
    "manda audio",
    "manda áudio",
    "envia audio",
    "envia áudio",
    "responde em audio",
    "responde em áudio",
    "fala por audio",
    "fala por áudio",
    "mensagem de voz",
    "voz",
    "audio",
    "áudio",
    "pronuncia",
    "pronúncia",
  ];
  const pediuPorTexto = gatilhos.some((p) => t.includes(p));
  const pediuPorAudio = isAudio && (t.includes("pronun") || t.includes("corrig"));
  return pediuPorTexto || pediuPorAudio;
}

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
    textoNorm.includes("quem e voce") ||
    textoNorm.includes("quem é você") ||
    textoNorm.includes("who are you") ||
    textoNorm.includes("what is your name");

  if (isPerguntaSobreKito) return "pergunta_sobre_kito";

  // ✅ gatilho de compra
  if (textoNorm.includes("premium") || textoNorm.includes("assinar") || textoNorm.includes("pagar") || textoNorm.includes("quero pagar"))
    return "pedido_premium";

  return "geral";
}

/** ---------- Firebase: salvar/carregar ---------- **/
async function saveStudentToFirestore(phone, aluno) {
  try {
    if (!db) {
      console.error("❌ Firestore OFF — não estou salvando nada. (Configura Render Secret Files/ENV)");
      return;
    }

    const normalize = (val) => safeToDate(val);

    const createdAt = normalize(aluno.createdAt) || new Date();
    const lastMessageAt = normalize(aluno.lastMessageAt) || new Date();

    const premiumUntil = normalize(aluno.premiumUntil);
    const lastPaywallPromptAt = normalize(aluno.lastPaywallPromptAt);

    const docRef = db.collection("students").doc(`whatsapp:${phone}`);
    await docRef.set(
      {
        nome: aluno.nome ?? null,
        idioma: aluno.idioma ?? null,
        nivel: aluno.nivel ?? "A0",
        stage: aluno.stage ?? null,
        chatMode: aluno.chatMode ?? null,
        objetivo: aluno.objetivo ?? null,

        messagesCount: aluno.messagesCount ?? 0,
        moduleIndex: aluno.moduleIndex ?? 0,
        moduleStep: aluno.moduleStep ?? 0,

        // ✅ paywall
        plan: aluno.plan ?? "free",
        premiumUntil: premiumUntil || null,
        paymentProvider: aluno.paymentProvider ?? null,
        dailyCount: aluno.dailyCount ?? 0,
        dailyDate: aluno.dailyDate ?? null,
        lastPaywallPromptAt: lastPaywallPromptAt || null,

        createdAt,
        lastMessageAt,

        updatedAt: new Date(),
      },
      { merge: true }
    );
  } catch (err) {
    console.error("❌ Erro ao salvar aluno no Firestore:", err.message);
  }
}

async function loadStudentFromFirestore(phone) {
  try {
    if (!db) return null;
    const docRef = db.collection("students").doc(`whatsapp:${phone}`);
    const snap = await docRef.get();
    if (!snap.exists) return null;
    const data = snap.data();

    return {
      ...data,
      createdAt: safeToDate(data.createdAt) || new Date(),
      lastMessageAt: safeToDate(data.lastMessageAt) || new Date(),
      premiumUntil: safeToDate(data.premiumUntil),
      lastPaywallPromptAt: safeToDate(data.lastPaywallPromptAt),
    };
  } catch (err) {
    console.error("❌ Erro ao carregar aluno do Firestore:", err.message);
    return null;
  }
}

/** ---------- OpenAI ---------- **/
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function limparTextoResposta(txt = "") {
  let r = String(txt || "").trim();
  r = r.replace(/\n{3,}/g, "\n\n").trim();
  return r;
}

async function gerarRespostaKito(aluno, moduloAtual, tipoMensagem = "geral") {
  const history = aluno.history || [];
  const ultimoUser = history.filter((m) => m.role === "user").slice(-1)[0];
  const textoDoAluno = ultimoUser ? ultimoUser.content : "(sem mensagem recente)";

  const idiomaAlvo =
    aluno.idioma === "frances" ? "FRANCÊS" : aluno.idioma === "ingles" ? "INGLÊS" : "INGLÊS E FRANCÊS";

  const idiomaChave = aluno.idioma === "frances" ? "frances" : "ingles";
  const trilha = learningPath[idiomaChave] || [];
  const moduloIndex = aluno.moduleIndex ?? 0;
  const modulo = moduloAtual || trilha[moduloIndex] || trilha[0];

  const step = aluno.moduleStep ?? 0;
  const totalSteps = modulo?.steps ?? 4;

  const modo = aluno.chatMode || "conversa";

  const systemPrompt = `
Tu és o **Kito**, professor oficial da **Jovika Academy**.
Você conversa de forma humana e natural pelo WhatsApp.

REGRAS IMPORTANTES:
- Escreva sempre em português do Brasil, usando "você".
- Se a mensagem for "pergunta_sobre_kito": responda como humano, direto, sem traduzir.
- Se a mensagem for "pedido_premium": responda curto e diga que você pode enviar o link de pagamento.
- Se o aluno pedir áudio: NÃO prometa áudio no texto. (o servidor controla)
- Mensagens curtas estilo WhatsApp. Máximo 2 blocos + 1 pergunta.

MODO DO ALUNO:
- chatMode: "${modo}"
- Se "conversa": responda como pessoa, sem correção automática.
- Se "aprender": corrija com carinho, com exemplos curtos.

PERFIL:
- Nome do aluno: ${aluno.nome || "não informado"}
- Idioma alvo: ${idiomaAlvo}
- Nível: ${aluno.nivel || "A0"}

MÓDULO:
- Título: ${modulo?.title || "Introdução"}
- Objetivo: ${modulo?.goal || "comunicação básica"}
- Passo: ${step} de ${totalSteps}

TIPO:
- ${tipoMensagem}

ÚLTIMA MENSAGEM DO ALUNO:
- "${textoDoAluno}"
  `.trim();

  const mensagens = [{ role: "system", content: systemPrompt }, ...history.slice(-10)];

  const resposta = await openai.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    input: mensagens,
  });

  const textoGerado = resposta.output?.[0]?.content?.[0]?.text || "";
  const limpo = limparTextoResposta(textoGerado);

  // ✅ nunca devolver string vazia
  return limpo.length > 0 ? limpo : "Entendi. 😊 Me diga: o que você quer praticar agora?";
}

/** ---------- ÁUDIO: transcrição (entrada) ---------- **/
async function downloadToTempFile(fileUrl) {
  const cleanUrl = fileUrl.split("?")[0];
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

/** ---------- ÁUDIO: TTS (SAÍDA) — APENAS PREMIUM ---------- **/
async function gerarAudioRespostaKito(texto) {
  try {
    const clean = String(texto || "").trim();
    if (!clean) return null;

    const enableTts = String(process.env.ENABLE_TTS || "true").toLowerCase() !== "false";
    if (!enableTts) return null;

    const speech = await openai.audio.speech.create({
      model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
      voice: process.env.OPENAI_TTS_VOICE || "onyx",
      instructions: process.env.OPENAI_TTS_INSTRUCTIONS || "Speak clearly, natural male voice.",
      input: clean,
      response_format: "mp3",
    });

    const buffer = Buffer.from(await speech.arrayBuffer());
    const base64 = buffer.toString("base64");
    return `data:audio/mpeg;base64,${base64}`;
  } catch (err) {
    console.error("❌ Erro ao gerar áudio:", err.response?.data || err.message);
    return null;
  }
}

/** ---------- Enviar WhatsApp (texto) ---------- **/
async function enviarMensagemWhatsApp(phone, message) {
  try {
    const instanceId = process.env.ZAPI_INSTANCE_ID;
    const instanceToken = process.env.ZAPI_INSTANCE_TOKEN;
    const clientToken = process.env.ZAPI_CLIENT_TOKEN;

    if (!instanceId || !instanceToken) {
      console.error("❌ Z-API: falta ZAPI_INSTANCE_ID ou ZAPI_INSTANCE_TOKEN");
      return;
    }

    const msg = String(message || "").trim();
    if (!msg) {
      console.error("❌ Z-API: tentei enviar texto vazio (bloqueado)");
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

/** ---------- Enviar WhatsApp (áudio) ---------- **/
async function enviarAudioWhatsApp(phone, audioBase64) {
  try {
    if (!audioBase64) return;

    const instanceId = process.env.ZAPI_INSTANCE_ID;
    const instanceToken = process.env.ZAPI_INSTANCE_TOKEN;
    const clientToken = process.env.ZAPI_CLIENT_TOKEN;

    if (!instanceId || !instanceToken) {
      console.error("❌ Z-API: falta ZAPI_INSTANCE_ID ou ZAPI_INSTANCE_TOKEN (áudio)");
      return;
    }

    const url = `https://api.z-api.io/instances/${instanceId}/token/${instanceToken}/send-audio`;
    const payload = { phone, audio: audioBase64, viewOnce: false, waveform: true };

    const headers = { "Content-Type": "application/json" };
    if (clientToken) headers["Client-Token"] = clientToken;

    await axios.post(url, payload, { headers });
  } catch (err) {
    console.error("❌ Erro ao enviar áudio via Z-API:", err.response?.data || err.message);
  }
}

/** ---------- Fluxo principal ---------- **/
async function getStudent(numeroAluno) {
  // 1) tenta RAM
  let aluno = students[numeroAluno];

  // 2) tenta Firestore como “fonte da verdade”
  const fromDb = await loadStudentFromFirestore(numeroAluno);
  if (fromDb) {
    aluno = {
      ...fromDb,
      history: aluno?.history || [],
      plan: fromDb.plan || "free",
      premiumUntil: fromDb.premiumUntil || null,
      paymentProvider: fromDb.paymentProvider || null,
      dailyCount: fromDb.dailyCount || 0,
      dailyDate: fromDb.dailyDate || null,
      lastPaywallPromptAt: fromDb.lastPaywallPromptAt || null,
    };
    students[numeroAluno] = aluno;
    return aluno;
  }

  // 3) se não existe, cria novo
  if (!aluno) {
    aluno = {
      stage: "ask_name",
      nome: null,
      idioma: null,
      nivel: "A0",
      chatMode: null,
      objetivo: null,
      messagesCount: 0,
      createdAt: new Date(),
      lastMessageAt: new Date(),
      moduleIndex: 0,
      moduleStep: 0,
      plan: "free",
      premiumUntil: null,
      paymentProvider: null,
      dailyCount: 0,
      dailyDate: null,
      lastPaywallPromptAt: null,
      history: [],
    };
    students[numeroAluno] = aluno;
  }

  return aluno;
}

async function processarMensagemAluno({ numeroAluno, texto, profileName, isAudio }) {
  const agora = new Date();
  const aluno = await getStudent(numeroAluno);

  aluno.lastMessageAt = agora;
  aluno.messagesCount = (aluno.messagesCount || 0) + 1;
  aluno.history = aluno.history || [];

  // contador diário (mensagens do aluno)
  const dailyCount = updateDailyCounter(aluno, agora);

  const textoLimpo = String(texto || "").trim();
  if (!textoLimpo) {
    await enviarMensagemWhatsApp(numeroAluno, "Eu não consegui ler sua mensagem 😅 Pode tentar escrever de novo?");
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  aluno.history.push({ role: "user", content: `${isAudio ? "[ÁUDIO] " : ""}${textoLimpo}` });

  const premium = isPremium(aluno, agora);
  const textoNorm = normalizarTexto(textoLimpo);
  const tipo = detectarTipoMensagem(textoNorm);

  // ✅ Se aluno pedir premium -> manda oferta completa imediata
  if (tipo === "pedido_premium") {
    const offer = montarMensagemOfertaPremium(numeroAluno);
    aluno.lastPaywallPromptAt = agora;
    aluno.history.push({ role: "assistant", content: offer });
    await enviarMensagemWhatsApp(numeroAluno, offer);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  // ✅ PAYWALL: se não premium e passou do limite -> oferta e bloqueia
  if (!premium && dailyCount > FREE_DAILY_LIMIT) {
    if (canSendPaywallPrompt(aluno, agora)) {
      const offer = montarMensagemOfertaPremium(numeroAluno);
      aluno.lastPaywallPromptAt = agora;
      aluno.history.push({ role: "assistant", content: offer });
      await enviarMensagemWhatsApp(numeroAluno, offer);
    } else {
      await enviarMensagemWhatsApp(
        numeroAluno,
        `Você já atingiu o limite do **plano grátis (${FREE_DAILY_LIMIT} mensagens hoje)**.\nVolte amanhã ou ative o Premium para continuar agora.`
      );
    }
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  // ✅ Se pedir ÁUDIO e NÃO for premium => NÃO envia áudio, manda oferta premium
  const pediuAudio = userQuerAudio(textoLimpo, isAudio);
  if (pediuAudio && !premium) {
    const offer = montarMensagemOfertaPremium(numeroAluno);
    aluno.lastPaywallPromptAt = agora;
    aluno.history.push({ role: "assistant", content: offer });

    // Mensagem específica sobre áudio
    const msg = [
      `🔒 Áudios são exclusivos do **Acesso Premium**.`,
      ``,
      offer,
    ].join("\n");

    await enviarMensagemWhatsApp(numeroAluno, msg);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  // Onboarding
  if (aluno.stage === "ask_name" && !aluno.nome) {
    const primeiroNome = extrairNome(profileName) || "Aluno";
    await enviarMensagemWhatsApp(
      numeroAluno,
      `Olá, ${primeiroNome}! 😄 Eu sou o Kito, professor de inglês e francês da Jovika Academy.\nComo você quer que eu chame você?`
    );
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  if (aluno.stage === "ask_name" && aluno.nome === null) {
    // fallback (não deve acontecer)
    aluno.nome = extrairNome(textoLimpo) || "Aluno";
    aluno.stage = "ask_language";
    await enviarMensagemWhatsApp(numeroAluno, `Perfeito, ${aluno.nome}! 😄 Você quer começar por inglês, francês ou os dois?`);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  if (aluno.stage === "ask_name" && !aluno.nome) {
    aluno.nome = extrairNome(textoLimpo) || "Aluno";
    aluno.stage = "ask_language";
    await enviarMensagemWhatsApp(numeroAluno, `Perfeito, ${aluno.nome}! 😄 Você quer começar por inglês, francês ou os dois?`);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  if (aluno.stage === "ask_language") {
    const idioma = detectarIdioma(textoLimpo);
    if (!idioma) {
      await enviarMensagemWhatsApp(numeroAluno, "Responda só com: inglês, francês ou os dois. 🙂");
      await saveStudentToFirestore(numeroAluno, aluno);
      return;
    }
    aluno.idioma = idioma;
    aluno.stage = "learning";
    aluno.chatMode = "conversa";
    await enviarMensagemWhatsApp(
      numeroAluno,
      `Ótimo, ${aluno.nome}! 💪\nA partir de agora a gente conversa para você praticar.\n\nMe diga: qual é o seu objetivo? (ex: trabalho, faculdade, viagem)`
    );
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  if (!aluno.objetivo) aluno.objetivo = textoLimpo;

  // Aula normal
  const idiomaChave = aluno.idioma === "frances" ? "frances" : "ingles";
  const trilha = learningPath[idiomaChave] || learningPath.ingles;
  const moduloAtual = trilha[Math.min(aluno.moduleIndex || 0, trilha.length - 1)] || trilha[0];

  const respostaKito = await gerarRespostaKito(aluno, moduloAtual, tipo);
  aluno.history.push({ role: "assistant", content: respostaKito });

  await sleep(300);
  await enviarMensagemWhatsApp(numeroAluno, respostaKito);

  // ✅ ÁUDIO (só premium): se pediu áudio e é premium -> manda TTS da resposta
  if (pediuAudio && premium) {
    const audioBase64 = await gerarAudioRespostaKito(respostaKito);
    if (audioBase64) await enviarAudioWhatsApp(numeroAluno, audioBase64);
  }

  await saveStudentToFirestore(numeroAluno, aluno);
}

/** ---------- STRIPE WEBHOOK (opcional) ---------- **/
app.post("/stripe/webhook", stripeRawParser, async (req, res) => {
  try {
    if (!stripe) return res.status(400).send("stripe_not_configured");
    const whsec = process.env.STRIPE_WEBHOOK_SECRET;
    if (!whsec) return res.status(400).send("missing_STRIPE_WEBHOOK_SECRET");
    if (!db) return res.status(400).send("firestore_off");

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
            console.warn("⚠️ Não consegui buscar subscription:", e.message);
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
          "🎉 Pagamento confirmado! Seu **Acesso Premium** foi ativado ✅\nAgora você tem mensagens ilimitadas e pode pedir áudios.\n\nO que você quer praticar agora?"
        );
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error("❌ Erro no webhook Stripe:", err.message);
    res.status(500).send("webhook_error");
  }
});

/** ---------- Admin: ativar Premium manual (BR/AO) ---------- **/
app.get("/admin/activate", async (req, res) => {
  try {
    if (!db) return res.status(400).send("firestore_off");
    const token = req.query.token;
    if (!token || token !== process.env.ADMIN_TOKEN) return res.status(401).send("Não autorizado");

    const phone = String(req.query.phone || "").replace(/\D/g, "");
    const days = Number(req.query.days || 30);
    const provider = String(req.query.provider || "manual");

    if (!phone) return res.status(400).send("phone_required");

    const now = new Date();
    const premiumUntil = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    await db.collection("students").doc(`whatsapp:${phone}`).set(
      { plan: "premium", paymentProvider: provider, premiumUntil, updatedAt: new Date() },
      { merge: true }
    );

    if (students[phone]) {
      students[phone].plan = "premium";
      students[phone].paymentProvider = provider;
      students[phone].premiumUntil = premiumUntil;
    }

    await enviarMensagemWhatsApp(
      phone,
      "🎉 Pronto! Seu **Acesso Premium** foi ativado ✅\nAgora você pode praticar sem limites e pedir áudios.\n\nO que você quer praticar agora?"
    );

    res.json({ ok: true, phone, premiumUntil, provider });
  } catch (err) {
    console.error("❌ admin/activate error:", err.message);
    res.status(500).send("error");
  }
});

/** ---------- Webhook Z-API ---------- **/
app.post("/zapi-webhook", async (req, res) => {
  const data = req.body;
  try {
    if (data.type !== "ReceivedCallback") return res.status(200).send("ignored");

    const msgId = data.messageId;
    const numeroAluno = String(data.phone || "").replace(/\D/g, "");
    const momentVal = data.momment;
    const texto = data.text?.message || null;

    let audioUrl =
      data.audioUrl ||
      data.audio?.url ||
      data.media?.url ||
      data.voice?.url ||
      data.audio?.audioUrl ||
      null;

    if (!numeroAluno) return res.status(200).send("no_phone");

    if (processedMessages.has(msgId)) return res.status(200).send("duplicate_ignored");
    processedMessages.add(msgId);

    if (momentVal && lastMomentByPhone[numeroAluno] === momentVal) return res.status(200).send("duplicate_moment_ignored");
    if (momentVal) lastMomentByPhone[numeroAluno] = momentVal;

    const nowTs = Date.now();
    const ultimo = lastTextByPhone[numeroAluno];
    if (texto && ultimo && ultimo.text === texto && nowTs - ultimo.time < 3000) return res.status(200).send("duplicate_text_recent");
    if (texto) lastTextByPhone[numeroAluno] = { text: texto, time: nowTs };

    const profileName = data.senderName || data.chatName || "Aluno";

    if (!texto && !audioUrl) return res.status(200).send("no_text_or_audio");

    if (audioUrl && !texto) {
      const transcricao = await transcreverAudio(audioUrl);
      if (!transcricao) {
        await enviarMensagemWhatsApp(
          numeroAluno,
          "Tentei ouvir o seu áudio mas não consegui transcrever bem 😅\nVocê pode tentar de novo falando mais perto do microfone?"
        );
        return res.status(200).send("audio_transcription_failed");
      }

      await processarMensagemAluno({ numeroAluno, texto: transcricao, profileName, isAudio: true });
      return res.status(200).send("ok_audio");
    }

    await processarMensagemAluno({ numeroAluno, texto, profileName, isAudio: false });
    res.status(200).send("ok");
  } catch (err) {
    console.error("❌ Erro webhook Z-API:", err.response?.data || err.message);
    res.status(500).send("erro");
  }
});

/** ---------- Dashboard (simples) ---------- **/
app.get("/", (req, res) => {
  res.send("Kito (Jovika Academy) está a correr ✅");
});

app.get("/admin/stats", (req, res) => {
  const token = req.query.token;
  if (!token || token !== process.env.ADMIN_TOKEN) return res.status(401).send("Não autorizado");

  const alunos = Object.entries(students).map(([numero, dados]) => ({
    numero,
    nome: dados.nome || "-",
    idioma: dados.idioma || "-",
    plan: dados.plan || "free",
    premiumUntil: dados.premiumUntil || null,
    dailyCount: dados.dailyCount || 0,
    dailyDate: dados.dailyDate || null,
    lastMessageAt: dados.lastMessageAt || null,
  }));

  res.json({ freeDailyLimit: FREE_DAILY_LIMIT, priceEur: PRICE_EUR, alunos });
});

/** ---------- Start ---------- **/
app.listen(PORT, () => {
  console.log(`🚀 Kito no ar em http://localhost:${PORT}`);
  if (!db) console.error("❌ Firestore está OFF. Corrige Render Secret Files / ENV!");
});
