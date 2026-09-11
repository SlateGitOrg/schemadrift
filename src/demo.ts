/**
 * The 60-second artefact: the same schema change, judged twice - once on
 * structure alone, once with usage evidence. Run: `npm run demo`
 */
import { parseSchema, structuralDiff } from './diff.ts';
import { buildWindow, applyUsage, worstSeverity, renderReport } from './usage.ts';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const OLD = `
type User {
  id: ID!
  email: String!
  legacyId: String @deprecated(reason: "use id")
  nickname: String @deprecated(reason: "unused")
  avatarUrl: String @deprecated(reason: "moved to Media")
  createdAt: String
}
`;
const NEW = `
type User {
  id: ID!
  email: String!
  legacyId: String @deprecated(reason: "use id")
  createdAt: String
  displayName: String
}
`;

const oldS = parseSchema(OLD);
const newS = parseSchema(NEW);
const structural = structuralDiff(oldS, newS);

// Telemetry: legacyId still has one caller; nickname and avatarUrl are dead.
const usage = [
  { field: 'User.legacyId', client: 'billing-web', at: NOW - 3 * DAY },
  { field: 'User.email', client: 'billing-web', at: NOW - DAY },
  { field: 'User.nickname', client: 'legacy-admin', at: NOW - 94 * DAY },
];
const withUsage = applyUsage(structural, oldS, buildWindow(usage, NOW, 30));

console.log('\n  SCHEMADRIFT - structural verdict vs usage-aware verdict');
console.log('  ' + '-'.repeat(64));
console.log(`  structure only:  ${worstSeverity(structural)}  ` +
            `(${structural.filter((c) => c.severity === 'BREAKING').length} breaking)`);
console.log(`  with usage:      ${worstSeverity(withUsage)}  ` +
            `(${withUsage.filter((c) => c.severity === 'BREAKING').length} breaking)\n`);

console.log('  field                 structural   with usage   why');
console.log('  ' + '-'.repeat(72));
for (const c of structural.filter((x) => x.kind === 'FIELD_REMOVED')) {
  const after = withUsage.find((x) => x.path === c.path)!;
  const why = after.callers?.length
    ? `still called by ${after.callers.join(', ')}`
    : after.downgradedFrom ? 'deprecated + 0 calls in 30d' : (after.justification ?? '');
  console.log(`  ${c.path.padEnd(21)} ${c.severity.padEnd(12)} ` +
              `${after.severity.padEnd(12)} ${why}`);
}

console.log('\n  The PR comment:\n');
console.log(renderReport(withUsage).split('\n').map((l) => '    ' + l).join('\n'));
