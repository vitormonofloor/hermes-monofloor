import express from 'express';
import fetch from 'node-fetch';

const app = express();

// ── ENV ─────────────────────────────────────────────────────────
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const ARGOS_URL = process.env.ARGOS_URL || 'https://argos-monofloor-production.up.railway.app';
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_REPO = process.env.GITHUB_REPO || 'vitormonofloor/Monofloor_Files';
const GH_FILE = process.env.GITHUB_FILE || 'analise.html';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const VITOR_CHAT_ID = process.env.VITOR_CHAT_ID || '8151246424';
const INTERVALO_HORAS = parseInt(process.env.INTERVALO_HORAS) || 24;
const HORA_EXECUCAO = parseInt(process.env.HORA_EXECUCAO) || 8; // 8h BR

// ── STATE ───────────────────────────────────────────────────────
let ultimaAnalise = null;
let analiseAnterior = null;
let historicoAnalises = [];

// ── BRAIN: VITOR'S VOICE SYSTEM PROMPT ──────────────────────────

const SYSTEM_PROMPT = `Você é Hermes, o agente narrativo da Monofloor. Sua função é traduzir dados operacionais em insights estratégicos na voz do Vitor Gomes, Gerente de Qualidade.

PERFIL DA MONOFLOOR:
- Empresa premium de superfícies contínuas (compósito mineral + polímero)
- NÃO é piso de concreto polido — NUNCA use essa expressão
- Produtos: STELION™ (R$910+/m²), LILIT™ (R$590+/m²), LEONA™, LUMINA™
- Opera em SP, RJ, Curitiba
- 183 projetos ativos em paralelo

VOZ DO VITOR:
- Direto, decisivo, sem floreios
- Frases curtas quando possível
- Zero disclaimers desnecessários ("é importante notar que...", "vale lembrar...")
- Zero "em conclusão" ou "para resumir"
- Foco em o-que-fazer, não em descrever problema
- Chama as coisas pelo nome: "Wesley está sobrecarregado" em vez de "há uma possível sobrecarga de trabalho"
- Usa dados específicos: nomes de projetos, números exatos
- Identifica padrões que os números sozinhos não mostram
- É honesto sobre o que não funciona, sem suavizar

ESTRUTURA OBRIGATÓRIA da resposta em JSON:
{
  "manchete": "uma frase impactante de no máximo 15 palavras que sintetiza o dia",
  "contexto": "2-3 parágrafos curtos narrando o que está acontecendo na operação. Use números específicos. Identifique o que mudou vs ontem se houver dados anteriores.",
  "insights": [
    { "titulo": "título curto", "texto": "parágrafo com padrão não-óbvio que os números revelam" },
    { "titulo": "título curto", "texto": "..." },
    { "titulo": "título curto", "texto": "..." }
  ],
  "acoes": [
    { "prioridade": "alta", "acao": "ação específica e imediata", "contexto": "por que fazer isso agora" },
    { "prioridade": "media", "acao": "...", "contexto": "..." },
    { "prioridade": "media", "acao": "...", "contexto": "..." }
  ],
  "semana": "um parágrafo projetando o que monitorar nos próximos 7 dias com base nos dados"
}

IMPORTANTE: retorne APENAS o JSON válido, sem markdown, sem comentários, sem texto extra.`;

// ── FETCH DATA FROM ARGOS ───────────────────────────────────────

async function buscarDadosArgos() {
  console.log('[HERMES] Buscando dados do Argos...');
  const r = await fetch(`${ARGOS_URL}/api/dados`);
  if (!r.ok) throw new Error(`Argos retornou ${r.status}`);
  const dados = await r.json();
  if (dados.error) throw new Error(`Argos: ${dados.error}`);
  console.log(`[HERMES] Recebidos dados de ${dados.meta?.projetosAtivos || 0} projetos ativos`);
  return dados;
}

// ── COMPUTE DIFF vs PREVIOUS ────────────────────────────────────

