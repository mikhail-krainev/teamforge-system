# Teamforge: план реализации

Фаза 4. Источники: `docs/orchestrator.md` (фазы 5-6, правила агентов), `docs/spec.md` (FR, CC-1..13, константы), `docs/architecture.md` (модули, схема БД, порядок блокировок, раздел 12 о конкурентном доступе, раздел 17 о рисках), `docs/api/openapi.yaml` (114 операций, у каждой `x-fr` и `x-authz`), `docs/adr/0001..0018`, `docs/playbooks.md` (раздел 2 о формате, YAML в 3.2 и 4.3).

Каждый срез даёт работающую функцию от интерфейса до базы. Порядок фиксирован: каркас, авторизация и профиль, команды и роли, подбор и очередь, маршрут проекта, рабочее пространство с GitHub, награды. Все 114 операций контракта распределены по срезам (раздел "Покрытие операций").

Обозначения: B = backend (`apps/api`), F = frontend (`apps/web`), S = `packages/shared`, T = автор тестов, I = инфраструктура (корень, `docker`, `.github`). Размер: XS, S, M (L и больше не используются, такие задачи разбиты).

---

## Окружение

Сейчас на машине разработки нет ничего из нужного (подтверждено в `docs/status.md`). До начала среза 1 нужны:

| Что | Версия | Зачем | Проверка |
|---|---|---|---|
| Node.js | 22 LTS (в `.nvmrc` и `engines`) | сборка и запуск api (ESM), web, тесты | `node -v` -> v22.x |
| pnpm | через corepack, версия фиксируется в `packageManager` корневого `package.json` | менеджер пакетов монорепо | `corepack enable; pnpm -v` |
| Docker Desktop (WSL2 backend) с Compose v2 | актуальный | PostgreSQL, PgBouncer, Redis, MinIO, контейнеры приложения, тестовая БД | `docker compose version`, `docker run hello-world` |
| Git | уже есть | | |
| Go-образ `ghcr.io/oasdiff/oasdiff` | запускается через Docker в CI и локально | проверка обратной совместимости контракта | `docker run --rm ghcr.io/oasdiff/oasdiff --help` |

Правила:

- Установку делает пользователь (оркестратор не ставит системное ПО и не меняет настройки системы). Если после запроса Node.js, pnpm или Docker не появились, срез 1 останавливается на задаче S1-01; подготовку документов и тестов (задачи T) можно вести без них, но запускать их нельзя.
- Docker Desktop на Windows: включить WSL2, выделить не менее 6 ГБ памяти (PostgreSQL + Redis x2 + MinIO + 4 приложения + тесты). Проекты хранить в файловой системе WSL или обычной NTFS без блокировки антивирусом каталога `node_modules`.
- Окончания строк: `.gitattributes` с `* text=auto eol=lf` (S1-01), иначе скрипты в контейнерах ломаются.
- Секреты только в `.env` (в `.gitignore`), шаблон `.env.example` без значений-секретов; для локального запуска генерирует недостающие значения скрипт `pnpm run env:init` (S1-08), который пишет случайные значения в `.env`.
- Первая проверка среды перед срезом 1: `node -v && pnpm -v && docker compose version`. Результат пишется в отчёт сессии.

---

## Общие соглашения для всех срезов

### Структура модуля NestJS

```
apps/api/src/modules/<m>/
  public.ts                 единственная поверхность импорта: интерфейс фасада XxxApi, DTO, типы событий, токены портов
  <m>.module.ts             NestJS-модуль, провайдеры фасада
  internal/
    controllers/            HTTP-контроллеры; каждый обработчик помечен @Operation('<operationId>') и @Authz()
    services/               сценарии (открывают транзакцию на уровне сценария через TransactionHost)
    repositories/           единственное место SQL/Drizzle; метод принимает всю цепочку идентификаторов (x-authz chain)
    schema/                 Drizzle pgSchema('<m>'): таблицы и индексы (имена уникальных индексов значимы)
    events/                 обработчики outbox-событий (через inbox для идемпотентности)
    jobs/                   процессоры BullMQ (запускаются в процессе worker)
    domain/                 чистые функции и конечные автоматы (без I/O), 95% покрытия
  test/                     тесты модуля: *.test.ts (интеграционные), concurrency/cc-NN-*.test.ts, idor.test.ts
```

Правила:

1. Другие модули импортируют только `modules/<m>/public.ts`. Внешние ключи только внутри схемы модуля, между модулями идентификаторы без FK (ADR-0002). Границы проверяют `eslint-plugin-boundaries` и `dependency-cruiser --validate` (создаются в S1-11) в CI.
2. Контроллер не содержит бизнес-логики: валидация (Ajv по `openapi.json` через `ValidationGuard`), `@Authz` (по `x-authz`), вызов сервиса, ответ. Типы запросов и ответов только из `packages/shared` (`Body<'op'>`, `Ok<'op'>`).
3. Изменяющий сценарий: `IdempotencyInterceptor` -> транзакция (первым оператором `SET LOCAL lock_timeout='5s'`, `SET LOCAL statement_timeout='10s'`) -> блокировки строго в глобальном порядке из architecture 12.1 -> запись -> `UPDATE idempotency_key ... completed` последним оператором -> запись события в outbox в той же транзакции.
4. Проверка "свободно ли" без блокировки или уникального индекса запрещена. Ошибка `23505` отображается в код по имени индекса (раздел 13.1 architecture). Время только через `Clock`, не `now()` в SQL.
5. Тяжёлое (разбор резюме, подбор, GitHub, письма, проверки ссылок) только в очередях BullMQ; `jobId` детерминированный (правила в architecture 13.12: три сегмента через `_`, без `:`).
6. Ошибки: `DomainError(code, status, data)` -> problem+json. Новый код ошибки добавляется только вместе с контрактом (через оркестратора).
7. Функции до 50 строк, файлы до 800, вложенность до 4, без `console.*`, логи через pino. Код и комментарии на английском.
8. Frontend: страницы в `apps/web/src/app/...`, компоненты в `apps/web/src/features/<m>/`, строки только из словарей `apps/web/src/i18n/ru/<feature>.json` (один файл на каталог `features/<feature>`, реестр словарей подхватывает файлы по маске, общего файла словарей нет; линтер запрещает литералы в JSX), вызовы API только через типизированный клиент `openapi-fetch` + TanStack Query; ключ `Idempotency-Key` создаётся на каждое нажатие пользователя и переиспользуется только при повторе после сетевой ошибки, тайм-аута, 429, 503, 5xx.

### Правила тестов

- Порядок среза (оркестратор, фаза 5): (1) задача T пишет по контракту и критериям приёмки API-тесты, тесты конкурентного доступа и сквозной сценарий Playwright, они падают; (2) B и F работают параллельно в своих каталогах; (3) T дополняет тесты по найденным граничным случаям. Тесты, которые не падали до реализации, не засчитываются как написанные "до".
- Название теста содержит идентификатор FR (`FR-TEAM-04: ...`) или CC (`CC-1: ...`); скрипт `pnpm run trace:fr` (S1-10) сверяет, что каждый FR среза упомянут хотя бы в одном тесте.
- Виды тестов:
  - Модульные (`domain/`): Vitest без I/O, быстрые.
  - API-тесты по контракту: `app.inject` (Fastify) на реальной PostgreSQL через PgBouncer и реальном Redis; каждый ответ проверяется схемой операции из `openapi.json` (хелпер `expectMatchesContract(operationId, response)`); негативные коды из `x-fr`/контракта обязательны (400, 401, 403, 404, 409, 422, 429 где применимо).
  - Конкурентный доступ: по шаблону architecture 12.5 (`barrier(N)` + `Promise.allSettled`, N не менее 20, если в таблице CC не указано иное; пул БД теста не меньше N; проверка кодов, SQL-инвариантов в БД и отсутствия `40P01` в журнале; запуск `--repeat 5` в CI). Для каждого CC парный тест "повтор того же запроса с тем же `Idempotency-Key`" (ответ сохранён, заголовок `Idempotent-Replayed: true`, второго эффекта нет). Для CC-3, CC-4 (срок), CC-6 процессоры задач вызываются напрямую (`processor.process(job)`).
  - IDOR: хелпер `idorMatrix(operationId)` строится из `x-authz` операции (S1-10): для каждой операции со вложенными идентификаторами проверяется (а) пользователь не из команды получает 404 (не 403) на чужой ресурс, (б) подмена вложенного идентификатора ресурсом другой команды (`itemId` от чужой `teamId`) даёт 404, (в) роль ниже требуемой даёт 403 с кодом, (г) администратор получает 404 на чужие резюме и отзывы. Тесты лежат в `test/idor.test.ts` модуля.
  - Сквозные (Playwright, `apps/web/e2e/<срез>.spec.ts`): в браузере против поднятого `docker compose` (отдельный проект `-p e2e`), с проверкой axe (WCAG AA) на каждой странице среза, на языке `ru`.
- Покрытие строк модулей не ниже 80%; правила наград, голосования, подбора, антифрода и конечные автоматы 95% (spec 5.9, C-65). Порог проверяется в CI.
- Часы: `FakeClock` подменяет `Clock` (таймеры голосования, испытательный срок, охлаждение, 24-часовые проверки). Тесты не используют `setTimeout` для ожиданий: ожидание условия через `waitFor` с лимитом.
- Падение теста сообщается с выводом. Тест не удаляется и не помечается `skip` ради зелёной сборки; отключённый тест допустим только с записью в `docs/backlog.md`.

### Тестовая БД

- `docker-compose.test.yml` (проект `-p tf-test`): PostgreSQL 16 + PgBouncer (transaction mode) + Redis + redis-resume + MinIO, порты на `127.0.0.1` с отдельными номерами (5433/6433/6380/9100), чтобы не конфликтовать с dev-стеком. Команды: `pnpm test:env:up`, `pnpm test:env:down`.
- Vitest `globalSetup` (в `apps/api/test/setup/`) один раз прогоняет миграции Drizzle через `DATABASE_DIRECT_URL` (в обход PgBouncer, Р-18), создаёт шаблонную базу `tf_template`; каждый тестовый файл получает свою базу `CREATE DATABASE tf_<worker> TEMPLATE tf_template` (быстро, изоляция файлов). Внутри файла чистка таблиц `TRUNCATE ... CASCADE` по списку схем перед каждым тестом или транзакционный откат там, где тест не проверяет конкурентность; конкурентные тесты всегда работают на закоммиченных данных.
- Приложение в тесте подключается к БД через PgBouncer (`DATABASE_URL`, `prepare=false`), миграции и фикстуры через прямое соединение.
- В CI те же сервисы поднимаются как `services:` GitHub Actions или командой `docker compose -p tf-test up -d --wait`.

### Фикстуры

- `apps/api/test/fixtures/`: билдеры с фабриками на `faker` с фиксированным seed: `user()`, `profile()`, `team({ status, members, seats })`, `teamWithOpenSeat({ candidates })`, `offer()`, `invitation()`, `leaderVote({ phase })`, `searchApplication()`, `project({ stage })`, `completedProject({ members })`, `repoLink()`, `creditRun()`.
- Билдеры вставляют строки напрямую в БД (быстро) и не вызывают HTTP; но расчётные поля (`member_count`, `seat_count`, `deficit_*`) строят через публичные фасады, чтобы инварианты совпадали с боевым кодом.
- `api.as(user)` создаёт сессию Better Auth напрямую в Redis (минуя вход) и возвращает клиента с cookie, `Idempotency-Key` по умолчанию случайный, `{ idempotencyKey }` задаёт явно.
- Сиды справочников (роли, теги стека, типы продукта, значки) загружаются один раз в `tf_template`. Сценарии маршрута в тестах - маленькие YAML-фикстуры (`test/fixtures/playbooks/mini.yaml`, 3 этапа) и отдельный тест на полные `web_service` и `ml_product`.
- Внешние сервисы заменяются локальными двойниками: SMTP - Mailpit (в compose), GitHub - `apps/api/test/fakes/github-server.ts` (HTTP-сервер на Fastify, эмулирует App, установки, REST и вебхуки с подписью), внешние URL для проверок ссылок - локальный сервер за разрешённым в тесте адресом (SSRF-клиент получает тестовый список разрешений только при `NODE_ENV=test`).

### Генерация типов

- Источник - `docs/api/openapi.yaml`. Команда `pnpm --filter shared run generate`: `redocly lint` -> `redocly bundle` в `packages/shared/openapi.json` -> `openapi-typescript` в `packages/shared/src/generated/api.ts`. Сгенерированные файлы коммитятся.
- CI: запуск генерации, затем `git diff --exit-code packages/shared`; `oasdiff breaking` против `main`; скрипт `scripts/check-contract.mjs` проверяет `operationId` (уникальны), `x-fr`, `x-authz` (допустимый `actor`, все идентификаторы пути в `chain` кроме публичных), `Idempotency-Key` у изменяющих операций кроме перечисленных исключений (architecture 14).
- Контракт после фазы 3 меняется только через оркестратора вместе с `docs/architecture.md`. Агент, которому нужно изменение контракта, останавливается и сообщает.
- Типы WebSocket-сообщений пишутся вручную в `packages/shared/src/realtime.ts` (в OpenAPI их нет).

### Правила коммитов и веток

- Ветка среза `feat/<срез>` (например `feat/slice-2-auth`) от свежей `main`; документы `docs/<фаза>`. Одна сессия - один срез - одна ветка.
- Субагенты коммитов не делают. Коммиты делает оркестратор после приёмки отчёта субагента, небольшими логическими шагами (одна задача или связная пара "тест + реализация").
- Формат `type: описание` (feat, fix, refactor, docs, test, chore, perf, ci); описание на английском в повелительном наклонении, до 72 символов. Пример: `feat: add seat offer acceptance with row locks`.
- Тесты из шага 1 коммитятся отдельно (`test: ...`) до реализации.
- Запрещено: коммиты и отправка в `main`, принудительная отправка, слияние запросов субагентами (слияние делает оркестратор в рамках автономного режима из `docs/status.md`), секреты, `.env`, токены GitHub пользователей, загруженные резюме.
- В конце сессии: отправка ветки, запрос на слияние с описанием и планом проверки.

### Распределение каталогов (чтобы два агента не правили один файл)

| Роль | Каталоги |
|---|---|
| T | `apps/api/**/test/**`, `apps/web/e2e/**`, `apps/api/test/fixtures/**` (общие фикстуры правит только T; B и F просят добавить) |
| B | `apps/api/src/**`, `apps/api/drizzle/**`, `apps/api/seeds/**` |
| F | `apps/web/src/**`, `apps/web/messages` / `src/i18n/**` |
| S | `packages/shared/**` (только оркестратор или задача S1-02; после генерации правка вручную только `realtime.ts`) |
| I | корень, `docker/**`, `.github/**`, `scripts/**` |

Миграции Drizzle в каждой задаче создаёт один B-агент; два B-агента в одном срезе не создают миграции одновременно (иначе конфликт нумерации): миграции среза идут в задаче "схема" до задач сервисов.

### Общие файлы (правит один агент за раз)

Параллельные агенты работают в одном рабочем каталоге, поэтому реестры и общие файлы не правятся из двух задач одновременно. Задача, которой нужна строка в таком файле, не правит его сама, а указывает строку в отчёте; оркестратор вносит её при приёмке. Исключение: файл, закреплённый за задачей в поле "Файлы".

| Файл | Правит |
|---|---|
| `apps/api/src/app.module.ts`, `modules/<m>/<m>.module.ts`, `modules/<m>/public.ts` | задача "схема" модуля (S1-11, S3-02, S4-02, S5-02, S6-03, S7-02, S2-03/S2-08) создаёт их целиком; дальше строки регистрации вносит оркестратор; привязка портов в `app.module.ts` - одна задача среза (S4-03, S5-04) |
| `apps/api/drizzle/**` (миграции, `meta/_journal.json`) | только задача "схема" среза или модуля (см. список ниже) |
| `eslint.config.js`, `.dependency-cruiser.cjs`, `.env.example`, `docker-compose.yml` | S1-01/S1-08/S1-11; в срезах 2 и 5 `docker-compose.yml` правят S2-10 и S5-09 (последовательно, не параллельно с другими I-задачами) |
| `packages/shared/src/realtime.ts` | создаётся в S1-02; новые события добавляет оркестратор до запуска F-задач |
| `apps/web/src/components/shell/**` (оболочка, навигация) | S1-09 создаёт; пункты навигации задачи F объявляют в `features/<feature>/nav.ts`, оболочка собирает их по маске |
| `apps/api/src/modules/rewards/internal/fraud/rules/index.ts` (реестр AF) | один агент, последним в S7-03 |

Задачи "схема" (единственные создают миграции в своём срезе): S1-04 (`platform`, пустые схемы), S2-03 (`auth`), S2-08 (все таблицы `profiles` среза 2), S3-02 (`teams`, минимум `playbooks`, `notification`), S4-02 (`matching`), S5-02 (`playbooks`) и S5-04 (`workspace`), S6-03 (`github` и вклад/завершение в `workspace`), S7-02 (`rewards`), S7-07 (`profiles`: отзывы).

### Определение готовности задачи

