// Shared steps for the PC tests: after a sign-in, the board. Whoever answers requests opens on
// Perlu dicek, so the tests that work the board go there through the sidebar, as the person would.
import { fireEvent, screen, waitFor } from '@testing-library/react';

export async function onBoard(): Promise<void> {
  await waitFor(() => {
    if (
      screen.queryByTestId('repair.desk.board') === null &&
      screen.queryByTestId('repair.desk.attention') === null
    )
      throw new Error('neither the board nor Perlu dicek is showing');
  });
  if (screen.queryByTestId('repair.desk.board') === null)
    fireEvent.click(screen.getByTestId('nav.repair'));
  await screen.findByTestId('repair.desk.board');
}
