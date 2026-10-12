import { linksOf, type MailMessage, tokenLinkOf } from '../../../../test/fakes/mail.js';

/** The cancel token of the "deletion requested" mail: a token link, or else a bare base64url string. */
export function cancelTokenOf(message: MailMessage): string {
  try {
    return tokenLinkOf(message).token;
  } catch {
    const text = `${message.text}\n${linksOf(message).join('\n')}`;
    const bare = /[A-Za-z0-9_-]{43}/.exec(text)?.[0];
    if (!bare) throw new Error(`no cancel token in mail "${message.subject}"`);
    return bare;
  }
}