function calcularDiff(atual, anterior) {
  if (!anterior) return null;
  const a = atual.indicadores;
  const b = anterior.indicadores;
  return {
    msgs: { atual: a.totalMsgs30d, anterior: b.totalMsgs30d, diff: a.totalMsgs30d - b.totalMsgs30d },
    ocs: { atual: a.totalOcs, anterior: b.totalOcs, diff: a.totalOcs - b.totalOcs },
    criticas: { atual: a.ocsCriticas, anterior: b.ocsCriticas, diff: a.ocsCriticas - b.ocsCriticas },
    atraso: { atual: parseFloat(a.taxaAtraso), anterior: parseFloat(b.taxaAtraso), diff: (parseFloat(a.taxaAtraso) - parseFloat(b.taxaAtraso)).toFixed(1) },
    silencio: { atual: parseFloat(a.taxaSilencio), anterior: parseFloat(b.taxaSilencio), diff: (parseFloat(a.taxaSilencio) - parseFloat(b.taxaSilencio)).toFixed(1) },
  };
}

// ── BUILD LLM CONTEXT ───────────────────────────────────────────

function montarContextoLLM(dados, diff) {
  const I = dados.indicadores;
  const meta = dados.meta;

  // Top 10 projetos mais problemáticos
  const problematicos = (I.problematicos || []).slice(0, 10).map(p =>
    `  - ${p.nome}: ${p.msgs30d || p.msgs || 0} msgs, ${p.totalOcs || p.ocs || 0} ocorrências | ${p.consultor} | fase: ${p.fase}`
  ).join('\n');

  // Top 5 tipos de ocorrência
  const tiposOcs = Object.entries(I.tiposOcs || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t, c]) => `  - ${t.replace(/_/g, ' ')}: ${c} (${(c / I.totalOcs * 100).toFixed(0)}%)`)
    .join('\n');

  // Carga por consultor
  const porConsultor = Object.entries(I.porConsultor || {})
    .sort((a, b) => b[1].obras - a[1].obras)
    .slice(0, 5)
    .map(([c, d]) => `  - ${c}: ${d.obras} obras, ${d.msgs} msgs, ${d.ocs} ocorrências, ${d.atraso || 0} atrasadas`)
    .join('\n');

  // Por região
  const porRegiao = Object.entries(I.porRegiao || {})
    .map(([r, d]) => `  - ${r}: ${d.obras} obras, ${d.msgs} msgs, ${d.ocs} ocs`)
    .join('\n');

  // Projetos silenciosos
  const silenciosos = (I.silenciosos || []).slice(0, 5).map(s => `  - ${s.nome} (${s.status} | ${s.fase})`).join('\n');

  // Contradições
  const contradicoes = (I.contradicoes || []).map(c => `  - ${c.nome}: status "${c.status}" mas ${c.msgs30d || 0} msgs em 30d`).join('\n');

  let ctx = `DADOS OPERACIONAIS — ${new Date(meta.geradoEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}

INDICADORES PRINCIPAIS:
- Projetos ativos: ${meta.projetosAtivos} (de ${meta.totalProjetos} total)
- Mensagens últimos 30 dias: ${I.totalMsgs30d.toLocaleString('pt-BR')} (Telegram: ${I.totalTG}, WhatsApp: ${I.totalWA})
- Projetos com atividade: ${I.comMsgs} | Silenciosos: ${I.semMsgs} (taxa: ${I.taxaSilencio}%)
- Ocorrências abertas: ${I.totalOcs} (críticas: ${I.ocsCriticas}, altas: ${I.ocsAltas || 0}) — taxa de resolução: 0%
- Taxa de atraso: ${I.taxaAtraso}%
- Reparos ativos: ${I.reparos || 0}

PROJETOS MAIS PROBLEMÁTICOS (alta msg + alta ocorrência):
${problematicos || '  (nenhum)'}

TIPOS DE OCORRÊNCIA MAIS FREQUENTES:
${tiposOcs || '  (sem dados)'}

CARGA POR CONSULTOR:
${porConsultor || '  (sem dados)'}

DISTRIBUIÇÃO REGIONAL:
${porRegiao || '  (sem dados)'}

PROJETOS SILENCIOSOS (top 5):
${silenciosos || '  (nenhum)'}

CONTRADIÇÕES DETECTADAS (pausados com atividade):
${contradicoes || '  (nenhuma)'}
`;

  if (diff) {
    ctx += `\nCOMPARAÇÃO COM ANÁLISE ANTERIOR:
- Mensagens: ${diff.msgs.atual} (${diff.msgs.diff >= 0 ? '+' : ''}${diff.msgs.diff} vs anterior)
- Ocorrências: ${diff.ocs.atual} (${diff.ocs.diff >= 0 ? '+' : ''}${diff.ocs.diff})
- Críticas: ${diff.criticas.atual} (${diff.criticas.diff >= 0 ? '+' : ''}${diff.criticas.diff})
- Taxa atraso: ${diff.atraso.atual}% (${diff.atraso.diff >= 0 ? '+' : ''}${diff.atraso.diff}pp)
- Taxa silêncio: ${diff.silencio.atual}% (${diff.silencio.diff >= 0 ? '+' : ''}${diff.silencio.diff}pp)`;
  }

  return ctx;
}

