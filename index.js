import crypto from 'crypto';
import { pathToFileURL } from 'url';
import admin from 'firebase-admin';
import Parser from 'rss-parser';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const parser = new Parser({ timeout: 15000 });

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;

const NOTICIAS_COLLECTION = 'radar_noticias_usadas';
const MAX_ARTICLES = 4;
const TELEGRAM_LIMIT = 4000; // limite do Telegram é 4096; deixa margem

const RSS_URLS = [
  'https://news.google.com/rss/search?q=consorcio+OR+%22taxa+selic%22+OR+%22financiamento+imobiliario%22&hl=pt-BR&gl=BR&ceid=BR:pt-419',
  'https://www.bing.com/news/search?q=consorcio+imobiliario+OR+taxa+selic&format=rss&mkt=pt-br'
];

// Ordem de tentativa. Se um modelo estiver sobrecarregado (503) ou não existir (404), passa ao próximo.
// Lista de modelos válidos: https://ai.google.dev/gemini-api/docs/models
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function checkEnv() {
  const missing = Object.entries({ GEMINI_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, FIREBASE_SERVICE_ACCOUNT })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`Secrets não configurados no GitHub: ${missing.join(', ')}`);
  }
}

let db;
function getDb() {
  if (!db) {
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)) });
    }
    db = admin.firestore();
  }
  return db;
}

export function generateDocId(title, link) {
  const uniqueKey = title ? `${title}-${link.substring(0, 40)}` : link;
  return crypto.createHash('md5').update(uniqueKey.trim()).digest('hex');
}

async function fetchFeed(url) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`Lendo feed (${attempt}/2): ${url.substring(0, 45)}...`);
      const response = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'pt-BR,pt;q=0.9' },
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw new Error(`HTTP Status ${response.status}`);
      return await parser.parseString(await response.text());
    } catch (err) {
      console.warn(`Aviso na tentativa ${attempt}: ${err.message}`);
      if (attempt < 2) await sleep(3000);
    }
  }
  return null;
}

// Converte os itens do feed em candidatos, do mais recente para o mais antigo.
export function toCandidates(items) {
  return items
    .map(item => {
      const link = item.link || item.guid || '';
      return {
        id: link ? generateDocId(item.title, link) : null,
        title: item.title,
        link,
        pubDate: item.pubDate,
        snippet: (item.contentSnippet || item.content || '').substring(0, 500)
      };
    })
    .filter(c => c.id)
    .sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0))
    .slice(0, 15);
}

async function fetchUnusedNews() {
  const unused = [];
  let anyFeedOk = false;

  for (const url of RSS_URLS) {
    const feed = await fetchFeed(url);
    if (!feed) continue;
    anyFeedOk = true;

    const candidates = toCandidates(feed.items || []).filter(c => !unused.some(u => u.id === c.id));
    if (!candidates.length) continue;

    // Uma única leitura em lote no Firestore em vez de uma por notícia
    const refs = candidates.map(c => getDb().collection(NOTICIAS_COLLECTION).doc(c.id));
    const snaps = await getDb().getAll(...refs);
    candidates.forEach((c, i) => { if (!snaps[i].exists) unused.push(c); });

    if (unused.length >= MAX_ARTICLES) break;
  }

  if (!anyFeedOk) throw new Error('Todas as fontes de RSS retornaram erro.');
  return unused.slice(0, MAX_ARTICLES);
}

function buildPrompt(articles) {
  return `
Você é um estrategista de conteúdo e consultor especialista em consórcios e planejamento financeiro imobiliário e veicular.

Analise as notícias recentes e inéditas abaixo:
${JSON.stringify(articles, null, 2)}

Escolha a notícia mais relevante/impactante e gere a resposta rigorosamente em formato JSON com as seguintes chaves:
- "selectedArticleId": (o campo "id" exato da matéria escolhida)
- "postContent": (o texto completo do post formatado em texto limpo e organizado com emojis para envio no Telegram, contendo 3 opções de ganchos, legenda completa com raciocínio financeiro/CTA e sugestão de imagem/carrossel).

Regras:
- Use apenas números e dados (taxas, percentuais, valores) que aparecem nas notícias. Não invente números.
- Parágrafos curtos, fáceis de ler na tela do celular.
- Retorne APENAS o JSON válido, sem blocos de Markdown.
`;
}

