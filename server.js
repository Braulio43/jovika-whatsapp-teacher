// server.js – Kito, professor da Jovika Academy
// Z-API + memória + módulos + Dashboard + Firestore + ÁUDIO SOB PEDIDO
// ✅ + LEMBRETE anti-spam (a cada 2 dias) via /cron/tick (cron externo)

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

console.log(
  "🔥🔥🔥 KITO v4.8.1 – FIX PREMIUM (não rebaixa) + TEXTO + ÁUDIO SOB PEDIDO + LEMBRETE 2D 🔥🔥🔥"
);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Para receber JSON da Z-API
app.use(bodyParser.json());

// "Base de dados" simples em memória (cache)
const students = {};
const processedMessages = new Set();
const lastMomentByPhone = {};
const lastTextByPhone = {};

/** ---------- CONFIG: LEMBRETES (ANTI-SPAM) ---------- **/
const REMINDER_ENABLED = String(process.env.REMINDER_ENABLED || "1") === "1";
const REMINDER_EVERY_HOURS = Number(process.env.REMINDER_EVERY_HOURS || 48); // 2 dias
const REMINDER_QUERY_LIMIT = Number(process.env.REMINDER_QUERY_LIMIT || 250); // quantos por tick
const REMINDER_MIN_SILENCE_HOURS = Number(process.env.REMINDER_MIN_SILENCE_HOURS || 48); // só manda se aluno ficou Xh sem falar
const REMINDER_COOLDOWN_HOURS = Number(process.env.REMINDER_COOLDOWN_HOURS || 48); // não repetir em menos de Xh

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

// Detecta respostas tipo "sim", "bora", "vamos", "quero"
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

function safeToDate(val) {
  if (!val) return null;
  if (typeof val?.toDate === "function") return val.toDate(); // Firestore Timestamp
  const d = val instanceof Date ? val : new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function hoursDiff(now, past) {
  if (!now || !past) return Infinity;
  const a = safeToDate(now);
  const b = safeToDate(past);
  if (!a || !b) return Infinity;
  return (a.getTime() - b.getTime()) / (1000 * 60 * 60);
}

function addHours(date, hours) {
  const d = safeToDate(date) || new Date();
  return new Date(d.getTime() + Number(hours || 0) * 60 * 60 * 1000);
}

// 🔊 Detecta se o aluno está a pedir ÁUDIO
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

  return Boolean(pediuPorTexto || pediuPorAudio);
}

