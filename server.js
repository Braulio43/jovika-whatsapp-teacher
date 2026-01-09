// server.js – Kito, professor da Jovika Academy
// Z-API + memória + módulos + Dashboard + Firestore + PERFIL PEDAGÓGICO
// + HARD PAYWALL (só Premium usa o Kito)
// + Anti-spam: 1 mensagem de venda por aluno (não bombardeia)
// + ÁUDIO SOMENTE PREMIUM (somente quando aluno pede KITO enviar áudio)
// + STRIPE webhook (auto-unlock) + TRANSCRIÇÃO de áudio do aluno (FREE OK)
// + UPSELL INTELIGENTE por gatilhos (mantido, mas só premium usa “aulas”)
// + DIAGNÓSTICO (3 perguntas) e SÓ NO FIM mostra preço + link Stripe (GLOBAL)
// + Manual unlock/lock (admin endpoints)
// + Premium expira: aviso elegante 1x/24h quando aluno tentar usar
// + Follow-ups: 1h e 2 dias via /cron/tick (cron externo)
// ✅ FIX CRÍTICO: Firestore não pode voltar premium->free por causa da memória do server
//    - ensureStudentLoaded() agora SEMPRE reconcilia plan/premiumUntil com Firestore
//    - saveStudentToFirestore() tem anti-downgrade (se Firestore está premium ativo, não sobrescreve)

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
  "🔥 KITO v7.0 – HARD PAYWALL (só premium) + Anti-spam + Manual unlock + Expiração + Follow-ups (cron) + FIX anti-downgrade 🔥"
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

/** ---------- CONFIG PAYWALL / PLANOS ---------- **/
const HARD_PAYWALL = String(process.env.HARD_PAYWALL || "1") === "1"; // 1 = só Premium usa

// Limites (mantidos por compatibilidade; com HARD_PAYWALL=1 quase não entram)
const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 30);
const PAYWALL_COOLDOWN_HOURS = Number(process.env.PAYWALL_COOLDOWN_HOURS || 20);

// Upsell por progresso (anti-spam)
const UPSELL_PROGRESS_COOLDOWN_HOURS = Number(process.env.UPSELL_PROGRESS_COOLDOWN_HOURS || 24);

// Anti-spam da mensagem de venda única / reminders
const SALES_MESSAGE_COOLDOWN_HOURS = Number(process.env.SALES_MESSAGE_COOLDOWN_HOURS || 72); // se pedir “link/preço” pode repetir após 72h
const PREMIUM_EXPIRED_NOTICE_COOLDOWN_HOURS = Number(
  process.env.PREMIUM_EXPIRED_NOTICE_COOLDOWN_HOURS || 24
);

// Follow-ups via cron
const FOLLOWUP_1H_ENABLED = String(process.env.FOLLOWUP_1H_ENABLED || "1") === "1";
const FOLLOWUP_2D_ENABLED = String(process.env.FOLLOWUP_2D_ENABLED || "1") === "1";
const FOLLOWUP_1H_MINUTES = Number(process.env.FOLLOWUP_1H_MINUTES || 60);
const FOLLOWUP_2D_HOURS = Number(process.env.FOLLOWUP_2D_HOURS || 48);

const STRIPE_PAYMENT_LINK_URL = String(
  process.env.STRIPE_PAYMENT_LINK_URL ||
    "https://buy.stripe.com/00w28qchVgVQdfm1eS9ws01"
).trim();

const PREMIUM_PRICE_EUR = String(process.env.PREMIUM_PRICE_EUR || "9,99€").trim();
const PREMIUM_PERIOD_TEXT = String(process.env.PREMIUM_PERIOD_TEXT || "mês").trim();

// ✅ HOTMART (Brasil + Angola)
const HOTMART_PAYMENT_LINK_URL = String(
  process.env.HOTMART_PAYMENT_LINK_URL || "https://pay.hotmart.com/X103770007F"
).trim();

// Controle de memória
const MAX_HISTORY_MESSAGES = Number(process.env.MAX_HISTORY_MESSAGES || 24);
const MAX_PROCESSED_IDS = Number(process.env.MAX_PROCESSED_IDS || 5000);

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
    t.includes("enviar") ||
    t.includes("ativar") ||
    t.includes("assinar")
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

/** ---------- ✅ SELETOR DE LINK POR PAÍS (Brasil/Angola = Hotmart; Europa/outros = Stripe) ---------- **/
function phoneDigits(phone) {
  return String(phone || "").replace(/\D/g, ""); // no teu webhook já vem só dígitos
}

function isAngolaOrBrazilPhone(phone) {
  const d = phoneDigits(phone);
  // Angola +244 => começa 244; Brasil +55 => começa 55
  return d.startsWith("244") || d.startsWith("55");
}

