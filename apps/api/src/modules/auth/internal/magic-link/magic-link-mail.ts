import type { MailMessage } from '../../../../platform/mail/mail.service.js';

/** Text of the sign-in mail; the link carries the token in the fragment (SEC-09). */
export function magicLinkMessage(to: string, link: string, ttlMinutes: number): MailMessage {
  const text = [
    'Здравствуйте!',
    '',
    'Чтобы войти в Корнер, откройте ссылку и нажмите «Подтвердить вход»:',
    link,
    '',
    `Ссылка действует ${ttlMinutes} минут и работает один раз. Если вы не запрашивали вход, просто проигнорируйте это письмо.`,
  ].join('\n');
  const html = `<p>Здравствуйте!</p><p>Чтобы войти в Корнер, откройте ссылку и нажмите «Подтвердить вход»:</p><p><a href="${link}">${link}</a></p><p>Ссылка действует ${ttlMinutes} минут и работает один раз. Если вы не запрашивали вход, просто проигнорируйте это письмо.</p>`;
  return { to, subject: 'Вход в Корнер', text, html };
}
