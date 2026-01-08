// server.js – Kito, professor da Jovika Academy
// Z-API + memória + módulos + Dashboard + Firestore + PERFIL PEDAGÓGICO
// + MODO PREMIUM ONLY (TODOS PAGAM PARA TER ACESSO)
// + ÁUDIO SOMENTE PREMIUM (somente quando aluno pede KITO enviar áudio)
// + STRIPE webhook (auto-unlock) + TRANSCRIÇÃO de áudio do aluno (p/ entender pedido, mas NÃO dá aula se não pagou)
// + DIAGNÓSTICO (3 perguntas) e SÓ NO FIM mostra o preço + link Stripe (GLOBAL)

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import axios from "axios";
import OpenAI from "openai";
import { db } from "./firebaseAdmin.js";
import Stripe from "stripe";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

dotenv.config();

console.log(
  "🔥 KITO v7.0 – PREMIUM ONLY (todos pagam) + Stripe auto-unlock + Unlock manual + Firestore fallback 🔥"
);

const app = express();
const PORT = process.env.PORT || 10000;

/**
 * ✅ Stripe webhook precisa de RAW body, então:
 * - json parser em tudo EXCETO /stripe/webhook
 */
const jsonParser = bodyParser.json({ limit: "2mb" });
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

/** ---------- CONFIG ---------- **/
const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 30); // ainda existe, mas Premium Only ignora
const PAYWALL_COOLDOWN_HOURS = Number(process.env.PAYWALL_COOLDOWN_HOURS || 20);
const UPSELL_PROGRESS_COOLDOWN_HOURS = Number(process.env.UPSELL_PROGRESS_COOLDOWN_HOURS || 24);

const STRIPE_PAYMENT_LINK_URL = String(
  process.env.STRIPE_PAYMENT_LINK_URL ||
    "https://buy.stripe.com/00w28qchVgVQdfm1eS9ws01"
).trim();

const PREMIUM_PRICE_EUR = String(process.env.PREMIUM_PRICE_EUR || "9,99€").trim();
const PREMIUM_PERIOD_TEXT = String(process.env.PREMIUM_PERIOD_TEXT || "mês").trim();

const MAX_HISTORY_MESSAGES = Number(process.env.MAX_HISTORY_MESSAGES || 24);
const MAX_PROCESSED_IDS = Number(process.env.MAX_PROCESSED_IDS || 5000);

/**
 * ✅ MODO PREMIUM ONLY
 * - Se true: qualquer pessoa precisa pagar para ter acesso a QUALQUER conversa/aula.
 */
const REQUIRE_PREMIUM_FOR_ACCESS =
  String(process.env.REQUIRE_PREMIUM_FOR_ACCESS || "true").toLowerCase() === "true";

/** ---------- memória ---------- **/
const students = {};
const processedMessages = new Set();
const lastMomentByPhone = {};
const lastTextByPhone = {};

/** ---------- Trilhas ---------- **/
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

function isYes(texto = "") {
  const t = normalizarTexto(texto);
  return (
    t === "sim" ||
    t === "s" ||
    t.includes("sim") ||
    t.includes("quero") ||
    t.includes("pode") ||
    t.includes("manda") ||
    t.includes("envia") ||
    t.includes("enviar")
  );
}

function isNo(texto = "") {
  const t = normalizarTexto(texto);
  return (
    t === "nao" ||
    t === "não" ||
    t === "n" ||
    t.includes("nao") ||
    t.includes("não") ||
    t.includes("depois") ||
    t.includes("agora nao") ||
    t.includes("agora não")
  );
}

