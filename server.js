// server.js – Kito, professor da Jovika Academy
// Z-API + memória + módulos + Dashboard + Firestore + ÁUDIO SOB PEDIDO + PERFIL PEDAGÓGICO + LEMBRETES PERSONALIZADOS
// + MODO CONVERSA/APRENDER + ESPELHAR ÁUDIO EM MODO CONVERSA

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
  "🔥🔥🔥 KITO v5.3 – MODO CONVERSA/APRENDER + ESPELHAR ÁUDIO + PERFIL PEDAGÓGICO + LEMBRETES 🔥🔥🔥"
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

// Detecta respostas tipo "sim", "bora", "vamos", "quero"
function isConfirmMessage(texto = "") {
  const t = normalizarTexto(texto);
  const palavras = [
    "sim",
    "bora",
    "vamos",
    "quero",
    "claro",
    "ok",
    "tá bem",
    "esta bem",
    "ta bem",
  ];
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

// 🔊 Detecta se o aluno está a pedir ÁUDIO (pedido explícito)
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
    (t.includes("pronun") ||
      t.includes("pronún") ||
      t.includes("corrig") ||
      gatilhos.some((p) => t.includes(p)));

  const resultado = pediuPorTexto || pediuPorAudio;
  return resultado;
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

// Limpa coisas que não queremos que apareçam/lêem
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

/**
 * Extrai apenas as linhas do idioma alvo para o áudio
 */
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
      return (
        hasLatin.test(l) &&
        !ptAccents.test(l) &&
        enKeywords.some((k) => t.startsWith(k))
      );
    });
    if (enLines.length > 0) return enLines.join("\n");
  }

  return texto;
}

/** ---------- Helpers de perfil pedagógico ---------- **/

function inferirNivelPercebido(texto) {
  const t = normalizarTexto(texto);
  if (t.includes("nunca") || t.includes("zero") || t.includes("começar do zero")) {
    return { nivelPercebido: "iniciante", nivelCEFR: "A0" };
  }
  if (t.includes("basico") || t.includes("básico") || t.includes("pouco")) {
    return { nivelPercebido: "básico", nivelCEFR: "A1" };
  }
  if (t.includes("intermediario") || t.includes("intermediário") || t.includes("mediano")) {
    return { nivelPercebido: "intermediário", nivelCEFR: "A2/B1" };
  }
  if (t.includes("avancado") || t.includes("avançado") || t.includes("fluente")) {
    return { nivelPercebido: "avançado", nivelCEFR: "B2+" };
  }
  return { nivelPercebido: "iniciante", nivelCEFR: "A0" };
}

function inferirMaiorDificuldade(texto) {
  const t = normalizarTexto(texto);
  if (t.includes("pronuncia") || t.includes("pronúncia") || t.includes("falar") || t.includes("fala")) {
    return "pronúncia / fala";
  }
  if (t.includes("gramatica") || t.includes("gramática")) {
    return "gramática";
  }
  if (t.includes("vocabulario") || t.includes("vocabulário") || t.includes("palavra")) {
    return "vocabulário";
  }
  if (t.includes("escuta") || t.includes("ouvir") || t.includes("listening")) {
    return "escuta / compreensão auditiva";
  }
  if (t.includes("vergonha") || t.includes("timido") || t.includes("tímido") || t.includes("medo")) {
    return "medo / vergonha de falar";
  }
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
  if (t.includes("todo dia") || t.includes("todos os dias") || t.includes("diario") || t.includes("diário")) {
    return "diario";
  }
  if (t.includes("3x") || t.includes("3 vezes") || t.includes("tres vezes")) {
    return "3x";
  }
  if (t.includes("so quando") || t.includes("só quando") || t.includes("quando eu falar") || t.includes("quando falar comigo")) {
    return "livre";
  }
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

  return "geral";
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
    let reminder1hSentAt = aluno.reminder1hSentAt;
    let reminder2dSentAt = aluno.reminder2dSentAt;

    const normalize = (val) => {
      if (!val) return null;
      if (typeof val.toDate === "function") return val.toDate();
      const d = val instanceof Date ? val : new Date(val);
      return isNaN(d.getTime()) ? null : d;
    };

    createdAt = normalize(createdAt) || new Date();
    lastMessageAt = normalize(lastMessageAt) || new Date();
    reminder1hSentAt = normalize(reminder1hSentAt);
    reminder2dSentAt = normalize(reminder2dSentAt);

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
        chatMode: aluno.chatMode ?? null, // ✅ NOVO
        messagesCount: aluno.messagesCount ?? 0,
        moduleIndex: aluno.moduleIndex ?? 0,
        moduleStep: aluno.moduleStep ?? 0,
        createdAt,
        lastMessageAt,
        reminder1hSentAt: reminder1hSentAt || null,
        reminder2dSentAt: reminder2dSentAt || null,
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

    const normalize = (val) => {
      if (!val) return null;
      if (typeof val.toDate === "function") return val.toDate();
      const d = val instanceof Date ? val : new Date(val);
      return isNaN(d.getTime()) ? null : d;
    };

    return {
      ...data,
      createdAt: normalize(data.createdAt) || new Date(),
      lastMessageAt: normalize(data.lastMessageAt) || new Date(),
      reminder1hSentAt: normalize(data.reminder1hSentAt),
      reminder2dSentAt: normalize(data.reminder2dSentAt),
    };
  } catch (err) {
    console.error("❌ Erro ao carregar aluno do Firestore:", err.message);
    return null;
  }
}

