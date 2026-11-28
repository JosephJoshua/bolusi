// The phone's intake list editor over the real offline core: a save whose list lands but whose
// hiding is refused starts again from the saved list, so saving again does not send the list a
// second time and a new item keeps the id it was saved with (the PC's editor shares the hook).
import type { RepairRuntime } from '@bolusi/modules/repair/screens';
import { afterEach, expect, test, vi } from 'vitest';

import {
  ensureRepairCatalog,
  openRepairScreenHarness,
  press,
  render,
  repairRuntimeFor,
  settle,
  type,
  type RepairHarness,
  type RenderResult,
} from '../../../test/repair-support.js';

import { RepairSettingsRoute } from './RepairSettingsRoute.js';

let h: RepairHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const LIST = 'repair.options.list.accessories';

function rowIds(screen: RenderResult): string[] {
  const pattern = new RegExp(`^${LIST.replaceAll('.', '\\.')}\\.row\\.[^.]+$`);
  const ids = screen.container
    .queryAll(
      (node) => typeof node.props['testID'] === 'string' && pattern.test(node.props['testID']),
    )
    .map((node) => node.props['testID'] as string);
  return [...new Set(ids)];
}

test('a list that saved before its hiding was refused is not sent again on the next save', async () => {
  h = await openRepairScreenHarness(5801);
  const real = repairRuntimeFor(h, h.ownerId);
  let refuseHide = true;
  const sent: string[] = [];
  const runtime: RepairRuntime = {
    ...real,
    run: ((name: string, input: unknown) => {
      sent.push(name);
      if (name === 'hideIntakeOptions' && refuseHide) {
        refuseHide = false;
        return Promise.reject(new Error('offline'));
      }
      return real.run(name as never, input as never);
    }) as RepairRuntime['run'],
  };
  ensureRepairCatalog();
  const screen = render(
    <RepairSettingsRoute
      page="intakeOptions"
      runtime={runtime}
      syncChip={null}
      onClose={vi.fn()}
    />,
  );
  await settle();
  await press(screen, 'repair.options.open.accessories');

  // Hide an item this store does not use, and add a new one.
  const [first] = rowIds(screen);
  await press(screen, first!);
  await press(screen, `${first!}.shown`);
  await press(screen, `${first!}.done`);
  await press(screen, `${LIST}.add`);
  const added = rowIds(screen).find((id) => !rowIds(screen).slice(0, -1).includes(id))!;
  type(screen, `${added}.name`, 'Tali gantungan');
  await settle();

  await press(screen, `${LIST}.primary`);
  await settle();
  expect(sent).toEqual(['changeIntakeOptions', 'hideIntakeOptions']);
  // The list saved, hiding did not; saving again must not send the new item again.
  await press(screen, `${LIST}.primary`);
  await settle();

  expect(refuseHide).toBe(false);
  expect(sent).toEqual(['changeIntakeOptions', 'hideIntakeOptions']);
  const settings = (await real.query('intakeOptionSettings', {})).rows[0]!;
  const labels = settings.lists.accessories.map((option) => option.label);
  expect(labels.filter((label) => label === 'Tali gantungan')).toHaveLength(1);
});