// Limpa coisas que não queremos que apareçam/lêem, tipo "[Áudio enviado]" ou "(Áudio)"
function limparTextoResposta(txt = "") {
  if (!txt) return "";
  let r = String(txt);

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

/**
 * Extrai apenas as linhas do idioma alvo para o áudio
 */
function extrairTrechoParaAudio(texto = "", idiomaAlvo = null) {
  const linhas = String(texto)
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

/** ---------- PAYWALL PREMIUM (Express) ---------- **/

const EXPRESS_PAY_NUMBER = "922394075";
const PREMIUM_PRICE_KZ = "13.000 Kz";

function montarMensagemPaywallPremium() {
  return (
    `👋 Olá! Eu sou o Kito, professor de inglês e francês da Jovika Academy.\n\n` +
    `Para usar o **Kito Premium**, é necessário ativar o acesso.\n` +
    `💰 Valor: **${PREMIUM_PRICE_KZ} / mês**\n\n` +
    `⭐ Vantagens do Premium:\n` +
    `• 🎧 Áudios com pronúncia correta (inglês/francês)\n` +
    `• 📘 Aulas personalizadas no seu nível\n` +
    `• 🔁 Correção dos seus erros em tempo real\n` +
    `• 🗣️ Treino de conversação com exemplos práticos\n` +
    `• ⏰ Acompanhamento 24/24h, no seu ritmo\n\n` +
    `💳 Como ativar (Express – Angola 🇦🇴):\n` +
    `1) Faça o pagamento via **Express** para: **${EXPRESS_PAY_NUMBER}**\n` +
    `2) Envie o **comprovativo** aqui no WhatsApp\n` +
    `3) A nossa equipa vai **ativar o seu acesso** ✅\n\n` +
    `Assim que ativar, você pode falar comigo à vontade.`
  );
}

function isPremium(aluno) {
  return aluno && aluno.premium === true;
}

/**
 * Refresh premium do Firestore (resolve cache em memória)
 * - Se premium estiver false em memória, checa no Firestore.
 * - Se no Firestore for true, atualiza o aluno em memória.
 */
async function refreshPremiumIfNeeded(phone, aluno) {
  try {
    if (!db) return aluno;
    if (aluno?.premium === true) return aluno;

    const snap = await db.collection("students").doc(`whatsapp:${phone}`).get();
    if (!snap.exists) return aluno;

    const data = snap.data();
    if (data?.premium === true) {
      aluno.premium = true;
      students[phone] = aluno;
    }
    return aluno;
  } catch (e) {
    console.error("⚠️ Falha ao refresh premium:", e?.message || e);
    return aluno;
  }
}

/**
 * Se não for premium:
 * - mostra o paywall no máximo 2 vezes
 */
async function aplicarPaywallSeNecessario(numeroAluno, aluno) {
  const count = Number(aluno?.paywallShownCount || 0);

  if (count >= 2) {
    return { blocked: true, paywallSent: false };
  }

  const msg = montarMensagemPaywallPremium();
  await enviarMensagemWhatsApp(numeroAluno, msg);

  aluno.paywallShownCount = count + 1;
  aluno.paywallLastShownAt = new Date();

  return { blocked: true, paywallSent: true };
}

/** ---------- LEMBRETE: lógica (anti-spam) ---------- **/
function scheduleReminder(aluno, agora = new Date()) {
  // agenda para daqui 48h (ou o que estiver no ENV)
  aluno.reminderDueAt = addHours(agora, REMINDER_EVERY_HOURS);
  return aluno.reminderDueAt;
}

function shouldSendReminder(aluno, agora = new Date()) {
  if (!REMINDER_ENABLED) return false;
  if (!isPremium(aluno)) return false;

  const lastMsg = safeToDate(aluno.lastMessageAt);
  if (!lastMsg) return false;

  // só manda se ficou X horas sem falar
  const silenceH = hoursDiff(agora, lastMsg);
  if (silenceH < REMINDER_MIN_SILENCE_HOURS) return false;

  // cooldown: não repetir em menos de X horas
  const lastRem = safeToDate(aluno.lastReminderAt);
  if (lastRem) {
    const sinceLastRemH = hoursDiff(agora, lastRem);
    if (sinceLastRemH < REMINDER_COOLDOWN_HOURS) return false;
  }

  // dueAt (opcional) — se existir, respeita
  const due = safeToDate(aluno.reminderDueAt);
  if (due && due.getTime() > agora.getTime()) return false;

  return true;
}

function montarMensagemLembrete(aluno) {
  const nome = aluno?.nome ? `, ${aluno.nome}` : "";
  const idioma =
    aluno?.idioma === "frances" ? "francês" : aluno?.idioma === "ingles" ? "inglês" : "inglês ou francês";

  // curta, humana e sem parecer marketing
  return [
    `Oi${nome} 😊`,
    `Passando só para te lembrar da sua prática de ${idioma}.`,
    `Quer continuar de onde paramos? Se quiser, me diga: *“vamos continuar”*.`,
  ].join("\n");
}

/** ---------- Firebase: guardar / carregar aluno ---------- **/

async function saveStudentToFirestore(phone, aluno) {
  try {
    if (!db) {
      console.warn("⚠️ Firebase não inicializado — skip save");
      return;
    }

    let createdAt = aluno.createdAt;
    let lastMessageAt = aluno.lastMessageAt;

    if (createdAt && typeof createdAt.toDate === "function") createdAt = createdAt.toDate();
    if (lastMessageAt && typeof lastMessageAt.toDate === "function") lastMessageAt = lastMessageAt.toDate();

    if (!(createdAt instanceof Date) || isNaN(createdAt.getTime())) createdAt = new Date();
    if (!(lastMessageAt instanceof Date) || isNaN(lastMessageAt.getTime())) lastMessageAt = new Date();

    // ✅ IMPORTANTE:
    // - NÃO gravar premium=false (para não derrubar premium=true manual do Firebase)
    // - Só gravar premium quando for true.
    const dataToSave = {
      nome: aluno.nome ?? null,
      idioma: aluno.idioma ?? null,
      nivel: aluno.nivel ?? null,
      stage: aluno.stage ?? null,
      messagesCount: aluno.messagesCount ?? 0,
      moduleIndex: aluno.moduleIndex ?? 0,
      moduleStep: aluno.moduleStep ?? 0,
      createdAt,
      lastMessageAt,
      updatedAt: new Date(),

      paywallShownCount: aluno.paywallShownCount ?? 0,
      paywallLastShownAt: aluno.paywallLastShownAt ?? null,

      // ✅ lembretes
      reminderDueAt: safeToDate(aluno.reminderDueAt) || null,
      lastReminderAt: safeToDate(aluno.lastReminderAt) || null,
    };

    if (aluno.premium === true) dataToSave.premium = true;

    const docRef = db.collection("students").doc(`whatsapp:${phone}`);
    await docRef.set(dataToSave, { merge: true });
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

    // normaliza premium
    if (typeof data.premium !== "boolean") data.premium = data.premium === true;

    // normaliza datas
    data.createdAt = safeToDate(data.createdAt) || null;
    data.lastMessageAt = safeToDate(data.lastMessageAt) || null;
    data.paywallLastShownAt = safeToDate(data.paywallLastShownAt) || null;

    // ✅ lembretes
    data.reminderDueAt = safeToDate(data.reminderDueAt) || null;
    data.lastReminderAt = safeToDate(data.lastReminderAt) || null;

    return data;
  } catch (err) {
    console.error("❌ Erro ao carregar aluno do Firestore:", err.message);
    return null;
  }
}

/** ---------- OpenAI (Kito, professor da Jovika) ---------- **/

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function gerarRespostaKito(aluno, moduloAtual) {
  const history = aluno.history || [];
  const ultimoUser = history.filter((m) => m.role === "user").slice(-1)[0];
  const textoDoAluno = ultimoUser ? ultimoUser.content : "(sem mensagem recente)";

  console.log("🧠 Pergunta do aluno:", textoDoAluno);

  const idiomaAlvo =
    aluno.idioma === "frances"
      ? "FRANCÊS"
      : aluno.idioma === "ingles"
      ? "INGLÊS"
      : "INGLÊS E FRANCÊS";

  const idiomaChave = aluno.idioma === "frances" ? "frances" : "ingles";

  const trilha = learningPath[idiomaChave] || [];
  const moduloIndex = aluno.moduleIndex ?? 0;
  const modulo = moduloAtual || trilha[moduloIndex] || trilha[0];

  const step = aluno.moduleStep ?? 0;
  const totalSteps = modulo?.steps ?? 4;

  const systemPrompt = `
Tu és o **Kito**, professor oficial da **Jovika Academy**, uma escola moderna de inglês e francês
para jovens de Angola, Brasil e Portugal. Tu dás aulas pelo WhatsApp, de forma muito humana,
natural e inteligente (tipo ChatGPT, mas focado em idiomas).

IDENTIDADE DO KITO:
- Nome: Kito
- Papel: professor de INGLÊS e FRANCÊS da Jovika Academy
- Estilo: jovem, descontraído, empático, mas muito competente.
- Gosta de motivar, elogiar quando o aluno acerta e corrigir com carinho quando erra.

PORTUGUÊS DO BRASIL (IMPORTANTE):
- Escreve sempre em **português do Brasil**, com gramática correta.
- Usa "você" (não uses "tu") e evita gírias como "pra", "beleza?" ou "bora".
- Prefere "para", "porque", "tudo bem?", "vamos continuar?", etc.
- O tom é próximo, simpático e motivador, mas com escrita de professor.
- Quando escrever frases em francês, faz assim:
  - primeira linha: só a frase em francês;
  - linha seguinte: tradução em português do Brasil.
- Quando escrever frases em inglês, faz assim:
  - primeira linha: só a frase em inglês;
  - linha seguinte: tradução em português do Brasil.
- Evita misturar francês/inglês e português na mesma linha.

DADOS DO ALUNO:
- Nome: ${aluno.nome || "não informado"}
- Idioma alvo: ${idiomaAlvo}
- Nível aproximado: ${aluno.nivel || "iniciante"}
- Módulo atual: ${modulo?.title || "Introdução"}
- Nível do módulo: ${modulo?.level || aluno.nivel || "iniciante"}
- Objetivo do módulo: ${modulo?.goal || "ajudar o aluno a comunicar em situações básicas."}
- Passo atual (0-based): ${step}
- Número total de passos no módulo: ${totalSteps}

SOBRE ÁUDIO (MUITO IMPORTANTE):
- Tu consegues enviar áudios curtos de voz sintetizada quando o aluno pede.
- **NUNCA** digas que não consegues enviar áudio.
- **NUNCA** escrevas tags como "[Áudio enviado]" nem "Áudio:".
- **NÃO** digas "vou mandar um áudio". O sistema cuida do envio.
- Quando o aluno pedir áudio:
  1) Responde normalmente em texto.
  2) No final, pergunta: "Você prefere que eu continue também em áudio ou só por mensagem escrita?"

ESTILO:
- Frases curtas, parágrafos curtos, WhatsApp.
- No máximo 3 blocos e 1–2 emojis.
  `.trim();

  const mensagens = [{ role: "system", content: systemPrompt }, ...history.slice(-10)];

  const resposta = await openai.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    input: mensagens,
  });

  const textoGerado =
    resposta.output?.[0]?.content?.[0]?.text || "Desculpa, deu um erro aqui. Tente de novo 🙏";

  const textoLimpo = limparTextoResposta(textoGerado);

  console.log("🧠 Resposta do Kito (bruta):", textoGerado);
  console.log("🧠 Resposta do Kito (limpa):", textoLimpo);

  return textoLimpo;
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
      language: "pt",
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
    console.log("🎙️ Gerando áudio de resposta do Kito (sob pedido)...");

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

/** ---------- Z-API: enviar texto ---------- **/

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

/** ---------- Z-API: enviar áudio ---------- **/

async function enviarAudioWhatsApp(phone, audioBase64) {
  try {
    const instanceId = process.env.ZAPI_INSTANCE_ID;
    const instanceToken = process.env.ZAPI_INSTANCE_TOKEN;
    const clientToken = process.env.ZAPI_CLIENT_TOKEN;

    if (!instanceId || !instanceToken) {
      console.error("❌ Z-API: falta ZAPI_INSTANCE_ID ou ZAPI_INSTANCE_TOKEN no .env (áudio)");
      return;
    }

    const url = `https://api.z-api.io/instances/${instanceId}/token/${instanceToken}/send-audio`;

    const payload = {
      phone,
      audio: audioBase64,
      viewOnce: false,
      waveform: true,
    };

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
  let aluno = students[numeroAluno];
  const agora = new Date();

  // Se não está em memória, tenta buscar do Firestore
  if (!aluno) {
    const fromDb = await loadStudentFromFirestore(numeroAluno);
    if (fromDb) {
      const createdAt = safeToDate(fromDb.createdAt) || new Date();
      const lastMessageAt = safeToDate(fromDb.lastMessageAt) || new Date();

      aluno = {
        ...fromDb,
        createdAt,
        lastMessageAt,
        history: [],
      };
      students[numeroAluno] = aluno;
    }
  }

  // Novo aluno
  if (!aluno) {
    aluno = {
      stage: "ask_name",
      nome: null,
      idioma: null,
      nivel: "A0",
      messagesCount: 0,
      createdAt: agora,
      lastMessageAt: agora,
      moduleIndex: 0,
      moduleStep: 0,
      history: [],

      premium: false,
      paywallShownCount: 0,
      paywallLastShownAt: null,

      // ✅ lembretes
      reminderDueAt: null,
      lastReminderAt: null,
    };
    students[numeroAluno] = aluno;

    // ✅ refresh premium (caso alguém já tenha ativado antes)
    aluno = await refreshPremiumIfNeeded(numeroAluno, aluno);

    // ✅ HARD PAYWALL
    if (!isPremium(aluno)) {
      await aplicarPaywallSeNecessario(numeroAluno, aluno);
      await saveStudentToFirestore(numeroAluno, aluno);
      return;
    }

    // ✅ premium: agenda lembrete 48h (se sumir, lembra)
    scheduleReminder(aluno, agora);

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

  // ✅ refresh premium antes do paywall (resolve "volta para false")
  aluno = await refreshPremiumIfNeeded(numeroAluno, aluno);

  // ✅ HARD PAYWALL (antes de qualquer coisa)
  if (!isPremium(aluno)) {
    await aplicarPaywallSeNecessario(numeroAluno, aluno);
    students[numeroAluno] = aluno;
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  // ✅ premium: sempre que o aluno fala, reagenda o próximo lembrete (48h)
  scheduleReminder(aluno, agora);

  const prefix = isAudio ? "[ÁUDIO] " : "";
  aluno.history.push({ role: "user", content: `${prefix}${texto}` });

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
      aluno.stage = "learning";
      aluno.moduleIndex = 0;
      aluno.moduleStep = 0;
      aluno.nivel = "A0";

      const idiomaTexto =
        idioma === "ingles" ? "inglês" : idioma === "frances" ? "francês" : "inglês e francês";

      await enviarMensagemWhatsApp(
        numeroAluno,
        `Ótimo, ${aluno.nome}! Vamos trabalhar ${idiomaTexto} juntos 💪✨\n` +
          `Para eu te ajudar melhor, qual é o seu principal objetivo com esse idioma? Trabalho, viagem, faculdade, sair do país, ganhar confiança...?`
      );
    }
  } else {
    if (aluno.stage !== "learning") aluno.stage = "learning";

    const idiomaChave = aluno.idioma === "frances" ? "frances" : "ingles";
    const trilha = learningPath[idiomaChave] || learningPath["ingles"];

    let moduleIndex = aluno.moduleIndex ?? 0;
    let moduleStep = aluno.moduleStep ?? 0;
    if (moduleIndex >= trilha.length) moduleIndex = trilha.length - 1;

    const moduloAtual = trilha[moduleIndex] || trilha[0];

    const querAudio = userQuerAudio(texto, isAudio);
    const textoNorm = normalizarTexto(texto || "");
    const pediuExercicioEmAudio =
      querAudio &&
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
      if (audioBase64) await enviarAudioWhatsApp(numeroAluno, audioBase64);

      const msgConfirm =
        "Pronto! Enviei o exercício em áudio para você ouvir e praticar. Depois me envie suas respostas por mensagem que eu corrijo com carinho, combinado? 🙂";

      aluno.history.push({ role: "assistant", content: msgConfirm });
      await sleep(800);
      await enviarMensagemWhatsApp(numeroAluno, msgConfirm);
    } else {
      const respostaKito = await gerarRespostaKito(aluno, moduloAtual);

      moduleStep += 1;
      const totalSteps = moduloAtual.steps || 4;
      if (moduleStep >= totalSteps) {
        moduleIndex += 1;
        moduleStep = 0;
        if (moduleIndex >= trilha.length) moduleIndex = trilha.length - 1;
      }

      aluno.moduleIndex = moduleIndex;
      aluno.moduleStep = moduleStep;

      aluno.history.push({ role: "assistant", content: respostaKito });

      if (querAudio) {
        const textoParaAudio = extrairTrechoParaAudio(respostaKito, idiomaAudioAlvo);
        const audioBase64 = await gerarAudioRespostaKito(textoParaAudio, idiomaAudioAlvo);
        if (audioBase64) await enviarAudioWhatsApp(numeroAluno, audioBase64);
      }

      await sleep(1200);
      await enviarMensagemWhatsApp(numeroAluno, respostaKito);
    }
  }

  students[numeroAluno] = aluno;
  await saveStudentToFirestore(numeroAluno, aluno);
}

/** ---------- WEBHOOK Z-API ---------- **/

app.post("/zapi-webhook", async (req, res) => {
  const data = req.body;
  console.log("📩 Webhook Z-API recebido:", JSON.stringify(data, null, 2));

  try {
    if (data.type !== "ReceivedCallback") {
      return res.status(200).send("ignored_non_received");
    }

    const msgId = data.messageId;
    const numeroAluno = data.phone;
    const momentVal = data.momment;
    const texto = data.text?.message || null;

    let audioUrl =
      data.audioUrl || data.audio?.url || data.media?.url || data.voice?.url || data.audio?.audioUrl || null;

    // 1ª defesa: messageId
    if (processedMessages.has(msgId)) {
      console.log("⚠️ Mensagem duplicada ignorada (messageId):", msgId);
      return res.status(200).send("duplicate_ignored");
    }
    processedMessages.add(msgId);

    // 2ª defesa: mesmo momment
    if (momentVal && lastMomentByPhone[numeroAluno] === momentVal) {
      console.log("⚠️ Mensagem duplicada ignorada (momment):", msgId, momentVal);
      return res.status(200).send("duplicate_moment_ignored");
    }
    if (momentVal) lastMomentByPhone[numeroAluno] = momentVal;

    // 3ª defesa: mesmo texto em <3s
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
          "Tentei ouvir o seu áudio mas não consegui transcrever bem 😅\n" +
            "Você pode tentar falar um pouco mais perto do microfone ou enviar de novo?"
        );
        return res.status(200).send("audio_transcription_failed");
      }

      await processarMensagemAluno({
        numeroAluno,
        texto: transcricao,
        profileName,
        isAudio: true,
      });

      return res.status(200).send("ok_audio");
    }

    await processarMensagemAluno({
      numeroAluno,
      texto,
      profileName,
      isAudio: false,
    });

    return res.status(200).send("ok");
  } catch (erro) {
    console.error("❌ Erro no processamento do webhook Z-API:", erro?.response?.data || erro.message);
    return res.status(500).send("erro");
  }
});