Каждая задача считается выполненной, когда: критерии приёмки выполнены; `pnpm -r run typecheck`, `pnpm -r run lint` и тесты задачи проходят; нет `console.*`, секретов, TODO без записи в backlog; файл не больше 800 строк. Готовность среза - по фазе 6 (в конце каждого среза).

---

## Покрытие операций по срезам

| Срез | Операции (operationId) | Число |
|---|---|---|
| 1 | healthLive, healthReady | 2 |
| 2 | getMe, getCurrentConsentText, acceptConsent, requestDeletion, cancelDeletionRequest, getMyGithubAccount, signInSocial, signInMagicLink, verifyMagicLink, linkGithub, signOut, getSession, getMyProfile, saveMyProfile, getPublicProfile, uploadResume, getMyResume, confirmResumeFields, deleteResume, listRoles, createRole, updateRole, listStackTags, createStackTag, updateStackTag | 25 |
| 3 | listProductTypes, listTeams, createTeam, getTeam, updateTeam, listMyTeams, addSeats, updateSeat, closeSeat, startProject, listTeamEvents, createSeatOffer, listTeamSeatOffers, createJoinRequest, listMySeatOffers, acceptSeatOffer, rejectSeatOffer, createInvitation, listInvitations, revokeInvitation, previewInvitation, acceptInvitation, leaveTeam, listDepartures, decideDeparture, listLeaderVotes, getLeaderVoteRequests, requestLeaderVote, nominateCandidate, consentCandidacy, withdrawCandidacy, castBallot, respondLeaderOffer, listNotifications, markNotificationsRead | 35 |
| 4 | listSeatCandidates, listRecommendedTeams, getMySearchApplication, createSearchApplication, updateSearchApplication, cancelSearchApplication, getRoleDemand, excludeTrialMember, confirmTrial | 9 |
| 5 | listPlaybooks, getPlaybook, getTemplate, adminListPlaybooks, uploadPlaybook, publishPlaybook, listStages, getStageChecklist, updateChecklistItem, assignChecklistItem, revertFallback, uploadArtifactFile, getArtifactDownloadUrl, deleteArtifactFile, submitReview, acceptReviewRisk, transitionStage, confirmParticipation | 18 |
| 6 | createInstallationSession, githubSetupCallback, listAvailableRepositories, linkRepository, getRepository, unlinkRepository, receiveGithubWebhook, getTeamFeed, getContributionSummary, relabelContribution, requestCompletionCheck, getLatestCompletionCheck, completeProject, getCompletion | 14 |
| 7 | listBadges, listUserAwards, getUserCounters, getTeamCredit, createDispute, listFraudCases, getFraudCase, decideFraudCase, listReceivedReviews, createPeerReview, listSentReviews | 11 |
| | Итого | 114 |

Решения по границам срезов (где порядок среза пересекается с зависимостями модулей):

- Создание команды (T3) требует `PlaybooksApi.getLatestPublished`, а загрузка сценариев - срез 5. Поэтому в срезе 3 создаётся минимальная часть модуля playbooks (`product_type`, `playbook` без этапов, операция `listProductTypes`) и временная запись опубликованного сценария на каждый тип продукта (версия `0.0.1`, только для разработки и тестов). В срезе 5 загрузчик публикует настоящие `1.0.0`; команды, созданные на `0.0.1`, существуют только в средах разработки (до выпуска данных нет).
- `startProject` (FR-TEAM-10) живёт в срезе 3 и вызывает `TeamLifecyclePort.onProjectStarted`. В срезе 3 порт реализован заглушкой (статус `active`, без этапов); срез 5 подменяет реализацию: открывает этап 1 и создаёт пункты чек-листа в той же транзакции (T4).
- Уведомления (FR-WORK-19, `workspace.notification`) нужны командам с среза 3 (приглашения, голосование). Минимальный модуль workspace (таблица `notification`, `listNotifications`, `markNotificationsRead`, WebSocket-шлюз, очередь email) создаётся в срезе 3; остальные таблицы workspace добавляются в срезе 5.
- `excludeTrialMember` и `confirmTrial` (FR-TEAM-22, -24) относятся к срезу 4, так как зависят от автодобавления (`joined_via='auto'`).
- Отзывы (FR-PROF-08) относятся к срезу 7: право на отзыв появляется из события завершения проекта.
- `DeficitPort` в срезе 3 реализован заглушкой (дефицита нет), в срезе 4 подменён реализацией matching; `deficit_*` в `seat_assignment` в срезе 3 заполняются нулями/false.

### Принадлежность FR срезам

Каждый из 114 FR spec принадлежит ровно одному срезу по строке "Входящие FR" (проверено скриптом: разбор строк срезов против `**FR-...**` в spec.md). FR, чьи операции или механизмы лежат в нескольких срезах, закрываются в срезе-владельце (тест приёмки FR там), части в других срезах перечислены:

| FR | Владелец | Части в других срезах |
|---|---|---|
| FR-WORK-08 | 1 | `IdempotencyInterceptor` в 1; парный тест повтора ключа в каждом срезе с CC |
| FR-AUTH-04 | 2 | лимит загрузки артефактов - S5-06 |
| FR-AUTH-05 | 3 | вход GitHub и привязка - S2-05; проверка при постановке в очередь - S4-02 |
| FR-AUTH-08 | 2 | `AdminGuard` в `adminListPlaybooks` (5) и `listFraudCases` (7) |
| FR-GH-09 | 6 | `getMyGithubAccount` - 2; `pending_account` - S7-04 |
| FR-MATCH-01, -02 | 4 | `createSeatOffer`, `createJoinRequest` - 3 (без оценки) |
| FR-PLAY-03 | 5 | `createTeam` закрепляет сценарий - 3 |
| FR-PLAY-06 | 3 | - |
| FR-PLAY-08 | 5 | проверки репозитория (`repo_*`, `ci_workflow`) - S6-06 |
| FR-PROF-06 | 7 | `getPublicProfile` без наград - 2 |
| FR-PROF-07 | 4 | - |
| FR-REW-02, -11 | 7 | `completeProject`, `getCompletion` - 6 |
| FR-REW-15 | 7 | блок-правила AF при завершении - S6-08 |
| FR-TEAM-13, -14 | 3 | `assignChecklistItem` - 5; `getContributionSummary` - 6 |
| FR-TEAM-25 | 3 | реализация `DeficitPort` - S4-03 |
| FR-WORK-01 | 5 | `startProject` и заглушка порта - S3-09 |
| FR-WORK-12 | 5 | просрочка в итогах - S6-08 |
| FR-WORK-14 | 6 | сохранение ссылки на релиз - S5-05 |
| FR-WORK-17 | 6 | `updateChecklistItem` (исполнитель шага) - S5-05 |
| FR-WORK-18 | 5 | статус `suspended` и голосование - 3 |
| FR-WORK-19 | 3 | `stage-due-notify` - S5-08 |
| FR-GH-07 | 6 | `listNotifications` - 3 |

---

## Срез 1. Каркас

**Цель.** Любой агент может склонировать репозиторий, выполнить `docker compose up` и получить работающие web, api, worker, миграции, зависимости и зелёный CI. Все сквозные механизмы, на которых строятся срезы 2-7 (контракт и типы, конфигурация, ошибки, логи, транзакции и блокировки, идемпотентность, outbox, очереди, лимиты частоты, тестовая инфраструктура, i18n), проверены на тестовых эндпоинтах.

**Входящие FR.** Нефункциональные требования spec 5.1-5.6, 5.9; FR-WORK-08 (идемпотентность) на уровне инфраструктуры; операции `healthLive`, `healthReady`.

**Таблицы и миграции.** Схема `platform`: `idempotency_key`, `outbox_event`, `inbox_event`, `event_dead_letter` (architecture 5.1). Пустые схемы `auth`, `profiles`, `playbooks`, `teams`, `matching`, `workspace`, `github`, `rewards` создаются миграцией `0000_schemas`. Миграции идут только через `drizzle-kit` и контейнер `migrate` (прямое соединение с PostgreSQL).

### Задачи