/** Stripe link (GLOBAL) */
function gerarStripeLinkParaTelefone(phone) {
  const ref = `whatsapp:${phoneDigits(phone)}`;
  const glue = STRIPE_PAYMENT_LINK_URL.includes("?") ? "&" : "?";
  return `${STRIPE_PAYMENT_LINK_URL}${glue}client_reference_id=${encodeURIComponent(ref)}`;
}

/** Hotmart link (fixo) */
function gerarHotmartLinkParaTelefone() {
  // aqui fica fixo porque a Hotmart já trata PIX/checkout
  return HOTMART_PAYMENT_LINK_URL;
}

/** Decide provedor + link */
function getPaymentLinkForPhone(phone) {
  if (isAngolaOrBrazilPhone(phone)) {
    return { provider: "hotmart", link: gerarHotmartLinkParaTelefone(phone) };
  }
  return { provider: "stripe", link: gerarStripeLinkParaTelefone(phone) };
}

/** ---------- Mensagem ÚNICA para não-Premium (HARD PAYWALL) ---------- **/
function montarMensagemHardPaywall(phone) {
  const { provider, link } = getPaymentLinkForPhone(phone);
  const canal = provider === "hotmart" ? "Hotmart (PIX/cartão)" : "Stripe (cartão)";

  return [
    `Olá! 😊 Eu sou o *Kito*, professor de inglês e francês da *Jovika Academy*.`,
    ``,
    `Comigo você consegue:`,
    `✅ aprender do zero (A0) até conversar com confiança`,
    `✅ praticar conversa real (sem vergonha)`,
    `✅ receber correções e explicações claras`,
    `✅ treinar pronúncia com *áudios*`,
    `✅ ter plano guiado e progresso (A0 → B1)`,
    ``,
    `💰 *Acesso Premium: ${PREMIUM_PRICE_EUR}/${PREMIUM_PERIOD_TEXT}*`,
    `Sem fidelização. Cancele quando quiser.`,
    ``,
    `👉 *Ativar agora (${canal}):*`,
    `${link}`,
    ``,
    `Assim que o pagamento confirmar, eu libero automaticamente ✅`,
  ].join("\n");
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

function canSendSalesMessageAgain(aluno, now = new Date()) {
  const last = safeToDate(aluno.lastSalesMessageAt);
  if (!last) return true;
  const diffH = (now.getTime() - last.getTime()) / (1000 * 60 * 60);
  return diffH >= SALES_MESSAGE_COOLDOWN_HOURS;
}

function canSendPremiumExpiredNotice(aluno, now = new Date()) {
  const last = safeToDate(aluno.lastPremiumExpiredNoticeAt);
  if (!last) return true;
  const diffH = (now.getTime() - last.getTime()) / (1000 * 60 * 60);
  return diffH >= PREMIUM_EXPIRED_NOTICE_COOLDOWN_HOURS;
}

/** Mensagens Premium (mantidas) */
function montarMensagemPremiumPorAudio(phone) {
  const { provider, link } = getPaymentLinkForPhone(phone);
  const canal = provider === "hotmart" ? "Hotmart (PIX/cartão)" : "Stripe (cartão)";

  return [
    `🔒 Áudios são exclusivos do *Acesso Premium*.`,
    ``,
    `Por apenas *${PREMIUM_PRICE_EUR}/${PREMIUM_PERIOD_TEXT}*, você desbloqueia:`,
    `✅ Conversa real + correções`,
    `✅ Áudios para pronúncia (quando você pedir)`,
    `✅ Plano guiado + progresso (A0 → B1)`,
    ``,
    `👉 *Ativar Premium (${canal}):*`,
    `${link}`,
  ].join("\n");
}

function montarMensagemPremiumExpirou(phone) {
  const { provider, link } = getPaymentLinkForPhone(phone);
  const canal = provider === "hotmart" ? "Hotmart (PIX/cartão)" : "Stripe (cartão)";

  return [
    `Oi 😊 Eu consigo te ajudar sim.`,
    ``,
    `⚠️ Só um aviso rápido: seu *Acesso Premium expirou*.`,
    `Reative para voltar a ter aulas, conversa completa e áudios.`,
    ``,
    `💰 *${PREMIUM_PRICE_EUR}/${PREMIUM_PERIOD_TEXT}*`,
    `👉 *Reativar (${canal}):*`,
    `${link}`,
  ].join("\n");
}

/** Premium? */
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

/**
 * “Aluno mandou áudio” (isAudio=true) NÃO é “aluno pediu KITO enviar áudio”.
 */
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

/** gatilhos de “progresso/estrutura” para upsell/diagnóstico */
function isProgressPremiumTrigger(texto = "") {
  const t = normalizarTexto(texto || "");
  const gatilhos = [
    "plano",
    "plano de aula",
    "a0",
    "a1",
    "a2",
    "b1",
    "nivel",
    "nível",
    "progresso",
    "acompanhamento",
    "tarefa",
    "tarefas",
    "desafio",
    "exercicio",
    "exercício",
    "avaliacao",
    "avaliação",
    "teste de nivel",
    "teste de nível",
    "certificado",
    "cronograma",
    "todos os dias",
    "todo dia",
    "5x",
    "cinco vezes",
    "aulas por semana",
    "grupo",
    "comunidade",
    "zoom",
    "teams",
    "professor",
    "professor humano",
    "aula ao vivo",
    "mentoria",
    "quanto custa",
    "preco",
    "preço",
    "assinar",
    "premium",
  ];
  return gatilhos.some((g) => t.includes(g));
}

/** tipos – AJUSTADO para não traduzir “por engano” */
function detectarTipoMensagem(textoNorm = "") {
  if (!textoNorm) return "geral";

  const isPedidoTraducao =
    textoNorm.includes("como se diz") ||
    textoNorm.includes("traduz") ||
    textoNorm.includes("traduza") ||
    textoNorm.includes("translate") ||
    textoNorm.includes("tradução") ||
    (textoNorm.includes("em ingles") || textoNorm.includes("em inglês")) ||
    (textoNorm.includes("em frances") || textoNorm.includes("em francês"));

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
    textoNorm.includes("quero assinar") ||
    textoNorm.includes("manda link") ||
    textoNorm.includes("link stripe") ||
    textoNorm.includes("hotmart") ||
    textoNorm.includes("pix")
  )
    return "pedido_premium";

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

/** ---------- ✅ DIAGNÓSTICO (preço no fim) ---------- **/
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
  const map = {
    A: "Trabalho",
    B: "Faculdade / provas",
    C: "Viagem",
    D: "Morar fora",
    E: "Conversação / confiança",
    F: "Outro",
  };
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
  const map = {
    A: "10–15 min por dia",
    B: "30 min por dia",
    C: "1h por dia",
    D: "Só 3x por semana",
    E: "Só quando eu tiver tempo",
  };
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
    `1/3 — Qual é seu objetivo principal?`,
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
    `Agora eu posso te colocar num *plano guiado A0→B1*, com exercícios e acompanhamento do seu progresso.`,
  ].join("\n");
}

