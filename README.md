# Followup Railway

Сервис для генерации фоллоу-апов из транскриптов встреч через Claude API.

## Деплой на Railway

1. Создать новый проект → Deploy from GitHub repo
2. Указать env-переменные:
   - `CLAUDE_API_KEY` — ключ Anthropic
   - `CLAUDE_MODEL` — опционально, по умолчанию `claude-opus-4-5`
3. Railway сам подхватит `npm start`

## Использование

```
POST /process
{
  "transcript": "текст встречи...",
  "webhook_url": "https://hook.eu1.make.com/...",
  "metadata": { "meeting_id": "...", "title": "..." }
}
```

Ответ приходит сразу (`{ status: "processing" }`), результат отправляется на `webhook_url`.

### Payload на webhook (успех)

```json
{
  "status": "completed",
  "followup_md": "Тема А\n\n1. ...\n2. ... → решение\n\nТема Б (@owner)\n\n1. ...",
  "provider": "claude",
  "model": "claude-opus-4-5",
  "timestamp": "2026-05-02T...",
  "metadata": { ... }
}
```

### Payload на webhook (ошибка)

```json
{
  "status": "error",
  "error": "...",
  "error_type": "...",
  "metadata": { ... }
}
```

## Health check

`GET /health` → `{ status, model, timestamp }`
