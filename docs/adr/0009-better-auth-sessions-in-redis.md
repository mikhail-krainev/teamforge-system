# ADR-0009. Better Auth с сессиями в Redis

Статус: принято. Дата: 2026-10-12. Фаза 3. Обновлено в фазе 3 по аудиту безопасности (`docs/security-review-phase3.md`, SEC-07, SEC-08, SEC-09, SEC-10, SEC-17).

## Контекст

Авторизация - только готовая библиотека (оркестратор); фаза 1 выбрала Better Auth (GitHub OAuth, magic link, Drizzle, `secondaryStorage`). API без состояния, сессии в Redis (оркестратор, FR-AUTH-07): срок 30 дней со скользящим продлением, очистка Redis приводит только к повторному входу. Один домен для web и API (`/api` за прокси) избавляет от cross-site cookie.

## Решение

- Экземпляр `betterAuth()` в модуле auth, маршрут catch-all `/api/auth/*` регистрируется на уровне Fastify (до Nest-маршрутизации) по официальному гайду; Nest-гард `SessionGuard` вызывает `auth.api.getSession({ headers })`.
- `secondaryStorage` - Redis; `storeSessionInDatabase = false` (дубля в БД нет); `session.expiresIn = 30 дней`, `updateAge = 1 день` (скользящее продление). Cookie `__Secure-better-auth.session_token`: HttpOnly, Secure, SameSite=Lax. Redis сессий - с ACL-пользователем на процесс, `default` выключен, без доступа у resume-worker и link-checker (architecture.md 13.15, 13.16; SEC-01, SEC-10).
- Провайдеры: GitHub (вход и `linkSocial`; тот же GitHub App, что и для данных репозитория, user-to-server OAuth с Account permission Email addresses: read, architecture.md 7.1; запасной вариант - отдельное OAuth App), плагин `magicLink` (срок 15 мин, одноразовая ссылка, `storeToken: 'hashed'`), отправка писем через очередь `notifications`. Ссылка в письме ведёт на страницу подтверждения с токеном во фрагменте; вход - `POST /api/auth/magic-link/confirm` с токеном в теле (обёртка над `auth.api.magicLinkVerify`), библиотечный GET закрыт на прокси: почтовые сканеры не тратят токен, токен не попадает в журналы (SEC-07, SEC-09).
- Хуки базы Better Auth: перед созданием пользователя - нормализация email и запрет одноразовых доменов (FR-AUTH-06), уникальность `github_user_id` (FR-AUTH-05); после привязки аккаунта - обнуление OAuth-токенов (FR-GH-10), событие `auth.github_linked`. `account.encryptOAuthTokens = true` на случай, если токен будет нужен.
- Таблицы Better Auth в схеме `auth`, создаются миграциями Drizzle (не `getMigrations`); идентификаторы UUID v7.
- Отзыв сессий при удалении ПД - `revokeUserSessions`.
- `account.accountLinking = { enabled: true, trustedProviders: [], allowDifferentEmails: false }`; неявное объединение учёток по совпадению email запрещено, GitHub привязывается только явным `linkSocial` из активной сессии (SEC-09).
- `callbackURL` (и прочие URL возврата) - только относительный путь по схеме `CallbackPath` контракта; `trustedOrigins = [APP_ORIGIN]` ровно; версия Better Auth фиксируется точно (SEC-08).
- `requestDeletion` требует свежую сессию (`freshAge` 10 мин), иначе 403 `REAUTH_REQUIRED`; исполнение через 72 ч с отменой по ссылке из письма (SEC-17).

## Последствия

- Плюсы: нет своего кода аутентификации; сессии не держат состояния в процессе API; выход и отзыв мгновенны.
- Минусы: зависимость от частых релизов 1.x (версия фиксируется, changelog читается при обновлении); интеграция с Fastify внутри Nest и работа `secondaryStorage` без БД требуют прототипа (architecture.md, раздел 17); потеря Redis разлогинивает всех (принято спецификацией).

## Альтернативы

- Auth.js: в режиме поддержки, заточен под Next.js. Отклонено (components.md 1.1).
- Сессии в PostgreSQL: лишняя нагрузка на каждый запрос, противоречит "сессии в Redis". Отклонено.
- JWT без хранилища: нельзя мгновенно отозвать сессию при удалении ПД. Отклонено.
- `@thallesp/nestjs-better-auth`: поддержка Fastify "beta". Отложено до зрелости.