function todayKeyUTC(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function safeToDate(val) {
  if (!val) return null;
  if (typeof val.toDate === "function") return val.toDate();
  const d = val instanceof Date ? val : new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function trimHistory(aluno) {
  aluno.history = aluno.history || [];
  if (aluno.history.length > MAX_HISTORY_MESSAGES) {
    aluno.history = aluno.history.slice(-MAX_HISTORY_MESSAGES);
  }
}

/** Stripe link (GLOBAL) */
function gerarStripeLinkParaTelefone(phone) {
  const ref = `whatsapp:${String(phone || "").replace(/\D/g, "")}`;
  const glue = STRIPE_PAYMENT_LINK_URL.includes("?") ? "&" : "?";
  return `${STRIPE_PAYMENT_LINK_URL}${glue}client_reference_id=${encodeURIComponent(ref)}`;
}

/** ---------- Mensagem de Venda (Premium Only) ---------- **/
function montarMensagemPremiumOnly(phone) {
  const link = gerarStripeLinkParaTelefone(phone);

  return [
    `👋 Olá! Eu sou o *Professor Kito* da *Jovika Academy*.`,
    ``,
    `Eu ajudo você a *falar inglês ou francês na prática* (sem enrolação), com:`,
    `✅ Conversa real (estilo humano)`,
    `✅ Correções no seu nível`,
    `✅ Exercícios e desafios`,
    `✅ *Áudios* para treinar pronúncia (quando você pedir)`,
    `✅ Plano guiado A0 → B1`,
    ``,
    `🔓 Para ter acesso, o *Premium custa ${PREMIUM_PRICE_EUR}/${PREMIUM_PERIOD_TEXT}*.`,
    ``,
    `👉 *Ativar agora (Stripe):*`,
    `${link}`,
    ``,
    `Assim que o pagamento confirmar, eu libero automaticamente ✅`,
  ].join("\n");
}

/** Mensagens Premium (mantidas para outros fluxos) */
function montarMensagemPremiumPorAudio(phone) {
  const link = gerarStripeLinkParaTelefone(phone);
  return [
    `🔒 Áudios são exclusivos do *Acesso Premium*.`,
    ``,
    `Premium: *${PREMIUM_PRICE_EUR}/${PREMIUM_PERIOD_TEXT}* (cancele quando quiser).`,
    `👉 ${link}`,
  ].join("\n");
}

function montarMensagemPremiumPorProgresso(phone) {
  const link = gerarStripeLinkParaTelefone(phone);
  return [
    `Se você quiser *progresso mais rápido*, o *Premium* libera:`,
    `✅ Plano A0→B1 + acompanhamento`,
    `✅ Mensagens ilimitadas`,
    `✅ Áudios (quando você pedir)`,
    ``,
    `Por *${PREMIUM_PRICE_EUR}/${PREMIUM_PERIOD_TEXT}*.`,
    `👉 ${link}`,
  ].join("\n");
}

/** Premium? */
function isPremium(aluno, now = new Date()) {
  const plan = aluno?.plan || "free";
  const until = safeToDate(aluno?.premiumUntil);
  if (until && until.getTime() > now.getTime()) return true;
  return plan === "premium" && !until ? true : false;
}

/** contador diário (mantido) */
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

function canSendProgressUpsell(aluno, now = new Date()) {
  const last = safeToDate(aluno.lastProgressUpsellAt);
  if (!last) return true;
  const diffH = (now.getTime() - last.getTime()) / (1000 * 60 * 60);
  return diffH >= UPSELL_PROGRESS_COOLDOWN_HOURS;
}

function alunoPediuKitoEnviarAudio(texto = "") {
  const t = normalizarTexto(texto || "");
  const gatilhos = [
    "manda audio",
    "manda áudio",
    "envia audio",
    "envia áudio",
    "responde em audio",
    "responde em áudio",
    "pode enviar audio",
    "pode enviar áudio",
    "envia por audio",
    "envia por áudio",
    "me manda em audio",
    "me manda em áudio",
  ];
  return gatilhos.some((p) => t.includes(p));
}

/** modos */
function detectarComandoModo(texto = "") {
  const t = normalizarTexto(texto);
  const querConversa =
    t.includes("modo conversa") ||
    t === "conversa" ||
    t.includes("quero conversar") ||
    t.includes("vamos conversar");

  const querAprender =
    t.includes("modo aprender") ||
    t.includes("modo aula") ||
    t === "aprender" ||
    t.includes("me corrige") ||
    t.includes("corrigir");

  if (querConversa) return "conversa";
  if (querAprender) return "aprender";
  return null;
}

function isProgressPremiumTrigger(texto = "") {
  const t = normalizarTexto(texto || "");
  const gatilhos = [
    "plano", "nivel", "nível", "progresso", "acompanhamento", "tarefas", "desafio",
    "exercicio", "exercício", "teste de nivel", "teste de nível", "certificado",
    "cronograma", "todos os dias", "5x", "3x", "aulas por semana", "professor humano",
    "mentoria", "quanto custa", "preço", "assinar", "premium",
  ];
  return gatilhos.some((g) => t.includes(g));
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
  ) return "pedido_premium";

  return "geral";
}

/** Perfil pedagógico */
function inferirNivelPercebido(texto) {
  const t = normalizarTexto(texto);
  if (t.includes("nunca") || t.includes("zero") || t.includes("começar do zero"))
    return { nivelPercebido: "iniciante", nivelCEFR: "A0" };
  if (t.includes("basico") || t.includes("básico") || t.includes("pouco"))
    return { nivelPercebido: "básico", nivelCEFR: "A1" };
  if (t.includes("intermediario") || t.includes("intermediário"))
    return { nivelPercebido: "intermediário", nivelCEFR: "A2/B1" };
  if (t.includes("avancado") || t.includes("avançado") || t.includes("fluente"))
    return { nivelPercebido: "avançado", nivelCEFR: "B2+" };
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
  if (t.includes("so quando") || t.includes("só quando") || t.includes("quando eu falar"))
    return "livre";
  return "3x";
}

/** ---------- DIAGNÓSTICO (mantido) ---------- **/
function initDiagnosis(aluno) {
  aluno.diagnosis = aluno.diagnosis || { objetivo: null, nivel: null, tempo: null };
}

function parseChoiceLetter(texto = "") {
  const t = normalizarTexto(texto).trim();
  const m = t.match(/\b([a-f])\b/);
  if (m && m[1]) return m[1].toUpperCase();
  const m2 = t.match(/^([a-f])/);
  if (m2 && m2[1]) return m2[1].toUpperCase();
  return null;
}

function diagnosisObjetivoFromChoice(letter, rawText) {
  if (!letter) return String(rawText || "").trim() || null;
  const map = { A: "Trabalho", B: "Faculdade / provas", C: "Viagem", D: "Morar fora", E: "Conversação / confiança", F: "Outro" };
  return map[letter] || String(rawText || "").trim() || null;
}

function diagnosisNivelFromChoice(letter, rawText) {
  if (!letter) return String(rawText || "").trim() || null;
  const map = {
    A: "A0 (zero / começando agora)",
    B: "A1 (básico)",
    C: "A2 (entende razoável, trava para falar)",
    D: "A2+/B1- (conversa, mas erra muito)",
    E: "B1 (intermediário para avançado)",
  };
  return map[letter] || String(rawText || "").trim() || null;
}

function diagnosisTempoFromChoice(letter, rawText) {
  if (!letter) return String(rawText || "").trim() || null;
  const map = { A: "10–15 min por dia", B: "30 min por dia", C: "1h por dia", D: "Só 3x por semana", E: "Só quando eu tiver tempo" };
  return map[letter] || String(rawText || "").trim() || null;
}

function inferRitmoFromTempo(tempo = "") {
  const t = normalizarTexto(tempo);
  if (t.includes("1h") || t.includes("1 hora")) return "intenso (evolução mais rápida)";
  if (t.includes("30")) return "bom e consistente";
  if (t.includes("10") || t.includes("15")) return "leve, mas constante";
  if (t.includes("3x")) return "moderado (3x por semana)";
  if (t.includes("quando")) return "flexível (sem rotina fixa)";
  return "consistente";
}

function montarPerguntaDiagnosticoOptin() {
  return [
    `Perfeito. Antes de eu te passar um plano certinho, posso fazer um diagnóstico rápido (leva 1 minuto)?`,
    `Assim eu adapto tudo ao seu nível e ao seu objetivo.`,
    ``,
    `Responda: *SIM* ou *NÃO*.`,
  ].join("\n");
}

function montarPerguntaDiagnosticoQ1() {
  return [
    `1/3 — Qual é seu objetivo principal com o inglês/francês?`,
    ``,
    `A) Trabalho`,
    `B) Faculdade / provas`,
    `C) Viagem`,
    `D) Morar fora`,
    `E) Conversação / confiança`,
    `F) Outro (escreva)`,
  ].join("\n");
}

function montarPerguntaDiagnosticoQ2() {
  return [
    `2/3 — Qual frase descreve melhor seu nível hoje?`,
    ``,
    `A) Zero, estou começando agora`,
    `B) Sei o básico (cumprimentos, frases simples)`,
    `C) Entendo razoável, mas travo para falar`,
    `D) Já converso, mas erro muito`,
    `E) Intermediário para avançado`,
  ].join("\n");
}

function montarPerguntaDiagnosticoQ3() {
  return [
    `3/3 — Quanto tempo você consegue estudar por semana?`,
    ``,
    `A) 10–15 min por dia`,
    `B) 30 min por dia`,
    `C) 1h por dia`,
    `D) Só 3x por semana`,
    `E) Só quando eu tiver tempo`,
  ].join("\n");
}

function montarResultadoDiagnostico(aluno) {
  initDiagnosis(aluno);
  const objetivo = aluno.diagnosis?.objetivo || "—";
  const nivel = aluno.diagnosis?.nivel || "—";
  const tempo = aluno.diagnosis?.tempo || "—";
  const ritmo = inferRitmoFromTempo(tempo);

  return [
    `Fechado ✅ Aqui está seu diagnóstico:`,
    ``,
    `📌 Objetivo: ${objetivo}`,
    `📌 Nível atual: ${nivel}`,
    `📌 Melhor ritmo: ${ritmo}`,
    ``,
    `Se você seguir esse ritmo, o mais realista é evoluir para *A2/A2+ em 3–6 meses* (depende da consistência).`,
    ``,
    `Agora eu posso te colocar num *plano guiado A0→B1*, com exercícios e acompanhamento do seu progresso.`,
  ].join("\n");
}

function montarMensagemPrecoNoFim(phone) {
  const link = gerarStripeLinkParaTelefone(phone);
  return [
    `💰 Para liberar o *plano completo + mensagens ilimitadas + acompanhamento*, o *Premium custa ${PREMIUM_PRICE_EUR}/${PREMIUM_PERIOD_TEXT}*.`,
    ``,
    `👉 Link (Stripe):`,
    `${link}`,
  ].join("\n");
}

/** ---------- Firestore salvar/carregar ---------- **/
async function saveStudentToFirestore(phone, aluno) {
  try {
    if (!db) return;

    const createdAt = safeToDate(aluno.createdAt) || new Date();
    const lastMessageAt = safeToDate(aluno.lastMessageAt) || new Date();

    const premiumUntil = safeToDate(aluno.premiumUntil);
    const lastPaywallPromptAt = safeToDate(aluno.lastPaywallPromptAt);
    const lastProgressUpsellAt = safeToDate(aluno.lastProgressUpsellAt);

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
        diagnosis: aluno.diagnosis ?? null,

        messagesCount: aluno.messagesCount ?? 0,
        moduleIndex: aluno.moduleIndex ?? 0,
        moduleStep: aluno.moduleStep ?? 0,

        plan: aluno.plan ?? "free",
        premiumUntil: premiumUntil || null,
        paymentProvider: aluno.paymentProvider ?? null,

        dailyCount: aluno.dailyCount ?? 0,
        dailyDate: aluno.dailyDate ?? null,

        lastPaywallPromptAt: lastPaywallPromptAt || null,
        lastProgressUpsellAt: lastProgressUpsellAt || null,

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
      lastProgressUpsellAt: safeToDate(data.lastProgressUpsellAt),
      updatedAt: safeToDate(data.updatedAt),
    };
  } catch (err) {
    console.error("❌ Erro ao carregar aluno do Firestore:", err?.message || err);
    return null;
  }
}