**S1-01 Монорепозиторий (I, S)**
- Критерии: `pnpm install --frozen-lockfile` проходит; `pnpm-workspace.yaml` включает `apps/*`, `packages/*`; корневые скрипты `typecheck`, `lint`, `test`, `build` вызывают `pnpm -r run ...`; `.nvmrc` = 22, `engines.node >=22`, `packageManager` pnpm; `tsconfig.base.json` (strict); ESLint flat config + Prettier; `.editorconfig`, `.gitattributes` (LF); `.env.example` со всеми переменными из architecture 13.11 (без значений секретов).
- Зависимости: окружение (Node 22, pnpm).
- Файлы: корень (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`), `.gitignore`.
- Проверка: `pnpm -r run typecheck` на пустых пакетах без ошибок.

**S1-02 packages/shared и контракт (S+I, M)**
- Критерии: пакет `packages/shared` с `generate` (redocly lint -> bundle -> openapi-typescript); экспорт `Schema<N>`, `Body<Op>`, `Ok<Op>`, `ErrorCode`; `packages/shared/src/realtime.ts` (типы сообщений WebSocket из architecture 9); `scripts/check-contract.mjs` (operationId, x-fr, x-authz, Idempotency-Key, chain) падает на искусственно сломанном контракте (тест скрипта); `oasdiff` обёртка `pnpm run contract:breaking`; сгенерированные файлы закоммичены.
- Зависимости: S1-01.
- Файлы: `packages/shared/**`, `scripts/check-contract.mjs`, `scripts/check-contract.test.mjs`.
- Проверка: `pnpm --filter shared run generate && git diff --exit-code packages/shared`; `node scripts/check-contract.mjs` -> 114 операций, все с `x-authz`.

**S1-03 apps/api: загрузка приложения (B, M)**
- Критерии: NestJS 12 + Fastify, ESM (`"type": "module"`, `nodenext`, импорты с `.js`), entry `main.ts` (api) и `worker.ts` (контекст приложения без HTTP); `platform/config.ts` (zod-схема всех переменных 13.11; при ошибке печатает список имён без значений и выходит с кодом 1; тест на отсутствие `BETTER_AUTH_SECRET`, `DATA_ENCRYPTION_KEY`, слабого значения); pino (`nestjs-pino`) с сериализаторами без `url/query/headers`, поле `request_id` из `X-Request-Id` или новый; `DomainError` и фильтр problem+json (RFC 9457, поля из 13.1, `requestId`); `healthLive`, `healthReady` (PostgreSQL, Redis, S3 `HeadBucket`, тайм-аут 1 с, 503); `Clock` (системные и фиксированные часы).
- Зависимости: S1-01, S1-02.
- Файлы: `apps/api/src/main.ts`, `worker.ts`, `platform/{config,logging,errors,health,clock}/**`.
- Проверка: интеграционный тест: `GET /api/health/live` 200; `ready` 503 при остановленном Redis; запуск без секрета завершается кодом 1 и список имён в stderr.

**S1-04 Схема БД и миграции (B, S)**
- Критерии: `drizzle.config.ts` на `DATABASE_DIRECT_URL`; Drizzle-схемы `platform` и пустые схемы модулей; миграция `0000`; скрипт `pnpm --filter api run migrate` (используется контейнером `migrate`); повторный запуск не меняет базу; проверка CI "схема Drizzle = миграции" (`drizzle-kit generate` не создаёт новых файлов).
- Зависимости: S1-03.
- Файлы: `apps/api/drizzle/**`, `apps/api/drizzle.config.ts`, `platform/db/schema/**`, `platform/db/migrate.ts`.
- Проверка: миграция с пустой базы проходит; `\dn` показывает 9 схем.

**S1-05 Транзакции, блокировки, ошибки БД (B, M)**
- Критерии: `@nestjs-cls/transactional` с адаптером Drizzle (версии фиксированы); хелпер `runInTx(fn)`: `SET LOCAL lock_timeout='5s'`, `SET LOCAL statement_timeout='10s'`, повтор при `40P01`/`40001` до 3 раз с джиттером, `55P03` -> 503 `LOCK_TIMEOUT` с `Retry-After: 1`; хелперы блокировок с явным уровнем по таблице architecture 12.1 (типизированные `lockUser`, `lockTeam`, ... возвращают строку; взятие уровня ниже уже взятого бросает ошибку в `NODE_ENV=test`); отображение `23505` по имени ограничения (реестр `constraint -> code`); курсорная пагинация (`encodeCursor/decodeCursor`, фильтр-хэш, 400 при чужом курсоре).
- Зависимости: S1-04.
- Файлы: `apps/api/src/platform/tx/**`, `platform/db/pagination.ts`, `platform/errors/constraints.ts`.
- Проверка: тест двух транзакций, берущих блокировки в обратном порядке -> ошибка порядка в тестовом режиме; тест `lock_timeout` (одна транзакция держит строку, вторая получает 503); модульный тест курсора.

**S1-06 Идемпотентность и outbox (B, M)**
- Критерии: `IdempotencyInterceptor` по алгоритму 12.4 (захват вне транзакции, `lock_token`, `locked_until`, запись результата последним оператором транзакции, перехват истёкшего захвата, 422 `IDEMPOTENCY_KEY_REUSED`, 409 `IDEMPOTENCY_IN_PROGRESS`, 400 `IDEMPOTENCY_KEY_MISSING`, `Idempotent-Replayed: true`); outbox: запись события в транзакции, relay в очередь `events`, inbox для идемпотентности обработчиков, мёртвая очередь; задача `idempotency-cleanup`.
- Зависимости: S1-05, S1-07.
- Файлы: `platform/idempotency/**`, `platform/outbox/**`.
- Проверка: тестовый контроллер `POST /v1/_test/echo` (только в `NODE_ENV=test`): 20 параллельных запросов с одним ключом -> 1 эффект, остальные 409 или повтор; тот же ключ с другим телом -> 422; падение процесса до коммита (имитация) -> повтор допускается.

**S1-07 Redis, BullMQ, лимиты частоты (B, M)**
- Критерии: модуль Redis (ioredis, отдельные ACL-пользователи по процессам); реестр очередей и политика `removeOnComplete/Fail`, повторов (таблица 13.12); процессор-пример в `worker`; сервис лимита частоты (скользящее окно, Lua, атомарно, 429 с `Retry-After` и `RateLimit-*`, ключи по пользователю и HMAC IP); `trustProxy` по `TRUSTED_PROXY_CIDRS`; проверка правил `jobId` (ошибка при `:` или целом числе).
- Зависимости: S1-03.
- Файлы: `platform/redis/**`, `platform/queues/**`, `platform/ratelimit/**`.
- Проверка: тест 30 параллельных вызовов лимита с порогом 5 -> ровно 5 пропущено; тест заданий: повторная постановка с тем же `jobId` не создаёт второй.

**S1-08 Docker Compose (I, M)**
- Критерии: `docker-compose.yml`: postgres 16, pgbouncer (`pool_mode=transaction`, `prepare` выключен на клиенте), redis 7 (ACL-файл с пользователями `api`, `worker`, `linkcheck`, без `FLUSHALL/CONFIG/KEYS` для приложений), redis-resume (`save ""`, `appendonly no`, ACL), minio (+ `mc`-инициализация бакетов resumes, artifacts, приватные), mailpit (SMTP для dev), `migrate` (разовый, прямое подключение, `depends_on: service_completed_successfully`), `api`, `worker`, `web`; healthcheck у всех; сеть `resume-net` (`internal: true`) объявлена для среза 2; Dockerfile api и web (multi-stage, непривилегированный пользователь); `docker-compose.test.yml` (раздел "Тестовая БД"); скрипт `pnpm run env:init`; `.dockerignore`. Caddy в dev не используется: web проксирует `/api/*` на api через rewrites (одна origin); Caddy-конфиг для выпуска готовится в фазе 7.
- Зависимости: S1-03, S1-04 (Dockerfile api), S1-09 (Dockerfile web).
- Файлы: `docker-compose.yml`, `docker-compose.test.yml`, `docker/**`, `scripts/env-init.mjs`.
- Проверка: `docker compose up --build` с чистых томов: `migrate` завершается 0, `curl localhost:4000/api/health/ready` 200, `localhost:3000` отдаёт страницу; `docker compose down -v` и повторный запуск проходят.

**S1-09 apps/web: каркас, i18n, клиент (F, M)**
- Критерии: Next.js (App Router), React, TypeScript strict; оболочка `components/shell` со сбором навигации из `features/*/nav.ts`; MSW-обработчики генерируются из контракта (`pnpm --filter web run mocks:generate` в `src/mocks/generated/**`; нужны F-задачам срезов 2-7, чтобы работать параллельно с B); i18n: словари `src/i18n/ru/*.json`, функция `t(key, params)` с ICU-множественными числами, правило ESLint "нет строковых литералов в JSX" с тестом; `openapi-fetch` клиент `createClient<paths>({ baseUrl: '/api' })` с middleware: `Idempotency-Key` на изменяющих запросах (хелпер `useIdempotentMutation` по правилам повтора), разбор problem+json по `code`; TanStack Query провайдер; базовая вёрстка, дизайн-токены, контраст AA, видимый фокус; безопасность Next.js по 13.10 (`images.unoptimized`, `remotePatterns: []`, без Server Actions, минимальная версия Next.js проверяется); страница `/` с статусом API (вызов `healthReady`), страница 404.
- Зависимости: S1-01, S1-02.
- Файлы: `apps/web/**` (кроме `e2e/**`).
- Проверка: `pnpm --filter web build`; модульный тест `useIdempotentMutation` (ключ сбрасывается после ответа 4xx и сохраняется после сетевой ошибки).

**S1-10 Тестовая инфраструктура (T, M)**
- Критерии: Vitest конфиг api (`globalSetup`: миграции, шаблонная БД; база на файл), `barrier(N)`, `statuses()`, `codes()`, `api.as(user)`, `FakeClock`, `expectMatchesContract`, `idorMatrix(operationId)` (из `x-authz`), `pnpm run trace:fr`; Playwright конфиг (`webServer` через compose `-p e2e`), хелпер входа (создание сессии напрямую), подключение `@axe-core/playwright`; фикстуры-заготовки; тест-примеры работают на `_test/echo`.
- Зависимости: S1-02, S1-03, S1-05, S1-06, S1-07, S1-08.
- Файлы: `apps/api/test/setup/**`, `apps/api/test/helpers/**`, `apps/api/test/fixtures/index.ts`, `apps/web/e2e/support/**`, `apps/web/playwright.config.ts`, `scripts/trace-fr.mjs`.
- Проверка: пример теста CC (20 параллельных на `_test/echo`) проходит `--repeat 5`.

**S1-11 Границы модулей (B+I, S)**
- Критерии: `eslint-plugin-boundaries` и `dependency-cruiser` (правило `no-circular`, список разрешённых рёбер из architecture 2.2, запрет импорта `internal/**` чужого модуля); генератор каркаса модуля `pnpm run gen:module <name>` по структуре из раздела соглашений; пустые модули всех 8 имён с `public.ts` и `<m>.module.ts` подключены в `AppModule`.
- Зависимости: S1-03.
- Файлы: `apps/api/src/modules/*/public.ts`, `*.module.ts`, `.dependency-cruiser.cjs`, `eslint.config.js`, `scripts/gen-module.mjs`.
- Проверка: искусственный импорт `teams/internal` из `matching` ломает `pnpm -r run lint`; `depcruise --validate` зелёный.

**S1-12 CI GitHub Actions (I, M)**
- Критерии: `.github/workflows/ci.yml`: задачи `contract` (redocly lint, генерация и `git diff --exit-code`, `check-contract`, `oasdiff breaking` против `main`), `static` (typecheck, lint, depcruise, миграции = схема, запрет секретов `gitleaks`), `unit-integration` (Vitest с сервисами PostgreSQL/PgBouncer/Redis/MinIO, покрытие с порогом 80%, `--repeat 5` для `test/concurrency/**`), `e2e` (compose `-p e2e`, Playwright, артефакты трассировки при падении), `build` (сборка образов); кэш pnpm; `permissions: contents: read`; действия закреплены по SHA; `pnpm audit --prod` и проверки зависимостей из 13.18 (минимальные версии Next.js, `pdfjs-dist` и т.п. по мере появления); защита от запуска на форках с секретами.
- Зависимости: S1-02, S1-08, S1-09, S1-10, S1-11 (джоба `e2e` становится зелёной после S1-13).
- Файлы: `.github/workflows/ci.yml`, `.github/dependabot.yml`.
- Проверка: запрос на слияние среза зелёный; намеренно сломанный `x-authz` в ветке-пробнике делает джобу `contract` красной.

**S1-13 Сквозной сценарий среза и тесты инфраструктуры (T, S)**
- Критерии: `apps/web/e2e/slice1.spec.ts` по шагам из раздела "Тесты среза" (зелёный после S1-09 и S1-08); модульные тесты `AuthzRegistry` и конфигурации.
- Зависимости: S1-09, S1-10.
- Файлы: `apps/web/e2e/slice1.spec.ts`, `apps/api/src/platform/**/*.test.ts`.

### Параллельность

После S1-01/S1-02: B (S1-03, затем S1-04 -> S1-05; S1-07 и S1-11 параллельно им; S1-06 после S1-05 и S1-07) и F (S1-09) работают независимо (разные каталоги); I (S1-08) идёт после Dockerfile api и web, S1-12 после S1-13; T (S1-10) после S1-06, S1-07, S1-08.

### Тесты среза

- API по контракту: `healthLive`, `healthReady` (200/503), формат problem+json на 404 и 400 (`requestId`, `code`), заголовки `X-Request-Id`, 429 с `RateLimit-*`.
- Конкурентный доступ (на тестовом эндпоинте инфраструктуры): идемпотентность - 20 параллельных запросов с одним ключом -> 1 эффект (2xx или `completed`) и 19 повторов/409 `IDEMPOTENCY_IN_PROGRESS`; 20 запросов с разными ключами на один ресурс с версией -> 1 x 200, 19 x 409 `VERSION_CONFLICT` (шаблон CC-7); лимит частоты - ровно порог пропущен.
- IDOR: не применимо (нет ресурсов); проверяется, что приложение не стартует при операции без `x-authz` (модульный тест `AuthzRegistry`).
- Playwright `slice1.spec.ts`: (1) открыть `/`; (2) видна карточка "API работает" со статусом из `healthReady` (строка из словаря `ru`); (3) axe без нарушений уровня serious/critical; (4) остановить redis-контейнер, обновить страницу -> показано сообщение о недоступности (не пустая страница); (5) запустить redis, обновить -> статус восстановился.
- Безопасность: security-auditor на срезе 1 не обязателен (по оркестратору), но S1-03/S1-07 проверяются code-reviewer по SEC-07 (логи без токенов), SEC-10 (ACL Redis), SEC-16 (`trustProxy`).

### Проверка задач без собственной строки "Проверка"

Оркестратор требует для каждой задачи сквозной сценарий проверки. Для задач ниже он - шаги Playwright среза и перечисленные тесты.

| Задача | Чем проверяется |
|---|---|
| S1-13 | сам сценарий `slice1.spec.ts`, шаги 1-5; модульные тесты `AuthzRegistry` и конфигурации зелёные |

### Критерий готовности (фаза 6)

`docker compose up` с чистой базы поднимает все сервисы, `migrate` = 0; `pnpm -r run typecheck`, `lint`, все тесты локально и в CI зелёные; сквозной сценарий `slice1.spec.ts` пройден в браузере; независимый code-reviewer прочитал дифф; CRITICAL/HIGH нет; MEDIUM/LOW записаны в `docs/backlog.md`.

### Риски среза

| Риск | Мера |
|---|---|
| Node/pnpm/Docker не установлены | Блокирует срез; запросить установку до старта; до этого вести только документы и тесты-заготовки |
| NestJS 12 ESM + Fastify + `nestjs-cls`/Drizzle: несовместимость версий | Первая задача B - прототип загрузки и транзакции на выбранных версиях (S1-03/S1-05), версии фиксируются точно |
| PgBouncer transaction mode: `SET LOCAL`, подготовленные запросы | Проверено тестом в S1-05; драйвер с `prepare=false` |
| `redocly`/`oasdiff` на Windows | `oasdiff` через Docker; в CI Linux |
| Время сборки CI растёт (compose + Playwright) | Кэш слоёв, `e2e` отдельной джобой, `--repeat 5` только для `test/concurrency` |
| Объём (13 задач, проверка версий) | Если не помещается в одну сессию - делить по границе S1-05/S1-06: часть а (S1-01..S1-05, S1-07, S1-09, S1-11: монорепозиторий, api, транзакции, web) и часть б (S1-06, S1-08, S1-10, S1-12, S1-13: идемпотентность, compose, тесты, CI); решение оркестратора |

---

## Срез 2. Авторизация и профиль

**Цель.** Пользователь входит через GitHub или magic link, принимает согласие, заполняет профиль (роли, стек, опыт, предпочтения), загружает резюме и подтверждает распознанные поля, видит публичный профиль; может запросить удаление аккаунта. Администратор ведёт справочники ролей и стека.

**Входящие FR.** FR-AUTH-01..04, FR-AUTH-06..09 (FR-AUTH-05, обязательная привязка GitHub при вступлении, - срез 3), FR-PROF-01..05, FR-PROF-09 (FR-PROF-06 - срез 7, FR-PROF-07 - срез 4, FR-PROF-08 - срез 7). Операции: см. таблицу покрытия (25).

**Таблицы и миграции.** `auth`: `user`, `session` (пустая, совместимость Better Auth), `account`, `verification`, `consent`, `deletion_request`, `deletion_step`, `deletion_log`, `identity_signal`, `identity_tombstone`. `profiles`: `role`, `stack_tag`, `profile`, `profile_role_pref`, `profile_stack`, `profile_experience`, `resume_upload`. (`review_eligibility`, `peer_review`, `peer_review_authorship` создаются в срезе 7.) Сиды: роли и теги стека (миграция-сид).

### Задачи

**S2-01 Прототип Better Auth в NestJS+Fastify (B, M) - первым, до остальных задач среза**
- Что проверить (architecture 17.1, 17.2, backlog): монтирование catch-all маршрута Better Auth на Fastify внутри Nest; таблицы в схеме `auth` через Drizzle `pgSchema`; UUID v7 как `generateId`; сессии только в Redis (`secondaryStorage`, `storeSessionInDatabase=false`); `revokeUserSessions` при `secondaryStorage`; `encryptOAuthTokens` с `DATA_ENCRYPTION_KEY`; вход через user-to-server OAuth того же GitHub App (против минимального двойника GitHub внутри `spike/**`; полноценный двойник пишет S2-02 после спайка, цикла зависимостей нет); получение cookie и CSRF/Origin-проверки.
- Критерии: рабочий спайк (`apps/api/src/modules/auth/spike/`, затем превращается в основу S2-03); записка с результатом (что работает, что нет, запасной вариант `auth_`-префикс в `public`) для оркестратора, который вносит решение в `docs/decisions.md` или ADR. Если спайк не проходит по ключевому пункту, дальнейшие задачи S2-03..05 ждут решения оркестратора.
- Зависимости: срез 1.
- Файлы: `apps/api/src/modules/auth/spike/**` (временно).
- Проверка: интеграционный тест "вход -> cookie -> `getSession` -> выход -> сессия недействительна", и "revokeUserSessions" убирает все сессии пользователя из Redis.

**S2-02 Тесты среза до реализации (T, M)**
- Критерии: API-тесты по контракту всех 25 операций (успех и негативные коды), тесты CC-связанных мест среза, IDOR-тесты, Playwright `slice2.spec.ts`, двойник GitHub OAuth (`test/fakes/github-server.ts`: authorize, token, `/user`, `/user/emails`) и Mailpit-клиент. Все тесты на момент коммита падают.
- Зависимости: S1-10; S2-01 для двойника.
- Файлы: `apps/api/src/modules/{auth,profiles}/test/**`, `apps/api/test/fakes/**`, `apps/web/e2e/slice2.spec.ts`.

**S2-03 Модуль auth: схема и сессии (B, M)**
- Критерии: миграция таблиц `auth`; Better Auth смонтирован; `SessionGuard`, `ConsentGuard` (403 `CONSENT_REQUIRED`, исключения из 13.10), `@Authz()` для actor `public`, `authenticated`, `self`, `admin`; операции `getSession`, `signOut`; `AuthApi` в `public.ts`: `getUser`, `lockUserForJoin` (lock #1, `deleting` -> `USER_INACTIVE`), `getIdentitySignals`; проверка `Origin`/CSRF для изменяющих запросов; cookie `HttpOnly`, `Secure`, `SameSite=Lax`.
- Зависимости: S2-01, S2-02.
- Файлы: `modules/auth/**`.
- Проверка: тесты S2-02 для `getSession`/`signOut`/guards зелёные.

**S2-04 Вход по magic link (B, M)**
- Критерии: `signInMagicLink` (лимиты C-31: 5/ч на адрес, 20/ч на IP; ответ одинаков для существующего и несуществующего адреса - без перечисления), письмо через очередь `notifications` (Mailpit в dev), ссылка вида `/auth/confirm#token=...` (токен во фрагменте), `verifyMagicLink` (POST с токеном в теле; повтор -> 401 `INVALID_TOKEN`, истёкший -> 401 `EXPIRED_TOKEN`), нормализация email (gmail, Яндекс, mail.ru алиасы для антифрода, backlog MEDIUM), запись `identity_signal`.
- Зависимости: S2-03.
- Файлы: `modules/auth/internal/magic-link/**`, `platform/mail/**`.
- Проверка: тест: 10 параллельных `verifyMagicLink` по одному токену -> 1 x 200, 9 x 401.

**S2-05 Вход через GitHub и привязка (B, M)**
- Критерии: `signInSocial` (редирект на GitHub, `state` проверяется), `linkGithub`, `getMyGithubAccount`; токены GitHub шифруются (`encryptOAuthTokens`); `github_user_id` уникален (второй аккаунт с тем же GitHub -> 409 `GITHUB_ALREADY_LINKED`); запись `identity_signal`; логи не содержат `code`/`state` (тест `grep` по логам).
- Зависимости: S2-03.
- Файлы: `modules/auth/internal/github/**`.
- Проверка: тест входа через двойник GitHub; тест невозможности привязать один GitHub к двум пользователям (2 параллельных запроса -> 1 успех).

**S2-06 Согласие и getMe (B, S)**
- Критерии: `getCurrentConsentText`, `acceptConsent` (версия текста, дата, IP-хэш), `getMe` (статус, наличие согласия, признак admin, ожидающее удаление); новая версия текста требует повторного принятия; тексты согласия в `apps/api/seeds/consent/` (черновик, юридическая проверка отдельно - открытый вопрос статуса).
- Зависимости: S2-03.
- Файлы: `modules/auth/internal/consent/**`, `seeds/consent/**`.

**S2-07 Удаление аккаунта (B, M)**
- Критерии: `requestDeletion` (свежая сессия не старше 10 минут, отсрочка 72 часа, письмо со ссылкой отмены), `cancelDeletionRequest` (идемпотентна по одноразовому токену), `deletion-scheduler` (maintenance), сага `deletion_step` по модулям (событие `auth.user_deletion_requested`; в срезе 2 подписан profiles: профиль, резюме в MinIO; другие модули подключаются в своих срезах), `auth.user.status='deleting'` под lock #1, `identity_tombstone` (HMAC, 180 дней), `deletion_log`; повтор после восстановления из копии.
- Зависимости: S2-03, S2-10 (удаление резюме), S1-06.
- Файлы: `modules/auth/internal/deletion/**`, `modules/profiles/internal/events/**`.
- Проверка: тест с `FakeClock`: запрос -> до 72 ч отмена возможна -> после 72 ч данные удалены, повторный вход создаёт нового пользователя; параллельно с вступлением в команду (проверяется в срезе 3, CC-связь).

**S2-08 profiles: справочники (B, S)**
- Критерии: миграция всех таблиц `profiles` среза 2 (`role`, `stack_tag`, `profile`, `profile_role_pref`, `profile_stack`, `profile_experience`, `resume_upload`; S2-09 и S2-10 миграции не создают, чтобы параллельные цепочки не конфликтовали) + сиды ролей и тегов; `listRoles`, `listStackTags` (публичные для вошедших), админ-операции `createRole`, `updateRole`, `createStackTag`, `updateStackTag` (`AdminGuard`, дубль кода -> 409, неизвестный код роли в профиле -> 422).
- Зависимости: S2-03.
- Файлы: `modules/profiles/internal/catalog/**`, `seeds/catalog/**`.

**S2-09 Профиль и публичный профиль (B, M)**
- Критерии: `getMyProfile`, `saveMyProfile` (PUT с `version`; устаревшая версия -> 409 `VERSION_CONFLICT` с `current`; роли с приоритетами без дублей, стек из справочника, лимиты длины), `getPublicProfile` (только публичные поля; скрытые поля и контакты не отдаются; витрина наград подключается позже через фронтенд из срезов 4 и 7); `ProfilesApi` в `public.ts` (чтение для teams и matching).
- Зависимости: S2-08.
- Файлы: `modules/profiles/internal/profile/**`.
- Проверка: 20 параллельных `saveMyProfile` с версией N -> 1 x 200, 19 x 409 (аналог CC-7).

**S2-10 Резюме и изолированный разбор (B+I, M)**
- Критерии: `uploadResume` (multipart, тип по magic bytes PDF/DOCX, до 5 МБ, лимит C-33 5/ч, запись в MinIO `resumes` вне каталога приложения, `resume_upload` статус `queued`); процессор `resume-dispatch` в `worker` (читает MinIO, кладёт байты в `resume-parse` в `redis-resume`); контейнер `resume-worker` (родитель uid 10001, дочерний процесс `parse-child` uid 10002 с пустым окружением, лимиты C-22..C-26, `read_only`, `cap_drop ALL` + `SETUID/SETGID`, сеть `resume-net`), unpdf + mammoth; результат только `{ok, text, pages}` / `{ok:false, reason}`; `getMyResume` (статус, распознанные поля), `confirmResumeFields` (пользователь подтверждает вручную; в профиль попадает только подтверждённое), `deleteResume` (удаляет файл в MinIO и текст; админ 404); сканер `resume-stuck-scan`; текст резюме не логируется.
- Зависимости: S2-09, S1-08 (compose resume-net).
- Файлы: `modules/profiles/internal/resume/**`, `apps/api/src/resume-worker/**`, `docker/resume-worker/**`, `docker-compose.yml` (сервис `resume-worker`).
- Проверка: фикстуры PDF/DOCX с корректным текстом -> `ready`; PDF-бомба, зашифрованный, пустой, переименованный `.exe` -> соответствующий `reason` или 400/415; прототип изоляции (architecture 17.9): дочерний процесс действительно запущен под uid 10002 (тест читает `/proc/self/status`), при неудаче записывается запасной вариант (тот же uid + секрет передаётся родителем) и решается оркестратором.

**S2-11 Frontend: вход и согласие (F, M)**
- Критерии: страницы `/sign-in` (кнопка GitHub, форма email), `/auth/confirm` (токен из фрагмента, POST `verifyMagicLink`, ошибки по `code`), экран согласия (блокирует остальное до принятия), выход; middleware только UX-редиректы; состояния загрузки, ошибки, лимиты 429 с `Retry-After`; axe.
- Зависимости: S2-02 (тесты), контракты готовы - можно параллельно с B (мок сервера генерируется из контракта: MSW).
- Файлы: `apps/web/src/app/(auth)/**`, `features/auth/**`, `i18n/ru/auth.json`.

**S2-12 Frontend: профиль и резюме (F, M)**
- Критерии: страницы `/profile` (форма: роли с приоритетами, стек, опыт, предпочтения; конфликт версий показывает актуальные данные и предлагает перезаписать), загрузка резюме с `aria-live` статусом разбора (опрос или событие реального времени), подтверждение полей, удаление резюме; публичный профиль `/users/[id]`; настройки аккаунта: запрос удаления (с подтверждением) и отмена.
- Зависимости: S2-11.
- Файлы: `apps/web/src/app/(app)/profile/**`, `app/(app)/users/**`, `app/(app)/settings/**`, `features/profile/**`.

**S2-13 Дополнение тестов (T, S)**
- Критерии: граничные случаи по ревью (двойной клик "сохранить", обрыв загрузки резюме, повтор запроса с тем же ключом, истёкший magic link, удаление во время загрузки резюме).
- Зависимости: S2-03..S2-12.
- Файлы: `apps/api/src/modules/{auth,profiles}/test/**`, `apps/web/e2e/slice2.spec.ts`, `apps/api/test/fixtures/**`.

### Параллельность

B: S2-01 -> S2-03 -> (S2-04, S2-05, S2-06 параллельно после S2-03; разные подкаталоги `internal/`); S2-08 -> S2-09 -> S2-10 параллельно с цепочкой auth; S2-07 после S2-10. F: S2-11, затем S2-12 (S2-12 использует оболочку и сессию из S2-11), обе на моках параллельно с B; финальная склейка после готовности B. I-часть S2-10 (compose) и B-часть - один исполнитель (один агент меняет `docker-compose.yml`).

### Тесты среза

- API по контракту: все 25 операций; негативные: 401 без сессии, 403 `CONSENT_REQUIRED`, 422 справочники, 429 лимиты C-31/C-32/C-33, 415/413 для резюме, `deleteResume` повторно -> 404.
- Конкурентный доступ: (а) `verifyMagicLink` один токен x10 -> 1 x 200; (б) `linkGithub` один GitHub для 2 пользователей параллельно -> 1 успех; (в) `saveMyProfile` с одной версией x20 -> 1 x 200, 19 x 409; (г) 20 `uploadResume` -> лимит 5/ч: ровно 5 приняты; (д) `acceptConsent` x10 с разными ключами -> одна запись согласия этой версии.
- IDOR: `getMyResume`/`confirmResumeFields`/`deleteResume` с чужим `uploadId` -> 404 (фильтр `user_id = :me`); `getPublicProfile` не раскрывает скрытые поля; админ получает 404 на чужое резюме; `cancelDeletionRequest` с чужим токеном -> 401/404; `createRole`, `updateStackTag` обычным пользователем -> 403.
- Playwright `slice2.spec.ts`: (1) открыть `/sign-in`, ввести email, получить письмо из Mailpit, открыть ссылку `/auth/confirm#token=...`; (2) принять согласие; (3) заполнить профиль (2 роли, 3 тега, опыт), сохранить; (4) обновить страницу - данные на месте; (5) загрузить тестовый PDF, дождаться статуса "готово" (aria-live), подтвердить поля; (6) открыть публичный профиль в другом контексте браузера (без сессии доступ закрыт, по сессии другого пользователя виден); (7) войти через GitHub (двойник) вторым пользователем; (8) запросить удаление аккаунта, отменить по ссылке из письма; (9) axe на всех страницах.

### Проверка задач без собственной строки "Проверка"

Шаги Playwright `slice2.spec.ts`: 1 вход по magic link, 2 согласие, 3 профиль, 4 перезагрузка, 5 резюме, 6 публичный профиль, 7 вход через GitHub, 8 удаление и отмена, 9 axe.

| Задача | Чем проверяется |
|---|---|
| S2-02 | перед реализацией `pnpm test` падает по каждой из 25 операций и по `slice2.spec.ts` (вывод в отчёте); после среза всё зелёное |
| S2-06 | API-тесты `getCurrentConsentText`, `acceptConsent`, `getMe`, тест (д) из конкурентных; шаг 2 |
| S2-08 | API-тесты справочников, 403 на `createRole`/`updateStackTag` для обычного пользователя; шаг 3 (выбор из справочника) |
| S2-11 | шаги 1, 2, 7, 9; модульный тест разбора токена из фрагмента |
| S2-12 | шаги 3, 4, 5, 6, 8, 9 |
| S2-13 | граничные тесты из критериев зелёные, `slice2.spec.ts` не изменил результат |

### Безопасность

Обязателен security-auditor (авторизация): поверхность входа (magic link SEC-09, `state`, токены в логах SEC-07, перечисление пользователей), сессии и CSRF, шифрование токенов, лимиты, загрузка и изоляция резюме (SEC-01), удаление ПД (152-ФЗ).

### Критерий готовности (фаза 6)

Как в срезе 1 плюс: прототип Better Auth и изоляции резюме задокументированы; тесты с параллельными запросами (а)-(д) проходят `--repeat 5`; security-auditor завершил без CRITICAL/HIGH; тест "в логах нет `token`, `code`, `state`" зелёный; `slice2.spec.ts` пройден.

### Риски среза

| Риск | Мера |
|---|---|
| Better Auth в Fastify внутри Nest, `pgSchema`, UUID v7, `secondaryStorage` (architecture 17.1) | Прототип S2-01 первым; запасной вариант - префикс `auth_` в `public`; решение фиксирует оркестратор |
| Вход через GitHub App (user-to-server) вместо OAuth App | Проверка на двойнике и, при наличии тестового App, вручную; запасной вариант - отдельное OAuth App без смены кода |
| Дочерний процесс разбора под отдельным uid в контейнере (17.9) | Прототип в S2-10; запасной вариант описан в architecture 17.9 |
| SMTP с доставляемостью на mail.ru, yandex.ru (17.6) | Не блокирует разработку (Mailpit); провайдер выбирается до выпуска |
| Юридические тексты согласия и политики (17.8) | Черновик в сидах, проверка юристом до выпуска |
| Объём (25 операций, два прототипа, сага удаления) | Если не помещается в одну сессию - делить по границе S2-06/S2-07: часть а (S2-01..S2-06, S2-11: вход, сессии, согласие) и часть б (S2-07..S2-10, S2-12, S2-13: удаление, профиль, резюме); S2-02 пишется для своей части; решение оркестратора |

---

## Срез 3. Команды и роли

**Цель.** Тимлид создаёт команду, открывает места под роли, приглашает людей и принимает заявки; кандидат принимает предложение, вступает по приглашению, выходит; если тимлид уходит или неактивен, проходит голосование за нового тимлида; команда стартует проект. Все вступления безопасны при параллельных запросах.

**Входящие FR.** FR-AUTH-05, FR-TEAM-01..21, FR-TEAM-25..30 (FR-TEAM-22..24 - срез 4), FR-PLAY-06, FR-WORK-19 (уведомления; таймеры сроков - S5-08); `startProject` реализует FR-TEAM-10 (FR-WORK-01 принадлежит срезу 5). CC-1, CC-2, CC-4, CC-8, CC-13 (часть "Старт"). Операции: 35 (таблица покрытия).

**Таблицы и миграции.** `teams`: `team`, `seat`, `membership`, `seat_assignment`, `invitation`, `seat_offer`, `departure`, `leader_vote`, `vote_eligible`, `vote_candidate`, `vote_ballot`, `vote_offer`, `vote_request`, `team_event`. `playbooks` (минимум): `product_type`, `playbook`. `workspace` (минимум): `notification`. Индексы по architecture 5.10; частичные уникальные индексы `seat_assignment_active_seat_uq`, `seat_assignment_active_role_uq`, `membership_active_uq`, `leader_vote_open_uq`.

### Задачи

**S3-01 Тесты среза до реализации (T, M)**
- Критерии: API-тесты 35 операций, CC-1, CC-2, CC-4, CC-8, CC-13, прочие гонки 12.3 (закрытие места против вступления, выход против вступления на место, лимиты предложений), IDOR, Playwright `slice3.spec.ts`; фикстуры `team`, `teamWithOpenSeat`, `leaderVote`; тесты падают.
- Зависимости: срез 2 принят.
- Файлы: `modules/{teams,playbooks,workspace}/test/**`, `apps/api/test/fixtures/**`, `apps/web/e2e/slice3.spec.ts`.

**S3-02 Схема teams и минимальные playbooks/notification (B, M)**
- Критерии: миграции всех таблиц `teams`, `product_type`, `playbook`, `notification`; сид типов продукта и заглушек `0.0.1`; `PlaybooksApi.getLatestPublished`, `listProductTypes`; `TeamsApi` в `public.ts` (интерфейсы: `getRoster`, `lockTeam(teamId, mode)`, `assertMember`, `assertLead`, `joinSeat`, `getCompletionRosterSnapshot` (заглушка до среза 6), `markCompleted`, `setReleaseUrl`); порты `DeficitPort`, `TeamLifecyclePort` объявлены в teams и привязаны к заглушкам; guards `team-member`, `team-lead`, `offer-party`, `invitee`, `vote-participant`.
- Зависимости: S3-01.
- Файлы: `modules/teams/{public.ts,internal/schema/**}`, `modules/playbooks/**`, `modules/workspace/internal/schema/notification.ts`, `apps/api/drizzle/**`.

**S3-03 Команда и места (B, M)**
- Критерии: `createTeam` (T3: lock #1 -> привязан ли GitHub (FR-AUTH-05, иначе 409 `GITHUB_REQUIRED`) -> проверка лимита активных проектов (2, spec раздел 7) под блокировкой (CC-2), сценарий закрепляется `playbook_id`), `getTeam`, `listTeams` (курсор, фильтры), `updateTeam` (`version`), `listMyTeams`, `addSeats`, `updateSeat` (`version`), `closeSeat` (только `open`, иначе 409 `INVALID_STATE`; порядок блокировок #4 -> #5), `desired` пометка с `desired_changed_at`, `team_event` на каждое изменение; лимит мест C-04 под блокировкой команды; `listTeamEvents`.
- Зависимости: S3-02.
- Файлы: `modules/teams/internal/{controllers,services,repositories}/team*`, `seat*`.
- Проверка: CC-2 (в, создание команды при лимите), закрытие против вступления (после S3-04).

**S3-04 Вступление: предложения и заявки (B, M)**
- Критерии: `joinSeat` (T1) как единый путь вступления: lock #1 пользователя -> #3 билета -> #4 команды -> #5 места -> #6; статусы места под блокировкой, `member_count < 8`, лимит проектов, привязанный GitHub (FR-AUTH-05: 409 `GITHUB_REQUIRED` в `acceptSeatOffer`, `acceptInvitation`, `createJoinRequest`), `seat_assignment` + `UPDATE seat SET status='filled'`, `deficit_*` через `DeficitPort`; `createSeatOffer` (тимлид, лимит 30 pending на команду), `createJoinRequest` (кандидат, лимит 10), `listTeamSeatOffers`, `listMySeatOffers`, `acceptSeatOffer` (обе стороны по `direction`), `rejectSeatOffer`; события outbox `teams.member_joined`, `teams.seat_opened`; совмещение второй роли (FR-TEAM-07, C-03).
- Зависимости: S3-03.
- Файлы: `modules/teams/internal/services/join*`, `offers*`.
- Проверка: CC-1 x20 и CC-2 (а, б, в), `--repeat 5`.

**S3-05 Приглашения (B, M)**
- Критерии: `createInvitation` (токен показывается один раз, хранится хэш; адресное по `github_user_id` или HMAC email, либо ссылка; лимит C-13 под блокировкой команды), `listInvitations`, `revokeInvitation`, `previewInvitation` (безопасен, без раскрытия лишнего, лимит), `acceptInvitation` (CC-8: lock #1 -> #3 `invitation FOR UPDATE` -> CC-1); срок жизни, очистка через 30 дней (maintenance).
- Зависимости: S3-04.
- Файлы: `modules/teams/internal/{services,controllers}/invitation*`.
- Проверка: CC-8 (10 пользователей, 1 токен).

**S3-06 Выход и решение тимлида (B, M)**
- Критерии: `leaveTeam` (#1 -> #4 -> #6; место открывается после выхода; если выходит тимлид, в той же транзакции вызывается порт `LeaderVoteOpenPort.open`: в S3-06 стоит заглушка, реализацию даёт S3-07, тест выхода тимлида включается в S3-07), `listDepartures`, `decideDeparture` (#3 `departure FOR UPDATE`, `pending`), таймер `departure-default` (C-14) в `timers`; освобождение мест, события `teams.member_left`.
- Зависимости: S3-04.
- Файлы: `modules/teams/internal/services/departure*`, `jobs/departure-default.ts`.
- Проверка: выход против вступления на то же место (12.3); решение тимлида против таймера (12.3).

**S3-07 Голосование за тимлида: открытие и выдвижение (B, M)**
- Критерии: автомат состояний (`domain/leader-vote-machine.ts`, чистый, 95%); открытие по триггерам (выход тимлида, `requestLeaderVote` от >= ceil(N/2) при неактивности > 14 дней, удаление аккаунта), `leader_vote_open_uq`, снимок `vote_eligible`; `listLeaderVotes`, `getLeaderVoteRequests`, `requestLeaderVote`, `nominateCandidate`, `consentCandidacy`, `withdrawCandidacy`; отмена при возвращении тимлида.
- Зависимости: S3-06.
- Файлы: `modules/teams/internal/domain/leader-vote*`, `services/vote-open*`, `vote-nominate*`.

**S3-08 Голосование: бюллетени, срок, предложение (B, M)**
- Критерии: `castBallot` (#4 -> #7, `vote_ballot` PK, досрочное закрытие при > N/2), `respondLeaderOffer`, таймеры `vote-deadline` (`jobId` по правилам 13.12) + сканер раз в минуту, второй тур при ничьей, продление при отсутствии кворума, `offering` по сроку, приостановка команды на 14 дней (`suspension-expire`), раскрытие числа голосов только после закрытия (кто за кого - никогда); `team_event lead_changed`.
- Зависимости: S3-07.
- Файлы: `modules/teams/internal/services/vote-ballot*`, `jobs/vote-deadline.ts`, `jobs/vote-deadline-scan.ts`.
- Проверка: CC-4 (а, б, в) на `FakeClock`; все переходы автомата (таблица тестов по диаграмме 8.2).

**S3-09 Старт проекта (B, S)**
- Критерии: конечный автомат статусов команды (FR-TEAM-27: `domain/team-status.ts`, чистый, 95%; запрещённый переход -> 409 `INVALID_STATE`; в `voting`/`suspended` действия, кроме голосования и возобновления, -> 409 `TEAM_STATUS_BLOCKS_ACTION`), таймер `max-duration-scan` (120 дней от старта -> `suspended` с причиной `max_duration`); `startProject` (T4: #4, `status='forming'`, условия состава, `TeamLifecyclePort.onProjectStarted` заглушка); 409 `INVALID_STATE` повторно; CC-13 (часть "Начать").
- Зависимости: S3-03.
- Файлы: `modules/teams/internal/services/start*`, `internal/domain/team-status*`, `jobs/max-duration-scan.ts`.
- Проверка: 20 "Начать" -> 1 x 200.

**S3-10 Уведомления, WebSocket, email (B, M)**
- Критерии: `workspace.notification`, `listNotifications` (курсор), `markNotificationsRead`; обработчик событий teams -> уведомления (предложение, приглашение, место открыто, смена тимлида, голосование); WebSocket `/api/ws` (аутентификация cookie, подписка на каналы пользователя и команды после `assertMember`, события-инвалидации без данных, Redis pub/sub); очередь `notifications` -> email (шаблоны ru).
- Зависимости: S3-04, S1-07.
- Файлы: `modules/workspace/internal/{notifications,realtime}/**` (типы сообщений уже в `packages/shared/src/realtime.ts` из S1-02; новые события добавляет оркестратор до запуска F-задач, B-агент файл не правит).

**S3-11 Frontend: команды (F, M)**
- Критерии: `/teams` (список, фильтры, пагинация), `/teams/new` (форма создания, тип продукта из `listProductTypes`), `/teams/[id]` (состав, места, статус, события); управление местами тимлидом; обработка 409 с понятными сообщениями (`SEAT_TAKEN`, `TEAM_FULL`, `PROJECT_LIMIT`, `OFFER_LIMIT`, `GITHUB_REQUIRED` с переходом к привязке GitHub).
- Зависимости: S3-01; параллельно с B (моки).
- Файлы: `apps/web/src/app/(app)/teams/**`, `features/teams/**`, `i18n/ru/teams.json`.

**S3-12 Frontend: предложения, приглашения, выход (F, M)**
- Критерии: предложения и заявки (создание, список, принять/отклонить), приглашения (создать ссылку, список, отозвать, страница `/invite#token` с превью и принятием), выход и решение о выходе; кнопки блокируются на время запроса, повтор с тем же ключом.
- Зависимости: S3-11.
- Файлы: `apps/web/src/app/(app)/teams/[id]/{seats,offers,invitations}/**`, `app/invite/**`, `features/{offers,invitations}/**`.

**S3-13 Frontend: голосование и уведомления (F, M)**
- Критерии: страница голосования с фазами (выдвижение, голосование, второй тур, подтверждение, предложение), таймер до окончания фазы, `aria-live` для смены фазы, колокольчик уведомлений и WebSocket-клиент с переподключением и инвалидацией TanStack Query.
- Зависимости: S3-11.
- Файлы: `apps/web/src/app/(app)/teams/[id]/vote/**`, `features/{votes,notifications}/**`, `lib/realtime.ts`.

**S3-14 Дополнение тестов (T, M)**
- Критерии: граничные случаи (повторное выдвижение, голос после смены фазы, выход последнего участника, предложение на закрытое место, приглашение удалённому пользователю, удаление аккаунта во время вступления).
- Зависимости: S3-03..S3-13.
- Файлы: `modules/{teams,playbooks,workspace}/test/**`, `apps/web/e2e/slice3.spec.ts`, `apps/api/test/fixtures/**`.

### Параллельность

B: S3-02 -> S3-03 -> (S3-04 -> S3-05, S3-06 -> S3-07 -> S3-08, S3-09 параллельно после S3-03; разные файлы `internal/services/*`, миграции готовы в S3-02); S3-10 параллельно после S3-04. F: S3-11 -> (S3-12, S3-13) параллельно с B на моках, затем сквозная проверка.

### Тесты среза

- API по контракту: 35 операций, негативные коды: 409 `GITHUB_REQUIRED` (createTeam, acceptSeatOffer, acceptInvitation, createJoinRequest без привязанного GitHub), 403 `NOT_TEAM_LEAD`, 404 чужой ресурс, 409 `SEAT_TAKEN`/`TEAM_FULL`/`OFFER_LIMIT`/`INVALID_STATE`/`VERSION_CONFLICT`, 410 `INVITATION_GONE`, 422.
- Конкурентный доступ (реальная БД через PgBouncer, N не менее 20, `--repeat 5`):
  - CC-1: 20 пользователей с 20 предложениями на одно место -> 1 x 200, 19 x 409 `SEAT_TAKEN`; ровно 1 активное `seat_assignment`, `member_count` +1.
  - CC-2: (а) один пользователь принимает 5 предложений в 5 команд -> успехов не больше лимита (2); (б) 10 пользователей на 10 мест команды из 7 участников -> 1 успех, 9 x `TEAM_FULL`; (в) создание команды + 2 вступления параллельно у пользователя с 1 проектом -> лимит не превышен.
  - CC-4: (а) 20 голосов одного участника -> 1 x 201, 19 x 409; (б) 20 параллельных "тимлид вышел" + "запрос неактивности" -> одно открытое голосование; (в) последний голос и обработчик срока на `FakeClock` -> один `lead_changed`, один `outcome`.
  - CC-8: 10 пользователей, один токен приглашения -> 1 x 200, 9 x 410.
  - CC-13 (часть): 20 "Начать" -> 1 x 200.
  - Из 12.3: закрытие места против вступления (один исход, место не потеряно), выход против вступления, лимит предложений 30/10, лимит приглашений C-13, решение тимлида против таймера.
  - Для каждого парный тест повтора с тем же `Idempotency-Key`.
- IDOR: `getTeam`/`listInvitations`/`createSeatOffer` чужой командой (404 для постороннего, 403 `NOT_TEAM_LEAD` для участника без прав); `updateSeat` с `seatId` другой команды -> 404; `acceptSeatOffer` чужим пользователем -> 403/404 по `offer-party`; `revokeInvitation` с `invitationId` другой команды -> 404; `castBallot` не участником голосования -> 403; `decideDeparture` не тимлидом -> 403; `listTeamEvents` посторонним -> 404; `markNotificationsRead` по чужим уведомлениям -> 404; WebSocket-подписка на чужую команду отклоняется.
- Playwright `slice3.spec.ts` (два-три контекста браузера): (1) пользователь A входит, создаёт команду типа "Веб-сервис" с 3 местами; (2) A создаёт приглашение, копирует ссылку; (3) пользователь B открывает ссылку, видит превью, принимает; у A в реальном времени появляется уведомление и новый участник; (4) A делает предложение пользователю C, C принимает; (5) D и E одновременно (двумя контекстами) принимают предложения на последнее место: один успех, у второго понятное сообщение; (6) A стартует проект (статус "активна"); (7) A выходит - запускается голосование; B выдвигается, голосуют B и C, B становится тимлидом; (8) axe на страницах.

### Проверка задач без собственной строки "Проверка"

Шаги Playwright `slice3.spec.ts`: 1 создание команды, 2 приглашение, 3 принятие и уведомление в реальном времени, 4 предложение, 5 гонка за последнее место, 6 старт проекта, 7 выход тимлида и голосование, 8 axe.

| Задача | Чем проверяется |
|---|---|
| S3-01 | перед реализацией все тесты среза падают (вывод в отчёте) |
| S3-02 | миграция с чистой базы (`\dt teams.*`), контрактные тесты портов `DeficitPort`/`TeamLifecyclePort` с заглушками, сид `0.0.1` |
| S3-07 | таблица тестов по диаграмме автомата (95%), CC-4 (б), включённый тест выхода тимлида из S3-06; шаг 7 (выдвижение) |
| S3-10 | шаг 3 (уведомление приходит без перезагрузки), IDOR-тест подписки WebSocket, письмо в Mailpit |
| S3-11 | шаги 1, 5, 6, 8 |
| S3-12 | шаги 2, 3, 4, 5 |
| S3-13 | шаги 3 (колокольчик), 7, 8 |
| S3-14 | граничные тесты из критериев зелёные |

### Безопасность

Обязателен security-auditor (команды): авторизация по `x-authz` и цепочки владения, токены приглашений (хэш, одноразовость, перебор), гонки вступления, раскрытие информации через превью и списки, WebSocket (авторизация подписок), утечка голосов (кто за кого).

### Критерий готовности (фаза 6)

Как в срезе 1 плюс: все CC среза проходят `--repeat 5`; IDOR-матрица зелёная; security-auditor без CRITICAL/HIGH; `slice3.spec.ts` пройден; покрытие автомата голосования не ниже 95%.

### Риски среза

| Риск | Мера |
|---|---|
| Порядок блокировок нарушен в одном из путей, дедлок | Хелперы блокировок бросают ошибку порядка в тестах (S1-05); повтор 40P01 до 3 раз; CC-тесты с `--repeat 5` |
| Голосование - много состояний и таймеров | Чистый автомат + таблица тестов по диаграмме; сканер как страховка потери отложенных задач |
| `DeficitPort` и `TeamLifecyclePort` как заглушки | Контрактные тесты портов, чтобы срезы 4 и 5 подставили реализации без изменения teams |
| Объём среза (35 операций) | Делится на две сессии при необходимости по границе S3-06 (команды и вступление / выход и голосование); решение оркестратора |

---

## Срез 4. Подбор и очередь поиска

**Цель.** Кандидат встаёт в очередь поиска, видит витрину спроса по ролям и рекомендованные команды; тимлид видит рекомендованных кандидатов на место; свободное место автоматически заполняется подходящим кандидатом из очереди; автодобавленный участник проходит испытательный срок, в котором тимлид может его исключить.

**Входящие FR.** FR-MATCH-01..12, FR-PROF-07 (витрина спроса в профиле), FR-TEAM-22..24 (FR-TEAM-23 - выход автодобавленного участника), реализация `DeficitPort` (для FR-TEAM-25, владелец - срез 3), CC-3, CC-10. Операции: 9.

**Таблицы и миграции.** `matching`: `search_application`, `application_role`, `application_exclusion`, `match_candidate`, `candidate_stats`, `wait_sample`, `auto_add_log` (+ `search_application_active_uq`, версия). В `teams` ничего нового (поля `joined_via`, `trial_until`, `trial_confirmed_at` уже заложены в срезе 3; если нет - миграция расширения здесь).

### Задачи

**S4-01 Тесты среза до реализации (T, M)**
- Критерии: API по контракту (9 операций), CC-3 (а, б, в), CC-10, IDOR, гонки "исключение против истечения срока", выход автодобавленного участника в испытательный срок (FR-TEAM-23), Playwright `slice4.spec.ts`; фикстуры `searchApplication`, `teamWithDemand`; падают.
- Зависимости: срез 3 принят.
- Файлы: `modules/matching/test/**`, `apps/web/e2e/slice4.spec.ts`, `apps/api/test/fixtures/**`.

**S4-02 Заявка в очередь (B, M)**
- Критерии: миграция; `getMySearchApplication`, `createSearchApplication` (CC-10: `search_application_active_uq`, 409 `APPLICATION_EXISTS`), `updateSearchApplication` (lock #1 -> #2 + `version`), `cancelSearchApplication`; роли с приоритетами из профиля; исключённые команды; лимит активных проектов учитывается; нужен привязанный GitHub (FR-AUTH-05, FR-GH-09 для автодобавления).
- Зависимости: S4-01.
- Файлы: `modules/matching/internal/{schema,services,controllers}/application*`.

**S4-03 Дефицит и витрина спроса (B, M)**
- Критерии: реализация `DeficitPort` в matching (подключается в `AppModule`), `getRoleDemand` (открытые места по ролям, размер очереди, среднее время ожидания по `wait_sample`; кэш в Redis с коротким TTL, пересчёт по событиям), `deficit_at_join` записывается при вступлении (T1/T2) и не меняется; события `teams.seat_opened`/`member_joined` -> пересчёт.
- Зависимости: S4-02.
- Файлы: `modules/matching/internal/demand/**`, `app.module.ts` (привязка порта).
- Проверка: контрактный тест порта (из среза 3) с реальной реализацией; параллельные вступления на разные места одной роли (риск 17.7 принят, фиксируется тестом на границе).

**S4-04 Оценка и рекомендации (B, M)**
- Критерии: чистые функции оценки в `domain/` (жёсткие фильтры, веса C-44a..e, 95% покрытия); задача `matching-recompute` (предрасчёт `match_candidate`, `candidate_stats`) по событиям и расписанию; `listRecommendedTeams` (кандидату), `listSeatCandidates` (тимлиду, место принадлежит команде - цепочка), курсорная пагинация, без запросов в цикле (тест на число SQL-запросов).
- Зависимости: S4-02.
- Файлы: `modules/matching/internal/{domain,jobs,services}/score*`, `recommend*`.

**S4-05 Автодобавление (B, M)**
- Критерии: `matching-auto-add` (окно C-38 = 60 с, одновременные пары, приоритеты и справедливость по `enqueued_at`), T2 на пару: lock #1 -> #2 (`status='active'`) -> `TeamsApi.joinSeat`; результат пары в `auto_add_log.outcome` (пропуск при проигрыше гонки), `wait_sample`, заявка `fulfilled`; уведомление кандидату и тимлиду; `joined_via='auto'`, `trial_until` = +7 дней.
- Зависимости: S4-03, S4-04.
- Файлы: `modules/matching/internal/jobs/auto-add*`, `services/auto-add*`.
- Проверка: CC-3 (а, б, в).

**S4-06 Испытательный срок и возврат (B, M)**
- Критерии: `excludeTrialMember` (тимлид, только `joined_via='auto'` и `trial_until > :now AND trial_confirmed_at IS NULL`; #4 -> #6; 409 `TRIAL_EXPIRED`/`NOT_AUTO_ADDED`; исключённый возвращается в очередь по FR-MATCH-08 с переносом исключений и раннего `enqueued_at`, Р-15), `confirmTrial`, таймер `trial-expire`; событие `teams.member_excluded` -> matching; FR-TEAM-23: `leaveTeam` автодобавленного участника в испытательный срок проходит без последствий и в очередь не возвращает (тест).
- Зависимости: S4-05.
- Файлы: `modules/teams/internal/services/trial*`, `modules/matching/internal/events/**`.
- Проверка: исключение против истечения срока на `FakeClock` -> один исход; исключение чужой командой -> 404.

**S4-07 Frontend: очередь поиска и витрина (F, M)**
- Критерии: `/search` (форма заявки: роли с приоритетами, исключённые команды, статус заявки, отмена, предупреждение об изменении), `/demand` (витрина спроса: роли, число открытых мест, очередь, время ожидания); состояния пусто/ошибка/загрузка; конфликт версии.
- Зависимости: S4-01; контракты готовы, моки из S1-09.
- Файлы: `apps/web/src/app/(app)/search/**`, `app/(app)/demand/**`, `features/matching/**`, `i18n/ru/matching.json`; блок витрины по желаемым ролям на `/profile` (FR-PROF-07) - компонент `features/matching/RoleDemandBlock.tsx`, в странице профиля подключается одной строкой.

**S4-08 Frontend: рекомендации и испытательный срок (F, M)**
- Критерии: блок "Рекомендованные команды" с объяснением совпадения и кнопкой `createJoinRequest`; на странице места тимлида список кандидатов с кнопкой "предложить"; бейдж испытательного срока в составе, кнопки "исключить" и "подтвердить"; реальное время (событие автодобавления).
- Зависимости: S4-07 (оболочка и навигация среза).
- Файлы: `apps/web/src/app/(app)/teams/[id]/seats/[seatId]/**`, `features/{recommendations,trial}/**`.

**S4-09 Дополнение тестов (T, S)**
- Критерии: граничные случаи (место закрыто во время автодобавления, удаление аккаунта кандидата в очереди, заявка без GitHub, 2 параллельных запуска `runAutoAdd` при смене заявки).
- Зависимости: S4-02..S4-08.
- Файлы: `modules/matching/test/**`, `apps/web/e2e/slice4.spec.ts`, `apps/api/test/fixtures/**`.

### Параллельность

B: S4-02 -> (S4-03, S4-04 параллельно) -> S4-05 -> S4-06. F: S4-07 и S4-08 параллельно на моках.

### Тесты среза

- API по контракту: 9 операций, негативные: 409 `APPLICATION_EXISTS`/`VERSION_CONFLICT`/`TRIAL_EXPIRED`/`NOT_AUTO_ADDED`, 409 `GITHUB_REQUIRED` без привязанного GitHub, 404 чужое место.
- Конкурентный доступ:
  - CC-3 (а) два `runAutoAdd()` одновременно, 1 заявка, 3 подходящих места -> кандидат добавлен 1 раз, заявка `fulfilled` 1 раз, `wait_sample` 1 строка; (б) 20 заявок, 1 место, 2 параллельных запуска -> ровно 1 `seat_assignment`, остальные `active`; (в) автодобавление и ручное `acceptSeatOffer` того же пользователя при 1 свободном слоте лимита -> ровно одно успешно.
  - CC-10: 10 параллельных `createSearchApplication` -> 1 заявка, 9 x 409; `updateSearchApplication` параллельно с автодобавлением -> либо изменение до добавления, либо 409/404 после `fulfilled`.
  - Исключение против истечения испытательного срока (12.3).
  - Парные тесты повтора ключа.
- IDOR: `getMySearchApplication`/`update`/`cancel` только свои (`self`); `listSeatCandidates` с `seatId` другой команды -> 404, не тимлидом -> 403; `excludeTrialMember` с `userId` не из команды -> 404; рекомендации не раскрывают скрытые поля профиля.
- Playwright `slice4.spec.ts`: (1) тимлид создаёт команду с открытым местом "Backend"; (2) кандидат (с привязанным GitHub) встаёт в очередь на роль Backend; (3) на `/demand` счётчики очереди и спроса изменились; (4) срабатывает автодобавление (воркер запущен в стеке; часы теста продвигаются через тестовый эндпоинт запуска `matching-auto-add`, доступный только в `NODE_ENV=test`); (5) кандидат видит себя в составе с отметкой испытательного срока, тимлид получил уведомление; (6) тимлид исключает его - кандидат снова в очереди с прежним временем ожидания; (7) кандидат открывает рекомендованные команды и подаёт заявку на место; (8) axe.

### Проверка задач без собственной строки "Проверка"

Шаги Playwright `slice4.spec.ts`: 1 команда с местом, 2 очередь кандидата, 3 витрина, 4 автодобавление, 5 отметка испытательного срока, 6 исключение и возврат, 7 рекомендации и заявка, 8 axe.

| Задача | Чем проверяется |
|---|---|
| S4-01 | перед реализацией тесты падают (вывод в отчёте) |
| S4-02 | CC-10 (10 параллельных `createSearchApplication`), негативные 409 `GITHUB_REQUIRED`/`APPLICATION_EXISTS`; шаг 2 |
| S4-04 | тест числа SQL-запросов в `listRecommendedTeams`/`listSeatCandidates`, покрытие `domain/` 95%; шаг 7 |
| S4-07 | шаги 2, 3, 8 и блок витрины в профиле |
| S4-08 | шаги 5, 6, 7 |
| S4-09 | граничные тесты из критериев зелёные |

### Безопасность

Обязателен security-auditor (подбор): справедливость очереди и невозможность обхода (приоритеты, мультизаявки), IDOR на кандидатах и рекомендациях, утечка скрытых полей профиля через рекомендации, злоупотребление автодобавлением (AF-правила, лимиты), тайминговое раскрытие очереди.

### Критерий готовности (фаза 6)

Как в срезе 1 плюс: CC-3, CC-10 `--repeat 5` зелёные; покрытие оценки и автодобавления не ниже 95%; security-auditor без CRITICAL/HIGH; `slice4.spec.ts` пройден.

### Риски среза

| Риск | Мера |
|---|---|
| Справедливость и производительность подбора, N+1 | Предрасчёт, тест на число запросов, индексы из 5.10; нагрузочная проверка в фазе 7 |
| Параллельные вступления видят устаревший дефицит (17.7) | Принято спецификацией; тест фиксирует границу поведения |
| Время тестов автодобавления (окно 60 с) | `FakeClock` и прямой вызов процессора (`processor.process(job)`) |
| Веса и формулы оценки (C-44a..e) неоднозначны | Вынести в конфигурацию (раздел 7 spec), константы не менять без решения; вопросы оркестратору |

---

## Срез 5. Маршрут проекта

**Цель.** Опубликованный сценарий (веб-сервис, ML-продукт) загружается из YAML в базу; у стартовавшей команды появляется маршрут: этапы, чек-лист каждого этапа, назначение исполнителей, файлы артефактов, ссылки с автопроверкой, чек-лист ревью, запасные шаги; тимлид переводит команду на следующий этап, когда условия выполнены.

**Входящие FR.** FR-PLAY-01..05, FR-PLAY-07..08 (FR-PLAY-06 - срез 3), FR-WORK-01..07, FR-WORK-09..12, FR-WORK-18 (приостановка: таймеры этапов и плановая дата; статус `suspended` ставит срез 3), CC-5, CC-7, CC-13 (часть "Начать": первый этап). Операции: 18.

**Таблицы и миграции.** `playbooks`: `stage`, `step`, `step_review_item`, `step_fallback`, `platform_template` (+ расширение `playbook`: `source_text`, `sha256`, `status`). `workspace`: `project_stage`, `checklist_item`, `artifact_file`, `project_storage_usage`, `review_answer`, `review_risk`, `participation_confirm`, `release_check` (часть, нужная ссылкам; `completion_check` - срез 6). Индексы: `project_stage_one_open_uq`, `UNIQUE (project_stage_id, step_key)`, `UNIQUE (playbook_id, key)` и т.д.

### Задачи

**S5-01 Тесты среза до реализации (T, M)**
- Критерии: API по контракту (18 операций), CC-5, CC-7, гонки с файлами и квотами (12.3), IDOR, Playwright `slice5.spec.ts`; фикстура мини-сценария (3 этапа) и проверка полных сценариев; все падают.
- Зависимости: срез 4 принят.
- Файлы: `modules/{playbooks,workspace}/test/**`, `apps/api/test/fixtures/playbooks/**`, `apps/web/e2e/slice5.spec.ts`.

**S5-02 Загрузка сценариев из YAML (B+I, M)**
- Критерии: миграция playbooks; безопасный разбор (`yaml.parse`, schema core, без тегов, `maxAliasCount: 0`, до 1 МБ); zod по структуре `docs/playbooks.md` 2.1; доменные правила FR-PLAY-02 (роли из справочника, шаблоны из каталога, `auto_checks` из каталога 2.4, уникальность ключей `(playbook_id, key)`); ошибки 422 `PLAYBOOK_INVALID` со списком `errors[]` (JSON Pointer), предупреждения `warnings[]` (сумма вне 10-16 недель); версия semver строго больше (409 `PLAYBOOK_VERSION_NOT_GREATER`); `uploadPlaybook`, `publishPlaybook` (неизменяемость после публикации), `adminListPlaybooks`; CLI `playbooks:load <file> [--publish]`; скрипт `scripts/extract-playbook-seeds.mjs` извлекает YAML-блоки 3.2 и 4.3 из `docs/playbooks.md` в `apps/api/seeds/playbooks/{web_service,ml_product}.yaml` (проверка: `total_days` 84 и 91; запуск в контейнере `migrate`); каталог шаблонов платформы (`platform_template`, раздел 5 playbooks.md), `getTemplate`.
- Зависимости: S5-01.
- Файлы: `modules/playbooks/internal/{loader,schema,controllers}/**`, `apps/api/seeds/playbooks/**`, `scripts/extract-playbook-seeds.mjs`, `docker/migrate/**`.
- Проверка: оба сценария загружаются и публикуются из `docs/playbooks.md`; сломанные фикстуры (дубль ключа, неизвестная роль, неизвестная проверка, YAML-якоря) дают полный список ошибок.

**S5-03 Чтение сценариев (B, S)**
- Критерии: `listPlaybooks`, `getPlaybook` (этапы, шаги, пункты ревью, запасные шаги), `PlaybooksApi.getDefinition(id)` с кэшем по id (опубликованное неизменно); замена заглушек `0.0.1` на `1.0.0`.
- Зависимости: S5-02.
- Файлы: `modules/playbooks/internal/read/**`.

**S5-04 Маршрут проекта: этапы и чек-лист (B, M)**
- Критерии: миграция workspace; реализация `TeamLifecyclePort.onProjectStarted` в workspace: в транзакции T4 открывается этап 1, создаются пункты чек-листа из шагов (`UNIQUE (project_stage_id, step_key)`), исполнители назначаются из состава по ролям; `listStages` (статус, сроки, просрочка по проекту целиком), `getStageChecklist`; плановая дата окончания фиксируется при старте и продлевается на время `suspended` (FR-WORK-12, -18); `getTeam` показывает текущий этап.
- Зависимости: S5-03, срез 3 (порт).
- Файлы: `modules/workspace/internal/{schema,services,controllers}/stage*`, `checklist*`, `app.module.ts` (привязка порта).
- Проверка: CC-13 "Начать" x20 -> 1 первый этап.

**S5-05 Правка пунктов и запасные шаги (B, M)**
- Критерии: `updateChecklistItem` (PATCH с `version`: условный `UPDATE ... WHERE version=:v`, 0 строк -> 409 `VERSION_CONFLICT` с `current`; перед этим `project_stage FOR SHARE` (#8); статус `done` проверяет обязательные автопроверки), `assignChecklistItem` (исполнитель из состава), `revertFallback` (замена запасным шагом и возврат); ссылки: https и защита от SSRF при сохранении (запрещённые схемы отклоняются), постановка `auto-checks`; обработчик `teams.member_left`/`member_joined` (architecture 11): пункты вышедшего остаются без исполнителя (FR-TEAM-11), пересчёт `fallback_used`, перераспределение тимлидом через `assignChecklistItem` (FR-TEAM-13, список "задачи без исполнителя"). Проверка обязательных автопроверок при `done` включается после S5-09.
- Зависимости: S5-04.
- Файлы: `modules/workspace/internal/services/item*`, `fallback*`.
- Проверка: CC-7 (2 и 20 параллельных записей с версией N).

**S5-06 Файлы артефактов (B, M)**
- Критерии: `uploadArtifactFile` (multipart через API в MinIO `artifacts`; тип по magic bytes из разрешённого списка, 1 КБ..10 МБ, квота проекта 30 файлов и 50 МБ условным `UPDATE project_storage_usage` (409 `PROJECT_STORAGE_LIMIT`), пункт в статусе `open` под блокировкой #9, версия пункта растёт, лимит частоты загрузок), `getArtifactDownloadUrl` (подписанная ссылка на отдельный origin `files.*`, короткий срок), `deleteArtifactFile` (автор файла или тимлид; обратный `UPDATE` квоты); SHA-256 и сигнал `sha_dedup` (балл 0); сирот S3 чистит maintenance.
- Зависимости: S5-05.
- Файлы: `modules/workspace/internal/services/artifact*`, `platform/storage/**`.
- Проверка: 20 параллельных загрузок при запасе квоты в 1 файл -> 1 успех; загрузка против `PATCH status=done` -> один исход.

**S5-07 Чек-лист ревью (B, S)**
- Критерии: `submitReview` (ответы да/нет по `step_review_item`, `review_answer (checklist_item_id, ordinal)`), `acceptReviewRisk` (пункт "нет" принят как риск в протоколе, `review_risk`, только тимлид), блокировка перехода при непройденном ревью; ревьюер не автор артефакта там, где это требует сценарий.
- Зависимости: S5-05.
- Файлы: `modules/workspace/internal/services/review*`.

**S5-08 Переход этапа и участие (B, M)**
- Критерии: `transitionStage` (T5/CC-5: #4 `team` -> #8 `project_stage FOR UPDATE`; условия: обязательные пункты выполнены, ревью пройдено или риск принят, минимум 24 ч на этап (антифрод), последовательность этапов; 409 `STAGE_NOT_OPEN` / 422 с `unmet[]`; следующий этап и его пункты создаются в той же транзакции), `confirmParticipation` (подтверждение участия в этапе), уведомление `stage-due-notify` (таймер; сроки этапов не идут в `suspended`, FR-WORK-18); событие `workspace.stage_changed`.
- Зависимости: S5-05, S5-06 (обязательные артефакты), S5-07, S5-09 (автопроверки в условиях перехода).
- Файлы: `modules/workspace/internal/services/transition*`, `participation*`, `jobs/stage-due-notify.ts`.
- Проверка: CC-5 x20 с разными ключами -> 1 x 201, 19 x 409; пункты следующего этапа созданы 1 раз.

**S5-09 Автопроверки и проверка ссылок (B+I, M)**
- Критерии: очередь `auto-checks` (каталог 2.4: `file_ok`, `sha_dedup`, `link_https`, `ritual_fields`, `min_files`, `md_headings`; `repo_*`, `pr_cross_review`, `ci_workflow` подключаются в срезе 6) и `link-check`; отдельный процесс `link-checker` (контейнер без БД и S3, ACL Redis на `bull:link-check:*`, `SELF_PUBLIC_IPS`); SSRF-клиент по 13.12: https:443, резолв A/AAAA, запрещённые диапазоны IANA, подключение к проверенному IP, SNI/Host, до 3 редиректов с повторной проверкой, тайм-аут 10 с, тело до 1 МБ, пользователю только код причины (`release_check.reason`), лимит 30 проверок/ч на команду и пользователя, не чаще 1/мин на домен; результат записывает `worker`.
- Зависимости: S5-05.
- Файлы: `apps/api/src/link-checker/**`, `modules/workspace/internal/jobs/auto-checks*`, `docker/link-checker/**`, `docker-compose.yml` (сервис).
- Проверка: набор SSRF-тестов (127.0.0.1, 169.254.169.254, `[::1]`, IPv4-mapped IPv6, DNS-rebinding двойник, редирект на внутренний адрес, `http:`, порт 8080, userinfo) -> все `BLOCKED_*`; тест, что контейнер не имеет доступа к PostgreSQL.

**S5-10 Frontend: маршрут и этап (F, M)**
- Критерии: `/teams/[id]/route` (таймлайн этапов, сроки, просрочка по проекту, текущий этап), `/teams/[id]/stages/[n]` (чек-лист: пункты, исполнитель, статус, шаблон по `getTemplate`, запасной шаг с возвратом); `aria-live` для статусов автопроверок.
- Зависимости: S5-01; контракты готовы, моки из S1-09.
- Файлы: `apps/web/src/app/(app)/teams/[id]/{route,stages}/**`, `features/route/**`, `i18n/ru/route.json`.

**S5-11 Frontend: правка пунктов и конфликты версий (F, M)**
- Критерии: изменение статуса и полей пункта с `version`; при 409 показывается актуальное значение и действие "применить мои изменения заново"; назначение исполнителя; ввод ссылок с отображением результата проверки (код причины на русском).
- Зависимости: S5-10.
- Файлы: `features/checklist/**`.

**S5-12 Frontend: файлы и ревью (F, M)**
- Критерии: загрузка файла с прогрессом и ошибками (тип, размер, квота), скачивание по подписанной ссылке, удаление; форма чек-листа ревью, принятие риска тимлидом.
- Зависимости: S5-10.
- Файлы: `features/artifacts/**`, `features/review/**`.

**S5-13 Frontend: переход этапа (F, S)**
- Критерии: кнопка "Перейти к следующему этапу" с перечнем невыполненных условий (`unmet[]`), подтверждение участия, обработка 409 `STAGE_NOT_OPEN` (другой участник уже перевёл), реальное время (событие смены этапа).
- Зависимости: S5-10.
- Файлы: `features/transition/**`.

**S5-14 Дополнение тестов (T, M)**
- Критерии: граничные случаи (удаление файла при `done`, этап с запасным шагом, повторная загрузка файла после отката квоты, переход при выходе исполнителя, YAML-атаки, смена тимлида посреди перехода).
- Зависимости: S5-02..S5-13.
- Файлы: `modules/{playbooks,workspace}/test/**`, `apps/web/e2e/slice5.spec.ts`, `apps/api/test/fixtures/**`.

### Параллельность

B: S5-02 -> S5-03 -> S5-04 -> S5-05 -> (S5-06, S5-07, S5-09 параллельно, разные файлы) -> S5-08. F: S5-10 затем S5-11, S5-12, S5-13 параллельно (разные каталоги `features/*`). Миграции workspace и playbooks создаются в S5-02 и S5-04 последовательно.

### Тесты среза

- API по контракту: 18 операций; негативные: 422 `PLAYBOOK_INVALID` (полный список), 409 `PLAYBOOK_VERSION_NOT_GREATER`/`STAGE_NOT_OPEN`/`VERSION_CONFLICT`/`PROJECT_STORAGE_LIMIT`/`INVALID_STATE`, 413/415, 422 с `unmet[]`, 429 лимиты загрузки и проверок.
- Конкурентный доступ:
  - CC-5: 20 "Перейти" с разными ключами -> 1 x 201, 19 x 409; открытых этапов 1; пункты следующего этапа созданы 1 раз.
  - CC-7: 2 и 20 параллельных записей с версией N -> 1 успех (N+1), остальные 409, потерянных записей нет.
  - CC-13: 20 "Начать" -> первый этап 1; "Перейти" против "Завершить" на последнем этапе (когда завершение появится в срезе 6, тест достраивается).
  - Квота файлов: 20 параллельных загрузок при остатке 1 -> 1 успех, `files_count` и `bytes_total` не превышают лимит.
  - Файл против изменения пункта: загрузка и `PATCH status=done` параллельно -> один исход, версия пункта согласована.
  - Параллельная публикация одной версии сценария x10 -> 1 успех.
  - Парные тесты повтора ключа.
- IDOR: `getStageChecklist` с `ordinal` чужой команды -> 404; `updateChecklistItem` с `itemId` другой команды в пути -> 404; `getArtifactDownloadUrl` с `fileId` другого пункта -> 404; подписанная ссылка не открывается для файла другого проекта; `deleteArtifactFile` не автором и не тимлидом -> 403; `acceptReviewRisk` не тимлидом -> 403; админ-операции сценариев обычным пользователем -> 403; игнор попыток передать `teamId` в теле.
- Playwright `slice5.spec.ts`: (1) администратор (через API-хелпер) загружает и публикует сценарий; (2) команда из 3 участников создана (фикстура) и стартует проект; (3) на `/route` виден этап 1 и его пункты; (4) участник загружает файл, вставляет ссылку (двойник проверяет её), помечает пункт выполненным; (5) два участника одновременно меняют один пункт: у второго показан конфликт версий и актуальное значение; (6) выполняется чек-лист ревью, один пункт "нет" принимается как риск тимлидом; (7) нажатие "Перейти" до выполнения условий показывает список невыполненного; после выполнения переход успешен, открыт этап 2; (8) попытка вставить `http://127.0.0.1` отклонена с понятным сообщением; (9) axe.

### Проверка задач без собственной строки "Проверка"

Шаги Playwright `slice5.spec.ts`: 1 публикация сценария, 2 старт проекта, 3 маршрут, 4 файл, ссылка, пункт выполнен, 5 конфликт версий, 6 ревью и риск, 7 переход этапа, 8 SSRF-ссылка отклонена, 9 axe.

| Задача | Чем проверяется |
|---|---|
| S5-01 | перед реализацией тесты падают (вывод в отчёте) |
| S5-03 | API-тесты `listPlaybooks`/`getPlaybook`, тест замены `0.0.1` на `1.0.0` (команда после замены получает `1.0.0`); шаги 1-2 |
| S5-07 | API-тесты `submitReview`/`acceptReviewRisk`, блокировка перехода без ревью; шаг 6 |
| S5-10 | шаги 2, 3, 9 |
| S5-11 | шаги 4, 5, 8 |
| S5-12 | шаги 4, 6 |
| S5-13 | шаг 7 (в том числе список `unmet[]` и 409 `STAGE_NOT_OPEN` у второго участника) |
| S5-14 | граничные тесты из критериев зелёные |

### Безопасность

Обязателен security-auditor (маршрут): загрузка файлов (тип, размер, хранение вне каталога приложения, подписанные ссылки, origin `files.*`), SSRF-клиент проверок ссылок (SEC-05), YAML-разбор (бомбы, теги), IDOR по цепочке `teamId/itemId/fileId`, антифрод минимальных сроков, раскрытие чужих файлов.

### Критерий готовности (фаза 6)

Как в срезе 1 плюс: оба сценария из `docs/playbooks.md` загружаются командой `playbooks:load` в контейнере `migrate`; CC-5, CC-7, квота `--repeat 5` зелёные; SSRF-набор зелёный; security-auditor без CRITICAL/HIGH; `slice5.spec.ts` пройден.

### Риски среза

| Риск | Мера |
|---|---|
| YAML в `docs/playbooks.md` содержит спорные места (раздел 6 "Шаги для вычитки"), вычитка человеком не сделана | Загрузчик строго валидирует; изменения сценария - только новой версией (1.0.1+); вычитку человеком записать открытым вопросом |
| Запасные шаги `w6_*` для команды из 3 человек (backlog MEDIUM) | Тест на команде из 3 человек; найденное - в backlog |
| SSRF-клиент сложный, ошибки дают дыру | Отдельный процесс без доступа к БД, набор негативных тестов, security-auditor |
| Объём (18 операций, много автоматических проверок) | Если не помещается в одну сессию - делить по границе S5-05/S5-06 (маршрут и чек-лист / файлы, ревью, переход), решение оркестратора |

---

## Срез 6. Рабочее пространство и интеграция GitHub

**Цель.** Команда привязывает репозиторий через GitHub App, события issue и PR попадают в ленту задач как вклад участников с ролями; тимлид завершает проект после автопроверок репозитория и релиза; снимок завершения фиксирует состав и вклад.

**Входящие FR.** FR-GH-01..11, FR-WORK-13..17 (завершение, проверка релиза, просрочка в итогах, лента, вклад, роль вклада), CC-9, CC-11, CC-13. Операции: 14.

**Таблицы и миграции.** `github`: `gh_installation`, `installation_grant`, `repo_link`, `webhook_delivery`, `gh_item`, `gh_pr_review`, `repo_sync_state`, `repo_check`, `account_check` (+ `repo_link_repository_uq`, `repo_link_team_active_uq`). `workspace`: `contribution` (`contribution_uq (team_id, source, ref, user_id)`), `completion_check`, `project_completion` (PK `team_id`), расширение `release_check`.

### Задачи

**S6-01 Прототип состояния установки GitHub App (B, S) - первым**
- Что проверить (backlog, architecture 17.2, 7.2): возврат `state` после установки GitHub App (одноразовое значение, привязка к пользователю и команде, срок), поведение при установке от имени организации, повторная установка, отзыв установки, права Metadata/Issues/PR/Actions read; работа на двойнике GitHub и, если есть тестовое App, вручную.
- Критерии: записка оркестратору с подтверждённым потоком; если `state` не возвращается, запасной вариант - привязка по `installation_id` из `setup_action` + проверка владельца через OAuth-токен пользователя.
- Зависимости: срез 5 принят.
- Файлы: `apps/api/src/modules/github/spike/**` (временно; собственный минимальный двойник внутри `spike/**`: каталог `apps/api/test/fakes/**` принадлежит T и расширяется в S6-02).

**S6-02 Тесты среза до реализации (T, M)**
- Критерии: двойник GitHub (App JWT, установки, `/app/installations/*/access_tokens`, репозитории, issues, PR, contributors, workflow runs, вебхуки с корректной и неверной подписью); API по контракту (14 операций), CC-9, CC-11, CC-13 полностью, IDOR, Playwright `slice6.spec.ts`; падают.
- Зависимости: S6-01 (подтверждённый поток `state`).
- Файлы: `modules/{github,workspace}/test/**`, `apps/api/test/fakes/**`, `apps/web/e2e/slice6.spec.ts`.

**S6-03 GitHub App: клиент и установка (B, M)**
- Критерии: миграции среза: `github` и таблицы `workspace` среза 6 (`contribution`, `completion_check`, `project_completion`, расширение `release_check`; S6-05..S6-08 миграции не создают); клиент Octokit (ESM: `@octokit/core` 7, `auth-app` 8, `webhooks` 14, `plugin-throttling` 11), JWT App, токены установки в памяти/Redis с коротким сроком; `createInstallationSession` (одноразовый `state`), `githubSetupCallback` (GET, проверка `state`, привязка установки к пользователю; в логах `state` и `code` не пишутся), `listAvailableRepositories`; установка принадлежит аккаунту, а не команде (смена тимлида не передаёт её); ограничение: репозиторий публичный.
- Зависимости: S6-01, S6-02.
- Файлы: `modules/github/internal/{client,installation,schema}/**`.

**S6-04 Привязка репозитория (B, M)**
- Критерии: `linkRepository` (CC-9: `INSERT repo_link`, `23505` по имени индекса -> 409 `REPO_TAKEN`; `repo_link_team_active_uq`; проверка по `repository.id`, не архивирован, публичный; только тимлид), `getRepository`, `unlinkRepository` (завершённый проект отвязать нельзя); `GithubApi.markRepositoryCompleted`; проверки `repo_exists` для автопроверок среза 5.
- Зависимости: S6-03.
- Файлы: `modules/github/internal/services/repo*`.
- Проверка: CC-9 (2 и 20 команд, 1 репозиторий).

**S6-05 Вебхуки и вклад (B, M)**
- Критерии: `receiveGithubWebhook` (сырое тело, `X-Hub-Signature-256`, неверная подпись -> 401, `webhook_delivery` PK `delivery_id` `ON CONFLICT DO NOTHING`, 202 без обработки повторов, ответ быстро, задача `github-webhook` с `jobId=delivery_id`); процессор: issues и PR -> `gh_item`, ревью PR -> `gh_pr_review`, событие `github.contribution_detected` -> workspace создаёт `contribution` (`ON CONFLICT DO NOTHING`, несколько исполнителей, FR-GH-05); zod-валидация полезной нагрузки; sweeper `webhook-sweeper`; лимит по IP (LOW backlog).
- Зависимости: S6-04.
- Файлы: `modules/github/internal/{webhook,jobs}/**`, `modules/workspace/internal/events/contribution*`.
- Проверка: CC-11 (одна доставка x10 -> 1 `webhook_delivery`, 1 `contribution`).

**S6-06 Суточная сверка и проверки аккаунтов (B, M)**
- Критерии: `github-sync` ежедневно: догрузка пропущенных issues/PR, `repo_check`, `account_check` (возраст аккаунта, FR-GH-09 для `pending_account`), учёт лимитов и `Retry-After`, инкрементальная позиция `repo_sync_state`; вебхук + сверка параллельно -> 1 `contribution`; проверки `repo_final`, `pr_cross_review`, `ci_workflow` для автопроверок.
- Зависимости: S6-05.
- Файлы: `modules/github/internal/jobs/sync*`, `services/checks*`.

**S6-07 Лента, вклад и роль вклада (B, M)**
- Критерии: `getTeamFeed` (курсор, фильтры по исполнителю, статусу, источнику), `getContributionSummary` (по участникам и ролям), `relabelContribution` (смена роли вклада: `TeamsApi.lockTeam(teamId,'share')`, только статус `active`, роль участника из его ролей; метки фиксируются при завершении, FR-WORK-17), атрибуция по умолчанию из роли исполнителя (7.6); вклад из артефактов и ритуалов (FR-WORK-16, -17; без него зачёт по FR-REW-01 участникам без GitHub-вклада невозможен): обработчик `workspace.item_updated` создаёт `contribution` (`source` `artifact`/`ritual`, `ref` `item:<itemId>`, роль по `owner_role` шага или выбору участника) при `done`, `active=false` при возврате пункта в `open`; события реального времени `feed.updated`.
- Зависимости: S6-05.
- Файлы: `modules/workspace/internal/{feed,contribution}/**`.

**S6-08 Завершение проекта (B, M)**
- Критерии: `requestCompletionCheck` (постановка проверок `repo_final`, `release_alive_*` с двумя проверками с интервалом не менее 24 ч, `link-checker`; результаты `completion_check`), `getLatestCompletionCheck`; ссылка на релиз - T7 (`TeamsApi.setReleaseUrl` под #4); `completeProject` (T6/CC-13: #4 `team` -> `status='active'`, все этапы пройдены, минимум 14 календарных дней, проверки зелёные, блок-правила AF-01, AF-02, AF-04, AF-09, AF-10 (реализуются здесь как условия завершения в `workspace/internal/domain/completion-rules.ts`; S7-03 использует те же условия как сигналы, а не дубль кода); `project_completion` со снимком: состав, места с `desired`, назначения с `deficit_at_join`, вклад с ролями, подтверждения участия, этапы, `overdue_days`; `TeamsApi.markCompleted`, `GithubApi.markRepositoryCompleted`; событие `workspace.project_completed`), `getCompletion`; снимок неизменяем (триггер/ограничение).
- Зависимости: S6-06, S6-07, срез 5.
- Файлы: `modules/workspace/internal/services/completion*`, `jobs/completion-check*`.
- Проверка: 20 "Завершить" -> 1 x 201, одна строка `project_completion`; "Завершить" против "Перейти" на последнем этапе -> один исход.

**S6-09 Frontend: подключение GitHub (F, M)**
- Критерии: `/teams/[id]/github`: кнопка установки App (редирект), страница возврата с результатом, выбор репозитория из `listAvailableRepositories`, привязка/отвязка, статусы (`REPO_TAKEN`, не публичный, архивирован); состояния ошибок на русском.
- Зависимости: S6-02; контракты готовы, моки из S1-09.
- Файлы: `apps/web/src/app/(app)/teams/[id]/github/**`, `app/github/setup/**`, `features/github/**`, `i18n/ru/github.json`.

**S6-10 Frontend: лента и вклад (F, M)**
- Критерии: `/teams/[id]/feed` (лента задач и PR, фильтры, бесконечная прокрутка по курсору, обновление по WebSocket), сводка вклада по участникам и ролям, смена роли вклада с подтверждением.
- Зависимости: S6-02; контракты готовы, моки из S1-09.
- Файлы: `apps/web/src/app/(app)/teams/[id]/feed/**`, `features/feed/**`, `features/contribution/**`.

**S6-11 Frontend: завершение проекта (F, M)**
- Критерии: мастер завершения: ссылка на релиз, запуск проверок, статус каждой проверки (с причинами кодами), таймер до второй проверки релиза, кнопка "Завершить проект", экран итогов `getCompletion` со снимком.
- Зависимости: S6-02; контракты готовы, моки из S1-09.
- Файлы: `apps/web/src/app/(app)/teams/[id]/complete/**`, `features/completion/**`.

**S6-12 Дополнение тестов (T, M)**
- Критерии: граничные случаи (отзыв установки, вебхук для чужого репозитория, переименование репозитория, форк, удалённый issue, подпись с пробелами, огромное тело, смена тимлида посреди завершения).
- Зависимости: S6-03..S6-11.
- Файлы: `modules/{github,workspace}/test/**`, `apps/web/e2e/slice6.spec.ts`, `apps/api/test/fakes/**`.

### Параллельность

B: S6-01 -> S6-03 -> S6-04 -> S6-05 -> (S6-06, S6-07 параллельно, разные каталоги) -> S6-08. F: S6-09, S6-10, S6-11 параллельно на моках (разные `features/*`).

### Тесты среза

- API по контракту: 14 операций; негативные: 401 неверная подпись вебхука, 409 `REPO_TAKEN`/`INVALID_STATE`/`TEAM_STATUS_BLOCKS_ACTION`, 403 не тимлид, 422 с `unmet[]` (проверки не пройдены), 202 повторная доставка без обработки, 400 неверный `state`.
- Конкурентный доступ:
  - CC-9: 2 и 20 команд привязывают один `repository_id` -> 1 успех, остальные 409 `REPO_TAKEN`.
  - CC-11: одна доставка x10 параллельно -> 1 строка `webhook_delivery`, 1 `contribution`; вебхук + суточная сверка одного issue параллельно -> 1 `contribution`.
  - CC-13: 20 "Завершить" -> 1 x 201, 1 строка `project_completion`; "Завершить" против "Перейти" на последнем этапе -> один исход, нет закрытого проекта с открытым этапом.
  - Смена роли вклада против завершения: снимок видит метку до или после, но не промежуточное состояние (12.3).
  - Ссылка на релиз (T7) против перехода/завершения.
  - `githubSetupCallback` с одним `state` x10 -> 1 успех.
  - Парные тесты повтора ключа (кроме вебхука: идемпотентность по `X-GitHub-Delivery`).
- IDOR: `getRepository`/`linkRepository` чужой командой -> 404; `listAvailableRepositories` показывает только установки текущего пользователя; `githubSetupCallback` с `state` другого пользователя -> 400/403; `getTeamFeed` и `getContributionSummary` посторонним -> 404; `relabelContribution` с `contributionId` другой команды -> 404; вебхук с подписью другой установки не создаёт вклад в чужой команде; `completeProject` не тимлидом -> 403.
- Playwright `slice6.spec.ts` (GitHub - двойник): (1) тимлид на `/github` нажимает "Установить App", проходит возврат, выбирает репозиторий, привязывает; (2) двойник присылает вебхук "issue opened/closed" и "PR merged"; (3) лента показывает записи с исполнителем и ролью; (4) участник меняет роль вклада; (5) вторая команда пытается привязать тот же репозиторий и видит `REPO_TAKEN`; (6) на этапе релиза тимлид вставляет ссылку, запускаются проверки (часы теста продвинуты для второй проверки); (7) нажимает "Завершить" - видит итоговый экран со снимком состава и вклада; повторное нажатие невозможно; (8) axe.

### Проверка задач без собственной строки "Проверка"

Шаги Playwright `slice6.spec.ts`: 1 установка и привязка, 2 вебхуки, 3 лента, 4 смена роли вклада, 5 `REPO_TAKEN`, 6 релиз и проверки, 7 завершение, 8 axe.

| Задача | Чем проверяется |
|---|---|
| S6-01 | записка с результатом потока `state` и тест на собственном двойнике спайка |
| S6-02 | перед реализацией тесты падают (вывод в отчёте) |
| S6-03 | тест `githubSetupCallback` с одним `state` x10 -> 1 успех, `state` чужого пользователя -> 400/403; шаг 1 |
| S6-06 | CC-11 "вебхук + суточная сверка -> 1 вклад", тест лимитов и `Retry-After`, проверки `repo_final`/`pr_cross_review`/`ci_workflow`; шаг 6 |
| S6-07 | тесты `getTeamFeed`/`getContributionSummary`/`relabelContribution`, вклад из артефакта и ритуала, "смена роли против завершения"; шаги 3, 4 |
| S6-09 | шаги 1, 5 |
| S6-10 | шаги 2, 3, 4 |
| S6-11 | шаги 6, 7 |
| S6-12 | граничные тесты из критериев зелёные |

### Безопасность

Обязателен security-auditor (интеграция GitHub): подпись вебхуков и сырое тело, replay, `state` и привязка установки (CSRF), хранение ключа App и токенов, права App (минимальные), IDOR при привязке, шифрование токенов пользователей, SSRF в ответах GitHub, раскрытие приватных репозиториев, утечка `code`/`state` в логах.

### Критерий готовности (фаза 6)

Как в срезе 1 плюс: CC-9, CC-11, CC-13 `--repeat 5` зелёные; прототип `state` задокументирован; security-auditor без CRITICAL/HIGH; `slice6.spec.ts` пройден; при наличии тестового GitHub App выполнен ручной прогон установки (иначе записано как непроверенное).

### Риски среза

| Риск | Мера |
|---|---|
| Возврат `state` после установки App (backlog, 17.2) | Прототип S6-01 первым; запасной поток через `installation_id` и проверку владельца |
| Реальный GitHub App недоступен в окружении агента | Двойник GitHub для всех автотестов; реальную установку проверяет пользователь вручную, пункт в `docs/release.md` |
| Лимиты GitHub API, потеря вебхуков | Суточная сверка, `Retry-After`, `plugin-throttling`; sweeper (LOW backlog) |
| ESM-only Octokit | Решено: api собирается как ESM (проверено в срезе 1) |
| Объём (14 операций + завершение) | При нехватке одной сессии - разделить по границе S6-06/S6-07 (GitHub / лента и завершение) |

---

## Срез 7. Награды

**Цель.** После завершения проекта проходит охлаждение и антифрод; зачтённые участники получают зачёт, значки, счётчики и командный бонус; администратор разбирает подозрительные проекты; участники оставляют друг другу отзывы, видимые только адресату; профиль показывает награды.

**Входящие FR.** FR-REW-01..16, FR-PROF-06 (витрина наград в профиле), FR-PROF-08 (отзывы), AF-01..25 (spec 8; админ-доступ к делам - `AdminGuard`, FR-AUTH-08 принадлежит срезу 2), CC-6, CC-12. Операции: 11.

**Таблицы и миграции.** `rewards`: `credit_run`, `project_credit`, `credit`, `counter`, `badge_def`, `award`, `fraud_signal`, `fraud_case`, `dispute`, `admin_audit` (+ сиды `badge_def`). `profiles`: `review_eligibility`, `peer_review`, `peer_review_authorship`.

### Задачи

**S7-01 Тесты среза до реализации (T, M)**
- Критерии: API по контракту (11 операций); модульные тесты правил наград и каждого правила AF с фикстурой; CC-6, CC-12; тесты отзывов (пакетная публикация); IDOR; Playwright `slice7.spec.ts`; падают.
- Зависимости: срез 6 принят.
- Файлы: `modules/{rewards,profiles}/test/**`, `modules/rewards/internal/fraud/rules/*.test.ts`, `apps/web/e2e/slice7.spec.ts`.

**S7-02 Схема rewards и запуск зачёта (B, M)**
- Критерии: миграции rewards (+ сиды значков: серии "Проекты" 1/3/5/10, "Роли" 3/5, "Типы продукта" 2/4 (ступень 4 `available=false`), "В срок", "Три в срок подряд", "Закрыл дефицит", "Закрытая вакансия"); обработчик события `workspace.project_completed` -> `credit_run(status='cooling', cooling_until = completed_at + 7 дней)`; таймер `rewards-cooling-end` (`jobId=credit_<teamId>`); сканер `credit-run-scan` (раз в 10 минут, страховка потери события); `RewardsApi`.
- Зависимости: S7-01, срез 6.
- Файлы: `modules/rewards/internal/{schema,events,jobs}/**`.

**S7-03 Антифрод: правила (B, M)**
- Критерии: чистые функции `(facts) -> Signal[]` в `rewards/internal/fraud/rules/AF-xx.ts` для AF-01..AF-25 по spec раздел 8, каждое с тестом на фикстуре; блок-правила (AF-01, AF-02, AF-04, AF-09, AF-10) дублируют условия завершения; сигналы и флаги пишутся в `fraud_signal`; AF-22 -> флаг и ручная проверка (Р-13); `sha_dedup` -> флаг по Р-8; правила мультиаккаунтов используют `AuthApi.getIdentitySignals` и `identity_tombstone` (только сигнал); фаза `completion` и фаза `cooling_end`; результат фазы - `credit_run.status` (`cooling` / `frozen`). Работа разбивается по группам правил на 2-3 субагента без пересечения файлов (каждый AF в своём файле; реестр `rules/index.ts` собирает один агент последним). Блок-правила AF-01, AF-02, AF-04, AF-09, AF-10 переиспользуют условия из `completion-rules.ts` (S6-08).
- Зависимости: S7-02.
- Файлы: `modules/rewards/internal/fraud/**`.
- Проверка: покрытие правил 95%; таблица "AF -> тест" в `trace:fr` (идентификаторы AF в названиях тестов).

**S7-04 Транзакция зачёта и награды (B, M)**
- Критерии: `creditProject(teamId)` по схеме 10.2: данные снимка и проверки аккаунтов читаются до `BEGIN`; в транзакции #11 `credit_run FOR UPDATE`, `status='cooling'`; `project_credit`, `credit` по ролям (`ON CONFLICT DO NOTHING RETURNING`), статусы `credited`/`pending_account`/`denied` (>= 60% этапов, FR-REW-01); счётчики и награды только по фактически вставленным строкам; правила 10.3 (серии, "В срок", "Три в срок подряд", "Закрыл дефицит", командный бонус для всех на момент завершения кроме вышедших досрочно; `pending_account` откладывает индивидуальные награды, но не командный бонус); событие `rewards.credits_changed` -> matching (счётчики), уведомления; ежедневный `pending-account-recheck`; AF-13 (`roster_hash`).
- Зависимости: S7-03.
- Файлы: `modules/rewards/internal/services/credit*`, `awards*`, `jobs/rewards-cooling-end.ts`, `jobs/pending-account-recheck.ts`.
- Проверка: CC-6 (10 параллельных `creditProject`).

**S7-05 Разбор подозрительных проектов и жалобы (B, M)**
- Критерии: `listFraudCases`, `getFraudCase` (`AdminGuard`, без лишних персональных данных), `decideFraudCase` (`ok` - зачёт; `violation` - отзыв: #11 + `fraud_case status='open'` под блокировкой, `credit`/`project_credit` -> `revoked`, счётчики уменьшаются по `RETURNING`, награды `revoked_at`; повторное решение -> 409 `INVALID_STATE`), `createDispute` (участник или зачтённый оспаривает отказ/заморозку, один раз, окно), журнал `admin_audit`.
- Зависимости: S7-04.
- Файлы: `modules/rewards/internal/{admin,disputes}/**`.
- Проверка: CC-12 (10 параллельных решений -> 1 успех; отзыв параллельно с `pending-account-recheck`).

**S7-06 Чтение наград (B, S)**
- Критерии: `listBadges` (каталог), `listUserAwards`, `getUserCounters` (публичные для вошедших; скрытые не отдаются), `getTeamCredit` (участники команды: статусы своего зачёта, этап охлаждения, причина отказа без раскрытия чужих сигналов); кэш витрины.
- Зависимости: S7-04.
- Файлы: `modules/rewards/internal/read/**`.

**S7-07 Отзывы (B, M)**
- Критерии: миграция profiles (`review_eligibility`, `peer_review`, `peer_review_authorship`); право на отзыв по событию завершения (`review-eligibility-scan` как страховка); `createPeerReview` (только участник снимка завершения об участнике той же команды, один отзыв на пару, окно C-27, текст ограничен и экранируется, UUID v4), публикация пакетом после окна только при отзывах от 2 и более авторов (`withheld` иначе), дата публикации вместо даты создания; `listReceivedReviews` (адресат видит без имени автора; администратор 404), `listSentReviews` (автор видит свои); обезличивание при удалении автора (строка `peer_review_authorship` удаляется, Р-20); подписка saga удаления.
- Зависимости: срез 6, S7-02.
- Файлы: `modules/profiles/internal/reviews/**`.
- Проверка: 20 параллельных `createPeerReview` одной пары -> 1 успех (`UNIQUE`); ни один ответ API не содержит идентификатор автора (тест по схеме и по содержимому).

**S7-08 Frontend: награды и профиль (F, M)**
- Критерии: витрина наград и счётчики на `/users/[id]` и в своём профиле (через `listUserAwards`, `getUserCounters`), каталог значков, визуальные состояния (получен, недоступен); страница результата зачёта команды `/teams/[id]/credit` (статус охлаждения с обратным отсчётом, итоги, причина отказа), подача жалобы.
- Зависимости: S7-01; контракты готовы, моки из S1-09.
- Файлы: `features/rewards/AwardsBlock.tsx` (подключается в страницу `app/(app)/users/**` одной строкой), `app/(app)/teams/[id]/credit/**`, `features/rewards/**`, `i18n/ru/rewards.json`.

**S7-09 Frontend: отзывы (F, M)**
- Критерии: форма отзыва участнику команды (после завершения), список полученных (без автора, с датой публикации), список отправленных, сообщение "отзывы будут опубликованы пакетом", `aria-live`.
- Зависимости: S7-01; контракты готовы, моки из S1-09.
- Файлы: `apps/web/src/app/(app)/reviews/**`, `features/reviews/**`.

**S7-10 Frontend: административный разбор (F, S)**
- Критерии: минимальная страница `/admin/fraud` (список дел, карточка, решение ok/violation с подтверждением), доступна только администратору (UX-редирект, права проверяет api).
- Зависимости: S7-01; контракты готовы, моки из S1-09.
- Файлы: `apps/web/src/app/(app)/admin/fraud/**`, `features/admin/**`.

**S7-11 Дополнение тестов (T, M)**
- Критерии: граничные случаи (участник удалил аккаунт до зачёта, смена тимлида в охлаждении, проект с идентичным составом, командный бонус без желательных мест, отзыв после удаления автора, рассинхрон `credit_run` и `project_completion`).
- Зависимости: S7-02..S7-10.
- Файлы: `modules/{rewards,profiles}/test/**`, `apps/web/e2e/slice7.spec.ts`, `apps/api/test/fixtures/**`.

### Параллельность

B: S7-02 -> S7-03 (внутри параллельно по группам правил) -> S7-04 -> (S7-05, S7-06 параллельно); S7-07 параллельно с S7-03..S7-06 (другой модуль, другие файлы). F: S7-08, S7-09, S7-10 параллельно на моках.

### Тесты среза

- API по контракту: 11 операций; негативные: 403 не участник/не администратор, 404 чужие ресурсы, 409 `INVALID_STATE`/`REVIEW_EXISTS`, 422, 410/409 после окна отзывов.
- Конкурентный доступ:
  - CC-6: 10 параллельных `creditProject(teamId)` -> `counter.value` +1 каждому зачтённому, `award` без дублей, `credit_run.status='credited'`.
  - CC-12: 10 параллельных решений администратора по одному делу -> 1 успех, 9 x 409; отзыв параллельно с `pending-account-recheck` -> счётчик не ниже исходного.
  - Повторная выдача `pending_account` параллельно с отзывом.
  - `createPeerReview` x20 одной пары -> 1 успех.
  - Событие завершения + сканер `credit-run-scan` одновременно -> один `credit_run`.
  - Парные тесты повтора ключа.
- IDOR: `getTeamCredit` посторонним -> 404; `createDispute` не участником -> 403/404; `listReceivedReviews`/`listSentReviews` только `self`, администратор 404; `createPeerReview` об участнике другой команды -> 404; админ-операции обычным пользователем -> 403; ни один публичный ответ (`listUserAwards`, `getUserCounters`) не раскрывает скрытые поля и сигналы антифрода.
- Playwright `slice7.spec.ts`: (1) фикстура: завершённый проект с 3 участниками (прошедшими срезы 3-6), `FakeClock`/тестовый эндпоинт переводит охлаждение на 7 дней; (2) участник видит на `/credit` статус "охлаждение" и затем "зачтено"; (3) на профиле появились значок "Проекты: 1" и счётчик; (4) участник оставляет отзывы двум коллегам; пока отзывов меньше двух авторов, получатель ничего не видит; после второго автора и окна видит оба отзыва без имён; (5) проект с подозрительным сигналом уходит в `frozen`, администратор открывает дело и выносит `violation`: значки и счётчики участников уменьшаются; (6) участник подаёт жалобу; (7) axe.

### Проверка задач без собственной строки "Проверка"

Шаги Playwright `slice7.spec.ts`: 1 фикстура завершённого проекта, 2 охлаждение и зачёт, 3 значок в профиле, 4 отзывы, 5 `frozen` и `violation`, 6 жалоба, 7 axe.

| Задача | Чем проверяется |
|---|---|
| S7-01 | перед реализацией тесты падают (вывод в отчёте) |
| S7-02 | тест "событие завершения + `credit-run-scan` одновременно -> один `credit_run`"; шаги 1, 2 |
| S7-06 | тесты скрытых полей и IDOR `getTeamCredit`; шаг 3 |
| S7-08 | шаги 2, 3, 6 |
| S7-09 | шаг 4 |
| S7-10 | шаг 5 |
| S7-11 | граничные тесты из критериев зелёные |

### Безопасность

Обязателен security-auditor (награды): целостность счётчиков (гонки, повторы), обход антифрода, анонимность отзывов (время, порядок, UUID), права администратора и журнал, IDOR на зачёте и делах, раскрытие сигналов антифрода пользователям, персональные данные (152-ФЗ) при удалении.

### Критерий готовности (фаза 6)

Как в срезе 1 плюс: CC-6, CC-12 `--repeat 5` зелёные; покрытие правил наград и антифрода не ниже 95%; security-auditor без CRITICAL/HIGH; `slice7.spec.ts` пройден; после среза полный регрессионный прогон всех сквозных сценариев срезов 1-7 в одной сессии CI.

### Риски среза

| Риск | Мера |
|---|---|
| 25 правил антифрода, неоднозначные формулировки | Чистые функции, один файл на правило, вопросы по неясным AF оркестратору; значения порогов из конфигурации (spec 7) |
| Рассинхрон события завершения и зачёта | Сканер `credit-run-scan`, идемпотентность по PK |
| Анонимность отзывов при малых командах | Пакетная публикация при >= 2 авторах, дата публикации, UUID v4, отдельная таблица авторства (SEC-04) |
| Юридические вопросы (сигналы устройств, надгробия 180 дней, 17.8) | Правила работают как сигналы; тексты политики - до выпуска; открытый вопрос |
| Объём (11 операций, 25 правил AF, отзывы) | Если не помещается в одну сессию - делить по границе S7-04/S7-05: часть а (S7-01..S7-04, S7-06, S7-08: зачёт и награды) и часть б (S7-05, S7-07, S7-09..S7-11: разбор, жалобы, отзывы); S7-01 пишется для своей части; решение оркестратора |

---

## Сквозные контрольные точки и порядок работы

| Контрольная точка | Условие |
|---|---|
| После срезов 1 | Окружение готово, CI зелёный, `docker compose up` работает, пользователь подтвердил установку Node/pnpm/Docker |
| После среза 2 | Прототипы Better Auth и изоляции резюме зафиксированы; security-auditor |
| После среза 3 | Все CC вступления и голосования зелёные `--repeat 5`; security-auditor |
| После среза 5 | Полный маршрут по обоим сценариям работает от старта до перехода последнего этапа |
| После среза 6 | Проект проходит от создания команды до завершения на двойнике GitHub |
| После среза 7 | Полный жизненный цикл: вход -> команда -> подбор -> маршрут -> GitHub -> завершение -> зачёт; регрессия всех сквозных сценариев |
| Фаза 7 | `docs/release.md`: нагрузочная проверка CC-1, CC-3, CC-5, CC-6; резервные копии; юридические пункты; ручная проверка реального GitHub App и SMTP |

## Сводные риски и прототипы (из architecture 17 и backlog)

| Риск / вопрос | Где решается | Критерий |
|---|---|---|
| Better Auth в Fastify внутри Nest: `pgSchema`, UUID v7, `secondaryStorage`, `revokeUserSessions`, `encryptOAuthTokens` (17.1) | S2-01, прототип первым | Тест вход-выход-отзыв сессий; запасной вариант `auth_` в `public` |
| Вход через тот же GitHub App (user-to-server OAuth) (17.2) | S2-01/S2-05 | Тест на двойнике, ручная проверка на реальном App |
| `state` после установки GitHub App (backlog) | S6-01, прототип первым | Одноразовый `state` или проверка владельца через `installation_id` |
| Дочерний процесс разбора резюме под другим uid в контейнере (17.9, backlog) | S2-10 | `/proc/self/status` дочернего процесса = uid 10002; иначе запасной вариант |
| ESM-only Octokit, NestJS 12 ESM (17.3) | S1-03 | Сборка и запуск api как ESM без обходов |
| `@nestjs-cls/transactional` + Drizzle через PgBouncer (17.4) | S1-05 | Тест `SET LOCAL`, повтор 40P01, порядок блокировок |
| Параллельные вступления видят устаревший дефицит (17.7) | S4-03, фаза 7 | Поведение зафиксировано тестом, нагрузочная проверка |
| SMTP с доставляемостью на mail.ru/yandex.ru (17.6) | До выпуска | В разработке Mailpit |
| Юридическая проверка согласия, политики, сигналов антифрода (17.8, status) | До выпуска | Тексты в сидах помечены черновиком |
| Вычитка человеком раздела 6 `docs/playbooks.md` | До выпуска сценариев `1.0.0` | Изменения сценариев только новой версией |
| Нет Node.js и Docker на машине | До среза 1 | Раздел "Окружение" |
| Объём срезов 3, 5, 6 больше одной сессии | Оркестратор | Границы деления указаны в рисках срезов |

## Открытые решения оркестратора

1. Если спайк Better Auth или изоляции резюме не проходит, выбрать запасной вариант (S2-01, S2-10).
2. Если для среза нужно изменить контракт OpenAPI (например, коды ошибок), изменение делается оркестратором вместе с `docs/architecture.md` и раздел 16 фиксирует расхождение.
3. Привязка Caddy и домена `files.*` проверяется в фазе 7; в разработке файлы раздаются с отдельного порта MinIO по подписанным ссылкам.