/** ---------- OpenAI (Kito, professor da Jovika) ---------- **/

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function gerarRespostaKito(aluno, moduloAtual, tipoMensagem = "geral") {
  const history = aluno.history || [];
  const ultimoUser = history.filter((m) => m.role === "user").slice(-1)[0];
  const textoDoAluno = ultimoUser ? ultimoUser.content : "(sem mensagem recente)";

  console.log("🧠 Pergunta do aluno:", textoDoAluno);
  console.log("🧠 Tipo de mensagem detectado:", tipoMensagem);

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

  const modo = aluno.chatMode || "conversa";

  const systemPrompt = `
Tu és o **Kito**, professor oficial da **Jovika Academy**, uma escola moderna de inglês e francês
para jovens de Angola, Brasil e Portugal. Tu dás aulas pelo WhatsApp, de forma muito humana,
natural e inteligente (tipo ChatGPT, mas focado em idiomas).

MODO ATUAL DO ALUNO (MUITO IMPORTANTE):
- chatMode: "${modo}"
- Se chatMode = "conversa":
  - O aluno quer praticar falando como se fosse com um humano.
  - Você DEVE responder primeiro como uma pessoa (fluido e natural).
  - NÃO faça correção de pronúncia/gramática automaticamente.
  - No máximo, ofereça no final uma pergunta opcional: "Quer que eu corrija essa frase?"
- Se chatMode = "aprender":
  - O aluno quer aprender com correções e explicações.
  - Você responde e corrige com carinho (sem interromper demais), com exemplos curtos.

IDENTIDADE DO KITO:
- Nome: Kito
- Papel: professor de INGLÊS e FRANCÊS da Jovika Academy
- Estilo: jovem, descontraído, empático, mas muito competente.

PORTUGUÊS DO BRASIL (IMPORTANTE):
- Escreve sempre em **português do Brasil**, com gramática correta.
- Usa "você" (não uses "tu") e evita gírias como "pra", "beleza?" ou "bora".
- Prefere "para", "porque", "tudo bem?", "vamos continuar?", etc.
- Quando escrever frases em francês:
  - primeira linha: só a frase em francês;
  - linha seguinte: tradução em português do Brasil.
- Quando escrever frases em inglês:
  - primeira linha: só a frase em inglês;
  - linha seguinte: tradução em português do Brasil.

PERFIL PEDAGÓGICO DESTE ALUNO:
- Nome: ${aluno.nome || "não informado"}
- Idioma alvo: ${idiomaAlvo}
- Nível aproximado (interno): ${aluno.nivel || "A0"}
- Nível percebido: ${aluno.nivelPercebido || "não definido"}
- Maior dificuldade: ${
    aluno.maiorDificuldade || "ainda não ficou clara — faça perguntas simples para descobrir."
  }
- Preferência de formato: ${aluno.preferenciaFormato || "misto"}.
- Frequência preferida: ${aluno.frequenciaPreferida || "não definida"}.
- Objetivo: ${
    aluno.objetivo ||
    "ainda não ficou claro — faça perguntas simples e naturais para entender o que ele realmente precisa."
  }

MÓDULO ATUAL (APENAS COMO GUIA, NÃO SCRIPT DURO):
- Título: ${modulo?.title || "Introdução"}
- Nível do módulo: ${modulo?.level || aluno.nivel || "iniciante"}
- Objetivo do módulo: ${modulo?.goal || "ajudar o aluno a comunicar em situações básicas."}
- Passo atual: ${step}
- Total de passos: ${totalSteps}

TIPO DA ÚLTIMA MENSAGEM:
- tipoMensagem: ${tipoMensagem}

REGRAS POR TIPO:
- Se tipoMensagem = "pedido_traducao": responda direto, explique e dê a frase correta.
- Se tipoMensagem = "pergunta_sobre_kito": responda como conversa real em português do Brasil.
- Se tipoMensagem = "geral":
  - Responda primeiro ao que o aluno disse.
  - Se chatMode = "conversa", foque em manter o diálogo fluindo.
  - Se chatMode = "aprender", você pode corrigir e ensinar, mas sem textão.

ESTILO:
- Mensagens curtas, estilo WhatsApp.
- No máximo 2 blocos curtos + 1 pergunta.
- Emojis com moderação (1 no máximo, se fizer sentido).

SOBRE ÁUDIO:
- Não diga "vou mandar áudio" nem "[Áudio enviado]".
- O sistema decide o envio do áudio.
  `.trim();

  const mensagens = [
    { role: "system", content: systemPrompt },
    ...history.slice(-10),
  ];

  const resposta = await openai.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    input: mensagens,
  });

  const textoGerado =
    resposta.output?.[0]?.content?.[0]?.text ||
    "Desculpa, deu um erro aqui. Tente de novo 🙏";
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

    // ✅ Importante: NÃO forçar language="pt"
    // porque muitos alunos vão falar inglês/francês no áudio.
    const transcription = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file: fs.createReadStream(tempPath),
    });

    fs.promises.unlink(tempPath).catch(() => {});

    console.log("📝 Transcrição:", transcription.text);
    return transcription.text;
  } catch (err) {
    console.error(
      "❌ Erro ao transcrever áudio:",
      err.response?.data || err.message
    );
    return null;
  }
}

