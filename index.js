import crypto from 'crypto';
import admin from 'firebase-admin';
import Parser from 'rss-parser';

const parser = new Parser();

// Variáveis de ambiente injetadas pelo GitHub Actions
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;

// Inicializa o Firebase Admin
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const NOTICIAS_COLLECTION = 'radar_noticias_usadas';

// Busca focada em consórcio, financiamento e taxa selic
const RSS_URL = 'https://news.google.com/rss/search?q=consorcio+OR+%22taxa+selic%22+OR+%22financiamento+imobiliario%22&hl=pt-BR&gl=BR&ceid=BR:pt-419';

function generateDocId(url) {
  return crypto.createHash('md5').update(url.trim()).digest('hex');
}

async function fetchUnusedNews() {
  const feed = await parser.parseURL(RSS_URL);
  const candidates = feed.items.slice(0, 15);
  const unusedArticles = [];

  for (const item of candidates) {
    const link = item.link || item.guid || '';
    if (!link) continue;

    const docId = generateDocId(link);
    const docRef = db.collection(NOTICIAS_COLLECTION).doc(docId);
    const docSnap = await docRef.get();

    // Se a notícia não existe no banco, adiciona aos candidatos
    if (!docSnap.exists) {
      unusedArticles.push({
        id: docId,
        title: item.title,
        link: link,
        pubDate: item.pubDate,
        snippet: item.contentSnippet || item.content || ''
      });
    }

    if (unusedArticles.length === 4) break;
  }

  return unusedArticles;
}

async function generateSocialPost(articles) {
  const prompt = `
Você é um estrategista de conteúdo e consultor especialista em consórcios e planejamento financeiro imobiliário e veicular.

Analise as notícias recentes e inéditas abaixo:
${JSON.stringify(articles, null, 2)}

Escolha a notícia mais relevante/impactante e gere a resposta rigorosamente em formato JSON com as seguintes chaves:
- "selectedArticleId": (o campo "id" exato da matéria escolhida)
- "selectedTitle": (título da matéria escolhida)
- "selectedLink": (link da matéria escolhida)
- "postContent": (o texto completo do post formatado em Markdown para envio no Telegram, contendo ganchos, legenda completa com raciocínio financeiro/CTA e sugestão de imagem/carrossel).

Retorne APENAS o JSON válido sem formatação Markdown externa (sem blocos \`\`\`json).
`;

  // VERSÃO DA API ATUALIZADA AQUI PARA gemini-3.8-flash
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.5,
        responseMimeType: 'application/json'
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Erro na API Gemini (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const rawText = data.candidates[0].content.parts[0].text;
  return JSON.parse(rawText);
}

async function markArticleAsUsed(articleId, title, link) {
  await db.collection(NOTICIAS_COLLECTION).doc(articleId).set({
    title: title,
    link: link,
    usedAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const maxChunkSize = 4000;

  for (let i = 0; i < text.length; i += maxChunkSize) {
    const chunk = text.substring(i, i + maxChunkSize);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: chunk,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      })
    });

    if (!response.ok) {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: chunk,
          disable_web_page_preview: true
        })
      });
    }
  }
}

async function run() {
  try {
    console.log('1. Buscando matérias inéditas no RSS e checando Firestore...');
    const articles = await fetchUnusedNews();

    if (!articles.length) {
      console.log('Nenhuma notícia inédita encontrada hoje.');
      return;
    }

    console.log(`Encontradas ${articles.length} matérias inéditas. Gerando conteúdo com Gemini...`);
    const result = await generateSocialPost(articles);

    console.log('2. Enviando post para o Telegram...');
    await sendTelegramMessage(result.postContent);

    console.log('3. Salvando notícia no Firestore para evitar repetição...');
    await markArticleAsUsed(result.selectedArticleId, result.selectedTitle, result.selectedLink);

    console.log('Rotina concluída com sucesso!');
  } catch (error) {
    console.error('Falha na execução:', error);
    process.exit(1);
  }
}

run();