async function ensureStudentLoaded(numeroAluno) {
  let aluno = students[numeroAluno];

  const incompleto =
    aluno &&
    (!aluno.stage ||
      (aluno.stage !== "ask_name" && !aluno.nome) ||
      (aluno.stage !== "ask_name" && aluno.stage !== "ask_language" && !aluno.idioma));

  if (!aluno || incompleto) {
    const fromDb = await loadStudentFromFirestore(numeroAluno);
    if (fromDb) {
      aluno = { ...(aluno || {}), ...fromDb, history: aluno?.history || [] };
      students[numeroAluno] = aluno;
    }
  }
  return aluno || null;
}

/** ---------- OpenAI ---------- **/
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function limparTextoResposta(txt = "") {
  if (!txt) return "";
  return String(txt).replace(/\n{3,}/g, "\n\n").trim();
}

async function gerarRespostaKito(aluno, moduloAtual, tipoMensagem = "geral") {
  const history = aluno.history || [];
  const ultimoUser = history.filter((m) => m.role === "user").slice(-1)[0];
  const textoDoAluno = ultimoUser ? ultimoUser.content : "(sem mensagem recente)";

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
Tu és o **Kito**, professor oficial da **Jovika Academy** (inglês e francês) no WhatsApp.

MODO DO ALUNO:
- chatMode: "${modo}"
- Se chatMode="conversa": responda humano e natural (sem correção automática). No final pergunte se quer correção.
- Se chatMode="aprender": ensine e corrija com explicação curta.

IMPORTANTE:
- Se tipo="pergunta_sobre_kito": responda direto (sem lição, sem tradução).
- Se tipo="pedido_traducao": traduza e explique curto.
- Se tipo="pedido_premium": responda curto e convide para Premium.
- Se o aluno mandar áudio, responda por texto e, se pedido, corrija por escrito.

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

MENSAGEM DO ALUNO:
${textoDoAluno}
  `.trim();

  const mensagens = [{ role: "system", content: systemPrompt }, ...history.slice(-10)];

  const resposta = await openai.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    input: mensagens,
  });

  const textoGerado =
    resposta.output?.[0]?.content?.[0]?.text ||
    "Desculpa, deu um erro aqui. Tente de novo 🙏";
  return limparTextoResposta(textoGerado);
}

/** ---------- Z-API send text ---------- **/
async function enviarMensagemWhatsApp(phone, message) {
  try {
    const msg = String(message || "").trim();
    if (!msg) return;

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

    await axios.post(url, payload, { headers });
  } catch (err) {
    console.error("❌ Erro ao enviar mensagem via Z-API:", err.response?.data || err.message);
  }
}

/** ---------- ÁUDIO (TTS) – Premium only ---------- **/
async function gerarAudioRespostaKito(texto, idiomaAlvo = null) {
  try {
    const clean = String(texto || "").trim();
    if (!clean) return null;

    const instructions =
      idiomaAlvo === "ingles"
        ? "Speak in clear, neutral English with a natural MALE voice. Talk slowly and clearly for beginners."
        : idiomaAlvo === "frances"
        ? "Parle en français standard de France, voix masculine naturelle, lent et très clair pour débutants."
        : "Speak clearly and naturally.";

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
    if (!audioBase64) return;

    const instanceId = process.env.ZAPI_INSTANCE_ID;
    const instanceToken = process.env.ZAPI_INSTANCE_TOKEN;
    const clientToken = process.env.ZAPI_CLIENT_TOKEN;

    if (!instanceId || !instanceToken) return;

    const url = `https://api.z-api.io/instances/${instanceId}/token/${instanceToken}/send-audio`;
    const payload = { phone, audio: audioBase64, viewOnce: false, waveform: true };

    const headers = { "Content-Type": "application/json" };
    if (clientToken) headers["Client-Token"] = clientToken;

    await axios.post(url, payload, { headers });
  } catch (err) {
    console.error("❌ Erro ao enviar áudio via Z-API:", err.response?.data || err.message);
  }
}

