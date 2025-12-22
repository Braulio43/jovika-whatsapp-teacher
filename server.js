// server.js – Kito, professor da Jovika Academy
// Z-API + memória + módulos + Dashboard + Firestore + PERFIL PEDAGÓGICO
// + PAYWALL (FREE 30 msgs/dia) + OFERTA por país
// + ÁUDIO SOMENTE PREMIUM (quando aluno pede ou em modo conversa com áudio)
// + STRIPE webhook (opcional, auto-unlock)

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import axios from "axios";
import OpenAI from "openai";
import { db } from "./firebaseAdmin.js"; // Firestore (deve exportar db)
import Stripe from "stripe";

dotenv.config();

console.log(
  "🔥 KITO v6.4 – PAYWALL 30/DIA (sempre com link/dados) + ÁUDIO só Premium (sem mostrar limite) + Stripe webhook FIX (raw body) 🔥"
);

const app = express();
const PORT = process.env.PORT || 10000;

/**
 * ✅ Stripe webhook precisa de RAW body, então:
 * - NÃO pode passar pelo bodyParser.json() antes.
 * A correção é: aplicar json parser em todas as rotas EXCETO /stripe/webhook.
 */
const jsonParser = bodyParser.json();
app.use((req, res, next) => {
  if (req.originalUrl === "/stripe/webhook") return next();
  return jsonParser(req, res, next);
});

const stripe =
  process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.trim()
    ? new Stripe(process.env.STRIPE_SECRET_KEY.trim(), { apiVersion: "2024-06-20" })
    : null;

const stripeRawParser = bodyParser.raw({ type: "application/json" });

/** ---------- LOG FIRESTORE ---------- **/
if (!db) {
  console.error("❌ Firestore está OFF. Corrige Render Secret Files / ENV!");
} else {
  console.log("✅ Firestore (db) parece OK no server.js");
}

/** ---------- CONFIG PAYWALL / PLANOS ---------- **/

// FREE: 30 mensagens por dia (do aluno)
const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 30);

// Anti-spam de oferta (só para não spammar se o aluno insistir em premium/áudio)
const PAYWALL_COOLDOWN_HOURS = Number(process.env.PAYWALL_COOLDOWN_HOURS || 20);

// Link Stripe Payment Link base (vai anexar client_reference_id)
const STRIPE_PAYMENT_LINK_URL = String(
  process.env.STRIPE_PAYMENT_LINK_URL || "https://buy.stripe.com/00w28qchVgVQdfm1eS9ws01"
).trim();

// Preço exibido na mensagem (PT/INT)
const PREMIUM_PRICE_EUR = String(process.env.PREMIUM_PRICE_EUR || "9,99€").trim();
const PREMIUM_PERIOD_TEXT = String(process.env.PREMIUM_PERIOD_TEXT || "mês").trim(); // "mês" ou "30 dias"

// ✅ Brasil (PIX manual) via ENV (Render)
const BR_PIX_NAME = String(process.env.BR_PIX_NAME || "Ademandra Francisco");
const BR_PIX_BANK = String(process.env.BR_PIX_BANK || "Nubank");
const BR_PIX_KEY = String(process.env.BR_PIX_KEY || "23848408864");
const BR_PIX_AMOUNT = String(process.env.BR_PIX_AMOUNT || "R$ 49,90");

// ✅ Angola (transferência manual) via ENV (Render)
const AO_BANK_NAME = String(process.env.AO_BANK_NAME || "Joana Bamba");
const AO_IBAN = String(process.env.AO_IBAN || "AO06000500002771833310197");
const AO_AMOUNT = String(process.env.AO_AMOUNT || "13.000 Kz");

/** ---------- “DB” em memória (cache) ---------- **/
const students = {};
const processedMessages = new Set();
const lastMomentByPhone = {};
const lastTextByPhone = {};

/** ---------- Trilhas de ensino (módulos) ---------- **/
const learningPath = {
  ingles: [
    { id: "en_a0_1", title: "Cumprimentos e apresentações", level: "A0", steps: 4, goal: "Dizer olá e se apresentar." },
    { id: "en_a0_2", title: "Idade, cidade e país", level: "A0", steps: 4, goal: "Dizer idade e de onde é." },
    { id: "en_a0_3", title: "Rotina diária simples", level: "A1", steps: 4, goal: "Descrever rotina no presente." },
  ],
  frances: [
    { id: "fr_a0_1", title: "Cumprimentos básicos", level: "A0", steps: 4, goal: "Cumprimentar e despedir-se." },
    { id: "fr_a0_2", title: "Apresentar-se", level: "A0", steps: 4, goal: "Dizer nome/idade/país." },
    { id: "fr_a0_3", title: "Rotina simples", level: "A1", steps: 4, goal: "Descrever rotina com verbos básicos." },
  ],
};