// ── CALL GROQ LLM ───────────────────────────────────────────────

async function chamarLLM(contexto) {
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY não configurada');

  console.log('[HERMES] Chamando Groq...');
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: contexto },
      ],
      temperature: 0.5,
      max_tokens: 3000,
      response_format: { type: 'json_object' },
    }),
  });

  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Groq ${r.status}: ${errText}`);
  }

  const d = await r.json();
  const content = d.choices?.[0]?.message?.content;
  if (!content) throw new Error('Groq retornou resposta vazia');

  // Parse JSON
  try {
    const analise = JSON.parse(content);
    console.log(`[HERMES] Análise gerada: ${analise.manchete}`);
    return analise;
  } catch (e) {
    console.error('[HERMES] Erro parsing JSON:', content.substring(0, 500));
    throw new Error(`JSON inválido do LLM: ${e.message}`);
  }
}

// ── RENDER HTML PRESENTATION ────────────────────────────────────

function renderHTML(analise, dados, diff) {
  const I = dados.indicadores;
  const meta = dados.meta;
  const dataFmt = new Date(meta.geradoEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  // Sparkline timeline from activity
  const diasOrdenados = Object.entries(I.atividadeGlobal || {}).sort((a, b) => a[0].localeCompare(b[0]));
  const maxDia = Math.max(...diasOrdenados.map(d => d[1]), 1);
  const sparkPoints = diasOrdenados.map((d, i) => {
    const x = (i / (diasOrdenados.length - 1 || 1)) * 600;
    const y = 80 - (d[1] / maxDia) * 80;
    return `${x.toFixed(0)},${y.toFixed(0)}`;
  }).join(' ');

  // Top types chart
  const tiposOrdenados = Object.entries(I.tiposOcs || {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxTipo = Math.max(...tiposOrdenados.map(t => t[1]), 1);

  // Insights cards
  const insightsHTML = (analise.insights || []).map(i => `
    <div class="insight-card">
      <div class="insight-title">${i.titulo}</div>
      <div class="insight-text">${i.texto}</div>
    </div>
  `).join('');

  // Actions
  const acoesHTML = (analise.acoes || []).map(a => `
    <div class="acao-card prio-${a.prioridade || 'media'}">
      <div class="acao-prio">${(a.prioridade || 'media').toUpperCase()}</div>
      <div class="acao-texto">${a.acao}</div>
      <div class="acao-ctx">${a.contexto}</div>
    </div>
  `).join('');

  // Types bars
  const tiposBars = tiposOrdenados.map(([t, c]) => {
    const pct = (c / maxTipo * 100).toFixed(0);
    return `
      <div class="tipo-row">
        <div class="tipo-label">${t.replace(/_/g, ' ')}</div>
        <div class="tipo-bar-wrap"><div class="tipo-bar" style="width:${pct}%"></div></div>
        <div class="tipo-num">${c}</div>
      </div>
    `;
  }).join('');

  // Diff cards
  let diffHTML = '';
  if (diff) {
    const diffCard = (label, valor, delta, unidade = '') => {
      const n = parseFloat(delta);
      const isUp = n > 0;
      const isNeg = (label === 'Ocorrências' || label === 'Críticas' || label === 'Atraso' || label === 'Silêncio') ? isUp : !isUp;
      const arrow = n === 0 ? '—' : (isUp ? '↑' : '↓');
      const cor = n === 0 ? '#888' : (isNeg ? '#ef4444' : '#22c55e');
      return `<div class="diff-card">
        <div class="diff-label">${label}</div>
        <div class="diff-valor">${valor}${unidade}</div>
        <div class="diff-delta" style="color:${cor}">${arrow} ${Math.abs(n).toFixed(unidade === '%' ? 1 : 0)}${unidade === '%' ? 'pp' : ''}</div>
      </div>`;
    };
    diffHTML = `
      <section class="slide slide-diff">
        <div class="slide-content">
          <div class="slide-eyebrow">comparativo</div>
          <h2>O que mudou desde a última análise</h2>
          <div class="diff-grid">
            ${diffCard('Mensagens', diff.msgs.atual.toLocaleString('pt-BR'), diff.msgs.diff)}
            ${diffCard('Ocorrências', diff.ocs.atual, diff.ocs.diff)}
            ${diffCard('Críticas', diff.criticas.atual, diff.criticas.diff)}
            ${diffCard('Atraso', diff.atraso.atual, diff.atraso.diff, '%')}
            ${diffCard('Silêncio', diff.silencio.atual, diff.silencio.diff, '%')}
          </div>
        </div>
      </section>
    `;
  }

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hermes — Análise Operacional Monofloor</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:#0a0a0a;color:#e0e0e0;font-family:Inter,-apple-system,sans-serif;scroll-behavior:smooth}
body{scroll-snap-type:y mandatory}
.slide{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:60px 40px;scroll-snap-align:start;position:relative;border-bottom:1px solid #151515}
.slide-content{max-width:1000px;width:100%}
.slide-eyebrow{font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#c4a77d;margin-bottom:16px;opacity:0;animation:fade 0.8s forwards}
.slide h1{font-size:56px;font-weight:300;line-height:1.15;margin-bottom:24px;letter-spacing:-0.02em;opacity:0;animation:fade 0.8s 0.1s forwards}
.slide h1 strong{color:#c4a77d;font-weight:500}
.slide h2{font-size:32px;font-weight:400;margin-bottom:32px;color:#c4a77d;letter-spacing:-0.01em;opacity:0;animation:fade 0.8s 0.1s forwards}
.slide p{font-size:18px;line-height:1.7;color:#d0d0d0;opacity:0;animation:fade 0.8s 0.2s forwards}
.slide p + p{margin-top:18px}
@keyframes fade{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
/* HERO */
.hero{background:radial-gradient(ellipse at center, #1a1510 0%, #0a0a0a 70%)}
.hero .logo{font-size:20px;letter-spacing:8px;color:#c4a77d;text-transform:uppercase;font-weight:300;margin-bottom:4px}
.hero .subtitle{font-size:10px;letter-spacing:4px;color:#555;text-transform:uppercase;margin-bottom:40px}
.hero h1{font-size:64px}
.hero-meta{font-size:13px;color:#666;margin-top:40px}
.hero-meta a{color:#c4a77d;text-decoration:none;border-bottom:1px solid #c4a77d30}
.hero-meta a:hover{border-bottom-color:#c4a77d}
/* KPI GRID */
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px;margin-top:40px}
.kpi-card{background:#141414;border:1px solid #222;border-radius:10px;padding:20px;text-align:center}
.kpi-val{font-size:36px;font-weight:700;line-height:1;color:#c4a77d}
.kpi-val.red{color:#ef4444}
.kpi-val.amber{color:#f59e0b}
.kpi-label{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:1px;margin-top:8px}
/* CONTEXT */
.contexto{font-size:20px;line-height:1.7;color:#d8d8d8}
.contexto strong{color:#c4a77d;font-weight:500}
/* SPARKLINE */
.chart-wrap{background:#141414;border:1px solid #222;border-radius:10px;padding:24px;margin-top:32px}
.chart-title{font-size:12px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
svg{width:100%;height:100px;display:block}
.chart-stats{display:flex;gap:32px;margin-top:16px;padding-top:16px;border-top:1px solid #222}
.chart-stat{font-size:11px;color:#888}
.chart-stat strong{color:#c4a77d;font-size:18px;display:block;margin-top:2px}
/* INSIGHTS */
.insights-grid{display:grid;gap:20px;margin-top:32px}
.insight-card{background:linear-gradient(135deg, #141414 0%, #1a1510 100%);border:1px solid #2a2015;border-left:3px solid #c4a77d;border-radius:8px;padding:24px 28px}
.insight-title{font-size:18px;color:#c4a77d;font-weight:500;margin-bottom:10px;letter-spacing:-0.01em}
.insight-text{font-size:15px;line-height:1.6;color:#d0d0d0}
/* ACTIONS */
.acoes-grid{display:grid;gap:16px;margin-top:32px}
.acao-card{background:#141414;border-radius:10px;padding:20px 24px;display:grid;grid-template-columns:80px 1fr;gap:20px;align-items:flex-start}
.acao-card.prio-alta{border-left:3px solid #ef4444}
.acao-card.prio-media{border-left:3px solid #f59e0b}
.acao-card.prio-baixa{border-left:3px solid #888}
.acao-prio{font-size:10px;letter-spacing:1px;color:#888;padding:6px 10px;background:#0a0a0a;border-radius:4px;text-align:center;align-self:start}
.acao-card.prio-alta .acao-prio{color:#ef4444}
.acao-card.prio-media .acao-prio{color:#f59e0b}
.acao-texto{font-size:17px;line-height:1.5;color:#e8e8e8;font-weight:500;margin-bottom:8px}
.acao-ctx{font-size:13px;line-height:1.6;color:#888}
/* TYPES CHART */
.tipos-chart{margin-top:32px}
.tipo-row{display:grid;grid-template-columns:200px 1fr 60px;gap:16px;align-items:center;margin-bottom:12px;font-size:13px}
.tipo-label{color:#c0c0c0;text-transform:capitalize}
.tipo-bar-wrap{background:#151515;border-radius:4px;height:10px;overflow:hidden}
.tipo-bar{background:linear-gradient(90deg, #c4a77d 0%, #8a6f45 100%);height:100%;border-radius:4px}
.tipo-num{color:#c4a77d;font-weight:600;text-align:right}
/* DIFF */
.diff-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:16px;margin-top:32px}
.diff-card{background:#141414;border:1px solid #222;border-radius:10px;padding:20px;text-align:center}
.diff-label{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
.diff-valor{font-size:28px;font-weight:600;color:#c4a77d;line-height:1}
.diff-delta{font-size:14px;margin-top:8px;font-weight:500}
/* NAV */
.nav{position:fixed;right:20px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:12px;z-index:10}
.nav-dot{width:10px;height:10px;border-radius:50%;background:#333;border:none;cursor:pointer;transition:all 0.2s;padding:0}
.nav-dot.active{background:#c4a77d;transform:scale(1.3)}
.nav-dot:hover{background:#888}
.footer{text-align:center;padding:40px;color:#444;font-size:11px;border-top:1px solid #151515}
.footer a{color:#c4a77d;text-decoration:none}
/* Back link */
.back-link{position:fixed;top:20px;left:20px;z-index:20;background:#141414;border:1px solid #222;color:#888;padding:8px 14px;border-radius:6px;text-decoration:none;font-size:12px;transition:all 0.2s}
.back-link:hover{color:#c4a77d;border-color:#c4a77d}
@media (max-width: 768px){
  .slide h1{font-size:36px}
  .hero h1{font-size:40px}
  .slide h2{font-size:24px}
  .slide{padding:40px 20px}
  .tipo-row{grid-template-columns:120px 1fr 40px;font-size:12px}
  .nav{display:none}
}
</style>
</head>
<body>

<a href="indicadores.html" class="back-link">← Painel</a>

<nav class="nav">
  <button class="nav-dot active" data-slide="0" title="Manchete"></button>
  <button class="nav-dot" data-slide="1" title="Contexto"></button>
  <button class="nav-dot" data-slide="2" title="Números"></button>
  ${diff ? '<button class="nav-dot" data-slide="3" title="Comparativo"></button>' : ''}
  <button class="nav-dot" data-slide="${diff ? 4 : 3}" title="Insights"></button>
  <button class="nav-dot" data-slide="${diff ? 5 : 4}" title="Ações"></button>
  <button class="nav-dot" data-slide="${diff ? 6 : 5}" title="Próxima semana"></button>
</nav>

<!-- SLIDE 1: HERO -->
<section class="slide hero">
  <div class="slide-content" style="text-align:center">
    <div class="logo">hermes</div>
    <div class="subtitle">análise diária · monofloor</div>
    <h1>${analise.manchete}</h1>
    <div class="hero-meta">${dataFmt} · <a href="indicadores.html">ver painel completo →</a></div>
  </div>
</section>

<!-- SLIDE 2: CONTEXTO -->
<section class="slide">
  <div class="slide-content">
    <div class="slide-eyebrow">o que está acontecendo</div>
    <h2>Contexto operacional</h2>
    <div class="contexto">${(analise.contexto || '').split('\n\n').map(p => `<p>${p}</p>`).join('')}</div>
  </div>
</section>

<!-- SLIDE 3: NÚMEROS -->
<section class="slide">
  <div class="slide-content">
    <div class="slide-eyebrow">snapshot</div>
    <h2>Os números de hoje</h2>
    <div class="kpi-grid">
      <div class="kpi-card"><div class="kpi-val">${I.totalMsgs30d.toLocaleString('pt-BR')}</div><div class="kpi-label">Mensagens 30d</div></div>
      <div class="kpi-card"><div class="kpi-val ${I.totalOcs > 150 ? 'red' : 'amber'}">${I.totalOcs}</div><div class="kpi-label">Ocorrências</div></div>
      <div class="kpi-card"><div class="kpi-val red">${I.ocsCriticas}</div><div class="kpi-label">Críticas</div></div>
      <div class="kpi-card"><div class="kpi-val ${parseFloat(I.taxaAtraso) > 20 ? 'red' : 'amber'}">${I.taxaAtraso}%</div><div class="kpi-label">Taxa atraso</div></div>
      <div class="kpi-card"><div class="kpi-val ${parseFloat(I.taxaSilencio) > 15 ? 'amber' : ''}">${I.taxaSilencio}%</div><div class="kpi-label">Silêncio</div></div>
      <div class="kpi-card"><div class="kpi-val">${meta.projetosAtivos}</div><div class="kpi-label">Projetos ativos</div></div>
    </div>
    <div class="chart-wrap">
      <div class="chart-title">Volume diário de mensagens — últimos 30 dias</div>
      <svg viewBox="0 0 600 100" preserveAspectRatio="none">
        <polygon points="0,100 ${sparkPoints} 600,100" fill="#c4a77d" opacity="0.1"/>
        <polyline points="${sparkPoints}" fill="none" stroke="#c4a77d" stroke-width="2"/>
      </svg>
      <div class="chart-stats">
        <div class="chart-stat">média <strong>${Math.round(I.totalMsgs30d / 30)}/dia</strong></div>
        <div class="chart-stat">pico <strong>${maxDia}</strong></div>
        <div class="chart-stat">total <strong>${I.totalMsgs30d.toLocaleString('pt-BR')}</strong></div>
      </div>
    </div>
    <div class="tipos-chart">
      <div class="chart-title" style="margin-bottom:16px">Tipos de ocorrência mais frequentes</div>
      ${tiposBars}
    </div>
  </div>
</section>

${diffHTML}

<!-- SLIDE: INSIGHTS -->
<section class="slide">
  <div class="slide-content">
    <div class="slide-eyebrow">leitura dos dados</div>
    <h2>Insights não-óbvios</h2>
    <div class="insights-grid">${insightsHTML}</div>
  </div>
</section>

<!-- SLIDE: AÇÕES -->
<section class="slide">
  <div class="slide-content">
    <div class="slide-eyebrow">plano de ação</div>
    <h2>O que fazer agora</h2>
    <div class="acoes-grid">${acoesHTML}</div>
  </div>
</section>

<!-- SLIDE: SEMANA -->
<section class="slide">
  <div class="slide-content">
    <div class="slide-eyebrow">próximos 7 dias</div>
    <h2>O que monitorar</h2>
    <p style="font-size:19px">${analise.semana || ''}</p>
  </div>
</section>

<div class="footer">
  Hermes v1.0 · análise gerada em ${dataFmt} · <a href="indicadores.html">ver painel operacional →</a>
</div>

<script>
const slides = document.querySelectorAll('.slide');
const dots = document.querySelectorAll('.nav-dot');
dots.forEach((dot, i) => {
  dot.addEventListener('click', () => {
    slides[i]?.scrollIntoView({ behavior: 'smooth' });
  });
});
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const idx = Array.from(slides).indexOf(entry.target);
      dots.forEach((d, i) => d.classList.toggle('active', i === idx));
    }
  });
}, { threshold: 0.5 });
slides.forEach(s => observer.observe(s));
</script>

</body>
</html>`;
}

