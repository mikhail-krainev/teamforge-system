# Бэклог

Замечания MEDIUM и LOW и задачи за пределами MVP.

## Фаза 1, ревью исследования

- MEDIUM: ступени серий наград (бронза и т.д.) назвать "ступени серии", чтобы не путать с запретом уровней. Решить в спецификации.
- MEDIUM: при совмещении ролей определить, как вклад делится по ролям, чтобы один и тот же вклад не давал две "разные роли". Решить в спецификации.
- MEDIUM: нормализация email для антифрода: добавить алиасы Яндекса и mail.ru, не только gmail.
- MEDIUM: уведомление Роскомнадзора о трансграничной передаче данных (GitHub) вынести в чек-лист выпуска, а не только к юристу.
- LOW: components.md 5.3.8 и 5.1.1: согласовать метки "блок" и "флаг" с текстом правил.
- LOW: methodologies.md: утверждение "Cagan отказался от термина" не проверено.
- LOW: methodologies.md этап 7 "Релиз" для ML: уточнить, что считается ссылкой на работающий релиз. Решить в playbooks.md.
- Вычитка чек-листов ревью человеком с опытом ревью.

## Фаза 2, ревью спецификации и сценариев

- MEDIUM: AF-06 в spec называет `sha_dedup` "флагом", в playbooks это "сигнал". Согласовать терминологию в архитектуре.
- MEDIUM: отзывы, написанные удалённым пользователем (FR-AUTH-09): описать обезличивание.
- MEDIUM: запасные шаги `w6_frontend` и `w6_backend` предполагают второго участника; проверить на команде из 3 человек.
- LOW: в spec нет C-51; веса C-44a..e записаны одной строкой.
- LOW: playbooks.md строка 12 "12-16 недель" против C-05 "10-16".
- LOW: playbooks.md 2.3 правило 5 ссылается на backlog, хотя spec уже закрыл вопрос.
- Вычитка человеком раздела 6 playbooks.md "Шаги для вычитки": сроки этапов, критерии перехода без первоисточника, запасные шаги мониторинга и хостинга.

## Фаза 3, ревью архитектуры и аудит безопасности

- LOW: SEC-20..SEC-33 из `docs/security-review-phase3.md` (статус "Отложено (LOW)").
- LOW: лимит частоты на вебхук GitHub по IP.
- LOW: подпись presigned URL на `files.<домен>`.
- LOW: перечислить сканеры для каждого таймера.
- LOW: `webhook-sweeper` не перепоставит упавшую задачу с тем же `jobId`.
- Вторая версия: уведомления в Telegram.
- Юридическая проверка: сбор сигналов устройств для антифрода, хранение записей об удалённых учётках 180 дней.
- Прототип: запуск дочернего процесса разбора резюме под отдельным uid; монтирование Better Auth в Fastify; возврат `state` после установки GitHub App.

## Фаза 4, ревью плана

- MEDIUM: добавить при сборке срезов параллельные тесты для совмещения ролей (FR-TEAM-07), лимита мест C-04, "желательная роль против завершения", "удаление учётной записи против вступления".
- MEDIUM: S1-03 и S1-13: тесты положить в каталоги тестов, а не в `src/`.
- MEDIUM: S3-04: колонки `joined_via` и `trial_until` создать миграцией явно.
- MEDIUM: у среза 4 нет границы деления.
- LOW: в шапке плана "x-fr у каждой операции", фактически 112 из 114 (без health).

## Фаза 6, срез 1 (compose, тестовая инфраструктура, CI)

