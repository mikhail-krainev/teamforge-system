# Локальный запуск без домена

Полный стек в режиме `production` на одной машине: те же образы, что пойдут на сервер. Домена, TLS и Caddy нет: сайт на `http://localhost:3000`, `web` проксирует `/api/*` в `api`. Письма уходят в Mailpit. Выкладка на сервер описана в `docs/release.md`.

## Что нужно

- Docker Desktop (Compose v2) и Node.js 24.
- Свободный порт 3000 и порты из `docker/local.env` (34000, 35432, 36432, 36379, 39000, 31025, 38025). Если какой-то занят, поменяйте его в `docker/local.env`.
- Любой браузер, Safari тоже. Флаг `Secure` у cookie входа зависит от схемы `BETTER_AUTH_URL`, а не от `NODE_ENV`: на `http://localhost` cookie без `Secure` (Safari отбрасывает `Secure`-cookie на http). В `production` адрес `http://` разрешён только на loopback, иначе `api` не стартует.

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
- Через GitHub: нужен свой GitHub App. `env-init` пишет заглушки `GITHUB_APP_*`, чтобы `api` стартовал без App; вход с заглушками не работает. Настройки App для локального запуска:
  - Homepage URL `http://localhost:3000`; Callback URL `http://localhost:3000/api/auth/callback/github`; Setup URL `http://localhost:3000/api/v1/github/setup`, Redirect on update включён.
  - Права репозитория: Metadata, Issues, Pull requests, Actions (read). Права аккаунта: Email addresses (read), без него вход падает (`/user/emails`).
  - Webhook: GitHub не достучится до localhost. Без туннеля снять Active (вклад по issue и PR не считается); с туннелем URL `https://<туннель>/api/v1/webhooks/github`, секрет = `GITHUB_WEBHOOK_SECRET`. События: Issues, Pull request, Pull request review, Repository.
  - В `.env`: `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` (PEM одной строкой с `\n`). После правки: `up -d --force-recreate api worker`.
- Ошибка входа через GitHub возвращает на `/sign-in?error=<код>` и показывается над формой.

## Администратор

Флаг администратора выдаётся только из базы. Сначала войдите на сайт под нужным email, потом выполните:

```bash
docker compose --env-file .env --env-file docker/local.env exec postgres \
  psql -U postgres -d teamforge -c "UPDATE auth.\"user\" SET is_admin = true WHERE email_normalized = lower('you@example.com');"
```

Обновите страницу: в профиле появится ссылка "Ручная проверка" (`/admin/fraud`).

## Демо-данные

Чтобы посмотреть сервис «как с живыми людьми», заполните базу демо-данными (стек должен быть запущен):

```bash
node apps/api/scripts/demo-seed/index.mjs
```

То же самое: `pnpm seed:demo`. Скрипт подключается к Postgres стека суперпользователем (`POSTGRES_PASSWORD` из `.env`, порт `POSTGRES_HOST_PORT` из `docker/local.env`; другой адрес можно задать в `DEMO_SEED_DATABASE_URL`). Он отказывается работать, если `NODE_ENV=production`, база или `WEB_URL`/`APP_ORIGIN`/`BETTER_AUTH_URL` не на localhost, или в базе больше 25 настоящих (не демо) аккаунтов.

Повторный запуск удаляет прежние демо-строки и пишет набор заново. Демо-строки узнаются по id с префиксом `dec0de00-` (и всё, что приложение успело к ним добавить: заявки, участия, уведомления) и по номерам GitHub от `9000000000000`. Ваши собственные аккаунты и команды не трогаются. Id демо-людей не меняются между запусками, поэтому вход сохраняется.

Что появится: около 60 человек, 21 проект на всех этапах (формируются, идея, разработка, релиз, голосование за тимлида, завершённые), очередь поиска, предложения и заявки, пробные периоды, вклад из GitHub, зачёты, значки, отзывы и дела антифрода. Воркер сразу начинает с ними работать: например, автодобавление из очереди занимает свободные места, поэтому через минуту картина чуть отличается от только что записанной.

Входите по email на `/sign-in`, ссылка придёт в Mailpit:

| Аккаунт | Кто это | Что посмотреть |
|---|---|---|
| `demo-user@example.test` | Анна Смирнова, тимлид | «Подорожник» (этап разработки, лента, GitHub), заявка в команду, предложение места от «Кофе-брейк» в «Моих предложениях», завершённые проекты, значки, отзывы, окно отзывов по «Прогнозу спроса для кофейни» |
| `demo-newcomer@example.test` | Игорь Ветров, новичок | пробный период 7 дней в «Соседях», заявка в очереди поиска, рекомендации, предложение от «Афиши района» |
| `demo-admin@example.test` | Ольга, администратор | «Ручная проверка» (`/admin/fraud`): три открытых дела, одно «в порядке», одно «нарушение» |

Любой человек из демо-набора тоже может войти: адрес вида `имя-фамилия@example.test` латиницей (например, `nikita-lebedev@example.test` состоит в «Маршруте», где идёт голосование). Список: `SELECT email FROM auth."user" WHERE id::text LIKE 'dec0de00-%';`.

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