// ── PUBLISH TO GITHUB ───────────────────────────────────────────

async function publicarGitHub(html) {
  if (!GH_TOKEN) {
    console.log('[HERMES] GITHUB_TOKEN não configurado');
    return false;
  }

  const url = `https://api.github.com/repos/${GH_REPO}/contents/${GH_FILE}`;

  // Get current SHA
  let sha = null;
  try {
    const r = await fetch(url, { headers: { 'Authorization': `token ${GH_TOKEN}` } });
    if (r.ok) { const d = await r.json(); sha = d.sha; }
  } catch {}

  const body = {
    message: `🔮 Hermes: análise ${new Date().toISOString().substring(0, 10)}`,
    content: Buffer.from(html, 'utf-8').toString('base64'),
    ...(sha ? { sha } : {}),
  };

  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `token ${GH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const err = await r.text();
    console.error('[HERMES] Erro GitHub:', err);
    return false;
  }

  console.log(`[HERMES] Análise publicada em ${GH_REPO}/${GH_FILE}`);
  return true;
}

// ── NOTIFY TELEGRAM ─────────────────────────────────────────────

async function notificarTelegram(analise) {
  if (!TG_TOKEN || !VITOR_CHAT_ID) return;

  let msg = `🔮 *Análise Hermes*\n`;
  msg += `_${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}_\n\n`;
  msg += `📰 *${analise.manchete}*\n\n`;

  if (analise.acoes && analise.acoes.length) {
    msg += `🎯 *Ações prioritárias:*\n`;
    analise.acoes.slice(0, 3).forEach(a => {
      const emoji = a.prioridade === 'alta' ? '🔴' : a.prioridade === 'media' ? '🟡' : '🟢';
      msg += `${emoji} ${a.acao.substring(0, 80)}\n`;
    });
  }

  msg += `\n📊 [Ler análise completa](https://vitormonofloor.github.io/Monofloor_Files/${GH_FILE})`;

  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: VITOR_CHAT_ID,
        text: msg,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    console.log('[HERMES] Telegram notificado');
  } catch (e) {
    console.error('[HERMES] Erro Telegram:', e.message);
  }
}

