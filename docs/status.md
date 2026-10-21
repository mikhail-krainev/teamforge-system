# Статус

## Сделано

- Фаза 0: `docs/decisions.md` (РФ/СНГ, русский интерфейс с i18n, GitHub OAuth + email, один VPS в РФ, 152-ФЗ).
- Фаза 1: `docs/research/methodologies.md`, `docs/research/components.md`.
- Фаза 2: `docs/spec.md` (FR, CC-1..13, константы, антифрод AF-01..25, модель данных), `docs/playbooks.md` (веб 84 дня, ML 91 день).
- Фаза 3: `docs/architecture.md`, `docs/api/openapi.yaml` (115 операций, `x-authz`), `docs/adr/0001..0020`, `docs/security-review-phase3.md`.
- Фаза 4: `docs/plan.md` (7 срезов, 86 задач), `docs/todo.md`.
- Срезы 1-4 слиты в main (PR #12, #13, #14; CI зелёный).
- Срез 5 (маршрут проекта), ветка `feat/playbooks`: S5-01..S5-14, ревью, аудит, повторное и финальное ревью исправлены. Integration 2576/2576, concurrency x5, Playwright slice1-5 36/36. PR не открыт (нет `gh`).
- Срез 6 (рабочее пространство и GitHub), ветка `feat/workspace-github` от `feat/playbooks`: S6-01..S6-12 и фаза 6 (2026-10-20).
  - Ревью кода: HIGH H-1..H-3 и MEDIUM M-3, M-5..M-7 исправлены; повторное ревью: HIGH R-1 и R-2, R-5, R-6, R-8 исправлены. Аудит: CRITICAL/HIGH нет, S6SEC-02/03 исправлены. Отчёты в `docs/reviews/slice6-*.md`, остаток в `docs/backlog.md` ("Срез 6, ревью и аудит").
  - Изменения после ревью: AF-04 считает разные задачи и PR; AF-02 по колонке `teams.team.release_key` (SQL-функция `teams.release_address_key`, канонический `new URL().href`, миграции 0017/0018, advisory lock на ключ в транзакции завершения); курсор возобновления сверки (`GITHUB_SYNC_MAX_PAGES`), правило равных `updated_at` (`supersedes()`); проверка аккаунта GitHub в setup callback (`account_mismatch`); вклад и его снятие под блокировкой команды; одна проверка завершения за раз (409), 10 в час на команду.
  - Проверено на реальном стеке (HEAD 88263b4): tsc, eslint, depcruise, db:check, contract:check; API integration 3233/3233; concurrency x5 (157 тестов) с числом воркеров по умолчанию; `docker compose up --build` с чистых томов; Playwright slice1-6 45/45 (6 мин); web vitest 455/455; actionlint и gitleaks чисто (allowlist для поддельных ключей S3 в тесте). CI не запускался: работает только на PR.

## Следующая фаза

ПАУЗА 2026-10-22 по просьбе пользователя. Срезы 5 и 6 слиты в main (PR #17, #18).
Срез 7, ветка `feat/rewards`: S7-01..S7-10 сделаны (integration 3574/3574, concurrency x3), коммит `e9850b7` - WIP правок e2e, не проверен. Ревью и аудит: `docs/reviews/slice7-code-review.md` (C-1 чтения через общий `DB` внутри транзакции в FraudFactsService/FraudCaseService, H-1 зачёт удалённого пользователя, H-2 `user_id` автора в логе отзыва и ослабленный тест), `docs/reviews/slice7-security-audit.md` (S7SEC-01 решение "в порядке" обходит охлаждение и AF-22). Дальше: e2e slice1-7 на полном стеке, исправить CRITICAL/HIGH/MEDIUM, повторное ревью, S7-11, PR, слияние.
B1 (`docs/release.md` 5.6): пул соединений исчерпывается, когда внутри транзакции читают через общий клиент `DB`. Ветка `fix/pool-starvation`, коммит `42b57e3` - WIP, не проверен (тест `cc-14-pool-starvation`, `shared-client-guard`). Дальше: довести, PR в main, слить main в `feat/rewards`.
Фаза 7: ветка `docs/release` (`docs/release.md`, `scripts/load/` k6), после B1 и среза 7 повторить нагрузку, PR.
Тесты из нескольких worktree одновременно на общем стеке `tf-test` ломают друг друга (общий `tf_template`): каждому свой стек.

## Открытые вопросы

- R-3: ключ адреса релиза отбрасывает query, два приложения Google Play дают ложный `FRAUD_BLOCK` (решение продукта).
- Юридическая проверка согласия и политики ПД, трансграничная передача в GitHub.
- Провайдер VPS в России.
- Вычитка человеком раздела 6 `docs/playbooks.md`.

## Локальная среда

- pnpm-обёртка не запускается: использовать `node_modules/.bin`. SeaweedFS в тестах с `SEAWEEDFS_VOLUME_SIZE_MB=32`.
- Порты 5432, 4000, 9000, 1025, 8025 заняты чужими контейнерами: переопределять порты хоста.
- e2e slice6 требует чистый стек на каждый прогон и доступ в интернет (https://www.wikipedia.org/, https://example.org/) либо `E2E_RELEASE_URL`. Ключ App для e2e в `apps/web/.e2e/`.
- Старый `.env` без заглушек `GITHUB_APP_*`: перегенерировать `env:init`.

## Принятые решения

- Автономная работа: оркестратор сам коммитит, открывает и сливает PR, идёт по срезам подряд (2026-10-14). Проверку делают независимые агенты.
- Авторизация Better Auth (magic link email + GitHub App user-to-server OAuth), токены GitHub шифруются `BETTER_AUTH_SECRET`, user-токен не хранится.
- Разбор резюме: unpdf + mammoth в отдельном контейнере, дочерний процесс на файл (uid 10002), отдельный Redis.
- GitHub App (Metadata, Issues, Pull requests, Actions read); вклад по Issues и PR, Projects v2 не основа.
- Проект 12 недель, минимум для зачёта 14 дней, команда 3-8, доля этапов 60%, лимит 2 активных проекта, испытательный срок 7 дней, голосование 72 ч с кворумом floor(N/2)+1.
- Просрочка по проекту целиком; командный бонус всем участникам на момент завершения, кроме вышедших досрочно.
- Релиз: только публичный адрес (ML: демо или API с /docs или /health, HTTP 200). Хостинг не навязывается.
- AF-02 учитывает завершения с датой не позже `now()` БД; шаблонные хосты дают `FRAUD_BLOCK`.
- Уведомления: в интерфейсе и email. Отзывы публикуются пакетом от 2 и более авторов.
- SeaweedFS вместо MinIO (ADR-0019), Redis 8 (ADR-0020). Роли БД: `tf_migrator` владелец, `tf_app` только DML.
- Лишние поля в теле запроса: 400. IP клиента: первый недоверенный справа в XFF.
- Исключение из команды действует на пользователя; только автодобавленных и только в испытательный срок. `returnAsLead` отдельной операцией.
- e2e автодобавление через CLI воркера `dist/cli/run-job.js`.
- Снимок `project_completion` неизменяем (триггер на UPDATE и DELETE, миграция 0016).
