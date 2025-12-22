// server.js – Kito, professor da Jovika Academy
// Z-API + memória + módulos + Dashboard + Firestore + ÁUDIO SOB PEDIDO + PERFIL PEDAGÓGICO
// + LEMBRETES PERSONALIZADOS POR FREQUÊNCIA + MODO CONVERSA/APRENDER + ESPELHAR ÁUDIO EM MODO CONVERSA
// + PAYWALL (FREE 30 msgs/dia) + OFERTA AUTOMÁTICA COM PAGAMENTO POR PAÍS + STRIPE WEBHOOK (opcional)

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

console.log(
  "🔥🔥🔥 KITO v5.5 – PAYWALL 30/DIA + OFERTA AUTOMÁTICA + PAGAMENTO POR PAÍS + ÁUDIO NO FREE + LEMBRETES 🔥🔥🔥"
);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * ✅ IMPORTANTE (Stripe Webhook):
 * O Stripe precisa do RAW body para validar a assinatura.
 * Se você usar JSON parser antes, o req.body vira objeto e a assinatura falha.
 *
 * Solução: middleware condicional:
 * - /stripe/webhook => raw({ type: "application/json" })
 * - resto => json()
 */
const stripeRawParser = bodyParser.raw({ type: "application/json" });
const jsonParser = bodyParser.json();

app.use((req, res, next) => {
  if (req.originalUrl === "/stripe/webhook") return stripeRawParser(req, res, next);
  return jsonParser(req, res, next);
});

// Stripe (opcional)
const stripe =
  process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.trim()
    ? new Stripe(process.env.STRIPE_SECRET_KEY.trim(), { apiVersion: "2024-06-20" })
    : null;

// "Base de dados" simples em memória (cache)
const students = {};
const processedMessages = new Set();
const lastMomentByPhone = {};
const lastTextByPhone = {};

/** ---------- CONFIG PAYWALL / PLANOS ---------- **/

// ✅ FREE: 30 mensagens por dia
const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 30);

// ✅ Anti-spam de oferta: no máximo 1 oferta por dia por aluno
const PAYWALL_COOLDOWN_HOURS = Number(process.env.PAYWALL_COOLDOWN_HOURS || 20);

// ✅ Link Stripe base (payment link) – vamos anexar client_reference_id com o telefone
const STRIPE_PAYMENT_LINK_URL = (process.env.STRIPE_PAYMENT_LINK_URL ||
  "https://buy.stripe.com/00w28qchVgVQdfm1eS9ws01").trim();

// ✅ Brasil (PIX manual)
const BR_PIX_NAME = "Ademandra Francisco";
const BR_PIX_BANK = "Nubank";
const BR_PIX_KEY = "23848408864"; // CPF (pix)
const BR_PIX_AMOUNT = process.env.BR_PIX_AMOUNT || "R$ 49,90";

// ✅ Angola (transferência manual)
const AO_BANK_NAME = "Joana Bamba";
const AO_IBAN = "AO06000500002771833310197";
const AO_AMOUNT = process.env.AO_AMOUNT || "13.000 Kz";

/** ---------- Trilhas de ensino (módulos estruturados) ---------- **/

const learningPath = {
  ingles: [
    {
      id: "en_a0_1",
      title: "Cumprimentos e apresentações",
      level: "A0",
      steps: 4,
      goal: "Aprender a dizer olá, despedir-se e apresentar-se de forma simples.",
    },
    {
      id: "en_a0_2",
      title: "Falar sobre idade, cidade e país",
      level: "A0",
      steps: 4,
      goal: "Conseguir dizer a idade, de onde é e onde vive.",
    },
    {
      id: "en_a0_3",
      title: "Rotina diária simples",
      level: "A1",
      steps: 4,
      goal: "Descrever a rotina do dia a dia com frases básicas no presente simples.",
    },
  ],
  frances: [
    {
      id: "fr_a0_1",
      title: "Cumprimentos básicos em francês",
      level: "A0",
      steps: 4,
      goal: "Cumprimentar, despedir-se e dizer como está em francês.",
    },
    {
      id: "fr_a0_2",
      title: "Apresentar-se em francês",
      level: "A0",
      steps: 4,
      goal: "Dizer o nome, idade e país em francês.",
    },
    {
      id: "fr_a0_3",
      title: "Rotina simples em francês",
      level: "A1",
      steps: 4,
      goal: "Descrever o dia a dia com verbos básicos em francês.",
    },
  ],
};

/** ---------- Helpers ---------- **/

