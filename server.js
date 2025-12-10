// server.js – Kito, professor da Jovika Academy
// Z-API + memória + módulos + Dashboard + Firestore + ÁUDIO SOB PEDIDO + PERFIL PEDAGÓGICO + LEMBRETES PERSONALIZADOS

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
  "🔥🔥🔥 KITO v5.2 – TEXTO + ÁUDIO + PERFIL PEDAGÓGICO + LEMBRETES + CONVERSA MAIS HUMANA 🔥🔥🔥"
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
    (t.includes("pronun") ||
      t.includes("pronún") ||
      t.includes("corrig") ||
      gatilhos.some((p) => t.includes(p)));

  const resultado = pediuPorTexto || pediuPorAudio;
  return resultado;
}

// Limpa coisas que não queremos que apareçam/lêem, tipo "[Áudio enviado]" ou "(Áudio)"
function limparTextoResposta(txt = "") {
  if (!txt) return "";
  let r = txt;

  // remove [Áudio enviado], [audio enviado], etc.
  r = r.replace(/\[\s*áudio enviado\s*\]/gi, "");
  r = r.replace(/\[\s*audio enviado\s*\]/gi, "");
  r = r.replace(/áudio enviado/gi, "");
  r = r.replace(/audio enviado/gi, "");

  // remove "(Áudio)" ou "(audio)" em qualquer parte
  r = r.replace(/\(\s*áudio\s*\)/gi, "");
  r = r.replace(/\(\s*audio\s*\)/gi, "");

  // remove qualquer frase que fale "vou ... áudio" ou "mandar ... áudio" ou "enviar ... áudio"
  r = r.replace(/.*vou .*áudio.*(\r?\n)?/gi, "");
  r = r.replace(/.*vou .*audio.*(\r?\n)?/gi, "");
  r = r.replace(/.*mandar .*áudio.*(\r?\n)?/gi, "");
  r = r.replace(/.*mandar .*audio.*(\r?\n)?/gi, "");
  r = r.replace(/.*enviar .*áudio.*(\r?\n)?/gi, "");
  r = r.replace(/.*enviar .*audio.*(\r?\n)?/gi, "");

  // remove espaços/linhas duplicadas desnecessárias
  r = r.replace(/\n{3,}/g, "\n\n").trim();

  return r;
}

/**
 * Extrai apenas as linhas do idioma alvo para o áudio
 * - inglês: linhas que parecem frases em inglês
 * - francês: linhas que parecem frases em francês
 * Se não encontrar nada, devolve o texto original.
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

  // fallback: devolve tudo se não conseguir separar
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
  return texto; // guarda a descrição original se não identificou
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
  // default se não ficou claro: 3x por semana
  return "3x";
}

/** ---------- Detectar tipo de mensagem (tradução vs conversa) ---------- **/

