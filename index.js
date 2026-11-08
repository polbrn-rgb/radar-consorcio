import crypto from 'crypto';
import admin from 'firebase-admin';
import Parser from 'rss-parser';

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml; q=0.9, */*; q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
  },
  timeout: 15000
});

// .trim() remove espaços em branco acidentais ao redor das chaves
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const NOTICIAS_COLLECTION = 'radar_noticias_usadas';

const RSS_URLS = [
  'https://news.google.com/rss/search?q=consorcio+OR+%22taxa+selic%22+OR+%22financiamento+imobiliario%22&hl=pt-BR&gl=BR&ceid=BR:pt-419',
  'https://www.bing.com/news/search?q=consorcio+imobiliario+OR+taxa+selic&format=rss&mkt=pt-br'
];

function generateDocId(url) {
  return crypto.createHash('md5').update(url.trim()).digest('hex');
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchFeedWithRetry() {
  for (const url of RSS_URLS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`Tentando ler feed (${attempt}/2): ${url.substring(0, 45)}...`);
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept-Language': 'pt-BR,pt;q=0.9'
          }
        });

        if (!response.ok) {
          throw new Error(`HTTP Status ${response.status}`);
        }

        const xml = await response.text();
        return await parser.parseString(xml);
      } catch (err) {
        console.warn(`Aviso na tentativa ${attempt}: ${err.message}`);
        await sleep(3000);
      }
    }
  }
  throw new Error('Todas as fontes de RSS retornaram erro temporário.');
}

async function fetchUnusedNews() {
  const feed = await fetchFeedWithRetry();
  const candidates = feed.items.slice(0, 15);
  const unusedArticles = [];

  for (const item of candidates) {
    const link = item.link || item.guid || '';
    if (!link) continue;

    const uniqueKey = item.title ? `${item.title}-${link.substring(0, 40)}` : link;
    const docId = generateDocId(uniqueKey);
    const docRef = db.collection(NOTICIAS_COLLECTION).doc(docId);
    const docSnap = await docRef.get();

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
- "postContent": (o texto completo do post formatado em texto limpo e organizado com emojis para envio no Telegram, contendo 3 opções de ganchos, legenda completa com raciocínio financeiro/CTA e sugestão de imagem/carrossel).

Retorne APENAS o JSON válido sem formatação Markdown externa (sem blocos \`\`\`json).
`;

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
  let rawText = data.candidates[0].content.parts[0].text;
  rawText = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  
  const parsed = JSON.parse(rawText);
  if (Array.isArray(parsed)) return parsed[0];
  return parsed;
}

async function markArticleAsUsed(articleId, title, link) {
  await db.collection(NOTICIAS_COLLECTION).doc(articleId).set({
    title: title,
    link: link,
    usedAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

async function sendTelegramMessage(text) {
  if (!text) {
    throw new Error('O conteúdo do post veio vazio da IA.');
  }

  let chatId = TELEGRAM_CHAT_ID;

  // Função interna para disparar um trecho de mensagem
  const sendChunk = async (targetChatId, chunk) => {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: targetChatId,
        text: chunk,
        disable_web_page_preview: true
      })
    });
    return await response.json();
  };

  // Se o ID salvo falhar, consulta as últimas mensagens recebidas pelo bot para pegar o ID real
  let firstChunk = text.substring(0, 4000);
  let firstAttempt = await sendChunk(chatId, firstChunk);

  if (!firstAttempt.ok) {
    console.log('ID configurado falhou. Buscando Chat ID automaticamente nas mensagens recebidas pelo bot...');
    const updatesUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`;
    const updatesRes = await fetch(updatesUrl);
    const updatesData = await updatesRes.json();

    if (updatesData.ok && updatesData.result && updatesData.result.length > 0) {
      for (let i = updatesData.result.length - 1; i >= 0; i--) {
        const item = updatesData.result[i];
        const foundId = item.message?.chat?.id || item.my_chat_member?.chat?.id || item.channel_post?.chat?.id;
        if (foundId) {
          chatId = foundId.toString();
          break;
        }
      }
      console.log(`Chat ID descoberto automaticamente: ${chatId} (Atualize sua secret TELEGRAM_CHAT_ID depois com esse número!)`);
      
      // Reenvia o primeiro bloco usando o ID descoberto
      firstAttempt = await sendChunk(chatId, firstChunk);
      if (!firstAttempt.ok) {
        throw new Error(`Erro na API do Telegram mesmo com ID automático (${chatId}): ${JSON.stringify(firstAttempt)}`);
      }
    } else {
      throw new Error(
        `Erro no Telegram: ${JSON.stringify(firstAttempt)}. ` +
        `Nenhuma mensagem encontrada no bot. Abra o seu bot no Telegram, clique em Começar (Start) e envie "Oi" agora mesmo antes de rodar novamente.`
      );
    }
  }

  // Se o texto for maior que 4000 caracteres, envia o restante das partes
  const maxChunkSize = 4000;
  for (let i = maxChunkSize; i < text.length; i += maxChunkSize) {
    const chunk = text.substring(i, i + maxChunkSize);
    const data = await sendChunk(chatId, chunk);

    if (!data.ok) {
      throw new Error(`Erro na API do Telegram na parte seguinte: ${JSON.stringify(data)}`);
    }
  }
}

async function run() {
  try {
    console.log('1. Buscando matérias inéditas no RSS e checando Firestore...');
    const articles = await fetchUnusedNews();

    if (!articles.length) {
      console.log('Nenhuma notícia inédita encontrada hoje.');
      process.exit(0);
    }

    console.log(`Encontradas ${articles.length} matérias inéditas. Gerando conteúdo com Gemini...`);
    const result = await generateSocialPost(articles);

    console.log('--- PRÉVIA DO POST GERADO ---');
    console.log(result.postContent);
    console.log('-----------------------------');

    console.log('2. Enviando post para o Telegram...');
    await sendTelegramMessage(result.postContent);

    console.log('3. Salvando notícia no Firestore para evitar repetição...');
    await markArticleAsUsed(result.selectedArticleId, result.selectedTitle, result.selectedLink);

    console.log('Rotina concluída com sucesso!');
    process.exit(0);
  } catch (error) {
    console.error('Falha na execução:', error);
    process.exit(1);
  }
}

run();
