import { afterAll, beforeAll, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import { expectOk, githubUser } from '../../../../test/fixtures/teams.js';
import { World } from '../../../../test/fixtures/world.js';
import { describeInfra } from '../../../../test/helpers/infra.js';

interface ProductType {
  code: string;
  name: string;
  active: boolean;
}

describeInfra('S3 playbooks: product types (FR-PLAY-06)', ['db', 'redis'], () => {
  let world: World;

  beforeAll(async () => {
    world = await World.start({ worker: false });
  });

  afterAll(async () => {
    if (!world) return;
    await world.close();
  });

  it('FR-PLAY-06: listProductTypes is public (no session) and matches the contract', async () => {
    const response = await world.anonymous().get('/v1/product-types');
    const body = expectOk<{ items: ProductType[] }>('listProductTypes', response, 200);
    expect(body.items.length).toBeGreaterThanOrEqual(2);
  });

  it('FR-PLAY-06: exactly web_service and ml_product are active in the MVP', async () => {
    const body = expectOk<{ items: ProductType[] }>(
      'listProductTypes',
      await world.anonymous().get('/v1/product-types'),
      200,
    );
    const active = body.items
      .filter((t) => t.active)
      .map((t) => t.code)
      .sort();
    expect(active).toEqual(['ml_product', 'web_service']);
    for (const type of body.items) expect(type.name.length).toBeGreaterThan(0);
  });

  it('FR-PLAY-06: a signed-in user gets the same list', async () => {
    const person = await githubUser(world, 'product-types');
    const anonymous = await world.anonymous().get('/v1/product-types');
    const signedIn = await world.as(person).get('/v1/product-types');
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json()).toEqual(anonymous.json());
  });

  it('FR-PLAY-06: a team cannot be created for an inactive product type -> 422', async () => {
    const body = expectOk<{ items: ProductType[] }>(
      'listProductTypes',
      await world.anonymous().get('/v1/product-types'),
      200,
    );
    const inactive = body.items.find((t) => !t.active);
    const lead = await githubUser(world, 'inactive-type');
    const productTypeCode = inactive?.code ?? 'no_such_type';
    const response = await world.as(lead).post('/v1/teams', {
      name: 'Inactive type team',
      description: 'must be refused',
      timezone: 'Europe/Moscow',
      hoursPerWeek: 10,
      productTypeCode,
    });
    expect(response.statusCode, response.body).toBe(422);
    expectProblem('createTeam', response, 422, response.json<{ code: string }>().code);
  });

  it('FR-PLAY-03: every active product type has a published playbook, so teams can be created for it', async () => {
    const lead = await githubUser(world, 'published-playbooks');
    for (const productTypeCode of ['web_service', 'ml_product']) {
      const response = await world.as(lead).post('/v1/teams', {
        name: `Team ${productTypeCode}`,
        description: 'pins the latest published playbook',
        timezone: 'Europe/Moscow',
        hoursPerWeek: 10,
        productTypeCode,
      });
      const team = expectOk<{ playbookVersion: string; productTypeCode: string }>(
        'createTeam',
        response,
        201,
      );
      expect(team.productTypeCode).toBe(productTypeCode);
      expect(team.playbookVersion).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
