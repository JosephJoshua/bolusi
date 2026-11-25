import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import rule from './refusals-in-rules.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });

tester.run('refusals-in-rules', rule, {
  valid: [
    { code: "throw MONEY_REFUSALS.refuseOnDevice('moveAboveDrawer');" },
    { code: 'requireWaiting(request.status);' },
    { code: "throw new DomainError('VALIDATION_FAILED', { field: 'name' });" },
    { code: 'const { refuseOnDevice } = MONEY_REFUSALS;' },
    { code: 'person.refuse(reason);' },
  ],
  invalid: [
    {
      code: "throw REPAIR_REFUSALS.refuse('downPaymentRefunded', { details });",
      errors: [{ messageId: 'commandRefusal' }],
    },
    { code: 'const { refuse } = REPAIR_REFUSALS;', errors: [{ messageId: 'commandRefusal' }] },
  ],
});
