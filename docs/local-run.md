# Локальный запуск без домена

Полный стек в режиме `production` на одной машине: те же образы, что пойдут на сервер. Домена, TLS и Caddy нет: сайт на `http://localhost:3000`, `web` проксирует `/api/*` в `api`. Письма уходят в Mailpit. Выкладка на сервер описана в `docs/release.md`.

## Что нужно

- Docker Desktop (Compose v2) и Node.js 24.
- Свободный порт 3000 и порты из `docker/local.env` (34000, 35432, 36432, 36379, 39000, 31025, 38025). Если какой-то занят, поменяйте его в `docker/local.env`.
- Браузер Chrome или Firefox. В режиме `production` cookie входа помечены `Secure`. Chrome и Firefox принимают такие cookie на `http://localhost`, Safari их не сохраняет.

## Запуск

Команды выполняются из корня репозитория.

1. Создайте `.env` (один раз). Скрипт генерирует пароли и ключи и не перезаписывает существующий файл:

   ```bash
   node scripts/env-init.mjs
   ```

2. Соберите образы и поднимите стек. Первая сборка идёт 5-10 минут:

   ```bash
   docker compose --env-file .env --env-file docker/local.env up --build -d --wait
   ```

   Контейнер `migrate` применяет миграции, загружает и публикует сценарии `web_service` и `ml_product`, потом завершается.

3. Откройте:

   | Что | Адрес |
   |---|---|
   | Сайт | http://localhost:3000 |
   | Почта (Mailpit) | http://localhost:38025 |
   | Состояние api | http://localhost:3000/api/health/ready |

## Вход

- По email: введите адрес на странице `/sign-in`, письмо со ссылкой придёт в Mailpit. Подойдёт любой адрес, наружу письма не уходят. При первом входе сайт попросит принять согласие на обработку ПД (текст пока черновик).
- Через GitHub локально не работает. `env-init` пишет заглушки `GITHUB_APP_*`, чтобы `api` стартовал без App. Вход, привязка репозитория и вебхуки требуют реального GitHub App и публичного адреса (`docs/release.md`, раздел 1.4).

## Администратор

Флаг администратора выдаётся только из базы. Сначала войдите на сайт под нужным email, потом выполните:

```bash
docker compose --env-file .env --env-file docker/local.env exec postgres \
  psql -U postgres -d teamforge -c "UPDATE auth.\"user\" SET is_admin = true WHERE email_normalized = lower('you@example.com');"
```

Обновите страницу: в профиле появится ссылка "Ручная проверка" (`/admin/fraud`).

## Остановка и сброс

Остановить, данные сохранятся:

```bash
docker compose --env-file .env --env-file docker/local.env down
```

Удалить стек вместе с данными (база, файлы, очереди):

```bash
docker compose --env-file .env --env-file docker/local.env down -v
```

После изменений в коде повторите шаг 2: `--build` пересоберёт образы.

## Если не запускается

- `run "pnpm run env:init" first`: нет `.env` или в нём пустые секреты. Выполните шаг 1.
- `port is already allocated`: порт занят другим стеком. Поменяйте его в `docker/local.env`, а для `S3_HOST_PORT` поменяйте и `FILES_PUBLIC_ORIGIN`.
- `api` не проходит проверку состояния: `docker compose --env-file .env --env-file docker/local.env logs api migrate`.
- Старый `.env` без `GITHUB_APP_*`: удалите его и выполните шаг 1 заново. Новые секреты не подойдут к старым томам, поэтому сначала `down -v`.