// ── MAIN CYCLE ──────────────────────────────────────────────────

async function cicloCompleto() {
  try {
    console.log('\n═══════════════════════════════════════');
    console.log(`[HERMES] Ciclo iniciado — ${new Date().toISOString()}`);

    const dados = await buscarDadosArgos();
    const diff = calcularDiff(dados, analiseAnterior);
    const contexto = montarContextoLLM(dados, diff);
    const analise = await chamarLLM(contexto);
    const html = renderHTML(analise, dados, diff);
    const publicado = await publicarGitHub(html);
    await notificarTelegram(analise);

    analiseAnterior = dados;
    ultimaAnalise = { timestamp: new Date().toISOString(), analise, dados: { meta: dados.meta, indicadores: { totalMsgs30d: dados.indicadores.totalMsgs30d, totalOcs: dados.indicadores.totalOcs } }, publicado };
    historicoAnalises.push(ultimaAnalise);
    if (historicoAnalises.length > 30) historicoAnalises = historicoAnalises.slice(-30);

    console.log(`[HERMES] Ciclo completo ✓`);
    console.log('═══════════════════════════════════════\n');
  } catch (e) {
    console.error('[HERMES] ERRO no ciclo:', e.message);
    if (TG_TOKEN && VITOR_CHAT_ID) {
      try {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: VITOR_CHAT_ID, text: `⚠️ Hermes falhou: ${e.message.substring(0, 200)}` }),
        });
      } catch {}
    }
  }
}

