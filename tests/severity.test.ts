import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseSchema, structuralDiff } from '../src/diff.ts';
import { buildWindow, applyUsage, worstSeverity, renderReport } from '../src/usage.ts';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const OLD = `
type User {
  id: ID!
  email: String!
  legacyId: String @deprecated(reason: "use id")
  nickname: String @deprecated(reason: "unused")
  createdAt: String
}
input UserFilter {
  email: String
}
`;

const NEW = `
type User {
  id: ID!
  email: String!
  createdAt: String!
  displayName: String
}
input UserFilter {
  email: String
  tenantId: String!
}
`;

function diffWith(usage: Array<{ field: string; client: string; at: number }>) {
  const oldS = parseSchema(OLD);
  const newS = parseSchema(NEW);
  const window = buildWindow(usage, NOW, 30);
  return { changes: applyUsage(structuralDiff(oldS, newS), oldS, window), oldS };
}

describe('the parser', () => {
  test('reads types, fields, nullability and deprecation', () => {
    const s = parseSchema(OLD);
    const user = s.get('User')!;
    assert.equal(user.fields.length, 5);
    assert.equal(user.fields.find((f) => f.name === 'id')!.nonNull, true);
    assert.equal(user.fields.find((f) => f.name === 'legacyId')!.deprecated, true);
    assert.equal(user.fields.find((f) => f.name === 'createdAt')!.deprecated, false);
  });

  test('distinguishes input types from output types', () => {
    const s = parseSchema(OLD);
    assert.equal(s.get('UserFilter')!.kind, 'input');
    assert.equal(s.get('User')!.kind, 'type');
  });
});

describe('usage-aware severity', () => {
  test('THE DIFFERENTIATOR: a deprecated field with zero callers is SAFE', () => {
    const { changes } = diffWith([]);
    const c = changes.find((x) => x.path === 'User.nickname')!;
    assert.equal(c.severity, 'SAFE');
    assert.equal(c.downgradedFrom, 'BREAKING');
    assert.match(c.justification!, /zero calls/);
  });

  test('a deprecated field with ONE caller stays BREAKING and names them', () => {
    const { changes } = diffWith([
      { field: 'User.legacyId', client: 'billing-web', at: NOW - 2 * DAY },
    ]);
    const c = changes.find((x) => x.path === 'User.legacyId')!;
    assert.equal(c.severity, 'BREAKING', 'one caller is still a caller');
    assert.deepEqual(c.callers, ['billing-web']);
    assert.equal(c.downgradedFrom, undefined);
  });

  test('severity changes as the usage window empties', () => {
    // Same field, same schema. Only the age of the last call differs.
    const recent = diffWith([
      { field: 'User.legacyId', client: 'billing-web', at: NOW - 29 * DAY },
    ]);
    const stale = diffWith([
      { field: 'User.legacyId', client: 'billing-web', at: NOW - 31 * DAY },
    ]);
    assert.equal(recent.changes.find((c) => c.path === 'User.legacyId')!.severity,
      'BREAKING');
    assert.equal(stale.changes.find((c) => c.path === 'User.legacyId')!.severity,
      'SAFE');
  });

  test('a NON-deprecated field with zero callers is NOT downgraded', () => {
    // Absence of traffic is not consent. Clients had no deprecation warning,
    // so "nobody called it this month" does not make removal safe.
    const oldS = parseSchema('type A { keep: String, gone: String }');
    const newS = parseSchema('type A { keep: String }');
    const changes = applyUsage(structuralDiff(oldS, newS), oldS,
      buildWindow([], NOW, 30));
    const c = changes.find((x) => x.path === 'A.gone')!;
    assert.equal(c.severity, 'BREAKING');
    assert.match(c.justification!, /never deprecated/);
  });

  test('multiple callers are all named, sorted', () => {
    const { changes } = diffWith([
      { field: 'User.legacyId', client: 'zeta', at: NOW - DAY },
      { field: 'User.legacyId', client: 'alpha', at: NOW - DAY },
      { field: 'User.legacyId', client: 'alpha', at: NOW - 2 * DAY },
    ]);
    assert.deepEqual(
      changes.find((c) => c.path === 'User.legacyId')!.callers, ['alpha', 'zeta']);
  });
});

describe('structural rules that are commonly got wrong', () => {
  test('an output field becoming non-null is SAFE', () => {
    const { changes } = diffWith([]);
    const c = changes.find((x) => x.kind === 'FIELD_MADE_NON_NULL')!;
    assert.equal(c.path, 'User.createdAt');
    assert.equal(c.severity, 'SAFE');
  });

  test('a required NEW input field is BREAKING', () => {
    const { changes } = diffWith([]);
    const c = changes.find((x) => x.path === 'UserFilter.tenantId')!;
    assert.equal(c.severity, 'BREAKING', 'existing callers omit it and now fail');
  });

  test('an added output field is SAFE', () => {
    const { changes } = diffWith([]);
    assert.equal(changes.find((c) => c.path === 'User.displayName')!.severity, 'SAFE');
  });
});

describe('the gate and its report', () => {
  test('the overall verdict is the worst severity present', () => {
    const { changes } = diffWith([]);
    assert.equal(worstSeverity(changes), 'BREAKING'); // UserFilter.tenantId
  });

  test('removing only the dead deprecated fields passes the gate', () => {
    const oldS = parseSchema(OLD);
    const newS = parseSchema(`
      type User { id: ID!  email: String!  createdAt: String }
      input UserFilter { email: String }
    `);
    const changes = applyUsage(structuralDiff(oldS, newS), oldS,
      buildWindow([], NOW, 30));
    assert.equal(worstSeverity(changes), 'SAFE',
      'a quarter-long block on dead fields is the failure this tool removes');
  });

  test('a downgrade is never silent - the reason is in the report', () => {
    const { changes } = diffWith([]);
    const md = renderReport(changes);
    assert.match(md, /User\.nickname/);
    assert.match(md, /was BREAKING/);
    assert.match(md, /zero calls/);
  });

  test('the report names callers for anything still breaking', () => {
    const { changes } = diffWith([
      { field: 'User.legacyId', client: 'billing-web', at: NOW - DAY },
    ]);
    assert.match(renderReport(changes), /callers: billing-web/);
  });
});
