import type { ErrorCode } from 'shared';

/** Russian titles (default UI language). Clients branch on `code`, never on these strings. */
const TITLES_RU: Partial<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: 'Некорректный запрос',
  UNAUTHENTICATED: 'Требуется вход',
  FORBIDDEN: 'Недостаточно прав',
  NOT_FOUND: 'Не найдено',
  IDEMPOTENCY_KEY_MISSING: 'Не указан ключ идемпотентности',
  IDEMPOTENCY_KEY_REUSED: 'Ключ идемпотентности использован с другим запросом',
  IDEMPOTENCY_IN_PROGRESS: 'Запрос с этим ключом ещё выполняется',
  VERSION_MISSING: 'Не указана версия ресурса',
  VERSION_CONFLICT: 'Ресурс уже изменён',
  INVALID_STATE: 'Действие недоступно в текущем состоянии',
  RATE_LIMITED: 'Слишком много запросов',
  LOCK_TIMEOUT: 'Сервис временно занят, повторите запрос',
  INTERNAL: 'Внутренняя ошибка',
};

const STATUS_TITLES_RU: Record<number, string> = {
  400: 'Некорректный запрос',
  401: 'Требуется вход',
  403: 'Недостаточно прав',
  404: 'Не найдено',
  409: 'Конфликт состояния',
  422: 'Данные не прошли проверку',
  429: 'Слишком много запросов',
  503: 'Сервис временно недоступен',
};

export function titleFor(code: ErrorCode, status: number): string {
  return TITLES_RU[code] ?? STATUS_TITLES_RU[status] ?? 'Ошибка';
}