// ── SCHEDULER ───────────────────────────────────────────────────

function getBRHour() {
  const now = new Date();
  return parseInt(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }));
}

function startScheduler() {
  setInterval(() => {
    const h = getBRHour();
    const m = new Date().getMinutes();
    if (h === HORA_EXECUCAO && m < 5) {
      cicloCompleto();
    }
  }, 5 * 60 * 1000);

  console.log(`[HERMES] Scheduler: ciclo diário às ${HORA_EXECUCAO}h (BR)`);
}

// ── API ─────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    agente: 'Hermes',
    descricao: 'Agente narrativo — traduz dados em insights estratégicos',
    version: '1.0.0',
    status: 'online',
    modelo: GROQ_MODEL,
    execucaoDiaria: `${HORA_EXECUCAO}h BR`,
    ultimaAnalise: ultimaAnalise?.timestamp || 'nunca',
    analise: ultimaAnalise?.analise?.manchete || null,
    historico: historicoAnalises.length + ' análises',
    paineis: {
      operacional: `https://vitormonofloor.github.io/${GH_REPO.split('/')[1]}/indicadores.html`,
      narrativo: `https://vitormonofloor.github.io/${GH_REPO.split('/')[1]}/${GH_FILE}`,
    },
  });
});

app.get('/api/ultima', (req, res) => {
  if (!ultimaAnalise) return res.json({ error: 'Nenhuma análise gerada ainda. Use /api/executar.' });
  res.json(ultimaAnalise);
});