- MEDIUM: MinIO заменён SeaweedFS (ADR-0019). Обновить architecture.md (разделы 1, 13.11, 13.15, 13.17, 13.18, схема и таблица сервисов), plan.md (S1-08, S1-12, S5-06), ADR-0010 и имена бакетов (`tf-resumes` в architecture против `resumes` в plan и `.env.example`); выбрать хранилище для выпуска в фазе 7.
- MEDIUM: проверить на SeaweedFS подписанные ссылки GET с `response-content-disposition`, сроком 5 минут и `nosniff` при раздаче (S5-06), условные запросы и очистку сирот; тест на реальном хранилище в каждом срезе, где появится новая S3-операция. Если не пройдёт - Garage или RustFS (ADR-0019).
- MEDIUM: у `worker` нет собственного heartbeat; healthcheck контейнера проверяет только PING в Redis с ACL-пользователем `worker` (`docker/worker-healthcheck.mjs`). Добавить метку живости цикла очередей (B), например ключ с TTL в `~bull:*`-совместимом пространстве.
- MEDIUM: `pnpm run format:check` падает на 12 файлах `apps/web` (сгенерированные `nav.generated.ts`, `registry.generated.ts`, `next-env.d.ts` не в `.prettierignore`; плюс несколько исходников без форматирования). Поэтому в CI нет шага `format:check`; добавить после исправления.
- LOW: сеть compose в разработке проще, чем в architecture 1 (`edge`/`internal`/`checker-net`/`egress`): есть `default` и `resume-net` (`internal: true`); порты зависимостей опубликованы на `127.0.0.1` (в том числе Redis, вопреки 13.16 для выпуска). Боевой compose и CI-проверка "нет `ports:` кроме Caddy" - фаза 7.
- LOW: контейнеры не ужесточены (`read_only`, `cap_drop`, `no-new-privileges`, лимиты памяти и процессов) за исключением resume-worker, которого ещё нет; ужесточить в боевом compose (фаза 7).
- LOW: `docker-compose.yml` и e2e-проект `e2e` используют одинаковые теги образов `teamforge-api:local` и `teamforge-web:local`: пересборка в e2e подменяет образы dev-стека (работающие контейнеры не затрагиваются). При необходимости разнести через `image: teamforge-api:${COMPOSE_PROJECT_NAME}`.
- LOW: CI-джоба `e2e` собирает образы с нуля (кэш слоёв Docker не подключён); при росте времени подключить `docker buildx bake` с кэшем GHA или использовать образы из джобы `build`.
- LOW: `ghcr.io/oasdiff/oasdiff` требует входа в реестр, поэтому `contract:breaking` использует `tufin/oasdiff` с Docker Hub по digest (architecture 17, п. 11 называет официальный образ).
- LOW: `eslint-plugin-boundaries` подключается из `apps/api` через `createRequire` в корневом `eslint.config.js`; работает при полной установке зависимостей. Перенести в корневые devDependencies, если когда-нибудь понадобится частичная установка (`--filter`).
- LOW: корневые скрипты вызывают `pnpm` изнутри; на Windows без `pnpm` в PATH (только `corepack pnpm`) они не запускаются. Сказать в README: `corepack enable`.
- LOW: `api.as(user)` и e2e `signIn` в срезе 1 - заготовки (заголовок `x-test-user`, ошибка-заглушка); в срезе 2 заменить созданием сессии Better Auth в Redis.
- LOW: пороги покрытия 80% действуют на весь `src`; правила наград, голосования, подбора, антифрода и автоматы требуют 95% (spec 5.9): добавить пороги по маскам каталогов, когда появятся модули. Фактическое покрытие среза 1: строки 91%, ветви 84% (порог 80% выдержан, снижать не пришлось).
- LOW: `trace:fr` проверяет только идентификаторы FR/CC/AF из строки "Входящие FR" среза; пункты NFR 5.x в названиях тестов не отслеживаются.

## Срез 1, ревью кода

Источник: `docs/reviews/slice1-code-review.md` (S1R-xx). HIGH и MEDIUM исправлены, кроме остатка ниже; LOW перенесены без правок.