/** ---------- ÁUDIO: TTS ---------- **/

async function gerarAudioRespostaKito(texto, idiomaAlvo = null) {
  try {
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
    const dataUrl = `data:audio/mpeg;base64,${base64}`;
    return dataUrl;
  } catch (err) {
    console.error(
      "❌ Erro ao gerar áudio de resposta:",
      err.response?.data || err.message
    );
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
      console.error(
        "❌ Z-API: falta ZAPI_INSTANCE_ID ou ZAPI_INSTANCE_TOKEN no .env"
      );
      return;
    }

    const url = `https://api.z-api.io/instances/${instanceId}/token/${instanceToken}/send-text`;

    console.log("🌍 URL Z-API usada:", url);

    const payload = { phone, message };

    const headers = { "Content-Type": "application/json" };
    if (clientToken) headers["Client-Token"] = clientToken;

    const resp = await axios.post(url, payload, { headers });
    console.log("📤 Mensagem enviada via Z-API para", phone, "resp:", resp.data);
  } catch (err) {
    console.error(
      "❌ Erro ao enviar mensagem via Z-API:",
      err.response?.data || err.message
    );
  }
}

/** ---------- Enviar ÁUDIO pela Z-API ---------- **/

async function enviarAudioWhatsApp(phone, audioBase64) {
  try {
    const instanceId = process.env.ZAPI_INSTANCE_ID;
    const instanceToken = process.env.ZAPI_INSTANCE_TOKEN;
    const clientToken = process.env.ZAPI_CLIENT_TOKEN;

    if (!instanceId || !instanceToken) {
      console.error(
        "❌ Z-API: falta ZAPI_INSTANCE_ID ou ZAPI_INSTANCE_TOKEN no .env (áudio)"
      );
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
    console.error(
      "❌ Erro ao enviar áudio via Z-API:",
      err.response?.data || err.message
    );
  }
}

/** ---------- LÓGICA PRINCIPAL DE MENSAGEM ---------- **/

async function processarMensagemAluno({
  numeroAluno,
  texto,
  profileName,
  isAudio,
}) {
  let aluno = students[numeroAluno];
  const agora = new Date();

  // Se não está em memória, tenta buscar do Firestore
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
        chatMode: fromDb.chatMode || null, // ✅ NOVO
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
      nivelPercebido: null,
      maiorDificuldade: null,
      preferenciaFormato: null,
      frequenciaPreferida: null,
      objetivo: null,
      chatMode: null, // ✅ NOVO
      messagesCount: 0,
      createdAt: agora,
      lastMessageAt: agora,
      moduleIndex: 0,
      moduleStep: 0,
      reminder1hSentAt: null,
      reminder2dSentAt: null,
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

  // Atualiza stats e reseta lembretes
  aluno.messagesCount = (aluno.messagesCount || 0) + 1;
  aluno.lastMessageAt = agora;
  aluno.reminder1hSentAt = null;
  aluno.reminder2dSentAt = null;
  aluno.history = aluno.history || [];

  const prefix = isAudio ? "[ÁUDIO] " : "";
  aluno.history.push({ role: "user", content: `${prefix}${texto}` });

  // ✅ Permitir troca de modo a qualquer momento (somente quando já está em learning/ask_mode)
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

  // 1) Perguntar / guardar nome
  if (aluno.stage === "ask_name" && !aluno.nome) {
    const nome = extrairNome(texto) || "Aluno";
    aluno.nome = nome;
    aluno.stage = "ask_language";

    await enviarMensagemWhatsApp(
      numeroAluno,
      `Perfeito, ${nome}! 😄 Agora me conta: você quer começar por inglês, francês ou os dois?`
    );
  } else if (aluno.stage === "ask_language") {
    // 2) Perguntar idioma
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

      const idiomaTexto =
        idioma === "ingles"
          ? "inglês"
          : idioma === "frances"
          ? "francês"
          : "inglês e francês";

      await enviarMensagemWhatsApp(
        numeroAluno,
        `Ótimo, ${aluno.nome}! Vamos trabalhar ${idiomaTexto} juntos 💪✨\nAntes de começar a aula, quero te conhecer um pouco melhor para adaptar tudo ao seu perfil.\n\nVocê já estudou ${idiomaTexto} antes?`
      );
    }
  } else if (aluno.stage === "ask_experience") {
    const { nivelPercebido, nivelCEFR } = inferirNivelPercebido(texto);
    aluno.nivelPercebido = nivelPercebido;
    aluno.nivel = aluno.nivel || nivelCEFR;

    aluno.stage = "ask_difficulty";

    await enviarMensagemWhatsApp(
      numeroAluno,
      `Perfeito, entendi. 😊\nAgora me conta: em ${
        aluno.idioma === "frances" ? "francês" : "inglês"
      }, o que você sente que é mais difícil hoje?\n\nPronúncia, gramática, vocabulário, escutar, vergonha de falar...`
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
      "Show! Para eu organizar melhor os seus estudos:\nVocê prefere que eu te puxe todos os dias, 3x por semana ou só quando você falar comigo?"
    );
  } else if (aluno.stage === "ask_frequency") {
    aluno.frequenciaPreferida = inferirFrequenciaPreferida(texto);

    // ✅ NOVO PASSO: escolher modo (conversa/aprender)
    aluno.stage = "ask_mode";

    await enviarMensagemWhatsApp(
      numeroAluno,
      "Antes de começarmos: você quer que eu seja mais como um parceiro de conversa (para praticar) ou como professor corrigindo?\n\nResponda com:\n1) conversar\n2) aprender\n\nVocê pode mudar quando quiser dizendo: modo conversa / modo aprender."
    );
  } else if (aluno.stage === "ask_mode") {
    const t = normalizarTexto(texto);
    const escolheuConversa =
      t.includes("1") || t.includes("convers") || t.includes("pratic");
    const escolheuAprender =
      t.includes("2") || t.includes("aprender") || t.includes("estudar") || t.includes("corrig");

    if (!escolheuConversa && !escolheuAprender) {
      await enviarMensagemWhatsApp(
        numeroAluno,
        "Só para eu acertar seu estilo 😊\nResponda com:\n1) conversar\n2) aprender"
      );
    } else {
      aluno.chatMode = escolheuAprender ? "aprender" : "conversa";
      aluno.stage = "learning";

      const idiomaTexto =
        aluno.idioma === "ingles"
          ? "inglês"
          : aluno.idioma === "frances"
          ? "francês"
          : "inglês e francês";

      await enviarMensagemWhatsApp(
        numeroAluno,
        aluno.chatMode === "conversa"
          ? `Perfeito 😊 A gente vai conversar para você praticar ${idiomaTexto}. Se quiser correção completa, diga: modo aprender.\n\nAgora me conte: qual é o seu principal objetivo com ${idiomaTexto}? Trabalho, viagem, faculdade, sair do país, ganhar confiança...?`
          : `Combinado 💪 Eu vou te ensinar e corrigir enquanto a gente conversa em ${idiomaTexto}. Se quiser só praticar sem correção, diga: modo conversa.\n\nAgora me conte: qual é o seu principal objetivo com ${idiomaTexto}? Trabalho, viagem, faculdade, sair do país, ganhar confiança...?`
      );
    }
  } else {
    // 7) Fase de aprendizagem
    if (aluno.stage !== "learning") {
      aluno.stage = "learning";
    }

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
    if (confirmacao) console.log("✅ Confirmação de continuar módulo recebida.");

    const querAudioPorPedido = userQuerAudio(texto, isAudio);

    // ✅ ESPELHAR ÁUDIO (somente em modo conversa)
    const chatMode = aluno.chatMode || "conversa";
    const espelharAudio =
      isAudio && chatMode === "conversa";

    const pediuExercicioEmAudio =
      querAudioPorPedido &&
      (textoNorm.includes("exercicio") ||
        textoNorm.includes("exercício") ||
        textoNorm.includes("exercicios") ||
        textoNorm.includes("exercícios"));

    console.log("DEBUG_AUDIO_POLICY:", {
      isAudio,
      chatMode,
      espelharAudio,
      querAudioPorPedido,
      pediuExercicioEmAudio,
      tipoMensagem,
    });

    const idiomaAudioAlvo =
      aluno.idioma === "ingles" || aluno.idioma === "frances"
        ? aluno.idioma
        : null;

    if (pediuExercicioEmAudio) {
      const lastAssistant =
        [...(aluno.history || [])].reverse().find((m) => m.role === "assistant") ||
        null;

      let textoParaAudio =
        lastAssistant?.content ||
        "Vamos praticar este exercício juntos. Escute com atenção e depois me envie suas respostas por mensagem.";

      textoParaAudio = extrairTrechoParaAudio(textoParaAudio, idiomaAudioAlvo);

      const audioBase64 = await gerarAudioRespostaKito(
        textoParaAudio,
        idiomaAudioAlvo
      );
      if (audioBase64) {
        await enviarAudioWhatsApp(numeroAluno, audioBase64);
      }

      const msgConfirm =
        "Pronto! Depois me envie suas respostas por mensagem que eu corrijo com carinho, combinado? 🙂";

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

      // ✅ Política de áudio:
      // - Se espelharAudio (áudio recebido + modo conversa) => manda áudio SEM o aluno pedir
      // - Se querAudioPorPedido => manda áudio sob pedido (como já era)
      const deveMandarAudio = espelharAudio || querAudioPorPedido;

      if (deveMandarAudio) {
        const trecho = extrairTrechoParaAudio(respostaKito, idiomaAudioAlvo);
        const audioBase64 = await gerarAudioRespostaKito(trecho, idiomaAudioAlvo);
        if (audioBase64) {
          await enviarAudioWhatsApp(numeroAluno, audioBase64);
        }
      }

      await sleep(1200);
      await enviarMensagemWhatsApp(numeroAluno, respostaKito);
    }
  }

  students[numeroAluno] = aluno;
  await saveStudentToFirestore(numeroAluno, aluno);
}