function detectarTipoMensagem(textoNorm = "") {
  if (!textoNorm) return "geral";

  // Pedido de tradução / "como se diz"
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

  // Perguntas sobre o próprio Kito: nome, quem é, etc.
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
    textoNorm.includes("quem e voce?") ||
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
  Exemplo:
  "Je suis fatigué."
  "Eu estou cansado."
- Quando escrever frases em inglês, faz assim:
  - primeira linha: só a frase em inglês;
  - linha seguinte: tradução em português do Brasil.
  Exemplo:
  "I am tired."
  "Eu estou cansado."
- Evita misturar francês/inglês e português na mesma linha.

PERFIL PEDAGÓGICO DESTE ALUNO:
- Nome: ${aluno.nome || "não informado"}
- Idioma alvo: ${idiomaAlvo}
- Nível aproximado (interno): ${aluno.nivel || "A0"}
- Nível percebido pelo próprio aluno: ${aluno.nivelPercebido || "não definido"}
- Maior dificuldade declarada: ${
    aluno.maiorDificuldade || "ainda não ficou clara — faça perguntas simples para descobrir."
  }
- Preferência de formato: ${
    aluno.preferenciaFormato || "misto"
  } (entenda: "audio", "texto" ou "misto").
- Frequência preferida de puxão: ${
    aluno.frequenciaPreferida ||
    "não definida — se ainda não estiver claro, pergunte de forma natural."
  }
- Objetivo declarado pelo aluno: ${
    aluno.objetivo ||
    "ainda não ficou claro — faça perguntas simples e naturais para entender o que ele realmente precisa (trabalho, viagem, faculdade, imigração, confiança, etc.)."
  }

MÓDULO ATUAL (APENAS COMO GUIA, NÃO SCRIPT DURO):
- Título: ${modulo?.title || "Introdução"}
- Nível do módulo: ${modulo?.level || aluno.nivel || "iniciante"}
- Objetivo pedagógico do módulo: ${
    modulo?.goal || "ajudar o aluno a comunicar em situações básicas."
  }
- Passo atual (0-based): ${step}
- Número total de passos no módulo: ${totalSteps}

TIPO DA ÚLTIMA MENSAGEM:
- tipoMensagem: ${tipoMensagem}
- Interpretação:
  - "pedido_traducao" = o aluno pediu explicitamente para saber COMO DIZER algo em inglês/francês, TRADUZIR, ou corrigir uma frase específica.
  - "pergunta_sobre_kito" = o aluno perguntou sobre você (nome, idade, quem é você, se é humano ou robô, etc.).
  - "geral" = mensagem de conversa normal, dúvida ou aula.

REGRAS ESPECIAIS PARA ISSO:
- Se tipoMensagem = "pedido_traducao":
  - Explique em português do Brasil e dê a frase correta no idioma alvo.
  - Não transforme a frase do aluno em um parágrafo inteiro em inglês/francês se ele não pediu.
  - Não responda apenas repetindo a frase dele traduzida; converse, explique e, se fizer sentido, ofereça um exemplo extra.
- Se tipoMensagem = "pergunta_sobre_kito":
  - Responda em português do Brasil, como se fosse uma conversa real.
  - Diga claramente que o seu nome é Kito, que você é o professor de inglês e francês da Jovika Academy e que é uma inteligência artificial treinada para ensinar línguas pelo WhatsApp.
  - Você pode acrescentar uma ou duas frases em inglês/francês APENAS se o próprio aluno pedir para ouvir isso na outra língua.
- Se tipoMensagem = "geral":
  - Priorize responder à pergunta ou comentário do aluno como uma pessoa numa conversa.
  - Só proponha exercício ou reformule a frase dele se isso fizer sentido no contexto ou se ele pedir correção.

KITO PROFESSOR HUMANO (ADAPTAÇÃO AO PERFIL):
- Leia com atenção o histórico de mensagens para perceber:
  - O que essa pessoa já sabe.
  - Qual é a dificuldade principal (vocabulário, gramática, pronúncia, medo de falar, vergonha, etc.).
  - Qual é o objetivo real (trabalho, viagem, estudos, imigração, sair do país, confiança, etc.).
  - Se o aluno prefere áudio, texto ou uma mistura dos dois.
- Use tudo isso para adaptar a forma como ensina:
  - Se a maior dificuldade for pronúncia ou fala, explique com calma e ofereça exemplos curtos que funcionam bem em áudio.
  - Se a maior dificuldade for gramática, dê explicações simples e poucos exemplos, sem sobrecarregar.
  - Se for vocabulário, traga palavras úteis ligadas ao objetivo dele.
  - Se for medo/vergonha de falar, seja mais acolhedor e destaque pequenos progressos.
- Você não é um "bot de exercícios". Você é um professor particular que conversa, ouve e pensa antes de responder.
- Antes de mandar exercícios ou várias frases para o aluno repetir:
  1) Pergunte-se: "O que essa pessoa realmente pediu nesta última mensagem?"
  2) Se ela só pediu uma tradução ou tirou uma dúvida pontual, responda de forma direta e clara, sem exercício extra obrigatório.
  3) Só ofereça exercício quando isso fizer sentido e deixe claro que é opcional.

COMO O KITO PENSA E AGE:
- Lembra-se do contexto da conversa (histórico) e não repete perguntas iniciais
  como nome, idioma ou objetivo.
- Responde exatamente ao que o aluno diz, usando os módulos apenas como GUIA,
  não como um script engessado.
- Se o aluno fizer perguntas específicas ("como digo X?", "explica Y"), responda diretamente
  e só depois, se fizer sentido, ofereça um pequeno exercício relacionado.