- MEDIUM (остаток S1R-13): нет HTTP-тестов жёсткого срока 70 с и исчерпания 3 повторов `40P01` (503 после четырёх попыток); есть только модульные тесты `TxRunner`.
- LOW (S1R-05): срок попытки отдаётся кодом `LOCK_TIMEOUT`; завести отдельный `ErrorCode` (например `ATTEMPT_TIMEOUT`) требует изменения контракта `docs/api/openapi.yaml`.
- Закрыто в срезе 2 (S1R-07): Ajv работает с `removeAdditional: false`, лишние поля тела отклоняются 400 (architecture 13.3).
- LOW (S1R-09): `style-src-attr 'unsafe-inline'` в CSP web оставлен ради атрибутов `style`; убрать, когда они исчезнут. `upgrade-insecure-requests` включить вместе с HTTPS (Caddy, фаза 7).
- LOW (S1R-14): ключи лимита не проверяются на TTL (мутант без `PEXPIRE` выживает); политика при сбое Redis ("закрыто или открыто") не определена, `rate-limiter.ts:103-122`. Тест `PTTL` и решение: вход и загрузки - закрыто 503, чтение - открыто.
- LOW (S1R-15): `afterCommit` выполняется внутри `try` в `tx-runner.ts`: ошибка послекоммитного хука вернётся как отказ уже выполненной операции; вынести из `try`, логировать без повторов.
- LOW (S1R-16): `deadlineAt` (жёсткий срок 70 с) нигде не передаётся; интерцептор идемпотентности должен задавать `start + 70 s` через CLS и проверять его перед каждой попыткой.
- LOW (S1R-17): `useIdempotentMutation`: один `slot` на хук (два параллельных `mutate` затирают ключи), `AbortError` сбрасывает ключ, страховочное middleware молча подставляет новый ключ (`idempotency.ts`, `client.ts`).
- LOW (S1R-18): правило `no-jsx-literals` пропускает шаблонные строки с выражениями, `cond && 'текст'`, `cond ? 'a' : 'b'`, `aria-valuetext`; разбор рекурсивно и тесты на обходы.
- LOW (S1R-19): `DATA_ENCRYPTION_KEY` принимает любую base64-строку из 43-44 символов (нестрогий разбор); `REDIS_ACL_STRICT=false` допустим при `NODE_ENV=production`.
- LOW (S1R-20): курсор пагинации без ограничения длины и арности (`pagination.ts`); лимит 512 символов и параметр `arity` в `decodeCursor`.
- LOW (S1R-21): `request_hash` идемпотентности не включает query-параметры; включить отсортированные параметры в `canonicalJson` и уточнить 12.4.
- LOW (S1R-22): `afterSuccess` игнорирует результат `complete` при ключе без транзакции; `afterFailure` при собственном сбое БД теряет исходную ошибку.
- LOW (S1R-23): ошибка подписки на `outbox:kick` глотается, `onApplicationShutdown` relay не дожидается текущего прохода `tick`.
- LOW (S1R-24): очистки (`idempotency-cleanup`, `outbox-cleanup`) - один `DELETE` без пакетов и `statement_timeout`; нет инструмента `events:replay` для строк `event_dead_letter` (срез 2).
- LOW (S1R-25): пароль Redis в аргументах `redis-cli` виден в `ps` (использовать `REDISCLI_AUTH`); приложение работает под S3-идентификатором `Admin` (нужны Read/Write/List).
- LOW (S1R-26): `.gitleaks.toml` исключает целиком `apps/api/test/`, `docker-compose.test.yml`, `.env.test`; заменить на `regexes` с конкретными тестовыми значениями.
- LOW (S1R-27): CI: `cancel-in-progress` отменяет и запуски на `main`; нет сканирования образов (trivy/grype) и `actionlint`/`zizmor`.
- LOW (S1R-28): минимальная версия Next.js `15.2.3` в `check-deps.mjs` и `next-config.test.ts` учитывает только CVE-2025-29927; завести минимумы по линиям 15.x и 16.x.
- LOW (S1R-29): `apps/api/test/boundaries.test.ts` создаёт нарушающие файлы в `src/modules/...`; при убитом процессе они ломают `lint`; использовать временный каталог вне `src`.
- LOW (S1R-30): интеграционные тесты идут на `users.test.acl.tpl`; боевой ACL (`~rl:*`, `&outbox:kick`, `~bull:*`) проверяется только e2e; параметризованный тест `rate-limiter` и `outbox` на боевом шаблоне.
- LOW (S1R-31): комментарии: `.env.test:2` ссылается на несуществующий `scripts/run-tests.mjs`, "MinIO" вместо SeaweedFS в `s3.module.ts`; в каждой строке журнала два идентификатора (`reqId` и `request_id`); `instance` в problem+json - шаблон маршрута, а не путь.

## Срез 1, повторное ревью исправлений (e503d2f)

- MEDIUM (исправлено в срезе 2, миграция 0001): `idempotency.service.ts:123` — ключ завершается сырым результатом транзакции, финальное HTTP-тело записывается позже (`overwriteResponse`); повтор между коммитом и перезаписью получает сырой результат. Пометить строку как предварительную и отвечать 409 `IDEMPOTENCY_IN_PROGRESS` до перезаписи.
- MEDIUM (исправлено в срезе 2: `sanitizeDatabaseError` в `queue-workers.ts`, ПД): `err.message` у DrizzleQueryError содержит SQL и параметры и попадает в BullMQ `failedReason`/stack в Redis на 7 дней. Очищать ошибки БД до выхода из процессора задач.
- LOW: защита от второй транзакции срабатывает после коммита первой и не покрывает `@NoIdempotency` и публичные изменяющие операции.
- LOW: регулярка `PG_CODE` совпадает с кодами Node (EPIPE, EPERM).
- Закрыто в срезе 2: `removeAdditional: false` (см. S1R-07), вырезания полей под `oneOf/allOf` больше нет.
- LOW: `tf_app` может менять журнал миграций `platform.__drizzle_migrations`; отозвать права.
- LOW: `10-roles.sh` не срабатывает на старом томе postgres-data; описать `docker compose down -v` при обновлении.
- LOW: HSTS в web отправляется и в dev.
- LOW: `await connection()` в корневом layout делает все страницы динамическими (нужно для nonce CSP).
- LOW: фиксированная подсеть compose 172.29.250.0/24 может конфликтовать с VPN.

## Срез 2, аудит безопасности

Отчёт: `docs/reviews/slice2-security-audit.md`. MEDIUM (S2SEC-01..03) и S2SEC-04 исправлены; ниже остальные LOW и хвосты исправлений.

