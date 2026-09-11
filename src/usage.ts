import type { Change, Schema, Severity } from './diff.ts';

/**
 * Field-usage telemetry and the severity-downgrade rule.
 *
 * One line per observed field access, as a real gateway would emit:
 *   { "field": "User.legacyId", "client": "billing-web", "at": 1700000000000 }
 */

export interface UsageRecord {
  readonly field: string;
  readonly client: string;
  readonly at: number;
}

export interface UsageWindow {
  /** Callers seen in the window, per field path. */
  readonly callersByField: ReadonlyMap<string, readonly string[]>;
  readonly windowDays: number;
  readonly now: number;
}

export function buildWindow(
  records: readonly UsageRecord[], now: number, windowDays: number,
): UsageWindow {
  const cutoff = now - windowDays * 86_400_000;
  const map = new Map<string, Set<string>>();
  for (const r of records) {
    if (r.at < cutoff) continue;
    if (!map.has(r.field)) map.set(r.field, new Set());
    map.get(r.field)!.add(r.client);
  }
  const out = new Map<string, readonly string[]>();
  for (const [k, v] of map) out.set(k, [...v].sort());
  return { callersByField: out, windowDays, now };
}

function isDeprecated(schema: Schema, path: string): boolean {
  const [typeName, fieldName] = path.split('.');
  if (!typeName || !fieldName) return false;
  const t = schema.get(typeName);
  return t?.fields.find((f) => f.name === fieldName)?.deprecated ?? false;
}

/**
 * Apply usage evidence.
 *
 * The rule is deliberately narrow. Only removals of DEPRECATED fields with
 * ZERO observed callers are downgraded. A field with one caller stays
 * BREAKING - "only one team uses it" is not a reason to break that team, and a
 * gate that starts making that judgement is a gate nobody can trust.
 */
export function applyUsage(
  changes: readonly Change[], oldSchema: Schema, window: UsageWindow,
): Change[] {
  return changes.map((c): Change => {
    if (c.kind !== 'FIELD_REMOVED' || c.severity !== 'BREAKING') return c;

    const callers = window.callersByField.get(c.path) ?? [];
    if (callers.length > 0) {
      // Enrich, do not downgrade. Naming the caller is the actionable part.
      return { ...c, callers };
    }
    if (!isDeprecated(oldSchema, c.path)) {
      return {
        ...c,
        justification:
          `no callers in ${window.windowDays}d, but the field was never ` +
          `deprecated - clients had no warning, so this stays breaking`,
        callers: [],
      };
    }
    return {
      ...c,
      severity: 'SAFE' as Severity,
      downgradedFrom: 'BREAKING' as Severity,
      justification:
        `deprecated, and zero calls from any client in the last ` +
        `${window.windowDays} days`,
      callers: [],
    };
  });
}

export function worstSeverity(changes: readonly Change[]): Severity {
  if (changes.some((c) => c.severity === 'BREAKING')) return 'BREAKING';
  if (changes.some((c) => c.severity === 'DANGEROUS')) return 'DANGEROUS';
  return 'SAFE';
}

/** The PR comment. A gate that cannot explain itself gets overridden. */
export function renderReport(changes: readonly Change[]): string {
  const order: Severity[] = ['BREAKING', 'DANGEROUS', 'SAFE'];
  const icon = { BREAKING: 'x', DANGEROUS: '!', SAFE: 'o' } as const;
  const lines = ['### Schema change report', ''];
  for (const sev of order) {
    const group = changes.filter((c) => c.severity === sev);
    if (!group.length) continue;
    lines.push(`**${sev}** (${group.length})`, '');
    for (const c of group) {
      let l = `- [${icon[sev]}] \`${c.path}\` - ${c.kind}`;
      if (c.downgradedFrom) l += ` _(was ${c.downgradedFrom}: ${c.justification})_`;
      else if (c.justification) l += ` _(${c.justification})_`;
      if (c.callers?.length) l += ` **callers: ${c.callers.join(', ')}**`;
      lines.push(l);
    }
    lines.push('');
  }
  return lines.join('\n');
}