/** ---------- CRON: lembretes 2 em 2 dias (ANTI-SPAM) ----------
 *  Chamar via cron externo:
 *  GET /cron/tick?token=SEU_ADMIN_TOKEN
 */
app.get("/cron/tick", async (req, res) => {
  try {
    const token = String(req.query.token || "");
    if (!token || token !== process.env.ADMIN_TOKEN) {
      return res.status(401).send("Não autorizado");
    }

    if (!REMINDER_ENABLED) {
      return res.json({ ok: true, remindersEnabled: false, sent: 0 });
    }

    if (!db) return res.status(500).send("Firestore não inicializado");

    const agora = new Date();
    let sent = 0;

    // Busca premium=true (como seu modelo atual)
    const snap = await db.collection("students").where("premium", "==", true).limit(REMINDER_QUERY_LIMIT).get();

    for (const doc of snap.docs) {
      const id = String(doc.id || ""); // whatsapp:244...
      const phone = id.startsWith("whatsapp:") ? id.replace("whatsapp:", "") : id;
      if (!phone) continue;

      const data = doc.data() || {};
      const aluno = {
        ...data,
        createdAt: safeToDate(data.createdAt),
        lastMessageAt: safeToDate(data.lastMessageAt),
        paywallLastShownAt: safeToDate(data.paywallLastShownAt),

        reminderDueAt: safeToDate(data.reminderDueAt),
        lastReminderAt: safeToDate(data.lastReminderAt),
      };

      // ✅ condição anti-spam
      if (!shouldSendReminder(aluno, agora)) continue;

      const msg = montarMensagemLembrete(aluno);

      await enviarMensagemWhatsApp(phone, msg);

      // marca lembrete enviado + agenda próximo para 48h (se continuar sumido)
      const lastReminderAt = agora;
      const reminderDueAt = addHours(agora, REMINDER_EVERY_HOURS);

      await db
        .collection("students")
        .doc(doc.id)
        .set(
          {
            lastReminderAt,
            reminderDueAt,
            updatedAt: new Date(),
          },
          { merge: true }
        );

      sent++;
      await sleep(250); // mini delay
    }

    return res.json({
      ok: true,
      remindersEnabled: true,
      sent,
      limit: REMINDER_QUERY_LIMIT,
      everyHours: REMINDER_EVERY_HOURS,
      minSilenceHours: REMINDER_MIN_SILENCE_HOURS,
      cooldownHours: REMINDER_COOLDOWN_HOURS,
    });
  } catch (e) {
    console.error("❌ /cron/tick erro:", e?.message || e);
    return res.status(500).send("erro");
  }
});

