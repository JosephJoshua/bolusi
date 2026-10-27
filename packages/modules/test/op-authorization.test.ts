// Every registered op type states who may write it (the server checks it on push). A type with no
// permission is one nothing authorizes, so it must be one only the runtime or the server writes:
// the sanctioned runtime emissions, and the server's own conflict record.
import { describe, expect, test } from 'vitest';

import { isSanctionedRuntimeEmission, PLATFORM_OP, registerModules } from '@bolusi/core';

import { ALL_MODULES } from '../src/index.js';

const SERVER_WRITTEN = new Set<string>([PLATFORM_OP.conflictDetected]);

describe('op type authorization declarations', () => {
  const registry = registerModules(ALL_MODULES);
  const declarations = registry.modules.flatMap((module) => Object.entries(module.operations));

  test('covers every module', () => {
    expect(declarations.length).toBeGreaterThan(20);
  });

  test('a type declares no permission exactly when only the runtime or the server writes it', () => {
    for (const [type, declaration] of declarations) {
      const writtenOutsideCommands = isSanctionedRuntimeEmission(type) || SERVER_WRITTEN.has(type);
      expect(declaration.permission === null, type).toBe(writtenOutsideCommands);
    }
  });
});
