const express = require('express');

const app = express();
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 3000;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const MAX_TOKENS = parseInt(process.env.CLAUDE_MAX_TOKENS || '16000', 10);
const REQUEST_TIMEOUT_MS = 180_000;
const DEBUG_RAW = process.env.DEBUG_RAW === 'true';

if (!CLAUDE_API_KEY) {
  console.error('FATAL: CLAUDE_API_KEY не задан');
  process.exit(1);
}

// ============================================================
// PROMPT
// ============================================================

const SYSTEM_PROMPT = `Ты помогаешь готовить фоллоу-апы по итогам встреч на русском языке.

Стиль:
— Группируй по темам. Заголовок темы — отдельной строкой, без markdown-разметки (#, **). Если у темы есть основной владелец — указывай в скобках: "Тема (@owner)" или "Тема (@owner1, @owner2)".
— Под каждым заголовком — нумерованный список основных пунктов (1., 2., 3.).
— Подпункты внутри пункта — через "   * " с отступом в три пробела.
— Решения, договорённости и следующие шаги встраивай в поток текста через стрелку " → ". Несколько решений по одной теме — несколько стрелок подряд внутри одного пункта.
— Имена участников упоминай через @ (например, @Ваня, @Серёга).
— Не пиши вступлений и заключений. Не используй слова "Решения:", "Action items:", "Итоги:". Структура темы сама несёт эту нагрузку.
— Сохраняй конкретику: цифры, проценты, сроки, имена. Не обобщай.
— Никаких markdown-заголовков (##), горизонтальных линий, болдов.
— Если в транскрипте чего-то нет — не додумывай.

Следующие шаги:
— Последняя тема — "Следующие шаги (@владельцы)". Собери в неё все шаги со встречи.
— Формат пункта: «@Имя делает X [срок, если назван] → зачем это / что дальше».
— Условные договорённости («если случится X — @Имя делает Y») — тоже сюда.
— Если владелец или срок не прозвучали — так и пиши («владелец не назван»), не додумывай.
— Открытые вопросы без решения — последними пунктами: «Вопрос → решения на встрече не принято».
— Если на встрече не было ни шагов, ни открытых вопросов — эту тему не добавляй.

Пример формата:

Прогнозирование заказов (power prediction)

1. До конца недели ждём результаты ресерча: какова точность предсказания и на чём нужно фокусироваться — большинство бинов заполнены нулями, поэтому открытый вопрос: пики по времени, топовые вендоры или локации
2. Порог точности — 85%; ниже — в продукт не идём, пока не выйдем на 100k заказов → Если точность недостаточная — в четверг возвращаемся к части CMA → Дополнительно прогнать симуляцию диспетчера в моменты низкой утилизации: если апгрейд диспетчера сам по себе даёт рост утилизации, приоритет фичи откладываем — сначала «улучшаем ёлку» → Даже в худшем сценарии задача предсказания заказов имеет прикладную ценность и пригодится в другом виде

Дизайн плашки потенциального заказа (@Ваня, @Макс)

1. Макс принёс первые драфты в старом дизайне: на основном оффере подсвечиваем «потенциальный заказ» + текст-успокоитель про выплату по тарифу за путь; по тапу — экран с подробностями
2. Три развилки во flow:
   * Удачный кейс: приходит пуш о подтверждении заказа → плашка превращается в стандартную, появляется кнопка звонка в ресторан
   * Дошёл, заказа нет → жмёт «Я на месте» → экран с подсветкой компенсации за дорогу → стандартное ожидание
   * Найден заказ из другого вендора → завершение текущего flow с пояснением, что путь оплачен → Тексты в драфтах не смотрим, финалим по мере разработки

Размен скорости на деньги (@Серёга, по материалу @Хатяш)

1. Индустриальный бенчмарк (Яндекс): улучшение курьерской скорости на 3 мин ↔ ухудшение клиентской скорости ~10% (≈3 мин 6 сек) — считается нормальным разменом, основной драйвер — рост батчинга → В 2026 в оптимизацию не идём — цель года: улучшение сервиса при сохранении экономики, не размен одного на другое → Серёга продублирует расчёты в чат, тему продолжаем крутить

Верни только текст фоллоу-апа в этом формате, без вступительных фраз и пояснений.`;

// ============================================================
// ENDPOINTS
// ============================================================

