// server.js – Kito, professor da Jovika Academy
// Z-API + memória + módulos + Dashboard + Firestore + ÁUDIO SOB PEDIDO

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

console.log("🔥🔥🔥 KITO v4.1 – TEXTO + ÁUDIO SOB PEDIDO (sem dizer que não pode enviar áudio) 🔥🔥🔥");

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
  ];

  const pediuPorTexto = gatilhos.some((p) => t.includes(p));

  const pediuPorAudio =
    isAudio &&
    (t.includes("pronun") ||
      t.includes("pronún") ||
      t.includes("corrig") ||
      gatilhos.some((p) => t.includes(p)));

  // palavra "audio" em qualquer contexto (ex: "enviasse um audio, por favor")
  const palavraAudioSolta = t.includes("audio");

  const resultado = pediuPorTexto || pediuPorAudio || palavraAudioSolta;
  return resultado;
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

    if (createdAt && typeof createdAt.toDate === "function") {
      createdAt = createdAt.toDate();
    }
    if (lastMessageAt && typeof lastMessageAt.toDate === "function") {
      lastMessageAt = lastMessageAt.toDate();
    }

    if (!(createdAt instanceof Date) || isNaN(createdAt.getTime())) {
      createdAt = new Date();
    }
    if (!(lastMessageAt instanceof Date) || isNaN(lastMessageAt.getTime())) {
      lastMessageAt = new Date();
    }

    const docRef = db.collection("students").doc(`whatsapp:${phone}`);
    await docRef.set(
      {
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
    return snap.data();
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
- **NUNCA** digas frases como "não consigo enviar áudio", "só consigo texto", "não tenho voz" ou "não posso ajudar com áudio".
- Quando o aluno pedir pronúncia em áudio, faz assim:
  1) Explica por texto (como sempre: conceito + exemplos + mini exercício);
  2) Diz algo simples que faça sentido também em áudio, por exemplo:
     - "Agora vou mandar um áudio curto para tu ouvires a pronúncia, ok?"
     - "Escuta o áudio e repete devagar."
- Lembra-te: o mesmo texto que escreves também pode ser transformado em áudio. Então evita falar coisas que só fazem sentido em texto, tipo:
  - "como escrevi acima" ou "como mostrei na mensagem anterior".

COMO O KITO PENSA E AGE:
- Tu lembras-te do contexto da conversa (histórico) e não repetes perguntas iniciais
  como nome, idioma ou objetivo.
- Tu respondes exatamente ao que o aluno diz, usando os módulos apenas como GUIA,
  não como um script engessado.
- Se o aluno fizer perguntas específicas ("como digo X?", "explica Y"), responde diretamente.
- Se o aluno só disser coisas como "sim", "bora", "vamos", "quero", assume que ele quer
  continuar para o próximo micro-passo do módulo, e tu crias esse próximo passo.
- Se o aluno disser palavras soltas de objetivo ("trabalho", "confiança", "Canadá", "emprego"),
  tu:
    - NÃO ficas só a traduzir a palavra.
    - Explicas como esse objetivo se relaciona com o idioma e o módulo.
    - Dás um pequeno exercício ou frase relacionada a esse objetivo.

ESTILO DE RESPOSTA:
- Escreve como se fosse mensagem de WhatsApp:
  - Frases curtas
  - Parágrafos curtos
  - Linguagem simples e direta
- Usa emojis com moderação (1–2 no máximo por mensagem), só se fizer sentido.
- Nunca mandes textão enorme. No máximo 3 blocos:
  1) Explicação rápida (contexto + conceito)
  2) 2–3 exemplos com tradução
  3) Um mini exercício para o aluno responder (1 ou 2 frases, gap-fill, escolha, etc.)

CORREÇÃO DE ERROS:
- Quando o aluno erra:
  - Mostra a frase original dele
  - Mostra a versão corrigida
  - Faz uma explicação rápida do porquê (sem excesso de gramática pesada)
- Mantém o tom positivo. Nada de "está errado", prefere "podemos melhorar assim". 

TOM EMOCIONAL:
- Se o aluno demonstra dificuldade, desmotivação ou cansaço, responde de forma
  mais acolhedora e incentiva a continuar devagar.
- Se o aluno está empolgado, acompanha essa energia e puxa um pouco mais.