/** ---------- Transcrição de áudio ---------- **/
async function transcreverAudioFromUrl(audioUrl) {
  const tmpDir = os.tmpdir();
  const filePath = path.join(tmpDir, `kito-audio-${randomUUID()}.ogg`);

  try {
    const resp = await axios.get(audioUrl, { responseType: "arraybuffer" });
    fs.writeFileSync(filePath, Buffer.from(resp.data));

    const fileStream = fs.createReadStream(filePath);
    const model = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";

    const tr = await openai.audio.transcriptions.create({
      file: fileStream,
      model,
    });

    const text = (tr?.text || "").trim();
    return text || null;
  } catch (err) {
    console.error("❌ Erro transcrevendo áudio:", err.response?.data || err.message);
    return null;
  } finally {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
  }
}

/** ---------- LÓGICA PRINCIPAL ---------- **/
async function processarMensagemAluno({ numeroAluno, texto, profileName, isAudio }) {
  const agora = new Date();

  // garante aluno carregado
  let aluno = await ensureStudentLoaded(numeroAluno);

  // se não existe, cria stub (mas NÃO dá aula se Premium Only)
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
      plan: "free",
      premiumUntil: null,
      paymentProvider: null,
      dailyCount: 0,
      dailyDate: null,
      lastPaywallPromptAt: null,
      lastProgressUpsellAt: null,
      diagnosis: null,
      history: [],
    };
    students[numeroAluno] = aluno;
    await saveStudentToFirestore(numeroAluno, aluno);
  }

  aluno.messagesCount = (aluno.messagesCount || 0) + 1;
  aluno.lastMessageAt = agora;
  aluno.history = aluno.history || [];

  // contador diário (mantido)
  updateDailyCounter(aluno, agora);

  const premium = isPremium(aluno, agora);

  /**
   * ✅ PREMIUM ONLY: se não pagou, envia mensagem de venda + link Stripe e para.
   */
  if (REQUIRE_PREMIUM_FOR_ACCESS && !premium) {
    // anti-spam
    if (canSendPaywallPrompt(aluno, agora)) {
      aluno.lastPaywallPromptAt = agora;
      const msg = montarMensagemPremiumOnly(numeroAluno);
      aluno.history.push({ role: "assistant", content: msg });
      trimHistory(aluno);

      await enviarMensagemWhatsApp(numeroAluno, msg);
      await saveStudentToFirestore(numeroAluno, aluno);
      return;
    }

    // se está em cooldown, não repete a oferta; só confirma que viu
    const curtinha = "🔒 Para ter acesso ao Professor Kito, ative o Premium no link que enviei acima ✅";
    await enviarMensagemWhatsApp(numeroAluno, curtinha);
    aluno.history.push({ role: "assistant", content: curtinha });
    trimHistory(aluno);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  /**
   * ✅ Daqui para baixo: somente PREMIUM (já pagou)
   */
  const pediuKitoAudio = alunoPediuKitoEnviarAudio(texto || "");

  // histórico user
  aluno.history.push({ role: "user", content: String(texto || "") });
  trimHistory(aluno);

  // aluno pede premium (já é premium, mas responde curto)
  const textoNormQuick = normalizarTexto(texto || "");
  const tipoQuick = detectarTipoMensagem(textoNormQuick);
  if (tipoQuick === "pedido_premium") {
    const msg = "Você já está com Premium ativo ✅\nO que você quer praticar agora: inglês ou francês?";
    aluno.history.push({ role: "assistant", content: msg });
    trimHistory(aluno);
    await enviarMensagemWhatsApp(numeroAluno, msg);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  // troca de modo
  const comandoModo = detectarComandoModo(texto || "");
  if (comandoModo && aluno.stage !== "ask_name" && aluno.stage !== "ask_language") {
    aluno.chatMode = comandoModo;
    const msgModo =
      comandoModo === "conversa"
        ? "Perfeito 😊 A partir de agora a gente conversa para você praticar. Se quiser que eu corrija tudo, diga: modo aprender."
        : "Combinado 💪 A partir de agora eu vou te ensinar e corrigir. Se quiser só praticar sem correção, diga: modo conversa.";

    aluno.history.push({ role: "assistant", content: msgModo });
    trimHistory(aluno);
    await enviarMensagemWhatsApp(numeroAluno, msgModo);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  /** ---------- Onboarding (Premium) ---------- **/
  if (aluno.stage === "ask_name" && !aluno.nome) {
    const primeiroNome = extrairNome(profileName) || "Aluno";
    // se mandou algo tipo "oi", pede o nome
    aluno.nome = extrairNome(texto) || null;

    if (!aluno.nome) {
      const msg = `Olá, ${primeiroNome}! 😄 Eu sou o Kito.\nComo você quer que eu te chame?`;
      aluno.history.push({ role: "assistant", content: msg });
      trimHistory(aluno);
      await enviarMensagemWhatsApp(numeroAluno, msg);
      await saveStudentToFirestore(numeroAluno, aluno);
      return;
    }

    aluno.stage = "ask_language";
    const msg = `Perfeito, ${aluno.nome}! 😄 Agora me conta: você quer começar por inglês, francês ou os dois?`;
    aluno.history.push({ role: "assistant", content: msg });
    trimHistory(aluno);
    await enviarMensagemWhatsApp(numeroAluno, msg);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  if (aluno.stage === "ask_language") {
    const idioma = detectarIdioma(texto);
    if (!idioma) {
      const msg = "Acho que não entendi 😅\nResponda só com: inglês, francês ou os dois.";
      aluno.history.push({ role: "assistant", content: msg });
      trimHistory(aluno);
      await enviarMensagemWhatsApp(numeroAluno, msg);
      await saveStudentToFirestore(numeroAluno, aluno);
      return;
    }

    aluno.idioma = idioma;
    aluno.stage = "ask_experience";
    aluno.moduleIndex = 0;
    aluno.moduleStep = 0;
    aluno.nivel = "A0";

    const idiomaTexto =
      idioma === "ingles" ? "inglês" : idioma === "frances" ? "francês" : "inglês e francês";
    const msg = `Ótimo, ${aluno.nome}! Vamos trabalhar ${idiomaTexto} 💪\nVocê já estudou ${idiomaTexto} antes?`;
    aluno.history.push({ role: "assistant", content: msg });
    trimHistory(aluno);
    await enviarMensagemWhatsApp(numeroAluno, msg);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  if (aluno.stage === "ask_experience") {
    const { nivelPercebido, nivelCEFR } = inferirNivelPercebido(texto);
    aluno.nivelPercebido = nivelPercebido;
    aluno.nivel = aluno.nivel || nivelCEFR;
    aluno.stage = "ask_difficulty";

    const msg = `Perfeito 😊\nNo ${aluno.idioma === "frances" ? "francês" : "inglês"}, o que é mais difícil hoje?`;
    aluno.history.push({ role: "assistant", content: msg });
    trimHistory(aluno);
    await enviarMensagemWhatsApp(numeroAluno, msg);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  if (aluno.stage === "ask_difficulty") {
    aluno.maiorDificuldade = inferirMaiorDificuldade(texto);
    aluno.stage = "ask_preference_format";

    const msg = "Ótimo 😊 Você prefere que eu explique por texto ou misturando? (Você também pode pedir áudio.)";
    aluno.history.push({ role: "assistant", content: msg });
    trimHistory(aluno);
    await enviarMensagemWhatsApp(numeroAluno, msg);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  if (aluno.stage === "ask_preference_format") {
    aluno.preferenciaFormato = inferirPreferenciaFormato(texto);
    aluno.stage = "ask_frequency";

    const msg = "Show! Você prefere que eu te puxe todos os dias, 3x por semana, 5x por semana ou só quando você falar comigo?";
    aluno.history.push({ role: "assistant", content: msg });
    trimHistory(aluno);
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
    trimHistory(aluno);
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
      trimHistory(aluno);
      await enviarMensagemWhatsApp(numeroAluno, msg);
      await saveStudentToFirestore(numeroAluno, aluno);
      return;
    }

    aluno.chatMode = escolheuAprender ? "aprender" : "conversa";
    aluno.stage = "learning";

    const idiomaTexto =
      aluno.idioma === "ingles"
        ? "inglês"
        : aluno.idioma === "frances"
        ? "francês"
        : "inglês e francês";

    const msg =
      aluno.chatMode === "conversa"
        ? `Perfeito 😊 Vamos conversar para você praticar ${idiomaTexto}.\nQual é seu principal objetivo com ${idiomaTexto}?`
        : `Combinado 💪 Vou te ensinar e corrigir em ${idiomaTexto}.\nQual é seu principal objetivo com ${idiomaTexto}?`;

    aluno.history.push({ role: "assistant", content: msg });
    trimHistory(aluno);
    await enviarMensagemWhatsApp(numeroAluno, msg);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  /** ---------- learning ---------- **/
  if (aluno.stage !== "learning") aluno.stage = "learning";
  if (!aluno.objetivo) aluno.objetivo = texto;

  const tipoMensagem = detectarTipoMensagem(normalizarTexto(texto || ""));
  const idiomaChave = aluno.idioma === "frances" ? "frances" : "ingles";
  const trilha = learningPath[idiomaChave] || learningPath["ingles"];

  let moduleIndex = aluno.moduleIndex ?? 0;
  let moduleStep = aluno.moduleStep ?? 0;
  if (moduleIndex >= trilha.length) moduleIndex = trilha.length - 1;

  const moduloAtual = trilha[moduleIndex] || trilha[0];
  const confirmacao = isConfirmMessage(texto);

  // disparo de diagnóstico (premium pode fazer)
  const disparouProgresso = isProgressPremiumTrigger(texto || "");
  if (disparouProgresso && canSendProgressUpsell(aluno, agora)) {
    aluno.stage = "diagnosis_optin";
    aluno.lastProgressUpsellAt = agora;

    const msg = montarPerguntaDiagnosticoOptin();
    aluno.history.push({ role: "assistant", content: msg });
    trimHistory(aluno);

    await enviarMensagemWhatsApp(numeroAluno, msg);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  // gera resposta normal
  const respostaKito = await gerarRespostaKito(aluno, moduloAtual, tipoMensagem);

  // avança módulo se confirmou
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
  trimHistory(aluno);

  // áudio só se pediu
  const deveMandarAudio = pediuKitoAudio;
  const idiomaAudioAlvo =
    aluno.idioma === "ingles" || aluno.idioma === "frances" ? aluno.idioma : null;

  if (deveMandarAudio) {
    const audioBase64 = await gerarAudioRespostaKito(respostaKito, idiomaAudioAlvo);
    await enviarAudioWhatsApp(numeroAluno, audioBase64);
  }

  await sleep(250);
  await enviarMensagemWhatsApp(numeroAluno, respostaKito);

  students[numeroAluno] = aluno;
  await saveStudentToFirestore(numeroAluno, aluno);
}

/** ---------- STRIPE WEBHOOK (auto-unlock) ---------- **/
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

        if (session.subscription) {
          try {
            const sub = await stripe.subscriptions.retrieve(session.subscription);
            if (sub?.current_period_end) premiumUntil = new Date(sub.current_period_end * 1000);
          } catch (e) {
            console.warn("⚠️ Não consegui buscar subscription:", e.message);
          }
        }

        // garante que aluno existe no Firestore
        const docRef = db.collection("students").doc(`whatsapp:${phone}`);
        await docRef.set(
          {
            plan: "premium",
            paymentProvider: "stripe",
            premiumUntil,
            stage: "ask_name", // depois que paga, começa onboarding
            updatedAt: new Date(),
          },
          { merge: true }
        );

        // atualiza memória local
        if (!students[phone]) {
          students[phone] = {
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
            createdAt: now,
            lastMessageAt: now,
            moduleIndex: 0,
            moduleStep: 0,
            plan: "premium",
            premiumUntil,
            paymentProvider: "stripe",
            dailyCount: 0,
            dailyDate: todayKeyUTC(now),
            lastPaywallPromptAt: null,
            lastProgressUpsellAt: null,
            diagnosis: null,
            history: [],
          };
        } else {
          students[phone].plan = "premium";
          students[phone].paymentProvider = "stripe";
          students[phone].premiumUntil = premiumUntil;
          if (!students[phone].stage) students[phone].stage = "ask_name";
        }

        await enviarMensagemWhatsApp(
          phone,
          "🎉 Pagamento confirmado! Seu *Acesso Premium* foi ativado ✅\n\nVamos começar: como você quer que eu te chame?"
        );
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error("❌ Erro no Stripe webhook:", err.message);
    res.status(500).send("webhook_error");
  }
});

/** ---------- ADMIN: unlock/lock manual (Plano B) ---------- **/
app.post("/admin/unlock", async (req, res) => {
  const token = req.query.token;
  if (!token || token !== process.env.ADMIN_TOKEN) return res.status(401).send("Não autorizado");

  try {
    const phone = String(req.body?.phone || "").replace(/\D/g, "");
    const days = Number(req.body?.days || 30);

    if (!phone) return res.status(400).send("missing_phone");

    const now = new Date();
    const premiumUntil = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    if (db) {
      await db.collection("students").doc(`whatsapp:${phone}`).set(
        {
          plan: "premium",
          paymentProvider: "manual",
          premiumUntil,
          stage: "ask_name",
          updatedAt: new Date(),
        },
        { merge: true }
      );
    }

    if (!students[phone]) students[phone] = {};
    students[phone].plan = "premium";
    students[phone].paymentProvider = "manual";
    students[phone].premiumUntil = premiumUntil;
    if (!students[phone].stage) students[phone].stage = "ask_name";

    await enviarMensagemWhatsApp(
      phone,
      "✅ Seu acesso foi liberado manualmente.\nVamos começar: como você quer que eu te chame?"
    );

    return res.json({ ok: true, phone, premiumUntil });
  } catch (e) {
    console.error("❌ admin/unlock error:", e?.message || e);
    return res.status(500).send("unlock_error");
  }
});

app.post("/admin/lock", async (req, res) => {
  const token = req.query.token;
  if (!token || token !== process.env.ADMIN_TOKEN) return res.status(401).send("Não autorizado");

  try {
    const phone = String(req.body?.phone || "").replace(/\D/g, "");
    if (!phone) return res.status(400).send("missing_phone");

    if (db) {
      await db.collection("students").doc(`whatsapp:${phone}`).set(
        {
          plan: "free",
          premiumUntil: null,
          paymentProvider: null,
          updatedAt: new Date(),
        },
        { merge: true }
      );
    }

    if (!students[phone]) students[phone] = {};
    students[phone].plan = "free";
    students[phone].premiumUntil = null;
    students[phone].paymentProvider = null;

    return res.json({ ok: true, phone });
  } catch (e) {
    console.error("❌ admin/lock error:", e?.message || e);
    return res.status(500).send("lock_error");
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

    if (!numeroAluno) return res.status(200).send("no_phone");

    if (processedMessages.has(msgId)) return res.status(200).send("duplicate_ignored");
    processedMessages.add(msgId);
    if (processedMessages.size > MAX_PROCESSED_IDS) processedMessages.clear();

    if (momentVal && lastMomentByPhone[numeroAluno] === momentVal)
      return res.status(200).send("duplicate_moment_ignored");
    if (momentVal) lastMomentByPhone[numeroAluno] = momentVal;

    const profileName = data.senderName || data.chatName || "Aluno";

    // texto
    let texto = data.text?.message || null;

    // áudio
    const audioUrl =
      data.audio?.audioUrl ||
      data.audio?.url ||
      data.voice?.url ||
      data.voice?.audioUrl ||
      data.message?.audioUrl ||
      data.message?.url ||
      data.media?.url ||
      null;

    const isAudio = Boolean(audioUrl);

    // anti-dupe de texto
    if (texto) {
      const now = Date.now();
      const ultimo = lastTextByPhone[numeroAluno];
      if (ultimo && ultimo.text === texto && now - ultimo.time < 3000)
        return res.status(200).send("duplicate_text_recent");
      lastTextByPhone[numeroAluno] = { text: texto, time: now };
    }

    // se for áudio e não tiver texto: transcreve (só para entender intenção; PREMIUM ONLY continua valendo)
    if (!texto && isAudio) {
      const transcript = await transcreverAudioFromUrl(audioUrl);
      texto = transcript || "enviei um áudio";
    }

    if (!texto) return res.status(200).send("no_text_or_audio");

    await processarMensagemAluno({ numeroAluno, texto, profileName, isAudio });
    res.status(200).send("ok");
  } catch (erro) {
    console.error("❌ Erro no webhook Z-API:", erro?.response?.data || erro.message);
    res.status(500).send("erro");
  }
});

/** ---------- DASHBOARD ---------- **/
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
    premiumUntil: dados.premiumUntil ? String(dados.premiumUntil) : "-",
    lastPaywallPromptAt: dados.lastPaywallPromptAt ? String(dados.lastPaywallPromptAt) : "-",
    lastProgressUpsellAt: dados.lastProgressUpsellAt ? String(dados.lastProgressUpsellAt) : "-",
    diagnosis: dados.diagnosis || null,
  }));

  res.json({ total: alunos.length, premiumOnly: REQUIRE_PREMIUM_FOR_ACCESS, alunos });
});