/** ---------- Helpers ---------- **/
function normalizarTexto(txt = "") {
  return String(txt).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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
  const palavras = ["sim", "quero", "ok", "certo", "entendi", "vamos", "claro", "pode"];
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
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

function safeToDate(val) {
  if (!val) return null;
  if (typeof val.toDate === "function") return val.toDate();
  const d = val instanceof Date ? val : new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

/** Detecta país pelo prefixo */
function detectarPaisPorTelefone(phone = "") {
  const p = String(phone || "").replace(/\D/g, "");
  if (p.startsWith("351")) return "PT";
  if (p.startsWith("55")) return "BR";
  if (p.startsWith("244")) return "AO";
  return "INT";
}

/** Link Stripe com client_reference_id */
function gerarStripeLinkParaTelefone(phone) {
  const ref = `whatsapp:${String(phone || "").replace(/\D/g, "")}`;
  const glue = STRIPE_PAYMENT_LINK_URL.includes("?") ? "&" : "?";
  return `${STRIPE_PAYMENT_LINK_URL}${glue}client_reference_id=${encodeURIComponent(ref)}`;
}

/** ✅ Mensagem Premium quando bater o limite (COM limite) */
function montarMensagemOfertaPremiumComLimite(phone) {
  const pais = detectarPaisPorTelefone(phone);

  const base = [
    `Você atingiu o limite do *plano grátis (${FREE_DAILY_LIMIT} mensagens hoje)*.`,
    ``,
    `Com o *Acesso Premium* por apenas *${PREMIUM_PRICE_EUR}/${PREMIUM_PERIOD_TEXT}*, você desbloqueia:`,
    `✅ Mensagens *ilimitadas* todos os dias`,
    `✅ Prática de *conversa real*, sem interrupções`,
    `✅ *Áudios* para treinar pronúncia quando quiser`,
    `✅ Correções personalizadas no seu nível`,
    ``,
    `Sem fidelização. Cancele quando quiser.`,
    ``,
  ].join("\n");

  if (pais === "PT" || pais === "INT") {
    const link = gerarStripeLinkParaTelefone(phone);
    return base + `👉 *Ativar Premium agora (Stripe):*\n${link}\n\nAssim que o pagamento confirmar, eu libero automaticamente ✅`;
  }

  if (pais === "BR") {
    return (
      base +
      `👉 *Ativar Premium por 30 dias (${BR_PIX_AMOUNT})*\n` +
      `Pix (CPF): ${BR_PIX_KEY}\n` +
      `Nome: ${BR_PIX_NAME}\n` +
      `Banco: ${BR_PIX_BANK}\n\n` +
      `Após o pagamento, envie aqui o comprovativo que eu libero ✅`
    );
  }

  return (
    base +
    `👉 *Ativar Premium por 30 dias (${AO_AMOUNT})*\n` +
    `Nome: ${AO_BANK_NAME}\n` +
    `IBAN: ${AO_IBAN}\n\n` +
    `Após o pagamento, envie aqui o comprovativo que eu libero ✅`
  );
}

/** ✅ Mensagem Premium quando pedir ÁUDIO (SEM falar do limite) */
function montarMensagemPremiumPorAudio(phone) {
  const pais = detectarPaisPorTelefone(phone);

  const base = [
    `🔒 Áudios são exclusivos do *Acesso Premium*.`,
    ``,
    `Com o *Acesso Premium* por apenas *${PREMIUM_PRICE_EUR}/${PREMIUM_PERIOD_TEXT}*, você desbloqueia:`,
    `✅ Mensagens *ilimitadas* todos os dias`,
    `✅ Prática de *conversa real*, sem interrupções`,
    `✅ *Áudios* para treinar pronúncia quando quiser`,
    `✅ Correções personalizadas no seu nível`,
    ``,
    `Sem fidelização. Cancele quando quiser.`,
    ``,
  ].join("\n");

  if (pais === "PT" || pais === "INT") {
    const link = gerarStripeLinkParaTelefone(phone);
    return base + `👉 *Ativar Premium agora (Stripe):*\n${link}\n\nAssim que o pagamento confirmar, eu libero automaticamente ✅`;
  }

  if (pais === "BR") {
    return (
      base +
      `👉 *Ativar Premium por 30 dias (${BR_PIX_AMOUNT})*\n` +
      `Pix (CPF): ${BR_PIX_KEY}\n` +
      `Nome: ${BR_PIX_NAME}\n` +
      `Banco: ${BR_PIX_BANK}\n\n` +
      `Após o pagamento, envie aqui o comprovativo que eu libero ✅`
    );
  }

  return (
    base +
    `👉 *Ativar Premium por 30 dias (${AO_AMOUNT})*\n` +
    `Nome: ${AO_BANK_NAME}\n` +
    `IBAN: ${AO_IBAN}\n\n` +
    `Após o pagamento, envie aqui o comprovativo que eu libero ✅`
  );
}

/** Decide se é Premium */
function isPremium(aluno, now = new Date()) {
  const plan = aluno?.plan || "free";
  const until = safeToDate(aluno?.premiumUntil);
  if (until && until.getTime() > now.getTime()) return true;
  return plan === "premium" && !until ? true : false;
}

/** Reset/incremento do contador diário (mensagens do aluno) */
function updateDailyCounter(aluno, now = new Date()) {
  const key = todayKeyUTC(now);
  if (!aluno.dailyDate || aluno.dailyDate !== key) {
    aluno.dailyDate = key;
    aluno.dailyCount = 0;
  }
  aluno.dailyCount = (aluno.dailyCount || 0) + 1;
  return aluno.dailyCount;
}

/** Pode mandar prompt de paywall agora? */
function canSendPaywallPrompt(aluno, now = new Date()) {
  const last = safeToDate(aluno.lastPaywallPromptAt);
  if (!last) return true;
  const diffH = (now.getTime() - last.getTime()) / (1000 * 60 * 60);
  return diffH >= PAYWALL_COOLDOWN_HOURS;
}

/** ---------- ÁUDIO: detectar pedido ---------- **/
function userQuerAudio(texto = "", isAudio = false) {
  const t = normalizarTexto(texto || "");
  const gatilhos = [
    "manda audio",
    "manda áudio",
    "envia audio",
    "envia áudio",
    "mensagem de voz",
    "msg de voz",
    "responde em audio",
    "responde em áudio",
    "pode enviar audio",
    "pode enviar áudio",
    "envia por audio",
    "envia por áudio",
    "audio",
    "áudio",
    "pronuncia",
    "pronúncia",
  ];
  const pediuPorTexto = gatilhos.some((p) => t.includes(p));
  const pediuPorAudio = isAudio && gatilhos.some((p) => t.includes(p));
  return pediuPorTexto || pediuPorAudio;
}

/** Modo */
function detectarComandoModo(texto = "") {
  const t = normalizarTexto(texto);
  const querConversa =
    t.includes("modo conversa") ||
    t === "conversa" ||
    t.includes("quero conversar") ||
    t.includes("vamos conversar") ||
    t.includes("só conversar") ||
    t.includes("so conversar");

  const querAprender =
    t.includes("modo aprender") ||
    t.includes("modo aula") ||
    t === "aprender" ||
    t.includes("quero aprender") ||
    t.includes("me corrige") ||
    t.includes("corrigir");

  if (querConversa) return "conversa";
  if (querAprender) return "aprender";
  return null;
}

/** Tipos de mensagem (evitar Kito “traduzir” quando perguntam nome) */
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
    textoNorm.includes("what is your name") ||
    textoNorm.includes("who are you");

  if (isPerguntaSobreKito) return "pergunta_sobre_kito";

  if (
    textoNorm.includes("premium") ||
    textoNorm.includes("assinar") ||
    textoNorm.includes("pagar") ||
    textoNorm.includes("quero pagar") ||
    textoNorm.includes("quero assinar")
  )
    return "pedido_premium";

  return "geral";
}

/** Perfil pedagógico simples */
function inferirNivelPercebido(texto) {
  const t = normalizarTexto(texto);
  if (t.includes("nunca") || t.includes("zero") || t.includes("começar do zero")) return { nivelPercebido: "iniciante", nivelCEFR: "A0" };
  if (t.includes("basico") || t.includes("básico") || t.includes("pouco")) return { nivelPercebido: "básico", nivelCEFR: "A1" };
  if (t.includes("intermediario") || t.includes("intermediário")) return { nivelPercebido: "intermediário", nivelCEFR: "A2/B1" };
  if (t.includes("avancado") || t.includes("avançado") || t.includes("fluente")) return { nivelPercebido: "avançado", nivelCEFR: "B2+" };
  return { nivelPercebido: "iniciante", nivelCEFR: "A0" };
}

function inferirMaiorDificuldade(texto) {
  const t = normalizarTexto(texto);
  if (t.includes("pronuncia") || t.includes("falar")) return "pronúncia / fala";
  if (t.includes("gramatica")) return "gramática";
  if (t.includes("vocabulario") || t.includes("palavra")) return "vocabulário";
  if (t.includes("escuta") || t.includes("ouvir")) return "escuta / compreensão auditiva";
  if (t.includes("vergonha") || t.includes("medo")) return "medo / vergonha de falar";
  return texto;
}

function inferirPreferenciaFormato(texto) {
  const t = normalizarTexto(texto);
  if (t.includes("audio") || t.includes("áudio")) return "audio";
  if (t.includes("texto") || t.includes("mensagem")) return "texto";
  if (t.includes("os dois") || t.includes("mistur") || t.includes("tanto faz")) return "misto";
  return "misto";
}

function inferirFrequenciaPreferida(texto) {
  const t = normalizarTexto(texto);
  if (t.includes("todo dia") || t.includes("todos os dias") || t.includes("diario")) return "diario";
  if (t.includes("5x") || t.includes("5 vezes") || t.includes("cinco vezes")) return "5x";
  if (t.includes("3x") || t.includes("3 vezes") || t.includes("tres vezes")) return "3x";
  if (t.includes("so quando") || t.includes("só quando") || t.includes("quando eu falar")) return "livre";
  return "3x";
}

/** ---------- Firestore: salvar / carregar ---------- **/
async function saveStudentToFirestore(phone, aluno) {
  try {
    if (!db) {
      console.error("🔥🔥🔥 NÃO SALVOU NO FIRESTORE (db OFF). Isso causa 'esquecer' após deploy/restart.");
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

        // PAYWALL
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
    console.error("❌ Erro ao salvar aluno no Firestore:", err?.message || err);
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
    console.error("❌ Erro ao carregar aluno do Firestore:", err?.message || err);
    return null;
  }
}

/** ---------- OpenAI (Kito) ---------- **/
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function limparTextoResposta(txt = "") {
  if (!txt) return "";
  return String(txt).replace(/\n{3,}/g, "\n\n").trim();
}

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
Tu és o **Kito**, professor oficial da **Jovika Academy** (inglês e francês) no WhatsApp.

MODO DO ALUNO:
- chatMode: "${modo}"
- Se chatMode="conversa": responda humano e natural (sem correção automática). No final pergunte se quer correção.
- Se chatMode="aprender": ensine e corrija com explicação curta.

IMPORTANTE:
- Se tipo="pergunta_sobre_kito": responda direto (sem lição, sem tradução).
- Se tipo="pedido_traducao": traduza e explique curto.
- Se tipo="pedido_premium": responda curto, convidando para Premium (sem falar de limite se não for o caso).
- Se o aluno disser "I'm fine and you?" / "How are you?" etc, responda natural (ex: "I'm good, thanks! And you?") em vez de traduzir.

ESTILO:
- Português do Brasil (você).
- Curto estilo WhatsApp (2 blocos no máximo + 1 pergunta).
- Emojis com moderação (máximo 1).

PERFIL:
Nome: ${aluno.nome || "não informado"}
Idioma: ${idiomaAlvo}
Nível: ${aluno.nivel || "A0"}
Objetivo: ${aluno.objetivo || "não definido"}

MÓDULO:
${modulo?.title || "Introdução"} — passo ${step} de ${totalSteps}
  `.trim();

  const mensagens = [{ role: "system", content: systemPrompt }, ...history.slice(-10)];

  const resposta = await openai.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    input: mensagens,
  });

  const textoGerado = resposta.output?.[0]?.content?.[0]?.text || "Desculpa, deu um erro aqui. Tente de novo 🙏";
  return limparTextoResposta(textoGerado);
}

/** ---------- Enviar mensagem pela Z-API ---------- **/
async function enviarMensagemWhatsApp(phone, message) {
  try {
    const msg = String(message || "").trim();
    if (!msg) {
      console.warn("⚠️ Z-API: tentou enviar mensagem vazia — ignorado.");
      return;
    }

    const instanceId = process.env.ZAPI_INSTANCE_ID;
    const instanceToken = process.env.ZAPI_INSTANCE_TOKEN;
    const clientToken = process.env.ZAPI_CLIENT_TOKEN;

    if (!instanceId || !instanceToken) {
      console.error("❌ Z-API: falta ZAPI_INSTANCE_ID ou ZAPI_INSTANCE_TOKEN no ENV");
      return;
    }

    const url = `https://api.z-api.io/instances/${instanceId}/token/${instanceToken}/send-text`;
    const payload = { phone, message: msg };

    const headers = { "Content-Type": "application/json" };
    if (clientToken) headers["Client-Token"] = clientToken;

    const resp = await axios.post(url, payload, { headers });
    console.log("📤 Mensagem enviada via Z-API para", phone, "resp:", resp.data);
  } catch (err) {
    console.error("❌ Erro ao enviar mensagem via Z-API:", err.response?.data || err.message);
  }
}