/** ---------- LEMBRETES AUTOMÁTICOS (1h e 2 dias) ---------- **/

const ONE_HOUR_MS = 60 * 60 * 1000;
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const REMINDER_CHECK_INTERVAL_MS = 5 * 60 * 1000;

function getIdiomaTexto(idioma) {
  if (idioma === "ingles") return "inglês";
  if (idioma === "frances") return "francês";
  if (idioma === "ambos") return "inglês e francês";
  return "o idioma";
}

async function verificarELancarLembretes() {
  const agora = new Date();

  for (const [numero, aluno] of Object.entries(students)) {
    if (!aluno.lastMessageAt) continue;
    if (aluno.frequenciaPreferida === "livre") continue;

    const diff = agora - new Date(aluno.lastMessageAt);
    const idiomaTexto = getIdiomaTexto(aluno.idioma);
    const nome = aluno.nome || "por aqui";

    const afterLast = (d) => !d || new Date(d) < new Date(aluno.lastMessageAt);

    if (diff >= TWO_DAYS_MS && afterLast(aluno.reminder2dSentAt)) {
      const msg2d = `Oi, ${nome}! 😊 Faz alguns dias que a gente não pratica ${idiomaTexto} juntos.\nQuer retomar agora?`;
      console.log("⏰ Lembrete 2 dias para", numero);
      aluno.reminder2dSentAt = agora;
      await enviarMensagemWhatsApp(numero, msg2d);
      await saveStudentToFirestore(numero, aluno);
      continue;
    }

    if (diff >= ONE_HOUR_MS && diff < TWO_DAYS_MS && afterLast(aluno.reminder1hSentAt)) {
      const msg1h = `Oi, ${nome}! 😄 Você quer continuar sua prática de ${idiomaTexto} agora? Se quiser, é só me mandar uma mensagem e seguimos do ponto onde paramos.`;
      console.log("⏰ Lembrete 1h para", numero);
      aluno.reminder1hSentAt = agora;
      await enviarMensagemWhatsApp(numero, msg1h);
      await saveStudentToFirestore(numero, aluno);
    }
  }
}