- Se o aluno disser palavras soltas de objetivo ("trabalho", "confiança", "Canadá", "emprego"),
  você:
    - NÃO fica só traduzindo a palavra.
    - Explica como esse objetivo se relaciona com o idioma e com o que ele precisa aprender.
    - Propõe um pequeno exercício ou frase relacionada a esse objetivo, mas sempre conectada ao que ele acabou de falar.
- Quando o aluno responde só "sim", "ok", "vamos", "tá bem", interprete isso como confirmação para dar o próximo micro-passo, MAS ainda assim responda de forma natural, não mecânica.

ESTILO DE RESPOSTA:
- Escreve como se fosse mensagem de WhatsApp:
  - Frases curtas
  - Parágrafos curtos
  - Linguagem simples e direta
- Usa emojis com moderação (1–2 no máximo por mensagem), só se fizer sentido.
- Nunca mande textão enorme. No máximo 3 blocos:
  1) Explicação rápida (contexto + conceito)
  2) 2–3 exemplos com tradução, se necessário
  3) Um mini exercício opcional (1 ou 2 frases, gap-fill, escolha, etc.), apenas se encaixar no momento.
- Quando não fizer sentido exercício, termine com uma pergunta simples do tipo:
  - "Isso fez sentido para você?"
  - "Quer que eu te dê mais um exemplo?"
  - "Você quer praticar isso com um exercício rapidinho?"

SOBRE ÁUDIO (MUITO IMPORTANTE):
- Você consegue enviar áudios curtos de voz sintetizada quando o aluno pede.
- **NUNCA** diga frases como "não consigo enviar áudio", "só consigo texto", "não tenho voz" ou "não posso ajudar com áudio".
- **NUNCA** escreva tags como "[Áudio enviado]" ou "[audio enviado]" nem use prefixos como "(Áudio)" ou "Áudio:".
- **NÃO** diga "vou mandar um áudio", "enviei um áudio" ou nada parecido. O sistema cuida do envio.
- Quando o aluno pedir para ouvir algo em áudio (pronúncia, frases, explicação, diálogo, etc.):
  1) Responda normalmente em texto (explicação + exemplos +, se fizer sentido, um mini exercício).
  2) No final da mensagem, faça **uma pergunta de preferência**, por exemplo:
     - "Você prefere que eu continue também em áudio ou só por mensagem escrita?"

CORREÇÃO DE ERROS:
- Quando o aluno erra:
  - Mostre a frase original dele.
  - Mostre a versão corrigida.
  - Faça uma explicação rápida do porquê (sem excesso de gramática pesada).
- Mantenha o tom positivo. Nada de "está errado", prefira "ficaria melhor assim" ou "podemos ajustar assim".

TOM EMOCIONAL:
- Se o aluno demonstrar dificuldade, desmotivação ou cansaço, responda de forma
  mais acolhedora e estimule a continuar devagar.
- Se o aluno estiver empolgado, acompanhe essa energia e puxe um pouco mais.