/** ---------- ÁUDIO (TTS) – SOMENTE PREMIUM ---------- **/
async function gerarAudioRespostaKito(texto, idiomaAlvo = null) {
  try {
    const clean = String(texto || "").trim();
    if (!clean) return null;

    const instructions =
      idiomaAlvo === "ingles"
        ? "Speak in clear, neutral English with a natural MALE voice. Talk slowly and clearly for beginners."
        : idiomaAlvo === "frances"
        ? "Parle en français standard de France, voix masculine naturelle, lent et très clair pour débutants."
        : "Speak clearly and naturally. If Portuguese, use Brazilian Portuguese. If French, use France accent.";

    const speech = await openai.audio.speech.create({
      model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
      voice: process.env.OPENAI_TTS_VOICE || "onyx",
      instructions,
      input: clean,
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

async function enviarAudioWhatsApp(phone, audioBase64) {
  try {
    if (!audioBase64) {
      console.warn("⚠️ Áudio vazio (base64 null) — não enviou.");
      return;
    }

    const instanceId = process.env.ZAPI_INSTANCE_ID;
    const instanceToken = process.env.ZAPI_INSTANCE_TOKEN;
    const clientToken = process.env.ZAPI_CLIENT_TOKEN;

    if (!instanceId || !instanceToken) {
      console.error("❌ Z-API: falta ZAPI_INSTANCE_ID ou ZAPI_INSTANCE_TOKEN no ENV (áudio)");
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

/** ---------- LÓGICA PRINCIPAL ---------- **/
async function processarMensagemAluno({ numeroAluno, texto, profileName, isAudio }) {
  const agora = new Date();
  let aluno = students[numeroAluno];

  // (1) Carrega do Firestore se não tem em memória
  if (!aluno) {
    const fromDb = await loadStudentFromFirestore(numeroAluno);
    if (fromDb) {
      aluno = { ...fromDb, history: [] };
      students[numeroAluno] = aluno;
    }
  }

  // (2) Se continua nulo, cria novo
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

      // paywall
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
    const msg = `Olá, ${primeiroNome}! 😄 Eu sou o Kito, professor de inglês e francês da Jovika Academy.\nComo você quer que eu chame você?`;

    aluno.history.push({ role: "assistant", content: msg });
    await enviarMensagemWhatsApp(numeroAluno, msg);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  // Atualiza stats básicos
  aluno.messagesCount = (aluno.messagesCount || 0) + 1;
  aluno.lastMessageAt = agora;
  aluno.history = aluno.history || [];

  // Conta mensagens do aluno por dia (persistente)
  const dailyCount = updateDailyCounter(aluno, agora);

  const premium = isPremium(aluno, agora);
  const querAudioPorPedido = userQuerAudio(texto, isAudio);

  /**
   * ✅ REGRA A (prioridade máxima):
   * Se pedir áudio e NÃO for premium -> oferta Premium SEM falar do limite.
   * (Mesmo que ele esteja perto do limite, não mistura as mensagens.)
   */
  if (querAudioPorPedido && !premium) {
    // opcional: respeitar cooldown para não spammar se ele insistir várias vezes
    if (canSendPaywallPrompt(aluno, agora)) aluno.lastPaywallPromptAt = agora;

    const msg = montarMensagemPremiumPorAudio(numeroAluno);
    aluno.history.push({ role: "assistant", content: msg });
    await enviarMensagemWhatsApp(numeroAluno, msg);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  /**
   * ✅ REGRA B:
   * Paywall só quando PASSAR do limite.
   * E quando passar -> sempre enviar a oferta completa com link/dados (NUNCA mensagem sem link).
   */
  if (!premium && dailyCount > FREE_DAILY_LIMIT) {
    const offer = montarMensagemOfertaPremiumComLimite(numeroAluno);
    aluno.lastPaywallPromptAt = agora;
    aluno.history.push({ role: "assistant", content: offer });
    await enviarMensagemWhatsApp(numeroAluno, offer);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  // Histórico do usuário
  aluno.history.push({ role: "user", content: String(texto || "") });

  // Atalho: aluno pede premium -> manda oferta (sem falar de limite)
  const textoNormQuick = normalizarTexto(texto || "");
  const tipoQuick = detectarTipoMensagem(textoNormQuick);
  if (tipoQuick === "pedido_premium") {
    const msg = montarMensagemPremiumPorAudio(numeroAluno);
    aluno.lastPaywallPromptAt = agora;
    aluno.history.push({ role: "assistant", content: msg });
    await enviarMensagemWhatsApp(numeroAluno, msg);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  // Troca de modo
  const comandoModo = detectarComandoModo(texto || "");
  if (comandoModo && aluno.stage !== "ask_name" && aluno.stage !== "ask_language") {
    aluno.chatMode = comandoModo;
    const msgModo =
      comandoModo === "conversa"
        ? "Perfeito 😊 A partir de agora a gente conversa para você praticar. Se quiser que eu corrija tudo, diga: modo aprender."
        : "Combinado 💪 A partir de agora eu vou te ensinar e corrigir. Se quiser só praticar sem correção, diga: modo conversa.";

    aluno.history.push({ role: "assistant", content: msgModo });
    await enviarMensagemWhatsApp(numeroAluno, msgModo);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  // Onboarding
  if (aluno.stage === "ask_name" && !aluno.nome) {
    aluno.nome = extrairNome(texto) || "Aluno";
    aluno.stage = "ask_language";

    const msg = `Perfeito, ${aluno.nome}! 😄 Agora me conta: você quer começar por inglês, francês ou os dois?`;
    aluno.history.push({ role: "assistant", content: msg });
    await enviarMensagemWhatsApp(numeroAluno, msg);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  if (aluno.stage === "ask_language") {
    const idioma = detectarIdioma(texto);
    if (!idioma) {
      const msg = "Acho que não entendi muito bem 😅\nResponda só com: inglês, francês ou os dois.";
      aluno.history.push({ role: "assistant", content: msg });
      await enviarMensagemWhatsApp(numeroAluno, msg);
      await saveStudentToFirestore(numeroAluno, aluno);
      return;
    }

    aluno.idioma = idioma;
    aluno.stage = "ask_experience";
    aluno.moduleIndex = 0;
    aluno.moduleStep = 0;
    aluno.nivel = "A0";

    const idiomaTexto = idioma === "ingles" ? "inglês" : idioma === "frances" ? "francês" : "inglês e francês";
    const msg = `Ótimo, ${aluno.nome}! Vamos trabalhar ${idiomaTexto} juntos 💪✨\nAntes de começar, você já estudou ${idiomaTexto} antes?`;

    aluno.history.push({ role: "assistant", content: msg });
    await enviarMensagemWhatsApp(numeroAluno, msg);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  if (aluno.stage === "ask_experience") {
    const { nivelPercebido, nivelCEFR } = inferirNivelPercebido(texto);
    aluno.nivelPercebido = nivelPercebido;
    aluno.nivel = aluno.nivel || nivelCEFR;
    aluno.stage = "ask_difficulty";

    const msg = `Perfeito, entendi. 😊\nAgora me conta: no ${aluno.idioma === "frances" ? "francês" : "inglês"}, o que você sente que é mais difícil hoje?`;
    aluno.history.push({ role: "assistant", content: msg });
    await enviarMensagemWhatsApp(numeroAluno, msg);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  if (aluno.stage === "ask_difficulty") {
    aluno.maiorDificuldade = inferirMaiorDificuldade(texto);
    aluno.stage = "ask_preference_format";

    const msg = "Ótimo 😊 Você prefere que eu explique por mensagem escrita, por áudio (Premium) ou misturando?";
    aluno.history.push({ role: "assistant", content: msg });
    await enviarMensagemWhatsApp(numeroAluno, msg);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  if (aluno.stage === "ask_preference_format") {
    aluno.preferenciaFormato = inferirPreferenciaFormato(texto);
    aluno.stage = "ask_frequency";

    const msg = "Show! Você prefere que eu te puxe todos os dias, 3x por semana, 5x por semana ou só quando você falar comigo?";
    aluno.history.push({ role: "assistant", content: msg });
    await enviarMensagemWhatsApp(numeroAluno, msg);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  if (aluno.stage === "ask_frequency") {
    aluno.frequenciaPreferida = inferirFrequenciaPreferida(texto);
    aluno.stage = "ask_mode";

    const msg =
      "Antes de começarmos: você quer que eu seja mais como parceiro de conversa ou como professor corrigindo?\n\nResponda:\n1) conversar\n2) aprender\n\nVocê pode mudar quando quiser: modo conversa / modo aprender.";
    aluno.history.push({ role: "assistant", content: msg });
    await enviarMensagemWhatsApp(numeroAluno, msg);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  if (aluno.stage === "ask_mode") {
    const t = normalizarTexto(texto);
    const escolheuConversa = t.includes("1") || t.includes("convers");
    const escolheuAprender = t.includes("2") || t.includes("aprender") || t.includes("corrig");

    if (!escolheuConversa && !escolheuAprender) {
      const msg = "Só para eu acertar seu estilo 😊\nResponda com:\n1) conversar\n2) aprender";
      aluno.history.push({ role: "assistant", content: msg });
      await enviarMensagemWhatsApp(numeroAluno, msg);
      await saveStudentToFirestore(numeroAluno, aluno);
      return;
    }

    aluno.chatMode = escolheuAprender ? "aprender" : "conversa";
    aluno.stage = "learning";

    const idiomaTexto = aluno.idioma === "ingles" ? "inglês" : aluno.idioma === "frances" ? "francês" : "inglês e francês";
    const msg =
      aluno.chatMode === "conversa"
        ? `Perfeito 😊 Vamos conversar para você praticar ${idiomaTexto}.\nAgora me conte: qual é o seu principal objetivo com ${idiomaTexto}?`
        : `Combinado 💪 Vou te ensinar e corrigir em ${idiomaTexto}.\nAgora me conte: qual é o seu principal objetivo com ${idiomaTexto}?`;

    aluno.history.push({ role: "assistant", content: msg });
    await enviarMensagemWhatsApp(numeroAluno, msg);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  // Learning
  if (aluno.stage !== "learning") aluno.stage = "learning";
  if (!aluno.objetivo) aluno.objetivo = texto;

  const textoNorm = normalizarTexto(texto || "");
  const tipoMensagem = detectarTipoMensagem(textoNorm);

  const idiomaChave = aluno.idioma === "frances" ? "frances" : "ingles";
  const trilha = learningPath[idiomaChave] || learningPath["ingles"];

  let moduleIndex = aluno.moduleIndex ?? 0;
  let moduleStep = aluno.moduleStep ?? 0;

  if (moduleIndex >= trilha.length) moduleIndex = trilha.length - 1;
  const moduloAtual = trilha[moduleIndex] || trilha[0];

  const confirmacao = isConfirmMessage(texto);

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

  // ✅ ÁUDIO SÓ PREMIUM
  const chatMode = aluno.chatMode || "conversa";
  const espelharAudioPremium = Boolean(process.env.MIRROR_AUDIO_PREMIUM === "true");
  const deveMandarAudio = premium && (querAudioPorPedido || (isAudio && chatMode === "conversa" && espelharAudioPremium));

  const idiomaAudioAlvo = aluno.idioma === "ingles" || aluno.idioma === "frances" ? aluno.idioma : null;

  if (deveMandarAudio) {
    const audioBase64 = await gerarAudioRespostaKito(respostaKito, idiomaAudioAlvo);
    await enviarAudioWhatsApp(numeroAluno, audioBase64);
  }

  await sleep(800);
  await enviarMensagemWhatsApp(numeroAluno, respostaKito);

  students[numeroAluno] = aluno;
  await saveStudentToFirestore(numeroAluno, aluno);
}

/** ---------- STRIPE WEBHOOK (OPCIONAL) ---------- **/
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

        // se for subscription, tenta buscar period_end
        if (session.subscription) {
          try {
            const sub = await stripe.subscriptions.retrieve(session.subscription);
            if (sub?.current_period_end) premiumUntil = new Date(sub.current_period_end * 1000);
          } catch (e) {
            console.warn("⚠️ Não consegui buscar subscription:", e.message);
          }
        }

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

        // atualiza cache
        if (students[phone]) {
          students[phone].plan = "premium";
          students[phone].paymentProvider = "stripe";
          students[phone].premiumUntil = premiumUntil;
        }

        await enviarMensagemWhatsApp(
          phone,
          "🎉 Pagamento confirmado! Seu *Acesso Premium* foi ativado.\nAgora você pode praticar sem limites ✅\n\nO que você quer praticar agora?"
        );
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error("❌ Erro no Stripe webhook:", err.message);
    res.status(500).send("webhook_error");
  }
});

/** ---------- ADMIN: ativar Premium manual ---------- **/
app.get("/admin/activate", async (req, res) => {
  try {
    if (!db) return res.status(500).send("firestore_off");

    const token = req.query.token;
    if (!token || token !== process.env.ADMIN_TOKEN) return res.status(401).send("Não autorizado");

    const phone = String(req.query.phone || "").replace(/\D/g, "");
    const days = Number(req.query.days || 30);
    const provider = String(req.query.provider || "manual");

    if (!phone) return res.status(400).send("phone_required");

    const now = new Date();
    const premiumUntil = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const docRef = db.collection("students").doc(`whatsapp:${phone}`);
    await docRef.set(
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
      "🎉 Pronto! Seu *Acesso Premium* foi ativado.\nAgora você pode praticar sem limites ✅\n\nO que você quer praticar agora?"
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
    if (data.type !== "ReceivedCallback") return res.status(200).send("ignored_non_received");

    const msgId = data.messageId;
    const numeroAluno = String(data.phone || "").replace(/\D/g, "");
    const momentVal = data.momment;
    const texto = data.text?.message || null;

    if (!numeroAluno) return res.status(200).send("no_phone");

    if (processedMessages.has(msgId)) return res.status(200).send("duplicate_ignored");
    processedMessages.add(msgId);

    if (momentVal && lastMomentByPhone[numeroAluno] === momentVal) return res.status(200).send("duplicate_moment_ignored");
    if (momentVal) lastMomentByPhone[numeroAluno] = momentVal;

    const agora = Date.now();
    const ultimo = lastTextByPhone[numeroAluno];
    if (texto && ultimo && ultimo.text === texto && agora - ultimo.time < 3000) return res.status(200).send("duplicate_text_recent");
    if (texto) lastTextByPhone[numeroAluno] = { text: texto, time: agora };

    const profileName = data.senderName || data.chatName || "Aluno";

    if (!texto) {
      // se vier sem texto, ignora (o teu fluxo de transcrição não está ativo aqui)
      return res.status(200).send("no_text");
    }

    await processarMensagemAluno({ numeroAluno, texto, profileName, isAudio: false });
    res.status(200).send("ok");
  } catch (erro) {
    console.error("❌ Erro no webhook Z-API:", erro?.response?.data || erro.message);
    res.status(500).send("erro");
  }
});

/** ---------- DASHBOARD simples ---------- **/
app.get("/admin/dashboard", (req, res) => {
  const token = req.query.token;
  if (!token || token !== process.env.ADMIN_TOKEN) return res.status(401).send("Não autorizado");

  const alunos = Object.entries(students).map(([numero, dados]) => ({
    numero,
    nome: dados.nome || "-",
    idioma: dados.idioma || "-",
    nivel: dados.nivel || "-",
    mensagens: dados.messagesCount || 0,
    stage: dados.stage,
    chatMode: dados.chatMode || "-",
    dailyCount: dados.dailyCount || 0,
    dailyDate: dados.dailyDate || "-",
    plan: dados.plan || "free",
    premiumUntil: dados.premiumUntil ? formatDate(dados.premiumUntil) : "-",
  }));

  res.json({ total: alunos.length, freeDailyLimit: FREE_DAILY_LIMIT, alunos });
});

/** ---------- ROOT ---------- **/
app.get("/", (req, res) => {
  res.send("Kito (Jovika Academy) está a correr ✅");
});

/** ---------- START ---------- **/
app.listen(PORT, () => {
  console.log(`🚀 Kito no ar em http://localhost:${PORT}`);
});