RESUMO:
Tu és o Kito, uma espécie de "ChatGPT-professor de idiomas" da Jovika Academy:
inteligente, adaptável, humano, e sempre focado em fazer o aluno realmente
falar o idioma, não só decorar regras.
  `.trim();

  const mensagens = [
    { role: "system", content: systemPrompt },
    ...history.slice(-10),
  ];

  const resposta = await openai.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    input: mensagens,
  });

  const textoGerado = resposta.output[0].content[0].text;
  console.log("🧠 Resposta do Kito:", textoGerado);
  return textoGerado;
}

/** ---------- ÁUDIO: download + transcrição (para entender o que o aluno falou) ---------- **/

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
    console.error(
      "❌ Erro ao transcrever áudio:",
      err.response?.data || err.message
    );
    return null;
  }
}

/** ---------- ÁUDIO: TTS (responder com áudio quando o aluno pedir) ---------- **/

async function gerarAudioRespostaKito(texto) {
  try {
    console.log("🎙️ Gerando áudio de resposta do Kito (sob pedido)...");
    const speech = await openai.audio.speech.create({
      model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
      voice: process.env.OPENAI_TTS_VOICE || "onyx",
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

/** ---------- Enviar ÁUDIO pela Z-API (sob pedido) ---------- **/

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
      audio: audioBase64, // "data:audio/mpeg;base64,AAAA..."
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

/** ---------- LÓGICA PRINCIPAL DE MENSAGEM (texto ou áudio) ---------- **/

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
      const createdAt =
        fromDb.createdAt && typeof fromDb.createdAt.toDate === "function"
          ? fromDb.createdAt.toDate()
          : fromDb.createdAt
          ? new Date(fromDb.createdAt)
          : new Date();

      const lastMessageAt =
        fromDb.lastMessageAt && typeof fromDb.lastMessageAt.toDate === "function"
          ? fromDb.lastMessageAt.toDate()
          : fromDb.lastMessageAt
          ? new Date(fromDb.lastMessageAt)
          : new Date();

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
    };
    students[numeroAluno] = aluno;

    const primeiroNome = extrairNome(profileName) || "Aluno";

    await enviarMensagemWhatsApp(
      numeroAluno,
      `Boas, ${primeiroNome}! 😄 Eu sou o Kito, professor de inglês e francês da Jovika Academy.\nComo queres que eu te chame?`
    );

    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  // Atualiza stats
  aluno.messagesCount = (aluno.messagesCount || 0) + 1;
  aluno.lastMessageAt = agora;
  aluno.history = aluno.history || [];

  const prefix = isAudio ? "[ÁUDIO] " : "";
  aluno.history.push({ role: "user", content: `${prefix}${texto}` });

  // 1) Perguntar / guardar nome
  if (aluno.stage === "ask_name" && !aluno.nome) {
    const nome = extrairNome(texto) || "Aluno";
    aluno.nome = nome;
    aluno.stage = "ask_language";

    await enviarMensagemWhatsApp(
      numeroAluno,
      `Fechou, ${nome}! 😄 Agora diz-me: queres começar por inglês, francês ou os dois?`
    );
  } else if (aluno.stage === "ask_language") {
    // 2) Perguntar idioma (apenas uma vez)
    const idioma = detectarIdioma(texto);

    if (!idioma) {
      await enviarMensagemWhatsApp(
        numeroAluno,
        "Acho que não apanhei bem 😅\nResponde só com: inglês, francês ou os dois."
      );
    } else {
      aluno.idioma = idioma;
      aluno.stage = "learning";
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
        `Perfeito, ${aluno.nome}! Vamos trabalhar ${idiomaTexto} juntos 💪✨\n` +
          `Primeiro, diz-me qual é o teu objetivo com esse idioma (ex: trabalho, viagem, confiança, faculdade, sair do país...).`
      );
    }
  } else {
    // 3) Fase de aprendizagem com módulos + memória (tipo ChatGPT)
    if (aluno.stage !== "learning") {
      aluno.stage = "learning";
    }

    const idiomaChave = aluno.idioma === "frances" ? "frances" : "ingles";

    const trilha = learningPath[idiomaChave] || learningPath["ingles"];
    let moduleIndex = aluno.moduleIndex ?? 0;
    let moduleStep = aluno.moduleStep ?? 0;

    let moduloAtual = trilha[moduleIndex] || trilha[0];

    const confirmacao = isConfirmMessage(texto);
    if (confirmacao) {
      console.log("✅ Confirmação de continuar módulo recebida.");
    }

    if (moduleIndex >= trilha.length) {
      moduleIndex = trilha.length - 1;
    }
    moduloAtual = trilha[moduleIndex];

    const respostaKito = await gerarRespostaKito(aluno, moduloAtual);

    // Avança micro-passos do módulo
    moduleStep += 1;
    const totalSteps = moduloAtual.steps || 4;
    if (moduleStep >= totalSteps) {
      moduleIndex += 1;
      moduleStep = 0;
      if (moduleIndex >= trilha.length) {
        moduleIndex = trilha.length - 1;
      }
    }

    aluno.moduleIndex = moduleIndex;
    aluno.moduleStep = moduleStep;

    aluno.history.push({ role: "assistant", content: respostaKito });

    // 🔊 ÁUDIO SOB PEDIDO
    const querAudio = userQuerAudio(texto, isAudio);
    console.log("DEBUG_QUER_AUDIO:", { texto, isAudio, querAudio });
    if (querAudio) {
      const audioBase64 = await gerarAudioRespostaKito(respostaKito);
      if (audioBase64) {
        await enviarAudioWhatsApp(numeroAluno, audioBase64);
      }
    }

    // Envia SEMPRE o texto para o aluno poder ler
    await sleep(1200);
    await enviarMensagemWhatsApp(numeroAluno, respostaKito);
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
    if (momentVal) {
      lastMomentByPhone[numeroAluno] = momentVal;
    }

    // 3ª defesa: mesmo texto em <3s
    const agora = Date.now();
    const ultimo = lastTextByPhone[numeroAluno];
    if (texto && ultimo && ultimo.text === texto && agora - ultimo.time < 3000) {
      console.log(
        "⚠️ Mensagem duplicada ignorada (texto + tempo):",
        msgId,
        texto
      );
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

    // Só áudio → transcreve e trata como texto vindo de áudio
    if (audioUrl && !texto) {
      const transcricao = await transcreverAudio(audioUrl);

      if (!transcricao) {
        await enviarMensagemWhatsApp(
          numeroAluno,
          "Tentei ouvir o teu áudio mas não consegui transcrever bem 😅\n" +
            "Podes tentar falar um pouco mais perto do micro ou enviar de novo?"
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

    // Mensagem de texto normal
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
<html lang="pt">
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
    h1 {
      font-size: 24px;
      margin-bottom: 8px;
    }
    h2 {
      font-size: 18px;
      margin: 24px 0 12px;
    }
    .subtitle {
      color: #9ca3af;
      margin-bottom: 20px;
    }
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
    .card-value {
      font-size: 22px;
      font-weight: 600;
    }
    .card-sub {
      font-size: 12px;
      color: #9ca3af;
      margin-top: 4px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
      font-size: 13px;
    }
    th, td {
      padding: 8px 10px;
      text-align: left;
      border-bottom: 1px solid #1f2937;
      vertical-align: top;
    }
    th {
      background: #111827;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    tr:nth-child(even) td {
      background: #020617;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 500;
    }
    .badge-en {
      background: rgba(56, 189, 248, 0.15);
      color: #7dd3fc;
    }
    .badge-fr {
      background: rgba(251, 191, 36, 0.15);
      color: #facc15;
    }
    .badge-both {
      background: rgba(52, 211, 153, 0.15);
      color: #6ee7b7;
    }
    .stage-pill {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      background: #111827;
      color: #e5e7eb;
      display: inline-block;
    }
    .stage-pill.ask_name { color: #f97316; }
    .stage-pill.ask_language { color: #22c55e; }
    .stage-pill.learning { color: #38bdf8; }
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
    .footer {
      margin-top: 24px;
      font-size: 11px;
      color: #6b7280;
    }
    a {
      color: #38bdf8;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
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
      <div class="card-value">${alunos.reduce(
        (sum, a) => sum + (a.mensagens || 0),
        0
      )}</div>
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
          <th>Módulo</th>
          <th>Msgs</th>
          <th>Entrou em</th>
          <th>Última mensagem</th>
        </tr>
      </thead>
      <tbody>
        ${
          alunos.length === 0
            ? `<tr><td colspan="9">Ainda não há alunos. Assim que alguém mandar "Oi" para o Kito, aparece aqui. 😄</td></tr>`
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
                    <td><span class="stage-pill ${a.stage}">${a.stage}</span></td>
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
    Endpoint JSON também disponível em <code>/admin/stats?token=${
      process.env.ADMIN_TOKEN || "TOKEN"
    }</code> · Jovika Academy · Professor Kito · ${new Date().getFullYear()}
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
    "Servidor Kito (Jovika Academy, Z-API + memória + módulos, TEXTO + ÁUDIO SOB PEDIDO) está a correr ✅"
  );
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(
    `🚀 Servidor REST (Kito + Z-API + memória + Dashboard, TEXTO + ÁUDIO SOB PEDIDO) em http://localhost:${PORT}`
  );
});