- LOW (S2SEC-05): `resume-file.ts:186-192`, поиск активного содержимого PDF по подстрокам обходится (hex-имена, `/JS<<`, `ObjStm`). Записать в архитектуре, что это эвристика, и брать флаги активного содержимого из дочернего процесса (`/OpenAction`, `/AA`, `/JavaScript`, `/EmbeddedFiles`).
- LOW (S2SEC-06): `resume-worker/parsers.ts:34`, отладочный вывод `DBGPDF` в stderr; удалить.
- LOW (S2SEC-07): `resume-worker/main.ts:67`, `run-child.ts:152-158`, два дочерних процесса под одним uid 10002 при `concurrency: 2`; `concurrency: 1` или отдельный uid на слот, либо проверка `kernel.yama.ptrace_scope >= 1` при старте.
- LOW (S2SEC-08): compose, resume-worker, `/tmp` tmpfs с правами 1777; `size=16m,noexec,nosuid,mode=0700,uid=0` или без `/tmp`.
- LOW (S2SEC-09): compose resume-worker `mem_limit: 512m`, `--max-old-space-size=256` не ограничивает ArrayBuffer и нативную память pdf.js; `concurrency: 1` или `prlimit --as` на дочерний процесс, тест "огромное изображение даёт LIMIT, родитель жив".
- LOW (S2SEC-10): `resume-parse.client.ts:12,71`, `removeOnFail: { age: 3600 }` держит байты резюме в redis-resume час; `removeOnFail: true` (исход пишет `markFailed`).
- LOW (S2SEC-11): `deletion-saga.service.ts:46,154`, удаление `verification` по `value ILIKE '%<email>%'` задевает чужие записи (`a@b.ru` и `xa@b.ru`); точное совпадение `(value::jsonb->>'email') = $1`.
- LOW (S2SEC-12): `deletion-request.service.ts:194`, `assertFreshSession` пропускает запрос без `sessionCreatedAt`; закрывать по умолчанию, тестовый аутентификатор тоже ставит поле.
- LOW (S2SEC-13): `session.authenticator.ts:25`, `deletion-request.service.ts:229`, при сбое `revokeUserSessions` сессии пользователя в статусе `deleting` остаются рабочими; аутентификатор должен пускать только `active`.
- LOW (S2SEC-14): `config.ts` (`GITHUB_OAUTH_BASE_URL`, `GITHUB_API_BASE_URL`) запрещены только при `NODE_ENV=production`; разрешать только при `NODE_ENV=test` или с loopback-хостом. Учесть: e2e-стек работает как `development` и использует двойник GitHub (`APP_NODE_ENV`), нужен отдельный признак для e2e.
- LOW (S2SEC-15): cookie сессии без префикса `__Host-` (SEC-23); `advanced.cookies.session_token.name`, правка `apps/web/src/proxy.ts`, или перенос в decisions.md.
- INFO: I-01 `registerOperations` может переписать операцию контракта; I-02 один `IP_HASH_SALT` для лимитов, согласия, сигналов и надгробий (HKDF с метками); I-03 `sprintf-js` через `mammoth>argparse`, записать отсрочку с датой; I-04 снимки Redis только с шифрованием; I-05 родитель resume-worker под root, ADR-0012.
- Хвост S2SEC-03: проверить на стеке, что rewrite Next (web -> api) передаёт `X-Forwarded-For` от Caddy и добавляет ли он адрес соединения; правило api верно в обоих случаях (самый правый недоверенный адрес), но реальный `request.ip` за цепочкой Caddy -> web -> api не проверен. Добавить e2e: два клиента с разными IP получают разные корзины лимита. В production `TRUSTED_PROXY_CIDRS` = адреса Caddy и web.
- Хвост S2SEC-01..03 (не запускались, Docker Desktop был остановлен): `apps/api/test/integration/client-ip-ratelimit.test.ts` (Redis), обновлённый `modules/auth/test/magic-link.test.ts` (alias отвечает 200 и письмо на сохранённый адрес), весь пакет `test:integration` после изменений `RateLimiter`/`preParsing`. Проверить `uploadResume` из `modules/profiles/test/resume.test.ts` (5 МиБ + 1, шестая загрузка 429).
- Хвост S2SEC-04: флаг `RATE_LIMIT_EXEMPT_LOOPBACK` не пробрасывается в `x-app-env` compose (правит другой агент); e2e-стек (`APP_NODE_ENV=development`) без флага не освобождает loopback. Если e2e этого требует, добавить `RATE_LIMIT_EXEMPT_LOOPBACK: ${RATE_LIMIT_EXEMPT_LOOPBACK:-false}` в compose и в `E2E_ENV`.