RESUMO:
Você é o Kito, uma espécie de "ChatGPT-professor de idiomas" da Jovika Academy:
inteligente, adaptável, humano, e sempre focado em fazer o aluno realmente
falar o idioma, não só decorar regras ou repetir frases soltas.
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
      // fallback genérico (PT-BR + FR se aparecer)
      instructions =
        "When the text is in Portuguese, speak Brazilian Portuguese with a clear, natural MALE voice. When the text is in French, pronounce it with a standard metropolitan French accent (France), slow and very clear, ideal for language learners.";
    }

    const speech = await openai.audio.speech.create({
      model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
      voice: process.env.OPENAI_TTS_VOICE || "onyx", // voz masculina fixa
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
      aluno = {
        ...fromDb,
        history: [],
        nivelPercebido: fromDb.nivelPercebido || null,
        maiorDificuldade: fromDb.maiorDificuldade || null,
        preferenciaFormato: fromDb.preferenciaFormato || null,
        frequenciaPreferida: fromDb.frequenciaPreferida || null,
        objetivo: fromDb.objetivo || null,
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

  // Atualiza stats e reseta lembretes (porque o aluno voltou a falar)
  aluno.messagesCount = (aluno.messagesCount || 0) + 1;
  aluno.lastMessageAt = agora;
  aluno.reminder1hSentAt = null;
  aluno.reminder2dSentAt = null;
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
        `Ótimo, ${aluno.nome}! Vamos trabalhar ${idiomaTexto} juntos 💪✨\nAntes de começar a aula, quero te conhecer um pouco melhor para adaptar tudo ao seu perfil.\n\nVocê já estudou ${idiomaTexto} antes? Pode responder algo como:\n- "Nunca estudei"\n- "Já estudei um pouco"\n- "Já tenho uma base boa".`
      );
    }
  } else if (aluno.stage === "ask_experience") {
    // 3) Já estudou antes?
    const { nivelPercebido, nivelCEFR } = inferirNivelPercebido(texto);
    aluno.nivelPercebido = nivelPercebido;
    aluno.nivel = aluno.nivel || nivelCEFR;

    aluno.stage = "ask_difficulty";

    await enviarMensagemWhatsApp(
      numeroAluno,
      `Perfeito, entendi. 😊\nAgora me conta: em ${
        aluno.idioma === "frances" ? "francês" : "inglês"
      }, o que você sente que é mais difícil para você hoje?\n\nPor exemplo: pronúncia, gramática, vocabulário, escutar, vergonha de falar...`
    );
  } else if (aluno.stage === "ask_difficulty") {
    // 4) Maior dificuldade
    aluno.maiorDificuldade = inferirMaiorDificuldade(texto);
    aluno.stage = "ask_preference_format";

    await enviarMensagemWhatsApp(
      numeroAluno,
      "Ótimo, obrigado por compartilhar isso comigo. 😊\nOutra coisa importante: você prefere que eu explique mais por áudio, por mensagem escrita ou misturando os dois?"
    );
  } else if (aluno.stage === "ask_preference_format") {
    // 5) Preferência de formato
    aluno.preferenciaFormato = inferirPreferenciaFormato(texto);
    aluno.stage = "ask_frequency";

    await enviarMensagemWhatsApp(
      numeroAluno,
      "Show! Para eu organizar melhor os seus estudos:\nVocê prefere que eu te puxe todos os dias, 3x por semana ou só quando você falar comigo?"
    );
  } else if (aluno.stage === "ask_frequency") {
    // 6) Frequência de lembrete
    aluno.frequenciaPreferida = inferirFrequenciaPreferida(texto);
    aluno.stage = "learning";

    const idiomaTexto =
      aluno.idioma === "ingles"
        ? "inglês"
        : aluno.idioma === "frances"
        ? "francês"
        : "inglês e francês";

    await enviarMensagemWhatsApp(
      numeroAluno,
      `Maravilha, combinado! 😄\nAgora a última coisa para eu te acompanhar bem:\nQual é o seu principal objetivo com ${idiomaTexto}? Trabalho, viagem, faculdade, sair do país, ganhar confiança...?`
    );
  } else {
    // 7) Fase de aprendizagem com módulos + memória (tipo ChatGPT)
    if (aluno.stage !== "learning") {
      aluno.stage = "learning";
    }

    // Se ainda não registou o objetivo, assume que esta mensagem é isso
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

    let moduloAtual = trilha[moduleIndex] || trilha[0];

    const confirmacao = isConfirmMessage(texto);
    if (confirmacao) {
      console.log("✅ Confirmação de continuar módulo recebida.");
    }

    if (moduleIndex >= trilha.length) {
      moduleIndex = trilha.length - 1;
    }
    moduloAtual = trilha[moduleIndex];

    const querAudio = userQuerAudio(texto, isAudio);
    const pediuExercicioEmAudio =
      querAudio &&
      (textoNorm.includes("exercicio") ||
        textoNorm.includes("exercício") ||
        textoNorm.includes("exercicios") ||
        textoNorm.includes("exercícios"));

    console.log("DEBUG_QUER_AUDIO:", {
      texto,
      isAudio,
      querAudio,
      pediuExercicioEmAudio,
      tipoMensagem,
    });

    // idioma alvo para áudio (o que o aluno está a estudar)
    const idiomaAudioAlvo =
      aluno.idioma === "ingles" || aluno.idioma === "frances"
        ? aluno.idioma
        : null;

    if (pediuExercicioEmAudio) {
      // Caso especial: "envia o exercício em áudio"
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
        "Pronto! Enviei o exercício em áudio para você ouvir e praticar. Depois me envie suas respostas por mensagem que eu corrijo com carinho, combinado? 🙂";

      aluno.history.push({ role: "assistant", content: msgConfirm });
      await sleep(800);
      await enviarMensagemWhatsApp(numeroAluno, msgConfirm);
    } else {
      // Fluxo normal
      const respostaKito = await gerarRespostaKito(
        aluno,
        moduloAtual,
        tipoMensagem
      );

      // Avança micro-passos do módulo APENAS quando o aluno confirma continuar
      if (confirmacao) {
        moduleStep += 1;
        const totalSteps = moduloAtual.steps || 4;
        if (moduleStep >= totalSteps) {
          moduleIndex += 1;
          moduleStep = 0;
          if (moduleIndex >= trilha.length) {
            moduleIndex = trilha.length - 1;
          }
        }
      }

      aluno.moduleIndex = moduleIndex;
      aluno.moduleStep = moduleStep;

      aluno.history.push({ role: "assistant", content: respostaKito });

      // ÁUDIO SOB PEDIDO (explicações / frases)
      if (querAudio) {
        const textoParaAudio = extrairTrechoParaAudio(
          respostaKito,
          idiomaAudioAlvo
        );
        const audioBase64 = await gerarAudioRespostaKito(
          textoParaAudio,
          idiomaAudioAlvo
        );
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
const REMINDER_CHECK_INTERVAL_MS = 5 * 60 * 1000; // a cada 5 minutos

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

    // Se o aluno escolheu "só quando você falar comigo", não envia lembretes
    if (aluno.frequenciaPreferida === "livre") continue;

    const diff = agora - new Date(aluno.lastMessageAt);
    const idiomaTexto = getIdiomaTexto(aluno.idioma);
    const nome = aluno.nome || "por aqui";

    const afterLast = (d) => !d || new Date(d) < new Date(aluno.lastMessageAt);

    // Lembrete de 2 dias
    if (diff >= TWO_DAYS_MS && afterLast(aluno.reminder2dSentAt)) {
      const msg2d = `Oi, ${nome}! 😊 Faz alguns dias que a gente não pratica ${idiomaTexto} juntos.\nQuer retomar a sua aula agora comigo?`;
      console.log("⏰ Lembrete 2 dias para", numero);
      aluno.reminder2dSentAt = agora;
      await enviarMensagemWhatsApp(numero, msg2d);
      await saveStudentToFirestore(numero, aluno);
      continue;
    }

    // Lembrete de 1 hora
    if (
      diff >= ONE_HOUR_MS &&
      diff < TWO_DAYS_MS &&
      afterLast(aluno.reminder1hSentAt)
    ) {
      const msg1h = `Oi, ${nome}! 😄 Só passando para saber se você quer continuar a sua aula de ${idiomaTexto} agora. Se quiser, é só me mandar uma mensagem e seguimos do ponto onde paramos.`;
      console.log("⏰ Lembrete 1h para", numero);
      aluno.reminder1hSentAt = agora;
      await enviarMensagemWhatsApp(numero, msg1h);
      await saveStudentToFirestore(numero, aluno);
    }
  }
}

// Inicia o loop de lembretes
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
    .stage-pill.ask_experience { color: #a855f7; }
    .stage-pill.ask_difficulty { color: #facc15; }
    .stage-pill.ask_preference_format { color: #ec4899; }
    .stage-pill.ask_frequency { color: #22c55e; }
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
            ? `<tr><td colspan="9">Ainda não há alunos. Assim que alguém mandar "oi" para o Kito, aparece aqui. 😄</td></tr>`
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
    "Servidor Kito (Jovika Academy, Z-API + memória + módulos, TEXTO + ÁUDIO + PERFIL PEDAGÓGICO + LEMBRETES + CONVERSA HUMANA) está a correr ✅"
  );
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(
    `🚀 Servidor REST (Kito + Z-API + memória + Dashboard, TEXTO + ÁUDIO + PERFIL PEDAGÓGICO + LEMBRETES + CONVERSA HUMANA) em http://localhost:${PORT}`
  );
});