function normalizarTexto(txt = "") {
  return txt.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function extrairNome(frase) {
  if (!frase) return null;
  const partes = frase.trim().split(/\s+/);
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

// ✅ Data do dia (UTC) para reset simples do contador diário
function todayKeyUTC(now = new Date()) {
  return now.toISOString().slice(0, 10); // yyyy-mm-dd
}

function safeToDate(val) {
  if (!val) return null;
  if (typeof val.toDate === "function") return val.toDate();
  const d = val instanceof Date ? val : new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

// ✅ Detecta país pelo prefixo (Z-API geralmente manda só dígitos, sem "+")
function detectarPaisPorTelefone(phone = "") {
  const p = String(phone || "").replace(/\D/g, "");
  if (p.startsWith("351")) return "PT";
  if (p.startsWith("55")) return "BR";
  if (p.startsWith("244")) return "AO";
  return "INT";
}

// ✅ Gera link Stripe com client_reference_id = whatsapp:PHONE (para webhook conseguir mapear)
function gerarStripeLinkParaTelefone(phone) {
  const ref = `whatsapp:${String(phone || "").replace(/\D/g, "")}`;
  const glue = STRIPE_PAYMENT_LINK_URL.includes("?") ? "&" : "?";
  return `${STRIPE_PAYMENT_LINK_URL}${glue}client_reference_id=${encodeURIComponent(ref)}`;
}

// ✅ Mensagem Premium (benefícios + pagamento por país)
function montarMensagemOfertaPremium(phone) {
  const pais = detectarPaisPorTelefone(phone);

  const base = [
    `Você atingiu o limite do **plano grátis (${FREE_DAILY_LIMIT} mensagens hoje)**.`,
    ``,
    `Com o **Acesso Premium**, você desbloqueia:`,
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
      `**Pix (CPF):** ${BR_PIX_KEY}\n` +
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

// ✅ Decide se o aluno está Premium
function isPremium(aluno, now = new Date()) {
  const plan = aluno?.plan || "free";
  const until = safeToDate(aluno?.premiumUntil);
  if (until && until.getTime() > now.getTime()) return true;
  return plan === "premium" && !until ? true : false;
}

// ✅ Reset/incremento do contador diário
function updateDailyCounter(aluno, now = new Date()) {
  const key = todayKeyUTC(now);
  if (!aluno.dailyDate || aluno.dailyDate !== key) {
    aluno.dailyDate = key;
    aluno.dailyCount = 0;
  }
  aluno.dailyCount = (aluno.dailyCount || 0) + 1;
  return aluno.dailyCount;
}

// ✅ Anti-spam: pode mandar oferta agora?
function canSendPaywallPrompt(aluno, now = new Date()) {
  const last = safeToDate(aluno.lastPaywallPromptAt);
  if (!last) return true;
  const diffH = (now.getTime() - last.getTime()) / (1000 * 60 * 60);
  return diffH >= PAYWALL_COOLDOWN_HOURS;
}

/** ---------- 🔊 Detecta se o aluno está a pedir ÁUDIO (pedido explícito) ---------- **/

function userQuerAudio(texto = "", isAudio = false) {
  const t = normalizarTexto(texto || "");
  const gatilhos = [
    "manda audio",
    "manda áudio",
    "manda um audio",
    "manda um áudio",
    "envia audio",
    "envia um audio",
    "envia um áudio",
    "envia audio por favor",
    "mensagem de voz",
    "msg de voz",
    "manda voz",
    "fala por audio",
    "fala por áudio",
    "responde em audio",
    "responde em áudio",
    "fala em audio",
    "fala em áudio",
    "so em audio",
    "só em audio",
    "so em áudio",
    "só em áudio",
    "le em voz alta",
    "lê em voz alta",
    "read it aloud",
    "say it",
    "fala devagar em ingles",
    "fala devagar em inglês",
    "fala devagar em frances",
    "fala devagar em francês",
    "pronuncia",
    "pronúncia",
    "áudio",
    "audio",
  ];

  const pediuPorTexto = gatilhos.some((p) => t.includes(p));
  const pediuPorAudio =
    isAudio &&
    (t.includes("pronun") || t.includes("pronún") || t.includes("corrig") || gatilhos.some((p) => t.includes(p)));

  return pediuPorTexto || pediuPorAudio;
}

// 🧠 Detecta comando para trocar modo (conversa/aprender)
function detectarComandoModo(texto = "") {
  const t = normalizarTexto(texto);

  const querConversa =
    t.includes("modo conversa") ||
    t.includes("modo convers") ||
    t === "conversa" ||
    t.includes("só conversar") ||
    t.includes("so conversar") ||
    t.includes("vamos conversar") ||
    t.includes("apenas conversar") ||
    t.includes("quero conversar") ||
    t.includes("praticar conversacao") ||
    t.includes("praticar conversação") ||
    t.includes("praticar falando");

  const querAprender =
    t.includes("modo aprender") ||
    t.includes("modo aula") ||
    t.includes("modo professor") ||
    t === "aprender" ||
    t.includes("quero aprender") ||
    t.includes("quero estudar") ||
    t.includes("vamos estudar") ||
    t.includes("me corrige") ||
    t.includes("me corrija") ||
    t.includes("corrige tudo") ||
    t.includes("corrigir tudo");

  if (querConversa) return "conversa";
  if (querAprender) return "aprender";
  return null;
}

function limparTextoResposta(txt = "") {
  if (!txt) return "";
  let r = txt;

  r = r.replace(/\[\s*áudio enviado\s*\]/gi, "");
  r = r.replace(/\[\s*audio enviado\s*\]/gi, "");
  r = r.replace(/áudio enviado/gi, "");
  r = r.replace(/audio enviado/gi, "");

  r = r.replace(/\(\s*áudio\s*\)/gi, "");
  r = r.replace(/\(\s*audio\s*\)/gi, "");

  r = r.replace(/.*vou .*áudio.*(\r?\n)?/gi, "");
  r = r.replace(/.*vou .*audio.*(\r?\n)?/gi, "");
  r = r.replace(/.*mandar .*áudio.*(\r?\n)?/gi, "");
  r = r.replace(/.*mandar .*audio.*(\r?\n)?/gi, "");
  r = r.replace(/.*enviar .*áudio.*(\r?\n)?/gi, "");
  r = r.replace(/.*enviar .*audio.*(\r?\n)?/gi, "");

  r = r.replace(/\n{3,}/g, "\n\n").trim();
  return r;
}

function extrairTrechoParaAudio(texto = "", idiomaAlvo = null) {
  const linhas = texto
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (!idiomaAlvo) return texto;

  if (idiomaAlvo === "frances") {
    const frAccents = /[àâçéèêëîïôùûüÿœ]/i;
    const frKeywords = [
      "je ",
      "j'",
      "tu ",
      "il ",
      "elle ",
      "nous ",
      "vous ",
      "ils ",
      "elles ",
      "bonjour",
      "bonsoir",
      "merci",
      "comment ça va",
      "comment ca va",
      "ça va",
      "ca va",
    ];
    const frLines = linhas.filter((l) => {
      const t = l.toLowerCase();
      return frAccents.test(l) || frKeywords.some((k) => t.startsWith(k));
    });
    if (frLines.length > 0) return frLines.join("\n");
  }

  if (idiomaAlvo === "ingles") {
    const hasLatin = /[a-z]/i;
    const ptAccents = /[áãâàéêíóôõúç]/i;
    const enKeywords = [
      "i ",
      "i'm",
      "i am",
      "you ",
      "you are",
      "he ",
      "he is",
      "she ",
      "she is",
      "we ",
      "we are",
      "they ",
      "they are",
      "hello",
      "hi ",
      "good morning",
      "good evening",
    ];
    const enLines = linhas.filter((l) => {
      const t = l.toLowerCase();
      return hasLatin.test(l) && !ptAccents.test(l) && enKeywords.some((k) => t.startsWith(k));
    });
    if (enLines.length > 0) return enLines.join("\n");
  }

  return texto;
}

/** ---------- Helpers de perfil pedagógico ---------- **/

function inferirNivelPercebido(texto) {
  const t = normalizarTexto(texto);
  if (t.includes("nunca") || t.includes("zero") || t.includes("começar do zero"))
    return { nivelPercebido: "iniciante", nivelCEFR: "A0" };
  if (t.includes("basico") || t.includes("básico") || t.includes("pouco"))
    return { nivelPercebido: "básico", nivelCEFR: "A1" };
  if (t.includes("intermediario") || t.includes("intermediário") || t.includes("mediano"))
    return { nivelPercebido: "intermediário", nivelCEFR: "A2/B1" };
  if (t.includes("avancado") || t.includes("avançado") || t.includes("fluente"))
    return { nivelPercebido: "avançado", nivelCEFR: "B2+" };
  return { nivelPercebido: "iniciante", nivelCEFR: "A0" };
}

function inferirMaiorDificuldade(texto) {
  const t = normalizarTexto(texto);
  if (t.includes("pronuncia") || t.includes("pronúncia") || t.includes("falar") || t.includes("fala"))
    return "pronúncia / fala";
  if (t.includes("gramatica") || t.includes("gramática")) return "gramática";
  if (t.includes("vocabulario") || t.includes("vocabulário") || t.includes("palavra")) return "vocabulário";
  if (t.includes("escuta") || t.includes("ouvir") || t.includes("listening")) return "escuta / compreensão auditiva";
  if (t.includes("vergonha") || t.includes("timido") || t.includes("tímido") || t.includes("medo"))
    return "medo / vergonha de falar";
  return texto;
}

function inferirPreferenciaFormato(texto) {
  const t = normalizarTexto(texto);
  if (t.includes("audio") || t.includes("áudio") || t.includes("voz")) return "audio";
  if (t.includes("escrita") || t.includes("texto") || t.includes("mensagem")) return "texto";
  if (t.includes("mistur") || t.includes("tanto faz") || t.includes("os dois")) return "misto";
  return "misto";
}

function inferirFrequenciaPreferida(texto) {
  const t = normalizarTexto(texto);
  if (t.includes("todo dia") || t.includes("todos os dias") || t.includes("diario") || t.includes("diário"))
    return "diario";
  if (t.includes("5x") || t.includes("5 vezes") || t.includes("cinco vezes") || t.includes("5 vezes por semana"))
    return "5x";
  if (t.includes("3x") || t.includes("3 vezes") || t.includes("tres vezes")) return "3x";
  if (t.includes("so quando") || t.includes("só quando") || t.includes("quando eu falar") || t.includes("quando falar comigo"))
    return "livre";
  return "3x";
}

/** ---------- Detectar tipo de mensagem (tradução vs conversa) ---------- **/

function detectarTipoMensagem(textoNorm = "") {
  if (!textoNorm) return "geral";

  const isPedidoTraducao =
    textoNorm.includes("como se diz") ||
    textoNorm.includes("como diz") ||
    textoNorm.includes("como eu digo") ||
    textoNorm.includes("como digo") ||
    textoNorm.includes("traduz") ||
    textoNorm.includes("traduza") ||
    textoNorm.includes("tradução") ||
    textoNorm.includes("translate") ||
    textoNorm.includes("em ingles") ||
    textoNorm.includes("em inglês") ||
    textoNorm.includes("em frances") ||
    textoNorm.includes("em francês") ||
    textoNorm.includes("what does") ||
    textoNorm.includes("how do i say");

  if (isPedidoTraducao) return "pedido_traducao";

  const isPerguntaSobreKito =
    textoNorm.includes("qual e o seu nome") ||
    textoNorm.includes("qual o seu nome") ||
    textoNorm.includes("teu nome") ||
    textoNorm.includes("seu nome") ||
    textoNorm.includes("como te chamas") ||
    textoNorm.includes("como se chama") ||
    textoNorm.includes("quem e voce") ||
    textoNorm.includes("quem é voce") ||
    textoNorm.includes("quem é você") ||
    textoNorm.includes("what is your name") ||
    textoNorm.includes("what's your name") ||
    textoNorm.includes("who are you") ||
    textoNorm.includes("voce e humano") ||
    textoNorm.includes("você é humano") ||
    textoNorm.includes("voce é um robo") ||
    textoNorm.includes("você é um robô") ||
    textoNorm.includes("vc e um robo") ||
    textoNorm.includes("vc é um robo");

  if (isPerguntaSobreKito) return "pergunta_sobre_kito";

  if (textoNorm.includes("premium") || textoNorm.includes("assinar") || textoNorm.includes("pagar"))
    return "pedido_premium";

  return "geral";
}

/** ---------- Firebase: guardar / carregar aluno ---------- **/

async function saveStudentToFirestore(phone, aluno) {
  try {
    if (!db) {
      console.warn("⚠️ Firebase não inicializado — skip save");
      return;
    }

    const normalize = (val) => safeToDate(val);

    const createdAt = normalize(aluno.createdAt) || new Date();
    const lastMessageAt = normalize(aluno.lastMessageAt) || new Date();
    const reminder1hSentAt = normalize(aluno.reminder1hSentAt);
    const reminder2dSentAt = normalize(aluno.reminder2dSentAt);

    const lastNudgeAt = normalize(aluno.lastNudgeAt);
    const preferredStudyDays = Array.isArray(aluno.preferredStudyDays) ? aluno.preferredStudyDays : null;
    const preferredStudyHour = Number.isFinite(aluno.preferredStudyHour) ? aluno.preferredStudyHour : null;

    const premiumUntil = normalize(aluno.premiumUntil);
    const lastPaywallPromptAt = normalize(aluno.lastPaywallPromptAt);

    const docRef = db.collection("students").doc(`whatsapp:${phone}`);
    await docRef.set(
      {
        nome: aluno.nome ?? null,
        idioma: aluno.idioma ?? null,
        nivel: aluno.nivel ?? null,
        nivelPercebido: aluno.nivelPercebido ?? null,
        maiorDificuldade: aluno.maiorDificuldade ?? null,
        preferenciaFormato: aluno.preferenciaFormato ?? null,
        frequenciaPreferida: aluno.frequenciaPreferida ?? null,
        objetivo: aluno.objetivo ?? null,
        stage: aluno.stage ?? null,
        chatMode: aluno.chatMode ?? null,

        messagesCount: aluno.messagesCount ?? 0,
        moduleIndex: aluno.moduleIndex ?? 0,
        moduleStep: aluno.moduleStep ?? 0,

        plan: aluno.plan ?? "free",
        premiumUntil: premiumUntil || null,
        paymentProvider: aluno.paymentProvider ?? null,
        dailyCount: aluno.dailyCount ?? 0,
        dailyDate: aluno.dailyDate ?? null,
        lastPaywallPromptAt: lastPaywallPromptAt || null,

        createdAt,
        lastMessageAt,
        reminder1hSentAt: reminder1hSentAt || null,
        reminder2dSentAt: reminder2dSentAt || null,

        lastNudgeAt: lastNudgeAt || null,
        nudgeCount: aluno.nudgeCount ?? 0,
        preferredStudyDays: preferredStudyDays || null,
        preferredStudyHour: preferredStudyHour,

        celebrations: aluno.celebrations ?? null,

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
      reminder1hSentAt: safeToDate(data.reminder1hSentAt),
      reminder2dSentAt: safeToDate(data.reminder2dSentAt),
      lastNudgeAt: safeToDate(data.lastNudgeAt),

      premiumUntil: safeToDate(data.premiumUntil),
      lastPaywallPromptAt: safeToDate(data.lastPaywallPromptAt),
    };
  } catch (err) {
    console.error("❌ Erro ao carregar aluno do Firestore:", err.message);
    return null;
  }
}

/** ---------- OpenAI (Kito, professor da Jovika) ---------- **/

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function gerarRespostaKito(aluno, moduloAtual, tipoMensagem = "geral") {
  const history = aluno.history || [];
  const ultimoUser = history.filter((m) => m.role === "user").slice(-1)[0];
  const textoDoAluno = ultimoUser ? ultimoUser.content : "(sem mensagem recente)";

  console.log("🧠 Pergunta do aluno:", textoDoAluno);
  console.log("🧠 Tipo de mensagem detectado:", tipoMensagem);

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
Tu és o **Kito**, professor oficial da **Jovika Academy**, uma escola moderna de inglês e francês
para jovens de Angola, Brasil e Portugal. Você dá aulas pelo WhatsApp, de forma humana, natural e inteligente.

MODO ATUAL DO ALUNO (MUITO IMPORTANTE):
- chatMode: "${modo}"
- Se chatMode = "conversa":
  - O aluno quer praticar falando como se fosse com um humano.
  - Você DEVE responder primeiro como uma pessoa (fluido e natural).
  - NÃO faça correção automática.
  - No final, pode perguntar opcionalmente: "Quer que eu corrija essa frase?"
- Se chatMode = "aprender":
  - O aluno quer aprender com correções e explicações.
  - Corrija com carinho, com exemplos curtos.

IDENTIDADE:
- Nome: Kito
- Papel: professor de INGLÊS e FRANCÊS da Jovika Academy

PORTUGUÊS DO BRASIL:
- Escreva sempre em português do Brasil, usando "você".
- Evite gírias ("pra", "bora").
- Inglês: 1ª linha frase em inglês; 2ª linha tradução.
- Francês: 1ª linha frase em francês; 2ª linha tradução.

PERFIL DO ALUNO:
- Nome: ${aluno.nome || "não informado"}
- Idioma alvo: ${idiomaAlvo}
- Nível interno: ${aluno.nivel || "A0"}
- Nível percebido: ${aluno.nivelPercebido || "não definido"}
- Maior dificuldade: ${aluno.maiorDificuldade || "descobrir com perguntas simples."}
- Preferência de formato: ${aluno.preferenciaFormato || "misto"}
- Frequência preferida: ${aluno.frequenciaPreferida || "não definida"}
- Objetivo: ${aluno.objetivo || "descobrir com perguntas simples."}

MÓDULO (GUIA):
- Título: ${modulo?.title || "Introdução"}
- Objetivo: ${modulo?.goal || "comunicação básica"}
- Passo atual: ${step} de ${totalSteps}

TIPO DA ÚLTIMA MENSAGEM:
- ${tipoMensagem}

REGRAS:
- pedido_traducao: responda direto e explique curto.
- pergunta_sobre_kito: responda como conversa real.
- pedido_premium: responda curto e ofereça o Premium.
- geral: responda primeiro ao aluno; depois 1 pergunta.

ESTILO:
- Mensagens curtas estilo WhatsApp.
- Máximo 2 blocos + 1 pergunta.
- Emojis com moderação (1 no máximo).

SOBRE ÁUDIO:
- Nunca diga "vou mandar áudio" nem "[Áudio enviado]". O sistema decide.
  `.trim();

  const mensagens = [{ role: "system", content: systemPrompt }, ...history.slice(-10)];

  const resposta = await openai.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    input: mensagens,
  });

  const textoGerado = resposta.output?.[0]?.content?.[0]?.text || "Desculpa, deu um erro aqui. Tente de novo 🙏";
  return limparTextoResposta(textoGerado);
}

/** ---------- ÁUDIO: download + transcrição ---------- **/

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
    console.log("🎧 Transcrevendo áudio:", audioUrl);
    const tempPath = await downloadToTempFile(audioUrl);

    const transcription = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file: fs.createReadStream(tempPath),
    });

    fs.promises.unlink(tempPath).catch(() => {});
    console.log("📝 Transcrição:", transcription.text);
    return transcription.text;
  } catch (err) {
    console.error("❌ Erro ao transcrever áudio:", err.response?.data || err.message);
    return null;
  }
}

/** ---------- ÁUDIO: TTS ---------- **/

async function gerarAudioRespostaKito(texto, idiomaAlvo = null) {
  try {
    const enableTts = String(process.env.ENABLE_TTS || "true").toLowerCase() !== "false";
    if (!enableTts) return null;

    console.log("🎙️ Gerando áudio de resposta do Kito...");

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
      input: texto,
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

/** ---------- Enviar mensagem pela Z-API (texto) ---------- **/

async function enviarMensagemWhatsApp(phone, message) {
  try {
    const instanceId = process.env.ZAPI_INSTANCE_ID;
    const instanceToken = process.env.ZAPI_INSTANCE_TOKEN;
    const clientToken = process.env.ZAPI_CLIENT_TOKEN;

    if (!instanceId || !instanceToken) {
      console.error("❌ Z-API: falta ZAPI_INSTANCE_ID ou ZAPI_INSTANCE_TOKEN no .env");
      return;
    }

    const url = `https://api.z-api.io/instances/${instanceId}/token/${instanceToken}/send-text`;
    const payload = { phone, message };

    const headers = { "Content-Type": "application/json" };
    if (clientToken) headers["Client-Token"] = clientToken;

    const resp = await axios.post(url, payload, { headers });
    console.log("📤 Mensagem enviada via Z-API para", phone, "resp:", resp.data);
  } catch (err) {
    console.error("❌ Erro ao enviar mensagem via Z-API:", err.response?.data || err.message);
  }
}

/** ---------- Enviar ÁUDIO pela Z-API ---------- **/

async function enviarAudioWhatsApp(phone, audioBase64) {
  try {
    if (!audioBase64) return;

    const instanceId = process.env.ZAPI_INSTANCE_ID;
    const instanceToken = process.env.ZAPI_INSTANCE_TOKEN;
    const clientToken = process.env.ZAPI_CLIENT_TOKEN;

    if (!instanceId || !instanceToken) {
      console.error("❌ Z-API: falta ZAPI_INSTANCE_ID ou ZAPI_INSTANCE_TOKEN no .env (áudio)");
      return;
    }

    const url = `https://api.z-api.io/instances/${instanceId}/token/${instanceToken}/send-audio`;
    const payload = { phone, audio: audioBase64, viewOnce: false, waveform: true };

    const headers = { "Content-Type": "application/json" };
    if (clientToken) headers["Client-Token"] = clientToken;

    const resp = await axios.post(url, payload, { headers });
    console.log("📤 Áudio enviado via Z-API para", phone, "resp:", resp.data);
  } catch (err) {
    console.error("❌ Erro ao enviar áudio via Z-API:", err.response?.data || err.message);
  }
}

/** ---------- MICRO-VITÓRIAS ---------- **/

function gerarMicroVitoria(aluno) {
  const counts = aluno.messagesCount || 0;
  if (counts >= 30) return "Você já está criando consistência de verdade 👏";
  if (counts >= 15) return "Você já evoluiu mais do que imagina 👊";
  if (counts >= 7) return "Você já está pegando o ritmo, parabéns!";
  if (counts >= 3) return "Boa! Você já começou do jeito certo.";
  return "Começar já foi uma vitória.";
}

/** ---------- LEMBRETES POR FREQUÊNCIA ---------- **/

const REMINDER_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const MIN_NUDGE_GAP_MS = 20 * 60 * 60 * 1000; // 20h
const DEFAULT_NUDGE_HOUR = Number(process.env.DEFAULT_NUDGE_HOUR || 19);

function weekdayPtToIso1_7(jsGetDay0_6) {
  if (jsGetDay0_6 === 0) return 7;
  return jsGetDay0_6;
}

function getIdiomaTexto(idioma) {
  if (idioma === "ingles") return "inglês";
  if (idioma === "frances") return "francês";
  if (idioma === "ambos") return "inglês e francês";
  return "o idioma";
}

function getDefaultStudyDays(frequenciaPreferida) {
  if (frequenciaPreferida === "diario") return [1, 2, 3, 4, 5, 6, 7];
  if (frequenciaPreferida === "5x") return [1, 2, 3, 4, 5];
  if (frequenciaPreferida === "3x") return [1, 3, 5];
  return null;
}

function isStudyDayToday(aluno, now = new Date()) {
  const freq = aluno.frequenciaPreferida || "3x";
  if (freq === "livre") return false;

  const days =
    Array.isArray(aluno.preferredStudyDays) && aluno.preferredStudyDays.length
      ? aluno.preferredStudyDays
      : getDefaultStudyDays(freq);

  if (!days) return false;

  const todayIso = weekdayPtToIso1_7(now.getDay());
  return days.includes(todayIso);
}

function shouldSendNudge(aluno, now = new Date()) {
  if (!aluno.lastMessageAt) return false;
  if (aluno.frequenciaPreferida === "livre") return false;
  if (aluno.stage && aluno.stage !== "learning") return false;

  const diffSinceMsg = now - new Date(aluno.lastMessageAt);
  if (diffSinceMsg < 12 * 60 * 60 * 1000) return false;

  if (aluno.lastNudgeAt) {
    const diffSinceNudge = now - new Date(aluno.lastNudgeAt);
    if (diffSinceNudge < MIN_NUDGE_GAP_MS) return false;
  }

  if (!isStudyDayToday(aluno, now)) return false;

  const targetHour = Number.isFinite(aluno.preferredStudyHour) ? aluno.preferredStudyHour : DEFAULT_NUDGE_HOUR;
  const hour = now.getHours();

  const start = (targetHour - 2 + 24) % 24;
  const end = (targetHour + 2) % 24;

  const inWindow = start <= end ? hour >= start && hour <= end : hour >= start || hour <= end;
  return inWindow;
}

function montarMensagemNudge(aluno) {
  const nome = aluno.nome || "por aqui";
  const idiomaTexto = getIdiomaTexto(aluno.idioma);
  const micro = gerarMicroVitoria(aluno);
  return `Oi, ${nome}! 😊\n${micro}\n\nQuer praticar ${idiomaTexto} comigo agora? É rapidinho (3 min).`;
}

async function verificarELancarLembretes() {
  const agora = new Date();

  for (const [numero, aluno] of Object.entries(students)) {
    try {
      if (!shouldSendNudge(aluno, agora)) continue;

      const msg = montarMensagemNudge(aluno);
      aluno.lastNudgeAt = agora;
      aluno.nudgeCount = (aluno.nudgeCount || 0) + 1;

      await enviarMensagemWhatsApp(numero, msg);
      await saveStudentToFirestore(numero, aluno);
    } catch (e) {
      console.error("❌ Erro ao enviar nudge:", e.message);
    }
  }
}

setInterval(verificarELancarLembretes, REMINDER_CHECK_INTERVAL_MS);

/** ---------- LÓGICA PRINCIPAL ---------- **/

async function processarMensagemAluno({ numeroAluno, texto, profileName, isAudio }) {
  let aluno = students[numeroAluno];
  const agora = new Date();

  if (!aluno) {
    const fromDb = await loadStudentFromFirestore(numeroAluno);
    if (fromDb) {
      aluno = {
        ...fromDb,
        history: [],
        nivelPercebido: fromDb.nivelPercebido || null,
        maiorDificuldade: fromDb.maiorDificuldade || null,
        preferenciaFormato: fromDb.preferenciaFormato || null,
        frequenciaPreferida: fromDb.frequenciaPreferida || null,
        objetivo: fromDb.objetivo || null,
        chatMode: fromDb.chatMode || null,

        preferredStudyDays: fromDb.preferredStudyDays || null,
        preferredStudyHour: Number.isFinite(fromDb.preferredStudyHour) ? fromDb.preferredStudyHour : null,
        lastNudgeAt: fromDb.lastNudgeAt || null,
        nudgeCount: fromDb.nudgeCount || 0,

        plan: fromDb.plan || "free",
        premiumUntil: fromDb.premiumUntil || null,
        paymentProvider: fromDb.paymentProvider || null,
        dailyCount: fromDb.dailyCount || 0,
        dailyDate: fromDb.dailyDate || null,
        lastPaywallPromptAt: fromDb.lastPaywallPromptAt || null,
      };
      students[numeroAluno] = aluno;
    }
  }

  if (!aluno) {
    aluno = {
      stage: "ask_name",
      nome: null,
      idioma: null,
      nivel: "A0",
      nivelPercebido: null,
      maiorDificuldade: null,
      preferenciaFormato: null,
      frequenciaPreferida: null,
      objetivo: null,
      chatMode: null,
      messagesCount: 0,
      createdAt: agora,
      lastMessageAt: agora,
      moduleIndex: 0,
      moduleStep: 0,

      reminder1hSentAt: null,
      reminder2dSentAt: null,

      preferredStudyDays: null,
      preferredStudyHour: null,
      lastNudgeAt: null,
      nudgeCount: 0,

      celebrations: null,

      plan: "free",
      premiumUntil: null,
      paymentProvider: null,
      dailyCount: 0,
      dailyDate: null,
      lastPaywallPromptAt: null,

      history: [],
    };

    students[numeroAluno] = aluno;

    const primeiroNome = extrairNome(profileName) || "Aluno";

    await enviarMensagemWhatsApp(
      numeroAluno,
      `Olá, ${primeiroNome}! 😄 Eu sou o Kito, professor de inglês e francês da Jovika Academy.\nComo você quer que eu chame você?`
    );

    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  // Atualiza stats
  aluno.messagesCount = (aluno.messagesCount || 0) + 1;
  aluno.lastMessageAt = agora;
  aluno.history = aluno.history || [];

  // ✅ contador diário (só conta mensagens do aluno)
  const dailyCount = updateDailyCounter(aluno, agora);

  const prefix = isAudio ? "[ÁUDIO] " : "";
  aluno.history.push({ role: "user", content: `${prefix}${texto}` });

  // ✅ PAYWALL: se não for premium e estourou limite, bloqueia e oferece Premium
  const premium = isPremium(aluno, agora);
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

    students[numeroAluno] = aluno;
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  // ✅ Atalho: se o aluno pedir premium
  const textoNormQuick = normalizarTexto(texto || "");
  const tipoQuick = detectarTipoMensagem(textoNormQuick);
  if (tipoQuick === "pedido_premium") {
    const offer = montarMensagemOfertaPremium(numeroAluno);
    aluno.lastPaywallPromptAt = agora;
    aluno.history.push({ role: "assistant", content: offer });
    await enviarMensagemWhatsApp(numeroAluno, offer);
    students[numeroAluno] = aluno;
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  // ✅ Troca de modo
  const comandoModo = detectarComandoModo(texto || "");
  if (comandoModo && aluno.stage !== "ask_name" && aluno.stage !== "ask_language") {
    aluno.chatMode = comandoModo;
    const msgModo =
      comandoModo === "conversa"
        ? "Perfeito 😊 A partir de agora a gente conversa para você praticar. Se quiser que eu corrija tudo, é só dizer: modo aprender."
        : "Combinado 💪 A partir de agora eu vou te ensinar e corrigir enquanto a gente conversa. Se quiser só praticar sem correção, diga: modo conversa.";
    aluno.history.push({ role: "assistant", content: msgModo });
    await enviarMensagemWhatsApp(numeroAluno, msgModo);
    students[numeroAluno] = aluno;
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  // Onboarding
  if (aluno.stage === "ask_name" && !aluno.nome) {
    const nome = extrairNome(texto) || "Aluno";
    aluno.nome = nome;
    aluno.stage = "ask_language";

    await enviarMensagemWhatsApp(
      numeroAluno,
      `Perfeito, ${nome}! 😄 Agora me conta: você quer começar por inglês, francês ou os dois?`
    );
  } else if (aluno.stage === "ask_language") {
    const idioma = detectarIdioma(texto);

    if (!idioma) {
      await enviarMensagemWhatsApp(
        numeroAluno,
        "Acho que não entendi muito bem 😅\nResponda só com: inglês, francês ou os dois."
      );
    } else {
      aluno.idioma = idioma;
      aluno.stage = "ask_experience";
      aluno.moduleIndex = 0;
      aluno.moduleStep = 0;
      aluno.nivel = "A0";

      const idiomaTexto = idioma === "ingles" ? "inglês" : idioma === "frances" ? "francês" : "inglês e francês";

      await enviarMensagemWhatsApp(
        numeroAluno,
        `Ótimo, ${aluno.nome}! Vamos trabalhar ${idiomaTexto} juntos 💪✨\nAntes de começar, quero adaptar tudo ao seu perfil.\n\nVocê já estudou ${idiomaTexto} antes?`
      );
    }
  } else if (aluno.stage === "ask_experience") {
    const { nivelPercebido, nivelCEFR } = inferirNivelPercebido(texto);
    aluno.nivelPercebido = nivelPercebido;
    aluno.nivel = aluno.nivel || nivelCEFR;
    aluno.stage = "ask_difficulty";

    await enviarMensagemWhatsApp(
      numeroAluno,
      `Perfeito, entendi. 😊\nAgora me conta: em ${aluno.idioma === "frances" ? "francês" : "inglês"}, o que você sente que é mais difícil hoje?\n\nPronúncia, gramática, vocabulário, escutar, vergonha de falar...`
    );
  } else if (aluno.stage === "ask_difficulty") {
    aluno.maiorDificuldade = inferirMaiorDificuldade(texto);
    aluno.stage = "ask_preference_format";

    await enviarMensagemWhatsApp(
      numeroAluno,
      "Ótimo, obrigado por compartilhar isso comigo. 😊\nVocê prefere que eu explique mais por áudio, por mensagem escrita ou misturando os dois?"
    );
  } else if (aluno.stage === "ask_preference_format") {
    aluno.preferenciaFormato = inferirPreferenciaFormato(texto);
    aluno.stage = "ask_frequency";

    await enviarMensagemWhatsApp(
      numeroAluno,
      "Show! Para eu organizar melhor os seus estudos:\nVocê prefere que eu te puxe todos os dias, 3x por semana, 5x por semana ou só quando você falar comigo?"
    );
  } else if (aluno.stage === "ask_frequency") {
    aluno.frequenciaPreferida = inferirFrequenciaPreferida(texto);
    aluno.preferredStudyDays = getDefaultStudyDays(aluno.frequenciaPreferida);
    aluno.preferredStudyHour = DEFAULT_NUDGE_HOUR;
    aluno.stage = "ask_mode";

    await enviarMensagemWhatsApp(
      numeroAluno,
      "Antes de começarmos: você quer que eu seja mais como um parceiro de conversa (para praticar) ou como professor corrigindo?\n\nResponda com:\n1) conversar\n2) aprender\n\nVocê pode mudar quando quiser dizendo: modo conversa / modo aprender."
    );
  } else if (aluno.stage === "ask_mode") {
    const t = normalizarTexto(texto);
    const escolheuConversa = t.includes("1") || t.includes("convers") || t.includes("pratic");
    const escolheuAprender = t.includes("2") || t.includes("aprender") || t.includes("estudar") || t.includes("corrig");

    if (!escolheuConversa && !escolheuAprender) {
      await enviarMensagemWhatsApp(numeroAluno, "Só para eu acertar seu estilo 😊\nResponda com:\n1) conversar\n2) aprender");
    } else {
      aluno.chatMode = escolheuAprender ? "aprender" : "conversa";
      aluno.stage = "learning";

      const idiomaTexto =
        aluno.idioma === "ingles" ? "inglês" : aluno.idioma === "frances" ? "francês" : "inglês e francês";

      await enviarMensagemWhatsApp(
        numeroAluno,
        aluno.chatMode === "conversa"
          ? `Perfeito 😊 A gente vai conversar para você praticar ${idiomaTexto}.\nSe quiser correção completa, diga: modo aprender.\n\nAgora me conte: qual é o seu principal objetivo com ${idiomaTexto}?`
          : `Combinado 💪 Eu vou te ensinar e corrigir enquanto a gente conversa em ${idiomaTexto}.\nSe quiser só praticar sem correção, diga: modo conversa.\n\nAgora me conte: qual é o seu principal objetivo com ${idiomaTexto}?`
      );
    }
  } else {
    if (aluno.stage !== "learning") aluno.stage = "learning";

    if (!aluno.objetivo) {
      aluno.objetivo = texto;
      console.log("🎯 Objetivo do aluno registrado:", aluno.objetivo);
    }

    const textoNorm = normalizarTexto(texto || "");
    const tipoMensagem = detectarTipoMensagem(textoNorm);

    const idiomaChave = aluno.idioma === "frances" ? "frances" : "ingles";
    const trilha = learningPath[idiomaChave] || learningPath["ingles"];

    let moduleIndex = aluno.moduleIndex ?? 0;
    let moduleStep = aluno.moduleStep ?? 0;

    if (moduleIndex >= trilha.length) moduleIndex = trilha.length - 1;
    const moduloAtual = trilha[moduleIndex] || trilha[0];

    const confirmacao = isConfirmMessage(texto);

    const querAudioPorPedido = userQuerAudio(texto, isAudio);
    const chatMode = aluno.chatMode || "conversa";
    const espelharAudio = isAudio && chatMode === "conversa";

    const pediuExercicioEmAudio =
      querAudioPorPedido &&
      (textoNorm.includes("exercicio") ||
        textoNorm.includes("exercício") ||
        textoNorm.includes("exercicios") ||
        textoNorm.includes("exercícios"));

    const idiomaAudioAlvo = aluno.idioma === "ingles" || aluno.idioma === "frances" ? aluno.idioma : null;

    if (pediuExercicioEmAudio) {
      const lastAssistant = [...(aluno.history || [])].reverse().find((m) => m.role === "assistant") || null;

      let textoParaAudio =
        lastAssistant?.content ||
        "Vamos praticar este exercício juntos. Escute com atenção e depois me envie suas respostas por mensagem.";

      textoParaAudio = extrairTrechoParaAudio(textoParaAudio, idiomaAudioAlvo);

      const audioBase64 = await gerarAudioRespostaKito(textoParaAudio, idiomaAudioAlvo);
      await enviarAudioWhatsApp(numeroAluno, audioBase64);

      const msgConfirm = "Pronto! Depois me envie suas respostas por mensagem que eu corrijo com carinho, combinado? 🙂";
      aluno.history.push({ role: "assistant", content: msgConfirm });
      await sleep(800);
      await enviarMensagemWhatsApp(numeroAluno, msgConfirm);
    } else {
      const respostaKito = await gerarRespostaKito(aluno, moduloAtual, tipoMensagem);

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

      const deveMandarAudio = espelharAudio || querAudioPorPedido;

      if (deveMandarAudio) {
        const trecho = extrairTrechoParaAudio(respostaKito, idiomaAudioAlvo);
        const audioBase64 = await gerarAudioRespostaKito(trecho, idiomaAudioAlvo);
        await enviarAudioWhatsApp(numeroAluno, audioBase64);
      }

      await sleep(1200);
      await enviarMensagemWhatsApp(numeroAluno, respostaKito);
    }
  }

  students[numeroAluno] = aluno;
  await saveStudentToFirestore(numeroAluno, aluno);
}

/** ---------- STRIPE WEBHOOK (OPCIONAL) ---------- **/
app.post("/stripe/webhook", async (req, res) => {
  try {
    if (!stripe) return res.status(400).send("stripe_not_configured");
    const whsec = process.env.STRIPE_WEBHOOK_SECRET;
    if (!whsec) return res.status(400).send("missing_STRIPE_WEBHOOK_SECRET");

    const sig = req.headers["stripe-signature"];
    let event;

    try {
      // req.body aqui é Buffer (raw)
      event = stripe.webhooks.constructEvent(req.body, sig, whsec);
    } catch (err) {
      console.error("❌ Stripe webhook signature error:", err.message);
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

        if (db) {
          const docRef = db.collection("students").doc(`whatsapp:${phone}`);
          await docRef.set(
            {
              plan: "premium",
              paymentProvider: "stripe",
              premiumUntil,
              updatedAt: new Date(),
            },
            { merge: true }
          );
        }

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

/** ---------- ADMIN: ativar Premium manual (Pix/Angola) ---------- **/
app.get("/admin/activate", async (req, res) => {
  try {
    const token = req.query.token;
    if (!token || token !== process.env.ADMIN_TOKEN) return res.status(401).send("Não autorizado");

    const phone = String(req.query.phone || "").replace(/\D/g, "");
    const days = Number(req.query.days || 30);
    const provider = String(req.query.provider || "manual");
    if (!phone) return res.status(400).send("phone_required");

    const now = new Date();
    const premiumUntil = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    if (db) {
      const docRef = db.collection("students").doc(`whatsapp:${phone}`);
      await docRef.set(
        {
          plan: "premium",
          paymentProvider: provider,
          premiumUntil,
          updatedAt: new Date(),
        },
        { merge: true }
      );
    }

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

/** ---------- WEBHOOK Z-API ---------- **/

app.post("/zapi-webhook", async (req, res) => {
  const data = req.body;
  console.log("📩 Webhook Z-API recebido:", JSON.stringify(data, null, 2));

  try {
    if (data.type !== "ReceivedCallback") {
      return res.status(200).send("ignored_non_received");
    }

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

    if (processedMessages.has(msgId)) {
      console.log("⚠️ Mensagem duplicada ignorada (messageId):", msgId);
      return res.status(200).send("duplicate_ignored");
    }
    processedMessages.add(msgId);

    if (momentVal && lastMomentByPhone[numeroAluno] === momentVal) {
      console.log("⚠️ Mensagem duplicada ignorada (momment):", msgId, momentVal);
      return res.status(200).send("duplicate_moment_ignored");
    }
    if (momentVal) lastMomentByPhone[numeroAluno] = momentVal;

    const agora = Date.now();
    const ultimo = lastTextByPhone[numeroAluno];
    if (texto && ultimo && ultimo.text === texto && agora - ultimo.time < 3000) {
      console.log("⚠️ Mensagem duplicada ignorada (texto + tempo):", msgId, texto);
      return res.status(200).send("duplicate_text_recent");
    }
    if (texto) lastTextByPhone[numeroAluno] = { text: texto, time: agora };

    const profileName = data.senderName || data.chatName || "Aluno";

    if (!texto && !audioUrl) {
      console.log("📭 Mensagem sem texto nem áudio processável.");
      return res.status(200).send("no_text_or_audio");
    }

    if (audioUrl && !texto) {
      const transcricao = await transcreverAudio(audioUrl);

      if (!transcricao) {
        await enviarMensagemWhatsApp(
          numeroAluno,
          "Tentei ouvir o seu áudio mas não consegui transcrever bem 😅\nVocê pode tentar falar um pouco mais perto do microfone ou enviar de novo?"
        );
        return res.status(200).send("audio_transcription_failed");
      }

      await processarMensagemAluno({ numeroAluno, texto: transcricao, profileName, isAudio: true });
      return res.status(200).send("ok_audio");
    }

    await processarMensagemAluno({ numeroAluno, texto, profileName, isAudio: false });
    res.status(200).send("ok");
  } catch (erro) {
    console.error("❌ Erro no processamento do webhook Z-API:", erro?.response?.data || erro.message);
    return res.status(500).send("erro");
  }
});

/** ---------- DASHBOARD HTML (/admin/dashboard) ---------- **/

app.get("/admin/dashboard", (req, res) => {
  const token = req.query.token;
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).send("Não autorizado");
  }

  const alunos = Object.entries(students).map(([numero, dados]) => ({
    numero,
    nome: dados.nome || "-",
    idioma: dados.idioma || "-",
    nivel: dados.nivel || "-",
    mensagens: dados.messagesCount || 0,
    stage: dados.stage,
    chatMode: dados.chatMode || "-",
    moduleIndex: dados.moduleIndex ?? 0,
    moduleStep: dados.moduleStep ?? 0,
    frequenciaPreferida: dados.frequenciaPreferida || "-",
    preferredStudyHour: Number.isFinite(dados.preferredStudyHour) ? dados.preferredStudyHour : "-",
    nudgeCount: dados.nudgeCount || 0,
    lastNudgeAt: dados.lastNudgeAt || null,
    createdAt: dados.createdAt,
    lastMessageAt: dados.lastMessageAt,

    plan: dados.plan || "free",
    premiumUntil: dados.premiumUntil || null,
    dailyCount: dados.dailyCount || 0,
    dailyDate: dados.dailyDate || null,
  }));

  const total = alunos.length;
  const ingles = alunos.filter((a) => a.idioma === "ingles").length;
  const frances = alunos.filter((a) => a.idioma === "frances").length;
  const ambos = alunos.filter((a) => a.idioma === "ambos").length;

  const agora = new Date();
  const ativos24h = alunos.filter((a) => {
    if (!a.lastMessageAt) return false;
    const diff = agora - new Date(a.lastMessageAt);
    return diff <= 24 * 60 * 60 * 1000;
  }).length;

  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <title>Dashboard - Jovika Academy (Professor Kito)</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #e5e7eb; padding: 24px; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    h2 { font-size: 18px; margin: 24px 0 12px; }
    .subtitle { color: #9ca3af; margin-bottom: 20px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #111827; border-radius: 12px; padding: 16px; border: 1px solid #1f2937; }
    .card-title { font-size: 13px; color: #9ca3af; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
    .card-value { font-size: 22px; font-weight: 600; }
    .card-sub { font-size: 12px; color: #9ca3af; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
    th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1f2937; vertical-align: top; }
    th { background: #111827; position: sticky; top: 0; z-index: 1; }
    tr:nth-child(even) td { background: #020617; }
    .badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; }
    .badge-en { background: rgba(56, 189, 248, 0.15); color: #7dd3fc; }
    .badge-fr { background: rgba(251, 191, 36, 0.15); color: #facc15; }
    .badge-both { background: rgba(52, 211, 153, 0.15); color: #6ee7b7; }
    .stage-pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #111827; color: #e5e7eb; display: inline-block; }
    .table-wrapper { max-height: 60vh; overflow: auto; border-radius: 12px; border: 1px solid #1f2937; background: #020617; }
    .top-bar { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
    .pill { font-size: 11px; padding: 4px 10px; border-radius: 999px; border: 1px solid #1f2937; color: #9ca3af; }
    .footer { margin-top: 24px; font-size: 11px; color: #6b7280; }
    code { background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <div class="top-bar">
    <div>
      <h1>Dashboard • Jovika Academy</h1>
      <div class="subtitle">Professor Kito — visão geral dos alunos em tempo real</div>
    </div>
    <div class="pill">Token: <strong>${process.env.ADMIN_TOKEN || "não definido"}</strong></div>
  </div>

  <div class="cards">
    <div class="card">
      <div class="card-title">Total de alunos</div>
      <div class="card-value">${total}</div>
      <div class="card-sub">Todos os números que já falaram com o Kito</div>
    </div>
    <div class="card">
      <div class="card-title">Ativos nas últimas 24h</div>
      <div class="card-value">${ativos24h}</div>
      <div class="card-sub">Quem falou nas últimas 24 horas</div>
    </div>
    <div class="card">
      <div class="card-title">Idiomas</div>
      <div class="card-value">EN: ${ingles} · FR: ${frances} · Ambos: ${ambos}</div>
      <div class="card-sub">Distribuição por idioma</div>
    </div>
    <div class="card">
      <div class="card-title">Paywall</div>
      <div class="card-value">Free: ${FREE_DAILY_LIMIT}/dia</div>
      <div class="card-sub">Premium: ilimitado</div>
    </div>
  </div>

  <h2>Alunos</h2>
  <div class="table-wrapper">
    <table>
      <thead>
        <tr>
          <th>Nome</th>
          <th>Número</th>
          <th>Plano</th>
          <th>Premium até</th>
          <th>Daily</th>
          <th>Idioma</th>
          <th>Nível</th>
          <th>Stage</th>
          <th>Modo</th>
          <th>Freq</th>
          <th>Nudges</th>
          <th>Último nudge</th>
          <th>Módulo</th>
          <th>Msgs</th>
          <th>Entrou em</th>
          <th>Última msg</th>
        </tr>
      </thead>
      <tbody>
        ${
          alunos.length === 0
            ? `<tr><td colspan="16">Ainda não há alunos. Assim que alguém mandar "oi" para o Kito, aparece aqui. 😄</td></tr>`
            : alunos
                .map((a) => {
                  let idiomaBadge = `<span class="badge">${a.idioma}</span>`;
                  if (a.idioma === "ingles") idiomaBadge = `<span class="badge badge-en">Inglês</span>`;
                  else if (a.idioma === "frances") idiomaBadge = `<span class="badge badge-fr">Francês</span>`;
                  else if (a.idioma === "ambos") idiomaBadge = `<span class="badge badge-both">Inglês + Francês</span>`;

                  const premiumUntilTxt = a.premiumUntil ? formatDate(a.premiumUntil) : "-";
                  const dailyTxt = `${a.dailyCount || 0} (${a.dailyDate || "-"})`;

                  return `
                  <tr>
                    <td>${a.nome}</td>
                    <td>${a.numero}</td>
                    <td>${a.plan}</td>
                    <td>${premiumUntilTxt}</td>
                    <td>${dailyTxt}</td>
                    <td>${idiomaBadge}</td>
                    <td>${a.nivel}</td>
                    <td><span class="stage-pill">${a.stage}</span></td>
                    <td>${a.chatMode}</td>
                    <td>${a.frequenciaPreferida}</td>
                    <td>${a.nudgeCount}</td>
                    <td>${formatDate(a.lastNudgeAt)}</td>
                    <td>Mód ${a.moduleIndex + 1} · Passo ${a.moduleStep + 1}</td>
                    <td>${a.mensagens}</td>
                    <td>${formatDate(a.createdAt)}</td>
                    <td>${formatDate(a.lastMessageAt)}</td>
                  </tr>
                  `;
                })
                .join("")
        }
      </tbody>
    </table>
  </div>

  <div class="footer">
    JSON: <code>/admin/stats?token=${process.env.ADMIN_TOKEN || "TOKEN"}</code> · Webhook Stripe: <code>/stripe/webhook</code>
  </div>
</body>
</html>
  `;

  res.send(html);
});

/** ---------- /admin/stats (JSON) ---------- **/

app.get("/admin/stats", (req, res) => {
  const token = req.query.token;
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).send("Não autorizado");
  }

  const alunos = Object.entries(students).map(([numero, dados]) => ({
    numero,
    nome: dados.nome,
    idioma: dados.idioma,
    nivel: dados.nivel,
    chatMode: dados.chatMode || null,
    frequenciaPreferida: dados.frequenciaPreferida || null,
    preferredStudyDays: dados.preferredStudyDays || null,
    preferredStudyHour: Number.isFinite(dados.preferredStudyHour) ? dados.preferredStudyHour : null,
    nudgeCount: dados.nudgeCount || 0,
    lastNudgeAt: dados.lastNudgeAt || null,
    mensagens: dados.messagesCount || 0,
    stage: dados.stage,
    moduleIndex: dados.moduleIndex ?? 0,
    moduleStep: dados.moduleStep ?? 0,
    createdAt: dados.createdAt,
    lastMessageAt: dados.lastMessageAt,

    plan: dados.plan || "free",
    premiumUntil: dados.premiumUntil || null,
    dailyCount: dados.dailyCount || 0,
    dailyDate: dados.dailyDate || null,
    paymentProvider: dados.paymentProvider || null,
  }));

  const total = alunos.length;
  const ingles = alunos.filter((a) => a.idioma === "ingles").length;
  const frances = alunos.filter((a) => a.idioma === "frances").length;
  const ambos = alunos.filter((a) => a.idioma === "ambos").length;

  res.json({
    totalAlunos: total,
    porIdioma: { ingles, frances, ambos },
    paywall: { freeDailyLimit: FREE_DAILY_LIMIT },
    alunos,
  });
});

app.get("/", (req, res) => {
  res.send(
    "Servidor Kito (Jovika Academy, Z-API + memória + módulos, TEXTO + ÁUDIO + PERFIL + LEMBRETES + PAYWALL 30/DIA + OFERTA AUTOMÁTICA + STRIPE WEBHOOK opcional) está a correr ✅"
  );
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor REST (Kito + Z-API + memória + Dashboard) em http://localhost:${PORT}`);
});