app.get('/api/historico', (req, res) => {
  res.json(historicoAnalises);
});

app.get('/api/executar', async (req, res) => {
  res.json({ status: 'Ciclo iniciado. Aguarde ~30 segundos.' });
  cicloCompleto();
});

// ── START ───────────────────────────────────────────────────────

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`\n🔮 Hermes v1.0 — port ${PORT}`);
  console.log(`   Argos: ${ARGOS_URL}`);
  console.log(`   Groq: ${GROQ_KEY ? '✓' : '⚠️ não configurada'}`);
  console.log(`   Modelo: ${GROQ_MODEL}`);
  console.log(`   GitHub: ${GH_REPO}/${GH_FILE}`);
  console.log(`   Telegram: ${VITOR_CHAT_ID ? '✓' : '⚠️ não configurado'}`);
  console.log(`   Execução: todo dia às ${HORA_EXECUCAO}h BR\n`);

  startScheduler();

  // Primeira execução 90s após boot (só se Groq estiver configurada)
  if (GROQ_KEY) {
    setTimeout(() => {
      console.log('[HERMES] Primeira execução automática...');
      cicloCompleto();
    }, 90000);
  } else {
    console.log('[HERMES] GROQ_API_KEY não configurada — aguardando configuração para executar');
  }
});