/** ---------- ADMIN: ativar premium por URL (opcional, útil) ----------
 *  GET /admin/premium?token=SEU_TOKEN&phone=2449...&value=true
 */
app.get("/admin/premium", async (req, res) => {
  try {
    const token = req.query.token;
    if (!token || token !== process.env.ADMIN_TOKEN) {
      return res.status(401).send("Não autorizado");
    }

    const phone = String(req.query.phone || "").trim();
    const value = String(req.query.value || "true").toLowerCase() === "true";

    if (!phone) return res.status(400).send("Falta phone");
    if (!db) return res.status(500).send("Firestore não inicializado");

    const docRef = db.collection("students").doc(`whatsapp:${phone}`);

    // aqui pode ligar/desligar de propósito
    await docRef.set({ premium: value, updatedAt: new Date() }, { merge: true });

    // atualiza cache em memória também
    const aluno = students[phone] || (await loadStudentFromFirestore(phone)) || {};
    aluno.premium = value;

    // ✅ se virou premium, agenda lembrete 48h
    if (value === true) scheduleReminder(aluno, new Date());

    students[phone] = aluno;

    // salva campos do lembrete também
    await saveStudentToFirestore(phone, aluno);

    return res.json({ ok: true, phone, premium: value });
  } catch (e) {
    console.error("❌ /admin/premium erro:", e?.message || e);
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
    moduleIndex: dados.moduleIndex ?? 0,
    moduleStep: dados.moduleStep ?? 0,
    createdAt: dados.createdAt,
    lastMessageAt: dados.lastMessageAt,
    premium: dados.premium === true,

    // ✅ lembretes
    reminderDueAt: dados.reminderDueAt || null,
    lastReminderAt: dados.lastReminderAt || null,
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
    .stage-pill.ask_name { color: #f97316; }
    .stage-pill.ask_language { color: #22c55e; }
    .stage-pill.learning { color: #38bdf8; }
    .table-wrapper { max-height: 60vh; overflow: auto; border-radius: 12px; border: 1px solid #1f2937; background: #020617; }
    .top-bar { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
    .pill { font-size: 11px; padding: 4px 10px; border-radius: 999px; border: 1px solid #1f2937; color: #9ca3af; }
    .footer { margin-top: 24px; font-size: 11px; color: #6b7280; }
    code { background: #0b1220; padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <div class="top-bar">
    <div>
      <h1>Dashboard • Jovika Academy</h1>
      <div class="subtitle">Professor Kito — visão geral dos alunos em tempo real</div>
    </div>
    <div class="pill">
      Token: <strong>${process.env.ADMIN_TOKEN || "não definido"}</strong>
    </div>
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
      <div class="card-sub">Alunos que enviaram mensagem nas últimas 24 horas</div>
    </div>
    <div class="card">
      <div class="card-title">Idiomas</div>
      <div class="card-value">EN: ${ingles} · FR: ${frances} · Ambos: ${ambos}</div>
      <div class="card-sub">Distribuição por idioma escolhido</div>
    </div>
    <div class="card">
      <div class="card-title">Mensagens totais (soma)</div>
      <div class="card-value">${alunos.reduce((sum, a) => sum + (a.mensagens || 0), 0)}</div>
      <div class="card-sub">Total de mensagens recebidas</div>
    </div>
  </div>

  <h2>Alunos</h2>
  <div class="table-wrapper">
    <table>
      <thead>
        <tr>
          <th>Nome</th>
          <th>Número</th>
          <th>Idioma</th>
          <th>Nível</th>
          <th>Stage</th>
          <th>Módulo</th>
          <th>Msgs</th>
          <th>Premium</th>
          <th>Entrou em</th>
          <th>Última mensagem</th>
          <th>Próx. lembrete</th>
          <th>Últ. lembrete</th>
        </tr>
      </thead>
      <tbody>
        ${
          alunos.length === 0
            ? `<tr><td colspan="12">Ainda não há alunos. Assim que alguém mandar "oi" para o Kito, aparece aqui. 😄</td></tr>`
            : alunos
                .map((a) => {
                  let idiomaBadge = `<span class="badge">${a.idioma}</span>`;
                  if (a.idioma === "ingles") idiomaBadge = `<span class="badge badge-en">Inglês</span>`;
                  else if (a.idioma === "frances") idiomaBadge = `<span class="badge badge-fr">Francês</span>`;
                  else if (a.idioma === "ambos") idiomaBadge = `<span class="badge badge-both">Inglês + Francês</span>`;

                  return `
                  <tr>
                    <td>${a.nome}</td>
                    <td>${a.numero}</td>
                    <td>${idiomaBadge}</td>
                    <td>${a.nivel}</td>
                    <td><span class="stage-pill ${a.stage}">${a.stage}</span></td>
                    <td>Mód ${a.moduleIndex + 1} · Passo ${a.moduleStep + 1}</td>
                    <td>${a.mensagens}</td>
                    <td>${a.premium ? "✅" : "—"}</td>
                    <td>${formatDate(a.createdAt)}</td>
                    <td>${formatDate(a.lastMessageAt)}</td>
                    <td>${formatDate(a.reminderDueAt)}</td>
                    <td>${formatDate(a.lastReminderAt)}</td>
                  </tr>
                  `;
                })
                .join("")
        }
      </tbody>
    </table>
  </div>

  <div class="footer">
    Endpoint JSON: <code>/admin/stats?token=${process.env.ADMIN_TOKEN || "TOKEN"}</code> · Cron: <code>/cron/tick?token=${
    process.env.ADMIN_TOKEN || "TOKEN"
  }</code> · Jovika Academy · ${new Date().getFullYear()}
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
    mensagens: dados.messagesCount || 0,
    stage: dados.stage,
    moduleIndex: dados.moduleIndex ?? 0,
    moduleStep: dados.moduleStep ?? 0,
    premium: dados.premium === true,
    createdAt: dados.createdAt,
    lastMessageAt: dados.lastMessageAt,

    // ✅ lembretes
    reminderDueAt: dados.reminderDueAt || null,
    lastReminderAt: dados.lastReminderAt || null,
  }));

  const total = alunos.length;
  const ingles = alunos.filter((a) => a.idioma === "ingles").length;
  const frances = alunos.filter((a) => a.idioma === "frances").length;
  const ambos = alunos.filter((a) => a.idioma === "ambos").length;

  res.json({
    totalAlunos: total,
    porIdioma: { ingles, frances, ambos },
    reminders: {
      enabled: REMINDER_ENABLED,
      everyHours: REMINDER_EVERY_HOURS,
      minSilenceHours: REMINDER_MIN_SILENCE_HOURS,
      cooldownHours: REMINDER_COOLDOWN_HOURS,
      queryLimit: REMINDER_QUERY_LIMIT,
    },
    alunos,
  });
});

// Rota de teste
app.get("/", (req, res) => {
  res.send(
    "Servidor Kito (Jovika Academy, Z-API + memória + módulos, TEXTO + ÁUDIO SOB PEDIDO + LEMBRETES) está a correr ✅"
  );
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor REST (Kito + Z-API + memória + Dashboard) em http://localhost:${PORT}`);
});