function montarMensagemPrecoNoFim(phone) {
  const { provider, link } = getPaymentLinkForPhone(phone);
  const canal = provider === "hotmart" ? "Hotmart (PIX/cartão)" : "Stripe (cartão)";

  return [
    `💰 Para liberar o *plano completo + acompanhamento + áudios*, o Premium custa *${PREMIUM_PRICE_EUR}/${PREMIUM_PERIOD_TEXT}*.`,
    ``,
    `👉 Link (${canal}):`,
    `${link}`,
  ].join("\n");
}

function montarMensagemNaoQueroAgora() {
  return [
    `Tranquilo 😊`,
    `Quando você quiser ativar, é só pedir: *"manda o link"*.`,
  ].join("\n");
}

/** ---------- ✅ util para anti-downgrade ---------- **/
function isPremiumActiveFromData(data, now = new Date()) {
  const plan = data?.plan || "free";
  const until = safeToDate(data?.premiumUntil);
  if (plan !== "premium") return false;
  if (!until) return true; // premium sem data => considera ativo
  return until.getTime() > now.getTime();
}

/** ---------- Firestore salvar/carregar ---------- **/
async function saveStudentToFirestore(phone, aluno) {
  try {
    if (!db) return;

    // ✅ ANTI-DOWNGRADE:
    // Se Firestore já está premium ativo, NÃO deixar a memória (free) sobrescrever.
    // Fazemos um get() só quando o aluno NÃO está premium em memória (para não pesar).
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
        console.warn("⚠️ anti-downgrade get falhou (continuando):", e?.message || e);
      }
    }

    const normalize = (val) => safeToDate(val);

    const createdAt = normalize(aluno.createdAt) || new Date();
    const lastMessageAt = normalize(aluno.lastMessageAt) || new Date();

    const premiumUntil = normalize(aluno.premiumUntil);
    const lastPaywallPromptAt = normalize(aluno.lastPaywallPromptAt);
    const lastProgressUpsellAt = normalize(aluno.lastProgressUpsellAt);

    const lastSalesMessageAt = normalize(aluno.lastSalesMessageAt);
    const lastPremiumExpiredNoticeAt = normalize(aluno.lastPremiumExpiredNoticeAt);

    const followup1hAt = normalize(aluno.followup1hAt);
    const followup2dAt = normalize(aluno.followup2dAt);
    const followup1hSentAt = normalize(aluno.followup1hSentAt);
    const followup2dSentAt = normalize(aluno.followup2dSentAt);

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

        // HARD PAYWALL anti-spam
        lastSalesMessageAt: lastSalesMessageAt || null,
        lastPremiumExpiredNoticeAt: lastPremiumExpiredNoticeAt || null,

        // followups
        followup1hAt: followup1hAt || null,
        followup2dAt: followup2dAt || null,
        followup1hSentAt: followup1hSentAt || null,
        followup2dSentAt: followup2dSentAt || null,

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
      lastSalesMessageAt: safeToDate(data.lastSalesMessageAt),
      lastPremiumExpiredNoticeAt: safeToDate(data.lastPremiumExpiredNoticeAt),
      followup1hAt: safeToDate(data.followup1hAt),
      followup2dAt: safeToDate(data.followup2dAt),
      followup1hSentAt: safeToDate(data.followup1hSentAt),
      followup2dSentAt: safeToDate(data.followup2dSentAt),
      updatedAt: safeToDate(data.updatedAt),
    };
  } catch (err) {
    console.error("❌ Erro ao carregar aluno do Firestore:", err?.message || err);
    return null;
  }
}