// 429 e 5xx são temporários: vale tentar de novo. 400/403/404 não adiantam repetir.
const isRetryable = (status) => status === 429 || status >= 500;

export async function generateSocialPost(articles, { models = GEMINI_MODELS, waitMs = 8000 } = {}) {
  const prompt = buildPrompt(articles);
  let lastError = null;

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    for (let attempt = 1; attempt <= 2; attempt++) {
      console.log(`Gerando com ${model} (tentativa ${attempt}/2)...`);
      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.5, responseMimeType: 'application/json' }
          }),
          signal: AbortSignal.timeout(90000)
        });
      } catch (err) {
        lastError = err; // erro de rede/timeout: tenta de novo
        console.warn(`Aviso em ${model}: ${err.message}`);
        if (attempt < 2) await sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        const body = await response.text();
        lastError = new Error(`${model} respondeu ${response.status}: ${body.substring(0, 300)}`);
        console.warn(lastError.message);
        if (!isRetryable(response.status)) break; // vai direto ao próximo modelo
        if (attempt < 2) await sleep(waitMs);
        continue;
      }

      try {
        const data = await response.json();
        const rawText = (data.candidates?.[0]?.content?.parts?.[0]?.text || '')
          .replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
        let parsed = JSON.parse(rawText);
        if (Array.isArray(parsed)) parsed = parsed[0];
        if (!parsed?.postContent) throw new Error('JSON sem "postContent"');

        // Usa os dados reais da notícia, não o que a IA reescreveu
        const article = articles.find(a => a.id === parsed.selectedArticleId) || articles[0];
        if (article.id !== parsed.selectedArticleId) {
          console.warn(`IA devolveu id desconhecido (${parsed.selectedArticleId}); usando "${article.title}".`);
        }
        return { postContent: parsed.postContent, article };
      } catch (err) {
        lastError = err; // resposta malformada: tenta de novo
        console.warn(`Resposta inválida de ${model}: ${err.message}`);
      }
    }
  }

  throw new Error(`Falha na API Gemini após testar todos os modelos: ${lastError?.message}`);
}

// Divide o texto em partes de até `limit` caracteres, quebrando em linhas e sem cortar emojis.
export function splitMessage(text, limit = TELEGRAM_LIMIT) {
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= limit) { current = candidate; continue; }
    if (current) chunks.push(current);
    // Linha sozinha maior que o limite: corta por caracteres (Array.from preserva emojis)
    const chars = Array.from(line);
    current = '';
    while (chars.length) {
      let piece = '';
      while (chars.length && (piece + chars[0]).length <= limit) piece += chars.shift();
      if (chars.length) chunks.push(piece); else current = piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function sendTelegramMessage(text) {
  if (!text) throw new Error('O conteúdo do post veio vazio da IA.');

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  for (const chunk of splitMessage(text)) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: chunk, disable_web_page_preview: true })
    });
    const data = await response.json();
    if (!data.ok) {
      const hint = /chat not found/i.test(data.description || '')
        ? ' Confira o secret TELEGRAM_CHAT_ID e se você já clicou em "Começar" no bot.'
        : '';
      throw new Error(`Erro na API do Telegram (${data.error_code}): ${data.description}.${hint}`);
    }
  }
}

async function markArticleAsUsed(article) {
  await getDb().collection(NOTICIAS_COLLECTION).doc(article.id).set({
    title: article.title,
    link: article.link,
    usedAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

async function run() {
  try {
    checkEnv();

    console.log('1. Buscando matérias inéditas no RSS e checando Firestore...');
    const articles = await fetchUnusedNews();
    if (!articles.length) {
      console.log('Nenhuma notícia inédita encontrada hoje.');
      process.exit(0);
    }

    console.log(`Encontradas ${articles.length} matérias inéditas. Gerando conteúdo com Gemini...`);
    const { postContent, article } = await generateSocialPost(articles);
    console.log(`Notícia escolhida: ${article.title}`);

    console.log('2. Enviando post para o Telegram...');
    await sendTelegramMessage(postContent);

    console.log('3. Salvando notícia no Firestore para evitar repetição...');
    await markArticleAsUsed(article);

    console.log('Rotina concluída com sucesso!');
    process.exit(0);
  } catch (error) {
    console.error('Falha na execução:', error.message);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
