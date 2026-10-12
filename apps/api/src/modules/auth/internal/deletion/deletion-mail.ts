import type { MailMessage } from '../../../../platform/mail/mail.service.js';

/** The mail that confirms a deletion request and carries the one-time cancel link (SEC-17). */
export function deletionRequestedMessage(
  to: string,
  cancelLink: string,
  scheduledAt: Date,
): MailMessage {
  const when = scheduledAt.toISOString();
  const text = [
    'Здравствуйте!',
    '',
    'Мы получили запрос на удаление вашей учётной записи Teamforge и персональных данных.',
    `Удаление начнётся после ${when} (через 72 часа). До этого момента запрос можно отменить:`,
    cancelLink,
    '',
    'Все сессии завершены. Если запрос отправили не вы, отмените его по ссылке и смените способ входа.',
  ].join('\n');
  const html = `<p>Здравствуйте!</p><p>Мы получили запрос на удаление вашей учётной записи Teamforge и персональных данных.</p><p>Удаление начнётся после ${when} (через 72 часа). До этого момента запрос можно отменить: <a href="${cancelLink}">${cancelLink}</a></p><p>Все сессии завершены. Если запрос отправили не вы, отмените его по ссылке и смените способ входа.</p>`;
  return { to, subject: 'Запрос на удаление учётной записи Teamforge', text, html };
}