/**
 * ✅ FIX PRINCIPAL:
 * - Antes: só recarregava do Firestore se “incompleto”.
 * - Agora: SEMPRE tenta reconciliação (plan/premiumUntil), para permitir unlock manual e não ser sobrescrito.
 */
async function ensureStudentLoaded(numeroAluno) {
  let aluno = students[numeroAluno] || null;

  const fromDb = await loadStudentFromFirestore(numeroAluno);

  // Se não tinha em memória, mas existe no Firestore
  if (!aluno && fromDb) {
    aluno = { ...fromDb, history: [] };
    students[numeroAluno] = aluno;
    return aluno;
  }

  // Se existe em memória e existe no Firestore: reconcilia
  if (aluno && fromDb) {
    const now = new Date();

    // 🔥 Se Firestore diz premium ativo, força memória para premium
    if (isPremiumActiveFromData(fromDb, now)) {
      aluno.plan = "premium";
      aluno.paymentProvider = fromDb.paymentProvider || aluno.paymentProvider || "manual";
      aluno.premiumUntil = safeToDate(fromDb.premiumUntil) || aluno.premiumUntil || null;
    } else {
      // Firestore não premium: só derruba memória se memória também não está premium ativo
      const memPremiumActive = isPremium(aluno, now);
      if (!memPremiumActive) {
        aluno.plan = fromDb.plan || aluno.plan || "free";
        aluno.paymentProvider = fromDb.paymentProvider ?? aluno.paymentProvider ?? null;
        aluno.premiumUntil = safeToDate(fromDb.premiumUntil) ?? aluno.premiumUntil ?? null;
      }
    }

    // Completa campos base sem destruir o que já existe
    aluno.stage = aluno.stage || fromDb.stage || "ask_name";
    aluno.nome = aluno.nome || fromDb.nome || null;
    aluno.idioma = aluno.idioma || fromDb.idioma || null;

    // Se memory não tem timestamps/flags, puxa do Firestore
    aluno.lastSalesMessageAt = aluno.lastSalesMessageAt || fromDb.lastSalesMessageAt || null;
    aluno.lastPremiumExpiredNoticeAt =
      aluno.lastPremiumExpiredNoticeAt || fromDb.lastPremiumExpiredNoticeAt || null;

    aluno.followup1hAt = aluno.followup1hAt || fromDb.followup1hAt || null;
    aluno.followup2dAt = aluno.followup2dAt || fromDb.followup2dAt || null;
    aluno.followup1hSentAt = aluno.followup1hSentAt || fromDb.followup1hSentAt || null;
    aluno.followup2dSentAt = aluno.followup2dSentAt || fromDb.followup2dSentAt || null;

    students[numeroAluno] = aluno;
    return aluno;
  }

  // Se só existe em memória
  return aluno;
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

REGRAS CRÍTICAS (anti-robot):
- NUNCA “traduzir automaticamente” a frase do aluno.
- Só traduza se tipo="pedido_traducao" OU se o aluno pedir explicitamente.
- Se o aluno fizer pergunta normal (ex: "qual é o seu nome?"), responda como humano.
- Se tipo="pergunta_sobre_kito": responda direto (sem lição, sem tradução).

MODO DO ALUNO:
- chatMode: "${modo}"
- Se chatMode="conversa": responda natural, como um humano. No final pergunte se quer correção.
- Se chatMode="aprender": ensine + corrija com explicação curta.

ESTILO:
- Português do Brasil (você).
- Curto estilo WhatsApp (2 blocos no máximo + 1 pergunta).
- Emojis com moderação (máximo 1).

PERFIL:
Nome do aluno: ${aluno.nome || "não informado"}
Idioma alvo: ${idiomaAlvo}
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

/** ---------- ÁUDIO (TTS) – Premium only (quando aluno pede KITO enviar áudio) ---------- **/
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

    // ✅ TTS resiliente: se falhar com voice do ENV, tenta fallback
    const voicePrimary = process.env.OPENAI_TTS_VOICE || "onyx";
    const voiceFallback = process.env.OPENAI_TTS_VOICE_FALLBACK || "alloy";

    const makeSpeech = async (voice) =>
      openai.audio.speech.create({
        model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
        voice,
        instructions,
        input: clean,
        response_format: "mp3",
      });

    let speech;
    try {
      speech = await makeSpeech(voicePrimary);
    } catch (e) {
      console.warn("⚠️ TTS falhou voice primary, tentando fallback:", e?.message || e);
      speech = await makeSpeech(voiceFallback);
    }

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

/** ---------- ✅ TRANSCRIÇÃO de ÁUDIO do aluno ---------- **/
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

/** ---------- FOLLOW-UP (1h / 2d) ---------- **/
function scheduleFollowups(aluno, agora = new Date()) {
  // Só faz sentido para Premium (quem tem acesso)
  aluno.followup1hAt = new Date(agora.getTime() + FOLLOWUP_1H_MINUTES * 60 * 1000);
  aluno.followup2dAt = new Date(agora.getTime() + FOLLOWUP_2D_HOURS * 60 * 60 * 1000);
}

function shouldSendFollowup1h(aluno, agora = new Date()) {
  if (!FOLLOWUP_1H_ENABLED) return false;
  if (!aluno.followup1hAt) return false;
  if (aluno.followup1hSentAt) return false;
  if (aluno.followup1hAt.getTime() > agora.getTime()) return false;

  // se o aluno falou depois que agendou, não manda
  const lastMsg = safeToDate(aluno.lastMessageAt);
  if (lastMsg && lastMsg.getTime() > safeToDate(aluno.followup1hAt).getTime()) return false;

  return true;
}

function shouldSendFollowup2d(aluno, agora = new Date()) {
  if (!FOLLOWUP_2D_ENABLED) return false;
  if (!aluno.followup2dAt) return false;
  if (aluno.followup2dSentAt) return false;
  if (aluno.followup2dAt.getTime() > agora.getTime()) return false;

  const lastMsg = safeToDate(aluno.lastMessageAt);
  if (lastMsg && lastMsg.getTime() > safeToDate(aluno.followup2dAt).getTime()) return false;

  return true;
}

/** ---------- LÓGICA PRINCIPAL ---------- **/
async function processarMensagemAluno({ numeroAluno, texto, profileName, isAudio }) {
  const agora = new Date();

  // ✅ garante aluno carregado + reconciliação de premium (FIX)
  let aluno = await ensureStudentLoaded(numeroAluno);

  const textoNormQuick = normalizarTexto(texto || "");
  const tipoQuick = detectarTipoMensagem(textoNormQuick);

  // Se não existe aluno ainda, cria doc “mínimo”
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

      // plano default
      plan: "free",
      premiumUntil: null,
      paymentProvider: null,

      dailyCount: 0,
      dailyDate: null,
      lastPaywallPromptAt: null,
      lastProgressUpsellAt: null,

      diagnosis: null,

      // anti-spam
      lastSalesMessageAt: null,
      lastPremiumExpiredNoticeAt: null,

      // followups
      followup1hAt: null,
      followup2dAt: null,
      followup1hSentAt: null,
      followup2dSentAt: null,

      history: [],
    };

    students[numeroAluno] = aluno;
    await saveStudentToFirestore(numeroAluno, aluno);
  }

  aluno.messagesCount = (aluno.messagesCount || 0) + 1;
  aluno.lastMessageAt = agora;
  aluno.history = aluno.history || [];

  const premium = isPremium(aluno, agora);
  const premiumExpired = isPremiumExpired(aluno, agora);

  /**
   * ✅ HARD PAYWALL:
   * Se não for premium, Kito NÃO dá aula.
   * Ele envia 1 mensagem de venda e para.
   */
  if (HARD_PAYWALL && !premium) {
    // Se expirou e ele tentou falar, avisar “expirou” 1x/24h
    if (premiumExpired && canSendPremiumExpiredNotice(aluno, agora)) {
      aluno.lastPremiumExpiredNoticeAt = agora;

      const msg = montarMensagemPremiumExpirou(numeroAluno);
      await enviarMensagemWhatsApp(numeroAluno, msg);
      aluno.history.push({ role: "assistant", content: msg });
      trimHistory(aluno);

      await saveStudentToFirestore(numeroAluno, aluno);
      return;
    }

    // Se ainda não enviou mensagem de venda → envia 1 vez
    if (!aluno.lastSalesMessageAt) {
      aluno.lastSalesMessageAt = agora;

      const msg = montarMensagemHardPaywall(numeroAluno);
      await enviarMensagemWhatsApp(numeroAluno, msg);
      aluno.history.push({ role: "assistant", content: msg });
      trimHistory(aluno);

      await saveStudentToFirestore(numeroAluno, aluno);
      return;
    }

    // Já enviou antes:
    // Só responde novamente se o aluno pedir link/preço/premium (intenção de compra)
    if (isSalesIntent(texto) && canSendSalesMessageAgain(aluno, agora)) {
      aluno.lastSalesMessageAt = agora;

      const msg = montarMensagemHardPaywall(numeroAluno);
      await enviarMensagemWhatsApp(numeroAluno, msg);
      aluno.history.push({ role: "assistant", content: msg });
      trimHistory(aluno);

      await saveStudentToFirestore(numeroAluno, aluno);
      return;
    }

    // Caso contrário, NÃO responde (zero spam)
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  /**
   * ✅ Daqui para baixo: só entra quem é PREMIUM
   */

  // agendar followups quando premium fala (1h / 2d)
  scheduleFollowups(aluno, agora);

  // contador diário (mantido)
  updateDailyCounter(aluno, agora);

  // pedido de áudio (Kito enviar áudio)
  const pediuKitoAudio = alunoPediuKitoEnviarAudio(texto || "");

  // histórico user
  aluno.history.push({ role: "user", content: String(texto || "") });
  trimHistory(aluno);

  // aluno pede premium (já é premium, então só responde normal, sem venda)
  if (tipoQuick === "pedido_premium") {
    const msg = "Você já está com Premium ativo ✅\nMe diga: quer praticar inglês, francês ou os dois?";
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

  /** ---------- Fluxo do DIAGNÓSTICO ---------- **/
  if (String(aluno.stage || "").startsWith("diagnosis_")) {
    initDiagnosis(aluno);

    if (aluno.stage === "diagnosis_optin") {
      if (isYes(texto)) {
        aluno.stage = "diagnosis_q1";
        const q1 = montarPerguntaDiagnosticoQ1();
        aluno.history.push({ role: "assistant", content: q1 });
        trimHistory(aluno);
        await enviarMensagemWhatsApp(numeroAluno, q1);
        await saveStudentToFirestore(numeroAluno, aluno);
        return;
      }
      if (isNo(texto)) {
        aluno.stage = "learning";
        const msg = "Tranquilo 😊 Então vamos direto pra prática. Você quer focar em conversa, gramática ou vocabulário?";
        aluno.history.push({ role: "assistant", content: msg });
        trimHistory(aluno);
        await enviarMensagemWhatsApp(numeroAluno, msg);
        await saveStudentToFirestore(numeroAluno, aluno);
        return;
      }

      const retry = "Só para eu confirmar 😊 Responda: *SIM* ou *NÃO*.";
      aluno.history.push({ role: "assistant", content: retry });
      trimHistory(aluno);
      await enviarMensagemWhatsApp(numeroAluno, retry);
      await saveStudentToFirestore(numeroAluno, aluno);
      return;
    }

    if (aluno.stage === "diagnosis_q1") {
      const letter = parseChoiceLetter(texto);
      aluno.diagnosis.objetivo = diagnosisObjetivoFromChoice(letter, texto);
      aluno.stage = "diagnosis_q2";
      const q2 = montarPerguntaDiagnosticoQ2();
      aluno.history.push({ role: "assistant", content: q2 });
      trimHistory(aluno);
      await enviarMensagemWhatsApp(numeroAluno, q2);
      await saveStudentToFirestore(numeroAluno, aluno);
      return;
    }

    if (aluno.stage === "diagnosis_q2") {
      const letter = parseChoiceLetter(texto);
      aluno.diagnosis.nivel = diagnosisNivelFromChoice(letter, texto);
      aluno.stage = "diagnosis_q3";
      const q3 = montarPerguntaDiagnosticoQ3();
      aluno.history.push({ role: "assistant", content: q3 });
      trimHistory(aluno);
      await enviarMensagemWhatsApp(numeroAluno, q3);
      await saveStudentToFirestore(numeroAluno, aluno);
      return;
    }

    if (aluno.stage === "diagnosis_q3") {
      const letter = parseChoiceLetter(texto);
      aluno.diagnosis.tempo = diagnosisTempoFromChoice(letter, texto);

      const resultado = montarResultadoDiagnostico(aluno);
      const preco = montarMensagemPrecoNoFim(numeroAluno);
      const combinado = `${resultado}\n\n${preco}`;

      aluno.stage = "learning";
      aluno.history.push({ role: "assistant", content: combinado });
      trimHistory(aluno);

      await sleep(250);
      await enviarMensagemWhatsApp(numeroAluno, combinado);
      await saveStudentToFirestore(numeroAluno, aluno);
      return;
    }
  }

  /** ---------- Onboarding (Premium) ---------- **/
  if (aluno.stage === "ask_name" && !aluno.nome) {
    aluno.nome = extrairNome(texto) || "Aluno";
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
      const msg = "Acho que não entendi muito bem 😅\nResponda só com: inglês, francês ou os dois.";
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
    const msg = `Ótimo, ${aluno.nome}! Vamos trabalhar ${idiomaTexto} juntos 💪✨\nAntes de começar, você já estudou ${idiomaTexto} antes?`;

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

    const msg = `Perfeito, entendi. 😊\nAgora me conta: no ${
      aluno.idioma === "frances" ? "francês" : "inglês"
    }, o que você sente que é mais difícil hoje?`;
    aluno.history.push({ role: "assistant", content: msg });
    trimHistory(aluno);
    await enviarMensagemWhatsApp(numeroAluno, msg);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  if (aluno.stage === "ask_difficulty") {
    aluno.maiorDificuldade = inferirMaiorDificuldade(texto);
    aluno.stage = "ask_preference_format";

    const msg = "Ótimo 😊 Você prefere que eu explique por mensagem escrita ou misturando? (Áudio quando você pedir.)";
    aluno.history.push({ role: "assistant", content: msg });
    trimHistory(aluno);
    await enviarMensagemWhatsApp(numeroAluno, msg);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  if (aluno.stage === "ask_preference_format") {
    aluno.preferenciaFormato = inferirPreferenciaFormato(texto);
    aluno.stage = "ask_frequency";

    const msg =
      "Show! Você prefere que eu te puxe todos os dias, 3x por semana, 5x por semana ou só quando você falar comigo?";
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
        ? `Perfeito 😊 Vamos conversar para você praticar ${idiomaTexto}.\nAgora me conte: qual é o seu principal objetivo com ${idiomaTexto}?`
        : `Combinado 💪 Vou te ensinar e corrigir em ${idiomaTexto}.\nAgora me conte: qual é o seu principal objetivo com ${idiomaTexto}?`;

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

  // Diagnóstico opcional (premium pode)
  const disparouProgresso = isProgressPremiumTrigger(texto || "");
  if (disparouProgresso && (!aluno.diagnosis || aluno.stage !== "diagnosis_optin")) {
    aluno.stage = "diagnosis_optin";
    const msg = montarPerguntaDiagnosticoOptin();
    aluno.history.push({ role: "assistant", content: msg });
    trimHistory(aluno);
    await enviarMensagemWhatsApp(numeroAluno, msg);
    await saveStudentToFirestore(numeroAluno, aluno);
    return;
  }

  // resposta normal
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

  // ÁUDIO (TTS) só se pediu
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

/** ---------- STRIPE WEBHOOK ---------- **/
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

        if (students[phone]) {
          students[phone].plan = "premium";
          students[phone].paymentProvider = "stripe";
          students[phone].premiumUntil = premiumUntil;
        } else {
          students[phone] = {
            plan: "premium",
            paymentProvider: "stripe",
            premiumUntil,
            stage: "ask_name",
            createdAt: now,
            lastMessageAt: now,
            messagesCount: 0,
            history: [],
          };
        }

        await enviarMensagemWhatsApp(
          phone,
          "🎉 Pagamento confirmado! Seu *Acesso Premium* foi ativado.\nAgora sim — vamos começar ✅\n\nComo você quer que eu te chame?"
        );
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error("❌ Erro no Stripe webhook:", err.message);
    res.status(500).send("webhook_error");
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

    // dedupe
    if (processedMessages.has(msgId)) return res.status(200).send("duplicate_ignored");
    processedMessages.add(msgId);
    if (processedMessages.size > MAX_PROCESSED_IDS) processedMessages.clear();

    if (momentVal && lastMomentByPhone[numeroAluno] === momentVal)
      return res.status(200).send("duplicate_moment_ignored");
    if (momentVal) lastMomentByPhone[numeroAluno] = momentVal;

    const profileName = data.senderName || data.chatName || "Aluno";

    // 1) texto
    let texto = data.text?.message || null;

    // 2) se não tem texto, tenta áudio
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

    // se for áudio e não tiver texto: transcreve
    if (!texto && isAudio) {
      const transcript = await transcreverAudioFromUrl(audioUrl);
      if (!transcript) {
        await enviarMensagemWhatsApp(
          numeroAluno,
          "Recebi seu áudio ✅\nMas não consegui transcrever agora. Pode me mandar a frase por texto também?"
        );
        return res.status(200).send("audio_no_transcript");
      }
      texto = transcript;
    }

    if (!texto) return res.status(200).send("no_text_or_audio");

    await processarMensagemAluno({ numeroAluno, texto, profileName, isAudio });
    res.status(200).send("ok");
  } catch (erro) {
    console.error("❌ Erro no webhook Z-API:", erro?.response?.data || erro.message);
    res.status(500).send("erro");
  }
});

/** ---------- CRON TICK (follow-ups 1h e 2d) ---------- **/
app.get("/cron/tick", async (req, res) => {
  try {
    const token = req.query.token;
    if (!token || token !== process.env.ADMIN_TOKEN) return res.status(401).send("Não autorizado");

    if (!db) return res.status(500).send("firestore_off");

    const agora = new Date();

    // busca candidatos (limite simples para não pesar)
    const snap = await db
      .collection("students")
      .where("plan", "==", "premium")
      .limit(200)
      .get();

    let sent = 0;

    for (const doc of snap.docs) {
      const aluno = loadNormalizeFromDoc(doc.data());
      const phone = String(doc.id || "").replace("whatsapp:", "");
      if (!phone) continue;

      // followup 1h
      if (shouldSendFollowup1h(aluno, agora)) {
        aluno.followup1hSentAt = agora;
        await enviarMensagemWhatsApp(phone, "Só para eu te acompanhar 😊 Quer continuar a aula de onde paramos?");
        await db.collection("students").doc(doc.id).set(
          { followup1hSentAt: aluno.followup1hSentAt },
          { merge: true }
        );
        sent++;
        continue;
      }

      // followup 2d
      if (shouldSendFollowup2d(aluno, agora)) {
        aluno.followup2dSentAt = agora;
        await enviarMensagemWhatsApp(phone, "Passando para te lembrar 😊 Quer retomar hoje? Me diga: inglês ou francês.");
        await db.collection("students").doc(doc.id).set(
          { followup2dSentAt: aluno.followup2dSentAt },
          { merge: true }
        );
        sent++;
      }
    }

    res.json({ ok: true, sent });
  } catch (e) {
    console.error("❌ cron tick error:", e?.message || e);
    res.status(500).send("cron_error");
  }
});

function loadNormalizeFromDoc(data) {
  return {
    ...data,
    createdAt: safeToDate(data.createdAt),
    lastMessageAt: safeToDate(data.lastMessageAt),
    premiumUntil: safeToDate(data.premiumUntil),
    lastSalesMessageAt: safeToDate(data.lastSalesMessageAt),
    lastPremiumExpiredNoticeAt: safeToDate(data.lastPremiumExpiredNoticeAt),
    followup1hAt: safeToDate(data.followup1hAt),
    followup2dAt: safeToDate(data.followup2dAt),
    followup1hSentAt: safeToDate(data.followup1hSentAt),
    followup2dSentAt: safeToDate(data.followup2dSentAt),
  };
}

/** ---------- ADMIN: manual unlock/lock/status ---------- **/
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
      `✅ Seu acesso Premium foi liberado manualmente.\nVálido até: ${premiumUntil.toISOString().slice(0, 10)}.\n\nComo você quer que eu te chame?`
    );

    res.json({ ok: true, phone, premiumUntil });
  } catch (e) {
    console.error("❌ unlock error:", e?.message || e);
    res.status(500).send("unlock_error");
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
      {
        plan: "free",
        premiumUntil: new Date(0),
        updatedAt: new Date(),
      },
      { merge: true }
    );

    if (students[phone]) {
      students[phone].plan = "free";
      students[phone].premiumUntil = new Date(0);
    }

    res.json({ ok: true, phone });
  } catch (e) {
    console.error("❌ lock error:", e?.message || e);
    res.status(500).send("lock_error");
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

    const aluno = loadNormalizeFromDoc(snap.data());
    res.json({
      ok: true,
      exists: true,
      phone,
      plan: aluno.plan,
      premiumUntil: aluno.premiumUntil,
      premiumActive: isPremium(aluno, new Date()),
      lastSalesMessageAt: aluno.lastSalesMessageAt,
      lastPremiumExpiredNoticeAt: aluno.lastPremiumExpiredNoticeAt,
    });
  } catch (e) {
    console.error("❌ status error:", e?.message || e);
    res.status(500).send("status_error");
  }
});

/** ---------- DASHBOARD (memória runtime) ---------- **/
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
    lastSalesMessageAt: dados.lastSalesMessageAt ? String(dados.lastSalesMessageAt) : "-",
    lastPremiumExpiredNoticeAt: dados.lastPremiumExpiredNoticeAt
      ? String(dados.lastPremiumExpiredNoticeAt)
      : "-",
    followup1hAt: dados.followup1hAt ? String(dados.followup1hAt) : "-",
    followup2dAt: dados.followup2dAt ? String(dados.followup2dAt) : "-",
  }));

  res.json({ total: alunos.length, hardPaywall: HARD_PAYWALL, alunos });
});

/** ---------- STATS (JSON simples) ---------- **/
app.get("/admin/stats", (req, res) => {
  const token = req.query.token;
  if (!token || token !== process.env.ADMIN_TOKEN) return res.status(401).send("Não autorizado");

  const alunos = Object.entries(students).map(([numero, a]) => ({
    numero,
    nome: a.nome || null,
    idioma: a.idioma || null,
    plan: a.plan || "free",
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
    hardPaywall: HARD_PAYWALL,
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
