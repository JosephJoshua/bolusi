// The CamelCasePlugin configuration (10-db-schema §1: "Runtime uses CamelCasePlugin so TS names
// are camelCase over the snake_case DDL").
//
// ONE definition, used by the production handle and the test harness alike — the plugin is only
// correct if the runtime mapping is the exact inverse of what kysely-codegen --camel-case wrote
// into src/generated/db.d.ts, so two copies of this config that drift would be a silent
// wrong-column bug.
//
// `underscoreBetweenUppercaseLetters` is NOT cosmetic and NOT the default:
//
//   column      codegen --camel-case      plugin (default)   plugin (this config)
//   op_a_id  →  opAId                  →  op_aid   ✗         op_a_id  ✓
//
// With the default, `conflicts.op_a_id` / `op_b_id` (10-db §8) compile fine and then fail at
// runtime against a column that does not exist. `test/codegen-camel-case.test.ts` re-derives
// this over EVERY generated property, so a future column of that shape cannot reintroduce it.
import { CamelCasePlugin } from 'kysely';

export const CAMEL_CASE_OPTIONS = {
  underscoreBetweenUppercaseLetters: true,
} as const;

export function createCamelCasePlugin(): CamelCasePlugin {
  return new CamelCasePlugin({ ...CAMEL_CASE_OPTIONS });
}
