import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hmacHex, type SignatureMode } from '../../../../test/fakes/github-webhooks.js';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import { github, postWebhook, WEBHOOK_URL } from '../../../../test/fixtures/github.js';
import { deliveryCount, deliveryRows } from '../../../../test/fixtures/github-db.js';
import { World } from '../../../../test/fixtures/world.js';
import { describeInfra } from '../../../../test/helpers/infra.js';

/*
 * S6-12, edge cases of the entrance of a webhook (FR-GH-03, SEC-06): how exactly the header
 * `X-Hub-Signature-256` has to look, what a body of any size and shape does, and which header values
 * the route refuses. The main cases (invalid, missing, sha1, padded, tampered) are in webhook.test.ts.
 */

const MEBIBYTE = 1024 * 1024;
const BODY_LIMIT = 5 * MEBIBYTE;

/** A JSON object of exactly `bytes` bytes: `{"zen":"xxx..."}`. */
const jsonOfSize = (bytes: number): string => {
  const frame = '{"zen":""}'.length;
  return `{"zen":"${'x'.repeat(bytes - frame)}"}`;
};

describeInfra('S6 github: webhook entrance, edge cases (S6-12)', ['db', 'redis'], () => {
  let world: World;

  beforeAll(async () => {
    world = await World.start({ github: true });
  });

  afterAll(async () => {
    if (!world) return;
    await world.close();
  });

  const app = () => github(world).app;
  const secret = () => app().webhookSecret;

  /** A signed `ping` (the event GitHub sends on registration): accepted, stored as ignored. */
  const ping = (signature: SignatureMode = 'valid') =>
    app().webhook('ping', { zen: 'Keep it logically awesome.' }, { signature });

  const signedHeaders = (body: string, deliveryId: string = randomUUID()) => ({
    'content-type': 'application/json',
    'x-github-event': 'ping',
    'x-github-delivery': deliveryId,
    'x-hub-signature-256': `sha256=${hmacHex(secret(), body)}`,
  });

  describe('the form of the signature header', () => {
    it.each<SignatureMode>([
      'upper-digest',
      'upper-prefix',
      'inner-space',
      'short',
      'empty',
      'tab',
      'padded',
      'sha1',
    ])('FR-GH-03: signature mode %s -> 401 SIGNATURE_INVALID and no trace', async (mode) => {
      const request = ping(mode);
      const response = await postWebhook(world, request);
      expectProblem('receiveGithubWebhook', response, 401, 'SIGNATURE_INVALID');
      expect(await deliveryCount(world, request.headers['x-github-delivery'] ?? '')).toBe(0);
    });

    it('FR-GH-03: a wrong legacy header next to the right sha256 one changes nothing: the new header decides', async () => {
      const request = ping('sha1-too');
      const response = await postWebhook(world, request);
      expect(response.statusCode, response.body).toBe(202);
      expect(await deliveryCount(world, request.headers['x-github-delivery'] ?? '')).toBe(1);
    });

    it('FR-GH-03: a refused signature does not burn the delivery id: the same id signed properly is accepted afterwards', async () => {
      const deliveryId = randomUUID();
      const refused = app().webhook('ping', { zen: 'a' }, { deliveryId, signature: 'invalid' });
      expect((await postWebhook(world, refused)).statusCode).toBe(401);
      const accepted = app().webhook('ping', { zen: 'a' }, { deliveryId });
      expect((await postWebhook(world, accepted)).statusCode).toBe(202);
      expect(await deliveryCount(world, deliveryId)).toBe(1);
    });

    it('FR-GH-03: the signature binds the delivery to its body, not to its id: a valid signature of another body is refused', async () => {
      const first = ping();
      const second = app().webhook('ping', { zen: 'another body' });
      const response = await postWebhook(world, {
        headers: {
          ...second.headers,
          'x-hub-signature-256': first.headers['x-hub-signature-256'] ?? '',
        },
        body: second.body,
      });
      expectProblem('receiveGithubWebhook', response, 401, 'SIGNATURE_INVALID');
    });
  });

  describe('the shape of a signed body', () => {
    it.each([
      ['an empty body', ''],
      ['a JSON array', '[1,2,3]'],
      ['a JSON string', '"text"'],
      ['JSON null', 'null'],
      ['truncated JSON', '{"zen":"x"'],
    ])('FR-GH-03: %s with a valid signature -> 400, nothing is stored', async (_title, body) => {
      const deliveryId = randomUUID();
      const response = await postWebhook(world, { headers: signedHeaders(body, deliveryId), body });
      expect(response.statusCode, response.body).toBe(400);
      expect(String(response.headers['content-type'])).toContain('application/problem+json');
      expect(await deliveryCount(world, deliveryId)).toBe(0);
    });

    it('FR-GH-03: a signed object without any known field is a plain ignored delivery, not a server error', async () => {
      const deliveryId = randomUUID();
      const body = JSON.stringify({ surprise: [1, { deep: true }] });
      const response = await postWebhook(world, { headers: signedHeaders(body, deliveryId), body });
      expect(response.statusCode, response.body).toBe(202);
      expect((await deliveryRows(world, deliveryId))[0]?.status).toBe('ignored');
    });

    it('FR-GH-03: non-ASCII text in the body is signed over its bytes, not over characters', async () => {
      const deliveryId = randomUUID();
      const body = JSON.stringify({ zen: 'Проверка: подпись по байтам, ünï, 😀' });
      const response = await postWebhook(world, { headers: signedHeaders(body, deliveryId), body });
      expect(response.statusCode, response.body).toBe(202);
    });
  });

  describe('the headers of the delivery', () => {
    it.each([
      ['an empty delivery id', ''],
      ['a delivery id of 65 characters', 'a'.repeat(65)],
      ['a delivery id with a slash', '../../etc/passwd'],
      ['a delivery id that is only digits (a job id BullMQ refuses)', '1234567'],
      ['a delivery id with spaces', 'one two'],
    ])('FR-GH-03: %s -> 400', async (_title, deliveryId) => {
      const body = JSON.stringify({ zen: 'x' });
      const headers = { ...signedHeaders(body), 'x-github-delivery': deliveryId };
      const response = await postWebhook(world, { headers, body });
      expect(response.statusCode, response.body).toBe(400);
    });

    it.each([
      ['capitals', 'Issues'],
      ['a space', 'pull request'],
      ['a 65-character name', 'a'.repeat(65)],
      ['an empty name', ''],
    ])('FR-GH-03: an event name with %s -> 400', async (_title, event) => {
      const body = JSON.stringify({ zen: 'x' });
      const headers = { ...signedHeaders(body), 'x-github-event': event };
      const response = await postWebhook(world, { headers, body });
      expect(response.statusCode, response.body).toBe(400);
    });

    it('FR-GH-03: the content type is not trusted: a signed body sent as text/plain is read the same way', async () => {
      const deliveryId = randomUUID();
      const body = JSON.stringify({ zen: 'x' });
      const headers = { ...signedHeaders(body, deliveryId), 'content-type': 'text/plain' };
      const response = await postWebhook(world, { headers, body });
      expect(response.statusCode, response.body).toBe(202);
    });

    it('FR-GH-03: the method matters: GET on the webhook address is not a delivery', async () => {
      const response = await world.app.inject({ method: 'GET', url: WEBHOOK_URL });
      expect([404, 405]).toContain(response.statusCode);
    });
  });

  describe('the size of the body (SEC-06)', () => {
    it('SEC-06: a body of exactly 5 MiB with a valid signature is accepted', async () => {
      const body = jsonOfSize(BODY_LIMIT);
      expect(Buffer.byteLength(body)).toBe(BODY_LIMIT);
      const deliveryId = randomUUID();
      const response = await postWebhook(world, { headers: signedHeaders(body, deliveryId), body });
      expect(response.statusCode, response.body.slice(0, 200)).toBe(202);
      expect(await deliveryCount(world, deliveryId)).toBe(1);
    });

    it('SEC-06: one byte over the limit -> 413 problem+json, nothing is stored', async () => {
      const body = jsonOfSize(BODY_LIMIT + 1);
      const deliveryId = randomUUID();
      const response = await postWebhook(world, { headers: signedHeaders(body, deliveryId), body });
      expect(response.statusCode).toBe(413);
      expect(String(response.headers['content-type'])).toContain('application/problem+json');
      expect(await deliveryCount(world, deliveryId)).toBe(0);
    });

    it('SEC-06: the limit is judged before the signature: a huge body without any signature is 413, not 401', async () => {
      const body = jsonOfSize(BODY_LIMIT + 1024);
      const response = await postWebhook(world, {
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'ping',
          'x-github-delivery': randomUUID(),
        },
        body,
      });
      expect(response.statusCode).toBe(413);
    });

    it('SEC-06: a body sent in chunks without a Content-Length is cut at the limit too', async () => {
      const chunk = Buffer.alloc(MEBIBYTE, 'x');
      const deliveryId = randomUUID();
      const response = await world.app.inject({
        method: 'POST',
        url: WEBHOOK_URL,
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'ping',
          'x-github-delivery': deliveryId,
          'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
        },
        payload: Readable.from(Array.from({ length: 7 }, () => chunk)),
      });
      expect(response.statusCode).toBe(413);
      expect(await deliveryCount(world, deliveryId)).toBe(0);
    });

    it('SEC-06: after a 413 the next ordinary delivery is served normally', async () => {
      const request = ping();
      const response = await postWebhook(world, request);
      expect(response.statusCode, response.body).toBe(202);
    });
  });
});
