import type { MailMessage } from '../../../../platform/mail/mail.service.js';
import type { NotificationType } from './notification-types.js';

interface Template {
  subject: string;
  lines: string[];
}

/** ru texts of the transactional mails; no personal data and no names, only a link (13.13). */
const TEMPLATES: Partial<Record<NotificationType, Template>> = {
  seat_offer: {
    subject: 'Вам предложили место в команде Teamforge',
    lines: ['Тимлид предложил вам место в команде.', 'Предложение действует ограниченное время.'],
  },
  vote_opened: {
    subject: 'В вашей команде открыто голосование за тимлида',
    lines: ['В вашей команде открыто голосование за тимлида.', 'Проголосуйте в срок.'],
  },
  leader_offer: {
    subject: 'Вам предложена роль тимлида',
    lines: ['Вам предложили роль тимлида команды.', 'Ответьте на предложение в течение 24 часов.'],
  },
  auto_added: {
    subject: 'Вы добавлены в команду Teamforge',
    lines: ['Вас автоматически добавили в команду по вашей заявке.'],
  },
};

/** The mail for a notification type, or `null` when the type is shown in the interface only. */
export function notificationMail(
  type: NotificationType,
  to: string,
  link: string,
): MailMessage | null {
  const template = TEMPLATES[type];
  if (template === undefined) return null;
  const text = ['Здравствуйте!', '', ...template.lines, '', `Открыть: ${link}`].join('\n');
  const html = `<p>Здравствуйте!</p>${template.lines.map((l) => `<p>${l}</p>`).join('')}<p><a href="${link}">Открыть в Teamforge</a></p>`;
  return { to, subject: template.subject, text, html };
}