app.post('/process', async (req, res) => {
  const { transcript, webhook_url, metadata = {} } = req.body;

  if (!transcript || !webhook_url) {
    return res.status(400).json({
      error: 'Нужны поля transcript и webhook_url'
    });
  }

  if (typeof transcript !== 'string') {
    return res.status(400).json({
      error: `transcript должен быть строкой, пришёл ${typeof transcript}`
    });
  }

  if (!isWebhookUrlSafe(webhook_url)) {
    return res.status(400).json({
      error: 'webhook_url должен быть https и публичным (не localhost / приватная сеть)'
    });
  }

  // Сразу отвечаем Make, чтобы не упереться в его таймаут
  res.json({ status: 'processing' });

  processTranscript(transcript, webhook_url, metadata).catch(err => {
    console.error('[FATAL] Необработанная ошибка:', err);
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    timestamp: new Date().toISOString()
  });
});

// ============================================================
// CORE
// ============================================================

async function processTranscript(transcript, webhook_url, metadata) {
  const startedAt = Date.now();
  console.log(`=== START === transcript_len=${transcript.length} meta=${JSON.stringify(metadata)}`);

  try {
    const { text: followup, stop_reason, usage } = await callClaude(transcript);
    console.log(
      `[OK] followup_len=${followup.length} stop_reason=${stop_reason} ` +
      `usage=${JSON.stringify(usage)} elapsed_ms=${Date.now() - startedAt}`
    );

    await sendWebhook(webhook_url, {
      status: 'completed',
      followup_md: followup,
      truncated: stop_reason === 'max_tokens',
      provider: 'claude',
      model: CLAUDE_MODEL,
      timestamp: new Date().toISOString(),
      metadata
    });

    console.log('=== DONE ===');
  } catch (error) {
    console.error('[ERROR]', error.name, error.message);

    await sendWebhook(webhook_url, {
      status: 'error',
      error: error.message,
      error_type: error.name,
      provider: 'claude',
      model: CLAUDE_MODEL,
      timestamp: new Date().toISOString(),
      metadata
    }).catch(e => console.error('[ERROR] Не удалось отправить ошибку на webhook:', e.message));
  }
}

// ============================================================
// CLAUDE CALL with retry
// ============================================================

async function callClaude(transcript, attempt = 1) {
  const MAX_ATTEMPTS = 3;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Транскрипт встречи:\n\n${transcript}`
          }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      const retryable = response.status === 429 || response.status >= 500;

      if (retryable && attempt < MAX_ATTEMPTS) {
        const delay = 1000 * Math.pow(2, attempt - 1);
        console.warn(`[Claude] ${response.status}, retry ${attempt}/${MAX_ATTEMPTS - 1} через ${delay}ms`);
        await sleep(delay);
        return callClaude(transcript, attempt + 1);
      }

      throw new Error(`Claude API ${response.status}: ${errorText.substring(0, 500)}`);
    }

    const result = await response.json();

    if (DEBUG_RAW) {
      console.log('[Claude] raw response:', JSON.stringify(result).substring(0, 2000));
    }

    const blocks = Array.isArray(result?.content) ? result.content : [];
    const types = blocks.map(b => b.type).join(',') || 'none';

    // Собираем текст из всех текстовых блоков, а не только из первого:
    // первым может прийти блок рассуждений (thinking) без поля text.
    const text = blocks
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n')
      .trim();

    console.log(
      `[Claude] stop_reason=${result?.stop_reason} blocks=[${types}] usage=${JSON.stringify(result?.usage)}`
    );

    if (!text) {
      throw new Error(
        `Claude вернул пустой content (stop_reason=${result?.stop_reason}, blocks=[${types}])`
      );
    }

    if (result?.stop_reason === 'max_tokens') {
      console.warn(`[Claude] ответ обрезан по max_tokens=${MAX_TOKENS}`);
    }

    return { text, stop_reason: result?.stop_reason, usage: result?.usage };
  } catch (err) {
    if (err.name === 'AbortError') {
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`[Claude] timeout, retry ${attempt}/${MAX_ATTEMPTS - 1}`);
        return callClaude(transcript, attempt + 1);
      }
      throw new Error(`Claude timeout после ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// HELPERS
// ============================================================

async function sendWebhook(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Webhook] ${response.status}: ${errorText.substring(0, 200)}`);
  } else {
    console.log(`[Webhook] OK ${response.status}`);
  }
}

function isWebhookUrlSafe(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;

    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return false;

    // блокируем приватные диапазоны и метаданные облака по hostname-IP
    if (/^10\./.test(host)) return false;
    if (/^192\.168\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (/^169\.254\./.test(host)) return false;

    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

app.listen(PORT, () => {
  console.log(`Followup server running on port ${PORT}`);
  console.log(`Model: ${CLAUDE_MODEL}, max_tokens: ${MAX_TOKENS}`);
});
