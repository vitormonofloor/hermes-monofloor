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

  // Regional data
  const regiaoData = Object.entries(I.porRegiao || {})
    .sort((a, b) => b[1].obras - a[1].obras)
    .map(([r, d]) => ({ nome: r, obras: d.obras, msgs: d.msgs, ocs: d.ocs }));

  // Build projects by region
  const projetosPorRegiao = {};
  (dados.projetos || []).forEach(p => {
    const cidade = (p.cidade || '').toLowerCase();
    let regiao = 'OUTROS';
    if (cidade.includes('são paulo') || cidade.includes('sao paulo')) regiao = 'SP';
    else if (cidade.includes('rio')) regiao = 'RJ';
    else if (cidade.includes('curitiba')) regiao = 'CWB';
    if (!projetosPorRegiao[regiao]) projetosPorRegiao[regiao] = [];
    projetosPorRegiao[regiao].push({
      nome: p.nome, cidade: p.cidade, msgs: p.msgs30d, ocs: p.totalOcs,
      fase: p.fase, status: p.status, consultor: p.consultor,
      ocorrencias: (p.ocsDetalhes || []).slice(0, 10).map(o => ({ tipo: o.tipo, sev: o.severidade, titulo: o.titulo }))
    });
  });

  // Build phase pipeline per region (for chart nodes + tooltip)
  const regiaoPipelines = {};
  Object.entries(projetosPorRegiao).forEach(([regiao, projetos]) => {
    const faseMap = {};
    projetos.forEach(p => {
      const f = (p.fase || 'sem fase').toLowerCase();
      if (!faseMap[f]) faseMap[f] = { count: 0, ocs: { total: 0, critica: 0, alta: 0, media: 0, baixa: 0 }, tipos: {}, projetos: [] };
      faseMap[f].count++;
      faseMap[f].ocs.total += p.ocs;
      faseMap[f].projetos.push(p);
      (p.ocorrencias || []).forEach(o => {
        if (faseMap[f].ocs[o.sev] !== undefined) faseMap[f].ocs[o.sev]++;
        const t = (o.tipo || '?').replace(/_/g, ' ');
        faseMap[f].tipos[t] = (faseMap[f].tipos[t] || 0) + 1;
      });
    });
    const classify = (fase) => {
      if (fase.includes('execu')) return 'exec';
      if (fase.includes('agend')) return 'agend';
      if (fase.includes('reparo') || fase.includes('pausada') || fase.includes('marcas')) return 'reparo';
      if (fase.includes('finaliz') || fase.includes('conclui') || fase.includes('cliente finalizado')) return 'final';
      return 'other';
    };
    regiaoPipelines[regiao] = Object.entries(faseMap)
      .map(([fase, d]) => ({ fase, count: d.count, type: classify(fase), ocs: d.ocs, tipos: d.tipos, projetos: d.projetos }))
      .sort((a, b) => b.count - a.count);
  });

  const drilldownData = JSON.stringify({ pipelines: regiaoPipelines }).replace(/<\\//g, '<\\\\/');

  // Render SVG pipeline chart (server-side)
  function renderPipelineSVG(fases, idx) {
    const maxCount = Math.max(...fases.map(f => f.count), 1);
    const W = 900, H = 180, padL = 35, padR = 25, padT = 25, padB = 55;
    const chartW = W - padL - padR, chartH = H - padT - padB;
    const stepX = fases.length > 1 ? chartW / (fases.length - 1) : chartW / 2;
    const points = fases.map((f, i) => ({
      x: padL + (fases.length > 1 ? i * stepX : chartW / 2),
      y: padT + chartH - (f.count / maxCount) * chartH, ...f
    }));
    let linePath = 'M ' + points[0].x + ' ' + points[0].y;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[Math.max(0, i-1)], p1 = points[i], p2 = points[i+1], p3 = points[Math.min(points.length-1, i+2)];
      const t = 0.35;
      linePath += ' C '+(p1.x+(p2.x-p0.x)*t)+' '+(p1.y+(p2.y-p0.y)*t)+', '+(p2.x-(p3.x-p1.x)*t)+' '+(p2.y-(p3.y-p1.y)*t)+', '+p2.x+' '+p2.y;
    }
    const areaPath = linePath+' L '+points[points.length-1].x+' '+(padT+chartH)+' L '+points[0].x+' '+(padT+chartH)+' Z';
    let grid = '';
    for (let i = 0; i <= 4; i++) {
      const y = padT+(chartH/4)*i;
      grid += '<line class="grid-line" x1="'+padL+'" y1="'+y+'" x2="'+(W-padR)+'" y2="'+y+'"/>';
      grid += '<text class="grid-label" x="'+(padL-8)+'" y="'+(y+4)+'" text-anchor="end">'+Math.round(maxCount-(maxCount/4)*i)+'</text>';
    }
    const pts = points.map(p => {
      const lbl = p.fase.length > 14 ? p.fase.substring(0,12)+'\u2026' : p.fase;
      return '<g class="data-point point-'+p.type+'" data-fase="'+p.fase.replace(/"/g,'&quot;')+'">'+
        '<circle class="bubble-glow" cx="'+p.x+'" cy="'+p.y+'" r="26"/>'+
        '<circle class="bubble-ring" cx="'+p.x+'" cy="'+p.y+'" r="24"/>'+
        '<circle class="bubble-bg" cx="'+p.x+'" cy="'+p.y+'" r="20"/>'+
        '<text class="bubble-value" x="'+p.x+'" y="'+p.y+'">'+p.count+'</text></g>'+
        '<text class="x-label" x="'+p.x+'" y="'+(H-8)+'" data-fase="'+p.fase.replace(/"/g,'&quot;')+'">'+lbl+'</text>';
    }).join('');
    return '<svg viewBox="0 0 '+W+' '+H+'">'+
      '<defs><linearGradient id="areaGrad-'+idx+'" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#c4a77d" stop-opacity="0.3"/><stop offset="100%" stop-color="#c4a77d" stop-opacity="0.02"/></linearGradient></defs>'+
      grid+'<path class="chart-area" d="'+areaPath+'" style="fill:url(#areaGrad-'+idx+')"/>'+
      '<path class="chart-line" d="'+linePath+'"/>'+pts+'</svg>';
  }

  const regionCards = regiaoData.map((r, idx) => {
    const fases = regiaoPipelines[r.nome] || [];
    if (!fases.length) return '';
    return '<div class="region-card" data-region="'+r.nome+'">'+
      '<div class="region-header"><div class="region-name">'+r.nome+'</div>'+
      '<div class="region-stats"><span><span class="val">'+r.obras+'</span>obras</span><span><span class="val">'+r.msgs.toLocaleString('pt-BR')+'</span>msgs</span><span><span class="val">'+r.ocs+'</span>ocs</span></div></div>'+
      '<div class="chart-container">'+renderPipelineSVG(fases, idx)+'</div>'+
      '<div class="drill-list" id="drill-'+r.nome+'"></div></div>';
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
        <div class="container">
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
html,body{background:#0a0a0a;color:#e0e0e0;font-family:Inter,-apple-system,sans-serif;scroll-behavior:smooth;overflow-x:hidden}
.container{max-width:1100px;margin:0 auto;padding:0 32px}
.slide{padding:80px 0;position:relative;border-bottom:1px solid #151515;opacity:0;transform:translateY(20px);transition:opacity 0.8s ease-out, transform 0.8s ease-out}
.slide.visible{opacity:1;transform:translateY(0)}
.slide:first-of-type{padding-top:0;opacity:1;transform:none}
.slide-content{width:100%}
.slide-eyebrow{font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#c4a77d;margin-bottom:20px;display:inline-block;padding:6px 12px;background:#c4a77d15;border-radius:4px}
.slide h1{font-size:52px;font-weight:300;line-height:1.12;margin-bottom:24px;letter-spacing:-0.02em;color:#fff}
.slide h1 strong{color:#c4a77d;font-weight:500}
.slide h2{font-size:36px;font-weight:400;margin-bottom:28px;color:#fff;letter-spacing:-0.015em;line-height:1.2}
.slide h2 .accent{color:#c4a77d}
.slide p{font-size:17px;line-height:1.75;color:#c8c8c8}
.slide p + p{margin-top:16px}
/* HERO */
.hero{min-height:85vh;display:flex;align-items:center;padding:60px 0 100px;background:radial-gradient(ellipse 80% 60% at 50% 30%, #1e1810 0%, #0a0a0a 60%)}
.hero-content{width:100%}
.hero .brand{display:flex;align-items:baseline;gap:14px;margin-bottom:40px;justify-content:center;flex-wrap:wrap}
.hero .logo{font-size:24px;letter-spacing:10px;color:#c4a77d;text-transform:uppercase;font-weight:300}
.hero .subtitle{font-size:10px;letter-spacing:4px;color:#555;text-transform:uppercase}
.hero .subtitle::before{content:"·";margin-right:10px;color:#333}
.hero h1{font-size:68px;text-align:center;max-width:900px;margin:0 auto 32px;line-height:1.08}
.hero-meta{font-size:13px;color:#666;text-align:center;margin-top:40px;padding-top:32px;border-top:1px solid #1a1a1a;max-width:600px;margin-left:auto;margin-right:auto}
.hero-meta a{color:#c4a77d;text-decoration:none;border-bottom:1px solid #c4a77d30;padding-bottom:1px}
.hero-meta a:hover{border-bottom-color:#c4a77d}
/* KPI GRID */
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:32px}
.kpi-card{background:linear-gradient(180deg, #141414 0%, #0e0e0e 100%);border:1px solid #1f1f1f;border-radius:12px;padding:24px 18px;text-align:center;transition:all 0.2s}
.kpi-card:hover{border-color:#c4a77d40;transform:translateY(-2px)}
.kpi-val{font-size:38px;font-weight:700;line-height:1;color:#c4a77d;font-variant-numeric:tabular-nums}
.kpi-val.red{color:#ef4444}
.kpi-val.amber{color:#f59e0b}
.kpi-label{font-size:10px;color:#777;text-transform:uppercase;letter-spacing:1.2px;margin-top:10px;font-weight:500}
/* CONTEXT */
.contexto{font-size:19px;line-height:1.75;color:#d8d8d8;max-width:780px}
.contexto strong{color:#c4a77d;font-weight:500}
.contexto p{font-size:19px;line-height:1.75}
/* CHART */
.chart-wrap{background:linear-gradient(180deg, #141414 0%, #0e0e0e 100%);border:1px solid #1f1f1f;border-radius:12px;padding:28px;margin-top:32px}
.chart-title{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:18px;font-weight:500}
svg.sparkline{width:100%;height:120px;display:block}
.chart-stats{display:flex;gap:40px;margin-top:20px;padding-top:18px;border-top:1px solid #222;flex-wrap:wrap}
.chart-stat{font-size:10px;color:#777;text-transform:uppercase;letter-spacing:1px}
.chart-stat strong{color:#c4a77d;font-size:22px;display:block;margin-top:4px;font-weight:600;letter-spacing:0;text-transform:none}
/* INSIGHTS */
.insights-grid{display:grid;gap:16px;margin-top:24px}
.insight-card{background:linear-gradient(135deg, #161108 0%, #0f0c07 100%);border:1px solid #2a2015;border-left:3px solid #c4a77d;border-radius:10px;padding:24px 28px;transition:transform 0.2s}
.insight-card:hover{transform:translateX(4px)}
.insight-title{font-size:19px;color:#c4a77d;font-weight:500;margin-bottom:10px;letter-spacing:-0.01em}
.insight-text{font-size:15px;line-height:1.65;color:#c8c8c8}
/* ACTIONS */
.acoes-grid{display:grid;gap:14px;margin-top:24px}
.acao-card{background:#121212;border-radius:10px;padding:20px 24px;display:grid;grid-template-columns:90px 1fr;gap:22px;align-items:flex-start;border:1px solid #1a1a1a;transition:all 0.2s}
.acao-card:hover{border-color:#333}
.acao-card.prio-alta{border-left:3px solid #ef4444}
.acao-card.prio-media{border-left:3px solid #f59e0b}
.acao-card.prio-baixa{border-left:3px solid #555}
.acao-prio{font-size:10px;letter-spacing:1.5px;color:#888;padding:8px 10px;background:#0a0a0a;border-radius:6px;text-align:center;font-weight:600;align-self:start}
.acao-card.prio-alta .acao-prio{color:#ef4444;background:#ef444415}
.acao-card.prio-media .acao-prio{color:#f59e0b;background:#f59e0b15}
.acao-texto{font-size:17px;line-height:1.5;color:#f0f0f0;font-weight:500;margin-bottom:8px}
.acao-ctx{font-size:13px;line-height:1.6;color:#888}
/* TYPES CHART */
.tipos-chart{margin-top:24px}
.tipo-row{display:grid;grid-template-columns:200px 1fr 70px;gap:18px;align-items:center;margin-bottom:14px;font-size:13px}
.tipo-label{color:#d0d0d0;text-transform:capitalize;font-weight:500}
.tipo-bar-wrap{background:#151515;border-radius:6px;height:10px;overflow:hidden}
.tipo-bar{background:linear-gradient(90deg, #c4a77d 0%, #8a6f45 100%);height:100%;border-radius:6px}
.tipo-num{color:#c4a77d;font-weight:600;text-align:right;font-variant-numeric:tabular-nums}
/* DIFF */
.diff-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:24px}
.diff-card{background:#141414;border:1px solid #1f1f1f;border-radius:10px;padding:22px 18px;text-align:center}
.diff-label{font-size:10px;color:#777;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:10px;font-weight:500}
.diff-valor{font-size:30px;font-weight:600;color:#c4a77d;line-height:1;font-variant-numeric:tabular-nums}
.diff-delta{font-size:14px;margin-top:10px;font-weight:500}
/* SEMANA */
.semana-box{background:linear-gradient(135deg, #0f1410 0%, #0a0c0a 100%);border-left:3px solid #22c55e;padding:28px 32px;border-radius:10px;margin-top:20px}
.semana-box p{font-size:19px;line-height:1.7;color:#e0e0e0}
/* BACK LINK */
.back-link{position:fixed;top:20px;left:20px;z-index:20;background:#141414cc;backdrop-filter:blur(8px);border:1px solid #222;color:#888;padding:10px 16px;border-radius:8px;text-decoration:none;font-size:12px;transition:all 0.2s;font-weight:500;display:inline-flex;align-items:center;gap:6px}
.back-link:hover{color:#c4a77d;border-color:#c4a77d;background:#141414}
.footer{text-align:center;padding:40px 20px;color:#444;font-size:11px;border-top:1px solid #151515;margin-top:40px}
.footer a{color:#c4a77d;text-decoration:none}
/* MOBILE */
@media (max-width: 768px){
  .container{padding:0 20px}
  .slide{padding:50px 0}
  .slide h1{font-size:34px}
  .hero{min-height:auto;padding:80px 0 60px}
  .hero h1{font-size:38px}
  .slide h2{font-size:26px}
  .hero .logo{font-size:18px;letter-spacing:6px}
  .tipo-row{grid-template-columns:130px 1fr 50px;font-size:12px;gap:12px}
  .acao-card{grid-template-columns:1fr;gap:12px}
  .acao-prio{display:inline-block;width:auto}
  .kpi-val{font-size:32px}
  .chart-stats{gap:24px}
  .chart-stat strong{font-size:18px}
  .ibar-stats{flex-wrap:wrap;gap:4px}
}
/* Pipeline chart */
.region-card{background:linear-gradient(180deg, #141414 0%, #0e0e0e 100%);border:1px solid #1f1f1f;border-radius:14px;padding:28px;margin-bottom:24px}
.region-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
.region-name{font-size:22px;font-weight:600;color:#e8e8e8;letter-spacing:1px}
.region-stats{display:flex;gap:16px;font-size:12px;color:#888}
.region-stats .val{color:#c4a77d;font-weight:600;font-size:14px;margin-right:3px}
.chart-container{position:relative;width:100%;height:220px}
.chart-container svg{width:100%;height:100%;overflow:visible}
.chart-area{opacity:0.15}
.grid-line{stroke:#1a1a1a;stroke-width:1}
.grid-label{fill:#555;font-size:10px;font-family:Inter,sans-serif}
.x-label{fill:#888;font-size:10px;font-family:Inter,sans-serif;text-anchor:middle;cursor:pointer;transition:fill 0.2s}
.x-label:hover{fill:#c4a77d}
.x-label.active{fill:#c4a77d;font-weight:600}
.data-point{cursor:pointer;transition:transform 0.2s}
.data-point:hover{transform:scale(1.15)}
.data-point.active .bubble-ring{stroke-width:2;opacity:1}
.data-point.active .bubble-glow{opacity:0.4}
.bubble-bg{fill:#141414;stroke:#333;stroke-width:1.5}
.bubble-ring{fill:none;stroke:#c4a77d;stroke-width:0;opacity:0;transition:all 0.3s}
.bubble-glow{fill:#c4a77d;opacity:0;transition:opacity 0.3s;filter:blur(8px)}
.bubble-value{fill:#c4a77d;font-size:13px;font-weight:700;font-family:Inter,sans-serif;text-anchor:middle;dominant-baseline:central}
.point-exec .bubble-bg{stroke:#3b82f6}.point-exec .bubble-value{fill:#3b82f6}.point-exec .bubble-ring{stroke:#3b82f6}.point-exec .bubble-glow{fill:#3b82f6}
.point-agend .bubble-bg{stroke:#f59e0b}.point-agend .bubble-value{fill:#f59e0b}.point-agend .bubble-ring{stroke:#f59e0b}.point-agend .bubble-glow{fill:#f59e0b}
.point-reparo .bubble-bg{stroke:#ef4444}.point-reparo .bubble-value{fill:#ef4444}.point-reparo .bubble-ring{stroke:#ef4444}.point-reparo .bubble-glow{fill:#ef4444}
.point-final .bubble-bg{stroke:#22c55e}.point-final .bubble-value{fill:#22c55e}.point-final .bubble-ring{stroke:#22c55e}.point-final .bubble-glow{fill:#22c55e}
.point-other .bubble-bg{stroke:#888}.point-other .bubble-value{fill:#888}.point-other .bubble-ring{stroke:#888}.point-other .bubble-glow{fill:#888}
/* Hermes tooltip */
.hermes-tooltip{position:fixed;z-index:1000;pointer-events:none;opacity:0;transform:translateY(8px);transition:opacity 0.25s,transform 0.25s;max-width:320px}
.hermes-tooltip.visible{opacity:1;transform:translateY(0)}
.tooltip-inner{background:#1a1510;border:1px solid #c4a77d40;border-radius:12px;padding:14px 18px;box-shadow:0 8px 32px rgba(0,0,0,0.6),0 0 20px #c4a77d15;position:relative}
.tooltip-wing{position:absolute;top:-8px;width:28px;height:28px;background-image:url('hermes-wing.png');background-size:contain;background-repeat:no-repeat;opacity:0.7;filter:drop-shadow(0 0 4px #c4a77d40)}
.tooltip-wing-left{left:-14px;transform:scaleX(-1) rotate(-15deg);animation:tt-flutter 1.2s ease-in-out infinite}
.tooltip-wing-right{right:-14px;transform:rotate(-15deg);animation:tt-flutter-r 1.2s ease-in-out infinite 0.1s}
@keyframes tt-flutter{0%,100%{transform:scaleX(-1) rotate(-15deg)}50%{transform:scaleX(-1) rotate(-22deg)}}
@keyframes tt-flutter-r{0%,100%{transform:rotate(-15deg)}50%{transform:rotate(-22deg)}}
.tooltip-header{display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #c4a77d20}
.tooltip-fase{font-size:13px;font-weight:600;color:#c4a77d;text-transform:capitalize;flex:1}
.tooltip-count{font-size:18px;font-weight:700;color:#fff}
.tooltip-count-label{font-size:9px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-left:4px}
.tooltip-sev-grid{display:flex;gap:6px;margin-bottom:10px}
.tooltip-sev-item{flex:1;text-align:center;background:#0a0a0a;border-radius:6px;padding:6px 4px}
.tooltip-sev-num{font-size:14px;font-weight:700;line-height:1}
.tooltip-sev-num.critica{color:#ef4444}.tooltip-sev-num.alta{color:#f59e0b}.tooltip-sev-num.media{color:#3b82f6}.tooltip-sev-num.baixa{color:#22c55e}
.tooltip-sev-label{font-size:8px;color:#888;text-transform:uppercase;letter-spacing:0.3px;margin-top:2px}
.tooltip-tipos{margin-top:8px}
.tooltip-tipo-row{display:flex;justify-content:space-between;font-size:10px;padding:3px 0;border-bottom:1px solid #0a0a0a}
.tooltip-tipo-name{color:#ccc;text-transform:capitalize}
.tooltip-tipo-count{color:#c4a77d;font-weight:600}
.tooltip-hint{font-size:9px;color:#666;text-align:center;margin-top:8px;font-style:italic}
/* Drill list */
.drill-list{max-height:0;overflow:hidden;transition:max-height 0.4s ease-out,opacity 0.3s;opacity:0;margin-top:0}
.drill-list.open{max-height:800px;opacity:1;margin-top:16px;overflow-y:auto}
.drill-list-header{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;background:#0a0a0a;border-radius:8px 8px 0 0;border:1px solid #222;border-bottom:none}
.drill-list-title{font-size:13px;font-weight:600;color:#c4a77d;text-transform:capitalize}
.drill-list-close{font-size:10px;color:#888;cursor:pointer;text-transform:uppercase;letter-spacing:1px;padding:4px 8px;border-radius:4px;transition:all 0.2s}
.drill-list-close:hover{color:#c4a77d;background:#1a1a1a}
.drill-list-body{background:#0a0a0a;border:1px solid #222;border-top:none;border-radius:0 0 8px 8px;padding:4px 0}
.drill-row{display:grid;grid-template-columns:1fr 80px 70px 60px;padding:8px 16px;font-size:12px;border-bottom:1px solid #151515;transition:background 0.15s;align-items:center}
.drill-row:hover{background:#141414}
.drill-row-name{color:#e0e0e0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.drill-row-cons{color:#888;font-size:11px}
.drill-row-msgs{color:#888;text-align:right;font-variant-numeric:tabular-nums}
.drill-row-ocs.zero{color:#333}
.drill-row-ocs.has-ocs{color:#ef4444;font-weight:600;cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px}
.drill-row-ocs.has-ocs:hover{color:#ff6b6b}
.ocs-expand{max-height:0;overflow:hidden;transition:max-height 0.3s ease-out,padding 0.3s;grid-column:1/-1;padding:0 16px;background:#080808;border-bottom:1px solid #1a1a1a}
.ocs-expand.open{max-height:500px;padding:10px 16px 12px;overflow-y:auto}
.ocs-list-head{font-size:9px;color:#666;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;display:flex;justify-content:space-between}
.ocs-item{display:grid;grid-template-columns:65px 100px 1fr;gap:8px;align-items:start;padding:5px 0;font-size:11px;border-bottom:1px solid #111}
.ocs-item:last-child{border-bottom:none}
.ocs-sev{padding:2px 6px;border-radius:3px;font-size:9px;font-weight:600;text-transform:uppercase;text-align:center}
.ocs-sev.critica{background:#ef444420;color:#ef4444}.ocs-sev.alta{background:#f59e0b20;color:#f59e0b}.ocs-sev.media{background:#3b82f620;color:#3b82f6}.ocs-sev.baixa{background:#22c55e20;color:#22c55e}
.ocs-tipo{color:#888;font-size:10px;text-transform:capitalize}
.drill-obra-meta .oc{color:#ef4444;font-weight:600}
</style>
</head>
<body>

<a href="indicadores.html" class="back-link">← Painel operacional</a>

<!-- SLIDE 1: HERO -->
<section class="slide hero">
  <div class="container hero-content">
    <div class="brand">
      <div class="logo">hermes</div>
      <div class="subtitle">análise diária · monofloor</div>
    </div>
    <h1>${analise.manchete}</h1>
    <div class="hero-meta">${dataFmt} · <a href="indicadores.html">ver painel completo →</a></div>
  </div>
</section>

<!-- SLIDE 2: CONTEXTO -->
<section class="slide">
  <div class="container">
    <div class="slide-eyebrow">o que está acontecendo</div>
    <h2>Contexto operacional</h2>
    <div class="contexto">${(analise.contexto || '').split('\n\n').map(p => `<p>${p}</p>`).join('')}</div>
  </div>
</section>

<!-- SLIDE 3: NÚMEROS -->
<section class="slide">
  <div class="container">
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

    <!-- Pipeline charts por região -->
    ${regionCards}

    <div class="chart-wrap" style="margin-top:24px">
      <div class="chart-title">Volume diário de mensagens · últimos 30 dias</div>
      <svg class="sparkline" viewBox="0 0 600 100" preserveAspectRatio="none">
        <polygon points="0,100 ${sparkPoints} 600,100" fill="#c4a77d" opacity="0.12"/>
        <polyline points="${sparkPoints}" fill="none" stroke="#c4a77d" stroke-width="2"/>
      </svg>
      <div class="chart-stats">
        <div class="chart-stat">média por dia<strong>${Math.round(I.totalMsgs30d / 30)}</strong></div>
        <div class="chart-stat">pico<strong>${maxDia}</strong></div>
        <div class="chart-stat">total<strong>${I.totalMsgs30d.toLocaleString('pt-BR')}</strong></div>
      </div>
    </div>
    <div class="tipos-chart" style="margin-top:24px">
      <div class="chart-title" style="margin-bottom:16px">Tipos de ocorrência mais frequentes</div>
      ${tiposBars}
    </div>
  </div>
</section>

${diffHTML}

<!-- SLIDE: INSIGHTS -->
<section class="slide">
  <div class="container">
    <div class="slide-eyebrow">leitura dos dados</div>
    <h2>Insights <span class="accent">não-óbvios</span></h2>
    <div class="insights-grid">${insightsHTML}</div>
  </div>
</section>

<!-- SLIDE: AÇÕES -->
<section class="slide">
  <div class="container">
    <div class="slide-eyebrow">plano de ação</div>
    <h2>O que fazer <span class="accent">agora</span></h2>
    <div class="acoes-grid">${acoesHTML}</div>
  </div>
</section>

<!-- SLIDE: SEMANA -->
<section class="slide">
  <div class="container">
    <div class="slide-eyebrow">próximos 7 dias</div>
    <h2>O que monitorar</h2>
    <div class="semana-box">
      <p>${analise.semana || ''}</p>
    </div>
  </div>
</section>

<div class="footer">
  Hermes v1.4 · análise gerada em ${dataFmt} · <a href="indicadores.html">ver painel operacional →</a>
</div>

<!-- Hermes tooltip -->
<div class="hermes-tooltip" id="hermes-tooltip">
  <div class="tooltip-inner">
    <div class="tooltip-wing tooltip-wing-left"></div>
    <div class="tooltip-wing tooltip-wing-right"></div>
    <div class="tooltip-header">
      <div class="tooltip-fase" id="tt-fase"></div>
      <div><span class="tooltip-count" id="tt-count"></span><span class="tooltip-count-label">obras</span></div>
    </div>
    <div class="tooltip-sev-grid" id="tt-sev"></div>
    <div class="tooltip-tipos" id="tt-tipos"></div>
    <div class="tooltip-hint">clique para ver detalhes</div>
  </div>
</div>

<script>
const DRILL = ${drilldownData};
const tooltip = document.getElementById('hermes-tooltip');
let tooltipTimeout = null;

// Fade-in
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => { if (entry.isIntersecting) entry.target.classList.add('visible'); });
}, { threshold: 0.15 });
document.querySelectorAll('.slide').forEach(s => observer.observe(s));

// Tooltip on hover
function showTooltip(faseData, x, y) {
  document.getElementById('tt-fase').textContent = faseData.fase;
  document.getElementById('tt-count').textContent = faseData.count;
  const ocs = faseData.ocs || { total:0, critica:0, alta:0, media:0, baixa:0 };
  document.getElementById('tt-sev').innerHTML =
    '<div class="tooltip-sev-item"><div class="tooltip-sev-num critica">'+ocs.critica+'</div><div class="tooltip-sev-label">crítica</div></div>'+
    '<div class="tooltip-sev-item"><div class="tooltip-sev-num alta">'+ocs.alta+'</div><div class="tooltip-sev-label">alta</div></div>'+
    '<div class="tooltip-sev-item"><div class="tooltip-sev-num media">'+ocs.media+'</div><div class="tooltip-sev-label">média</div></div>'+
    '<div class="tooltip-sev-item"><div class="tooltip-sev-num baixa">'+ocs.baixa+'</div><div class="tooltip-sev-label">baixa</div></div>';
  const tipos = faseData.tipos || {};
  const tiposArr = Object.entries(tipos).sort((a,b) => b[1]-a[1]).slice(0,4);
  const ttTipos = document.getElementById('tt-tipos');
  ttTipos.innerHTML = tiposArr.length ? tiposArr.map(function(t) { return '<div class="tooltip-tipo-row"><span class="tooltip-tipo-name">'+t[0]+'</span><span class="tooltip-tipo-count">'+t[1]+'</span></div>'; }).join('') : '';
  ttTipos.style.display = tiposArr.length ? 'block' : 'none';
  tooltip.style.left = Math.max(10, x - 160) + 'px';
  tooltip.style.top = (y - 10) + 'px';
  tooltip.classList.add('visible');
}

document.querySelectorAll('.data-point').forEach(function(point) {
  point.addEventListener('mouseenter', function(e) {
    clearTimeout(tooltipTimeout);
    var regionName = point.closest('.region-card').dataset.region;
    var faseName = point.dataset.fase;
    var pipeline = DRILL.pipelines[regionName] || [];
    var faseData = pipeline.find(function(f) { return f.fase === faseName; });
    if (!faseData) return;
    var rect = point.getBoundingClientRect();
    tooltipTimeout = setTimeout(function() { showTooltip(faseData, rect.left + rect.width/2, rect.top - 10); }, 300);
  });
  point.addEventListener('mouseleave', function() {
    clearTimeout(tooltipTimeout);
    tooltip.classList.remove('visible');
  });
});

// Click drill-down
document.querySelectorAll('.data-point, .x-label').forEach(function(el) {
  el.addEventListener('click', function() {
    tooltip.classList.remove('visible');
    var card = el.closest('.region-card');
    var regionName = card.dataset.region;
    var faseName = el.dataset.fase;
    var drillDiv = card.querySelector('.drill-list');
    var clickedPoint = card.querySelector('.data-point[data-fase="'+faseName+'"]');
    if (clickedPoint && clickedPoint.classList.contains('active')) {
      clickedPoint.classList.remove('active');
      card.querySelectorAll('.x-label').forEach(function(l) { l.classList.remove('active'); });
      drillDiv.classList.remove('open');
      return;
    }
    card.querySelectorAll('.data-point').forEach(function(p) { p.classList.remove('active'); });
    card.querySelectorAll('.x-label').forEach(function(l) { l.classList.remove('active'); });
    if (clickedPoint) clickedPoint.classList.add('active');
    card.querySelectorAll('.x-label[data-fase="'+faseName+'"]').forEach(function(l) { l.classList.add('active'); });
    var pipeline = DRILL.pipelines[regionName] || [];
    var faseData = pipeline.find(function(f) { return f.fase === faseName; });
    var projetos = faseData ? faseData.projetos : [];
    if (!projetos.length) {
      drillDiv.innerHTML = '<div class="drill-list-header"><div class="drill-list-title">'+faseName+'</div><div class="drill-list-close" data-action="close-drill">\u2715</div></div><div class="drill-list-body" style="padding:16px;color:#555;font-size:12px;text-align:center">Sem dados.</div>';
    } else {
      var rows = projetos.sort(function(a,b){return b.ocs-a.ocs;}).map(function(p,pi) {
        var uid = regionName+'-'+pi;
        var hasOcs = p.ocs > 0 && p.ocorrencias && p.ocorrencias.length > 0;
        var ocsHTML = '';
        if (hasOcs) {
          var items = p.ocorrencias.map(function(o) {
            return '<div class="ocs-item"><span class="ocs-sev '+(o.sev||'media')+'">'+(o.sev||'?')+'</span><span class="ocs-tipo">'+(o.tipo||'').replace(/_/g,' ')+'</span><span class="ocs-titulo">'+(o.titulo||'\u2014')+'</span></div>';
          }).join('');
          ocsHTML = '<div class="ocs-expand" id="ocs-'+uid+'"><div class="ocs-list-head"><span>Ocorr\u00eancias</span><span>'+p.ocorrencias.length+' reg.</span></div>'+items+'</div>';
        }
        return '<div class="drill-row">'+
          '<div class="drill-row-name">'+(p.nome||'').substring(0,30)+'</div>'+
          '<div class="drill-row-cons">'+(p.consultor||'')+'</div>'+
          '<div class="drill-row-msgs">'+(p.msgs||0)+' msgs</div>'+
          '<div class="drill-row-ocs '+(hasOcs?'has-ocs':(p.ocs>0?'':'zero'))+'" '+(hasOcs?'data-toggle-ocs="ocs-'+uid+'"':'')+'>'+
            (p.ocs>0?p.ocs+' ocs':'\u2014')+'</div></div>'+ocsHTML;
      }).join('');
      drillDiv.innerHTML = '<div class="drill-list-header"><div class="drill-list-title">'+faseName+' \u2014 '+projetos.length+' obra'+(projetos.length>1?'s':'')+'</div><div class="drill-list-close" data-action="close-drill">\u2715</div></div><div class="drill-list-body">'+rows+'</div>';
    }
    drillDiv.classList.add('open');
  });
});

document.addEventListener('click', function(e) {
  var ocsToggle = e.target.closest('[data-toggle-ocs]');
  if (ocsToggle) {
    e.stopPropagation();
    var targetId = ocsToggle.dataset.toggleOcs;
    var ocsDiv = document.getElementById(targetId);
    if (ocsDiv) {
      ocsDiv.closest('.drill-list-body').querySelectorAll('.ocs-expand.open').forEach(function(d) { if (d.id !== targetId) d.classList.remove('open'); });
      ocsDiv.classList.toggle('open');
    }
    return;
  }
  var closeBtn = e.target.closest('[data-action="close-drill"]');
  if (closeBtn) {
    e.stopPropagation();
    var card = closeBtn.closest('.region-card');
    card.querySelector('.drill-list').classList.remove('open');
    card.querySelectorAll('.data-point.active').forEach(function(p) { p.classList.remove('active'); });
    card.querySelectorAll('.x-label.active').forEach(function(l) { l.classList.remove('active'); });
  }
});
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