setInterval(verificarELancarLembretes, REMINDER_CHECK_INTERVAL_MS);

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
      data.audioUrl ||
      data.audio?.url ||
      data.media?.url ||
      data.voice?.url ||
      data.audio?.audioUrl ||
      null;

    console.log("DEBUG_AUDIO_URL:", {
      hasText: !!texto,
      audioUrl,
      audio: data.audio,
    });

    if (processedMessages.has(msgId)) {
      console.log("⚠️ Mensagem duplicada ignorada (messageId):", msgId);
      return res.status(200).send("duplicate_ignored");
    }
    processedMessages.add(msgId);

    if (momentVal && lastMomentByPhone[numeroAluno] === momentVal) {
      console.log("⚠️ Mensagem duplicada ignorada (momment):", msgId, momentVal);
      return res.status(200).send("duplicate_moment_ignored");
    }
    if (momentVal) {
      lastMomentByPhone[numeroAluno] = momentVal;
    }

    const agora = Date.now();
    const ultimo = lastTextByPhone[numeroAluno];
    if (texto && ultimo && ultimo.text === texto && agora - ultimo.time < 3000) {
      console.log("⚠️ Mensagem duplicada ignorada (texto + tempo):", msgId, texto);
      return res.status(200).send("duplicate_text_recent");
    }
    if (texto) {
      lastTextByPhone[numeroAluno] = { text: texto, time: agora };
    }

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

    res.status(200).send("ok");
  } catch (erro) {
    console.error(
      "❌ Erro no processamento do webhook Z-API:",
      erro?.response?.data || erro.message
    );
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
    chatMode: dados.chatMode || "-", // ✅ NOVO
    moduleIndex: dados.moduleIndex ?? 0,
    moduleStep: dados.moduleStep ?? 0,
    createdAt: dados.createdAt,
    lastMessageAt: dados.lastMessageAt,
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
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f172a;
      color: #e5e7eb;
      padding: 24px;
    }
    h1 { font-size: 24px; margin-bottom: 8px; }
    h2 { font-size: 18px; margin: 24px 0 12px; }
    .subtitle { color: #9ca3af; margin-bottom: 20px; }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: #111827;
      border-radius: 12px;
      padding: 16px;
      border: 1px solid #1f2937;
    }
    .card-title {
      font-size: 13px;
      color: #9ca3af;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .card-value { font-size: 22px; font-weight: 600; }
    .card-sub { font-size: 12px; color: #9ca3af; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
    th, td {
      padding: 8px 10px;
      text-align: left;
      border-bottom: 1px solid #1f2937;
      vertical-align: top;
    }
    th { background: #111827; position: sticky; top: 0; z-index: 1; }
    tr:nth-child(even) td { background: #020617; }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 500;
    }
    .badge-en { background: rgba(56, 189, 248, 0.15); color: #7dd3fc; }
    .badge-fr { background: rgba(251, 191, 36, 0.15); color: #facc15; }
    .badge-both { background: rgba(52, 211, 153, 0.15); color: #6ee7b7; }
    .stage-pill {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      background: #111827;
      color: #e5e7eb;
      display: inline-block;
    }
    .table-wrapper {
      max-height: 60vh;
      overflow: auto;
      border-radius: 12px;
      border: 1px solid #1f2937;
      background: #020617;
    }
    .top-bar {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .pill {
      font-size: 11px;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid #1f2937;
      color: #9ca3af;
    }
    .footer { margin-top: 24px; font-size: 11px; color: #6b7280; }
    a { color: #38bdf8; text-decoration: none; }
    a:hover { text-decoration: underline; }
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
      <div class="card-value">
        EN: ${ingles} · FR: ${frances} · Ambos: ${ambos}
      </div>
      <div class="card-sub">Distribuição por idioma escolhido</div>
    </div>
    <div class="card">
      <div class="card-title">Mensagens totais (soma)</div>
      <div class="card-value">${alunos.reduce((sum, a) => sum + (a.mensagens || 0), 0)}</div>
      <div class="card-sub">Total de mensagens recebidas de todos os alunos</div>
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
          <th>Modo</th>
          <th>Módulo</th>
          <th>Msgs</th>
          <th>Entrou em</th>
          <th>Última mensagem</th>
        </tr>
      </thead>
      <tbody>
        ${
          alunos.length === 0
            ? `<tr><td colspan="10">Ainda não há alunos. Assim que alguém mandar "oi" para o Kito, aparece aqui. 😄</td></tr>`
            : alunos
                .map((a) => {
                  let idiomaBadge = `<span class="badge">${a.idioma}</span>`;
                  if (a.idioma === "ingles") {
                    idiomaBadge = `<span class="badge badge-en">Inglês</span>`;
                  } else if (a.idioma === "frances") {
                    idiomaBadge = `<span class="badge badge-fr">Francês</span>`;
                  } else if (a.idioma === "ambos") {
                    idiomaBadge = `<span class="badge badge-both">Inglês + Francês</span>`;
                  }

                  return `
                  <tr>
                    <td>${a.nome}</td>
                    <td>${a.numero}</td>
                    <td>${idiomaBadge}</td>
                    <td>${a.nivel}</td>
                    <td><span class="stage-pill">${a.stage}</span></td>
                    <td>${a.chatMode}</td>
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
    Endpoint JSON também disponível em <code>/admin/stats?token=${process.env.ADMIN_TOKEN || "TOKEN"}</code> · Jovika Academy · ${new Date().getFullYear()}
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
    mensagens: dados.messagesCount || 0,
    stage: dados.stage,
    moduleIndex: dados.moduleIndex ?? 0,
    moduleStep: dados.moduleStep ?? 0,
    createdAt: dados.createdAt,
    lastMessageAt: dados.lastMessageAt,
  }));

  const total = alunos.length;
  const ingles = alunos.filter((a) => a.idioma === "ingles").length;
  const frances = alunos.filter((a) => a.idioma === "frances").length;
  const ambos = alunos.filter((a) => a.idioma === "ambos").length;

  res.json({
    totalAlunos: total,
    porIdioma: { ingles, frances, ambos },
    alunos,
  });
});

// Rota de teste
app.get("/", (req, res) => {
  res.send(
    "Servidor Kito (Jovika Academy, Z-API + memória + módulos, TEXTO + ÁUDIO + PERFIL PEDAGÓGICO + LEMBRETES + MODO CONVERSA/APRENDER + ESPELHAR ÁUDIO) está a correr ✅"
  );
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(
    `🚀 Servidor REST (Kito + Z-API + memória + Dashboard) em http://localhost:${PORT}`
  );
});
