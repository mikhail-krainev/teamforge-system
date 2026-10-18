# Статус

## Сделано

- Фаза 0: решения в `docs/decisions.md` (РФ/СНГ, русский интерфейс с i18n, GitHub OAuth + email, один VPS в РФ, 152-ФЗ).
- Фаза 1: `docs/research/methodologies.md`, `docs/research/components.md`, проверены ревьюером, HIGH исправлены, MEDIUM/LOW в `docs/backlog.md`.
- Фаза 2: `docs/spec.md` (FR с критериями приёмки, CC-1..13, константы, антифрод AF-01..25, модель данных) и `docs/playbooks.md` (веб 84 дня, ML 91 день, YAML сидов, шаблоны). Ревью пройдено, HIGH исправлены.
- Фаза 3: `docs/architecture.md`, `docs/api/openapi.yaml` (115 операций, `x-authz` у каждой), `docs/adr/0001..0018`, `docs/security-review-phase3.md`. Ревью архитектуры и аудит безопасности пройдены, CRITICAL/HIGH/MEDIUM исправлены.
- Фаза 4: `docs/plan.md` (7 срезов, 86 задач, покрытие всех FR и операций), `docs/todo.md` (чек-лист). Ревью пройдено, HIGH исправлены.
- Срез 1 (каркас): монорепо pnpm, `packages/shared` из OpenAPI, api (NestJS 12 + Fastify ESM, Drizzle, транзакции и блокировки, идемпотентность, outbox, BullMQ, лимиты, AuthzRegistry с запретом по умолчанию, проверка тел по контракту), web (Next.js 16, i18n, клиент с Idempotency-Key, CSP с nonce), Docker Compose (PgBouncer, Redis ACL, SeaweedFS вместо MinIO, ADR-0019), CI (6 джоб зелёные), Playwright. Ревью кода и повторное ревью пройдены.
- Срез 2 (авторизация и профиль), ветка `feat/auth-profile`: S2-01..S2-12, аудит безопасности и ревью кода исправлены (CRITICAL/HIGH нет), повторное ревью исправлений пройдено, R2-01 исправлена. На реальном стеке 2026-10-13: integration 814/814, concurrency 5 повторов зелёные, `docker compose up --build` с чистых томов, Playwright slice1+slice2 11/11, actionlint без замечаний. MEDIUM/LOW в `docs/backlog.md` (разделы "Срез 2, ревью кода" и "повторное ревью").
- Срез 2 слит в main (PR #12, CI зелёный, 2026-10-14).
- Срез 3 (команды и роли), PR #13: S3-01..S3-14, голосование за тимлида, уведомления и WebSocket, web. Фаза 6 на Redis 8: integration 1398/1398 (ветви 82.2%), concurrency x5 (65 тестов), автоматы 100%, `compose up` с нуля, перезапуск Redis без потери расписаний, Playwright slice1-3 19/19 дважды, gitleaks, actionlint. Ревью и аудит (дважды): CRITICAL/HIGH/MEDIUM нет, LOW в `docs/backlog.md`.

- Срез 4 слит в main (PR #14, CI зелёный).
- Срез 5 (маршрут проекта), ветка `feat/playbooks` (PR не открыт): S5-01 тесты (~380 кейсов, 9 Playwright), S5-02/03 загрузка и чтение сценариев из YAML (CLI `playbooks:load`, сиды из `docs/playbooks.md`, шаблоны платформы), S5-04 этапы и чек-лист при старте, S5-05 правка пунктов с версией, назначение, запасные шаги, ссылки https с политикой SSRF при сохранении, учёт времени в `suspended`. S5-07 ревью (`ReviewService.unpassedStepKeys` для перехода; тесты ревью ждут загрузку файлов S5-06).

## Следующая фаза

ПАУЗА 2026-10-17 (по просьбе пользователя). Срез 5 в `feat/playbooks`, PR не открыт. Готово: S5-01..S5-13 (backend, link-checker и compose-сервис, web), всё запушено. Тесты API: integration 2309/2312 (3 красных ssrf-links исправлены сервисом `link-checker` в compose, не перепрогнано), concurrency x5 зелёные.
S5-14 закончена 2026-10-18: Playwright slice1-5 на полном стеке 36/36 (3.3 мин), API vitest 2486/2492 (6 красных только `resume-worker/parsers.test.ts`, срез 2, локально Node 24, дочерний процесс даёт CORRUPTED; среза 5 не касается).
Осталось: integration/coverage на полном стеке, ревью кода и аудит безопасности среза, PR, слияние. Затем срез 6 (`feat/workspace-github`), срез 7 (`feat/rewards`), фаза 7 (`docs/release.md`).
Нужно: `gh` (brew install gh, gh auth login) для PR. Пользователь разрешил автослияние, моки вместо реальных секретов GitHub App, удаление слитых веток (сделано).
Локально: pnpm-обёртка не запускается, использовать node_modules/.bin; SeaweedFS в тестах с `SEAWEEDFS_VOLUME_SIZE_MB=32`.
Не сделано в S5-09: проверки `md_headings`, `min_files:N`, `ci_workflow`, `pr_cross_review`; `repo_*` придут в срезе 6; `sha_dedup` без подписчика до среза 7. `ChecklistItem` без кода причины проверки ссылки и без ключа шаблона (вопрос к контракту).

Ревью среза 5 (HIGH H1, H2 и MEDIUM, аудит M2/M3/M4, L1/L2/L6): исправлены в `feat/playbooks`, остаток в `docs/backlog.md` ("Срез 5, ревью"). Для развёртывания: `SELF_PUBLIC_IPS` (каждый элемент проверяется как IP) обязателен при любом `NODE_ENV`, кроме `development` и `test` (иначе `link-checker` не стартует), правило хоста `DOCKER-USER` на исходящие адреса описано в `docs/architecture.md` 13.12.

Повторное ревью среза 5 (2026-10-18), все находки исправлены в `feat/playbooks`: редирект на тот же хост не получает `DomainBusy`, адрес проверяется до троттла; срок ожидания занятого домена считается от первой отсрочки (`firstBusyAt` в данных задания); PDF-фильтр (NUL как разделитель, без `/URI` и `/OpenAction`, добавлены `/SubmitForm`, `/ImportData`, `/GoToR`, `/GoToE`, `/Rendition`); `safeFileName` (Cc, Zl, Zp, невидимые заполнители); `SELF_PUBLIC_IPS` и fail closed; запись в пункт без исполнителя (тимлид и держатели роли; необязательный запасной шаг открыт всем); 409 `PLAYBOOK_NOT_READY` и перепривязка forming-команд внутри `playbooks:load`; миграция 0014 с `version + 1`; курсор `stage-due-notify` с микросекундами и окно просрочки 30 дней; редакция query в URL сообщений об ошибках. Сброс ревью при замене файла не нужен (файл меняется только у открытого пункта). Остаток в `docs/backlog.md` ("Срез 5, ревью"). Прогон на реальном стеке: integration 2569/2569 (174 файла), concurrency x5 зелёные (112 тестов в прогоне), tsc, eslint, `db:check`, `check-contract`, `check-deps` без замечаний.
Финальное ревью среза 5 (2026-10-18), исправлено в `feat/playbooks`: M1 `publishPlaybook` перепривязывает forming-команды на заглушке в той же транзакции (порт `PLAYBOOK_PUBLISHED_PORT`, реализация в teams, тест через HTTP-публикацию); M2 слот домена в `link-checker` принадлежит заданию (`SET key jobId NX PX` с проверкой владельца), повтор после `DomainBusy` на редиректе не блокируется слотом первого хоста (тест с реальным Redis); M3 ожидание первого хоста ограничено `firstBusyAt`, сон не длиннее остатка лимита; M4 заглушка определяется по отсутствию этапов, а не по `source_text` (код и миграция 0014); L3 `serializeErr` маскирует userinfo URL в message, stack и causes; L1 `startProject` пересчитывает длину плана, если команду перепривязали между чтением и блокировкой; L4 `safeFileName` убирает `U+034F`, `U+17B4/5` и приводит `Zs` к обычному пробелу. Остальное LOW в `docs/backlog.md` ("Финальное ревью среза 5"). Прогон на реальном стеке: integration 2576/2576 (176 файлов), concurrency x5 зелёные (112 тестов), tsc, eslint, `db:check` без замечаний. Срез 5 готов к PR.

## Принятые решения

- Пользователь разрешил полностью автономную работу: оркестратор сам коммитит, открывает и сливает запросы, переходит между фазами и срезами подряд в одной сессии без подтверждений (2026-10-14). Проверку делают независимые агенты-ревьюеры.
- Авторизация: Better Auth, email через magic link, токены GitHub шифруются (`encryptOAuthTokens`).
- Разбор резюме: unpdf + mammoth в изолированном воркере.
- GitHub: GitHub App; вклад по Issues и PR, Projects v2 не основа (вебхуки только для организаций).
- Базовая длительность проекта 12 недель, минимум для зачёта 14 календарных дней.
- Команда для зачёта 3-8 человек, доля этапов 60%, лимит 2 активных проекта, испытательный срок 7 дней, голосование 72 ч с кворумом floor(N/2)+1.
- Просрочка считается по проекту целиком: фактическая дата завершения минус плановая.
- Платформа даёт свои шаблоны (устав, мини design doc, PR/FAQ, model card).
- Хостинг релизов студентов не навязывается: список вариантов, доступных из РФ/СНГ, проверяется только ответ ссылки.
- Релиз ML: только публичный адрес (демо или API с /docs или /health, HTTP 200).
- Командный бонус получают все участники на момент завершения, кроме вышедших досрочно.
- Вход через тот же GitHub App (user-to-server OAuth), права App: Metadata, Issues, Pull requests, Actions read.
- apps/api собирается как ESM на Node 22+; транзакции через `@nestjs-cls/transactional` + Drizzle.
- Уведомления в MVP: в интерфейсе и email.
- Разбор резюме: отдельный контейнер и отдельный Redis, дочерний процесс на файл.
- Отзывы публикуются пакетом, только при отзывах от 2 и более авторов.
- Локальное S3: SeaweedFS (образы MinIO недоступны), ADR-0019.
- Redis 8 вместо 7: в 7.4 загрузка AOF теряет MULTI/EXEC при выключенном `default`, ADR-0020.
- e2e запускает автодобавление через CLI воркера `dist/cli/run-job.js` с закрытым списком задач, без HTTP.
- Исключение из команды действует на пользователя (все его заявки); исключившая команда не показывается в рекомендациях.
- Возвращение неактивного тимлида - отдельная операция `returnAsLead`; выход кандидата снимает кандидатуру.
- Роли БД: `tf_migrator` владелец схем, `tf_app` только DML.
- Лишние поля в теле запроса отклоняются 400. Токены OAuth шифруются `BETTER_AUTH_SECRET`.
- resume-worker: родитель root с cap_drop ALL + SETUID/SETGID, дочерний процесс uid 10002.
- IP клиента: первый недоверенный адрес справа в XFF; исключение loopback из лимитов только флагом, запрещённым в production.
- Исключение участника тимлидом только для автодобавленных и только в испытательный срок.

## Открытые вопросы

- Юридическая проверка согласия и политики ПД, трансграничная передача в GitHub.
- Провайдер VPS в России.
- Вычитка человеком раздела 6 `docs/playbooks.md`.

Срез 6 начат (2026-10-18), ветка `feat/workspace-github` от `feat/playbooks`; PR среза 5 не открыт из-за отсутствия `gh`. S6-01 готов: `docs/research/github-state-spike.md` (поток `state` + запасной вариант по `installation_id` и `GET /user/installations`, список ручных проверок на реальном App), двойник и 17 тестов в `apps/api/src/modules/github/spike/**` (временно, удалить в S6-03).

S6-02 закончена (2026-10-18): тесты среза 6 до реализации. Двойник GitHub App в `apps/api/test/fakes/github-app*.ts` (+ `github-webhooks.ts`, подключён к `github-server.ts` как `GithubServer.app`): JWT App (RS256), `access_tokens`, `/user/installations`, репозитории, issues, PR, ревью, contributors, workflow runs, ETag/304, лимиты и `Retry-After` на управляемых часах, вебхуки с верной и неверной подписью (8 режимов); самопроверка двойника `github-app.test.ts` (8 зелёных). Тесты: `modules/github/test/{installation,link-repository,webhook,sync,idor}`, `modules/workspace/test/{feed,relabel,completion-check,completion,completion-blocks,idor-slice6,feed-realtime}`, `test/concurrency/{cc-09-repo-link,cc-11-webhook,cc-13-complete-project,cc-slice6-races}`, `apps/web/e2e/slice6.spec.ts` (+ `support/slice6-*.ts`, 9 тестов, 8 шагов плана с axe). 16 новых файлов красные (179 кейсов красных, ещё 156 пропущены из-за падения `beforeAll`, 5 кейсов зелёные только потому, что отсутствие маршрута даёт тот же 404/401), причина: нет маршрутов и таблиц среза 6; старые тесты не затронуты. `trace-fr --slice 6`: 19/19.
Допущения для S6-03..S6-11 (в шапках файлов): задача сверки `github-sync` (константа `GITHUB_SYNC_TASK`), `webhook-sweeper`; отказ callback - редирект с `?error=` либо 400/403; `unmet[]` приходит как 409 `COMPLETION_BLOCKED` (контракт), а не 422 из плана; событие реального времени `contribution.recorded` (контракт), а не `feed.updated`; приватный репозиторий при привязке - 422 `REPO_REJECTED` либо 200 с `repo_private`; ключи результатов проверки `repo_final`, `release_alive_web`; docker-compose.yml должен передать api и worker `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` (их даёт `githubComposeEnv()`); шаг 6 e2e требует страницу релиза, доступную контейнеру link-checker (`E2E_RELEASE_URL`).

S6-09, S6-10, S6-11 (frontend среза 6) готовы на моках и контрактных типах (2026-10-18), apps/api не тронут. `/teams/[id]/github` (установка App редиректом на https-адрес сессии, `app/github/setup` и `teams/[id]/settings/repository` разбирают возврат `?installation=`/`?error=` и ведут на экран подключения, выбор из `listAvailableRepositories` с курсором, привязка/отвязка с подтверждением, `REPO_TAKEN`, `REPO_REJECTED` с причинами, не публичный репозиторий, `unlinked`), `/teams/[id]/feed` (ссылки только https, фильтры исполнителя и источника, курсор через IntersectionObserver и кнопку, сводка вклада, смена роли вклада с подтверждением, живое обновление по `contribution.recorded` через `notifications/invalidation.ts`), `/teams/[id]/complete` (ссылка на релиз через пункт `*_final_links` последнего этапа, запуск и опрос проверок, статус и код причины, таймер до второй проверки релиза, «Завершить проект» с подтверждением и `unmet[]`, экран итогов). На странице команды добавлены ссылки на три экрана. i18n: `github.json`, `feed.json`, `completion.json`. Проверки в `apps/web`: tsc, eslint без замечаний, vitest 449/449 (новые тесты в `features/{github,feed,completion}`), axe-core (без контраста) на экранах чист; Playwright slice6 не запускался (ждёт бэкенд S6-03..S6-08).
Допущения к контракту (для бэкенда и S6-12): `Completion` не содержит снимка состава и вклада, итоги собираются из `getTeam` и `getContributionSummary` (после завершения роли зафиксированы); дата второй проверки релиза читается из `CompletionCheckResult.data` (`retryAt`/`repeatAt`/`nextCheckAt`/`earliestAt`/`availableAt`), без неё показывается правило «не ранее чем через 24 часа»; причина проверки - `data.reason` (`HTTP_STATUS`, `TOO_SMALL`, ...) и `data.httpStatus`; причины отказа `REPO_REJECTED` читаются из `errors[].code` (`REPO_ARCHIVED`, `REPO_NOT_PUBLIC`, `REPO_FORK`, `REPO_NOT_IN_INSTALLATION`); редирект API после GitHub - `/teams/{id}/settings/repository?installation=` (architecture 7.1) или `/github/setup?team=&installation=`/`?error=`; код `?error=` вида `state_invalid`, `access_denied` и т. п.