/** ---------- STATS ---------- **/
app.get("/admin/stats", (req, res) => {
  const token = req.query.token;
  if (!token || token !== process.env.ADMIN_TOKEN) return res.status(401).send("Não autorizado");

  const alunos = Object.entries(students).map(([numero, a]) => ({
    numero,
    nome: a.nome || null,
    idioma: a.idioma || null,
    plan: a.plan || "free",
    dailyCount: a.dailyCount || 0,
    dailyDate: a.dailyDate || null,
    premiumUntil: a.premiumUntil || null,
    lastMessageAt: a.lastMessageAt || null,
    stage: a.stage || null,
  }));

  const total = alunos.length;
  const premium = alunos.filter((a) => a.plan === "premium").length;
  const free = total - premium;

  res.json({
    total,
    free,
    premium,
    premiumOnly: REQUIRE_PREMIUM_FOR_ACCESS,
    paywallCooldownHours: PAYWALL_COOLDOWN_HOURS,
    alunos,
  });
});

/** ---------- ROOT ---------- **/
app.get("/", (req, res) => {
  res.send("Kito (Jovika Academy) está a correr ✅");
});

/** ---------- START ---------- **/
app.listen(PORT, () => {
  console.log(`🚀 Kito no ar em http://localhost:${PORT}`);
});
