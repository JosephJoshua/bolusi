// Who is at the counter: everyone who can sign in on this PC, most recent first, one click each.
// It doubles as the lock screen after an idle lock or "Kunci layar", where there is no way back into
// the previous person's work without their PIN.
import { derivePinAuthState, type PinAttemptRow } from '@bolusi/core';
import { t, translateRoleKey } from '@bolusi/i18n';
import {
  filterUsers,
  SWITCHER_SEARCH_MIN,
  switcherState,
  type SwitcherUser,
} from '@bolusi/device/models/switcher/model';
import { Avatar, Banner, Button, Chip, SearchField, Skeleton, StatePanel } from '@bolusi/ui-web';
import { KeyRound, Lock, UserX } from 'lucide-react';
import { useState } from 'react';

import { AuthHeading, AuthLayout } from './AuthLayout.js';

export function SwitcherScreen({
  storeName,
  users,
  usersError,
  pinRows,
  locked,
  current,
  onPick,
  onBack,
  onReenrol,
}: {
  readonly storeName: string | null;
  readonly users: readonly SwitcherUser[] | null;
  readonly usersError: string | null;
  readonly pinRows: Readonly<Record<string, PinAttemptRow | null>>;
  /** An idle lock or "Kunci layar" ended the session: say the work is safe. */
  readonly locked: boolean;
  /** Who is signed in while they choose someone else; null at the lock or before anyone. */
  readonly current: { readonly id: string; readonly name: string } | null;
  readonly onPick: (user: SwitcherUser) => void;
  readonly onBack: () => void;
  /** Register this PC again, offered when nobody is left to sign in. */
  readonly onReenrol: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const state = switcherState(users, usersError);

  return (
    <AuthLayout storeName={storeName} width="wide" testId="switcher">
      <AuthHeading title={t('auth.switcher.title')} />
      {locked ? (
        <Banner tone="info" message={t('auth.switcher.idleLocked')} className="mb-6" />
      ) : null}
      {state.kind === 'loading' ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3" aria-busy>
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-[72px]" />
          ))}
        </div>
      ) : state.kind === 'error' || state.kind === 'unauthorized' ? (
        <StatePanel
          icon={UserX}
          tone="danger"
          title={t('core.errors.UNEXPECTED')}
          testId="switcher.error"
        />
      ) : state.kind === 'empty' ? (
        <StatePanel
          icon={UserX}
          title={t('auth.pc.emptyUsers')}
          action={
            <Button
              label={t('auth.switcher.reenroll')}
              variant="secondary"
              onClick={onReenrol}
              data-testid="switcher.reenrol"
            />
          }
          testId="switcher.empty"
        />
      ) : (
        <People
          users={state.users}
          query={query}
          onQuery={setQuery}
          pinRows={pinRows}
          currentId={current?.id ?? null}
          onPick={onPick}
        />
      )}
      {current === null || locked ? null : (
        <div className="mt-6 flex justify-center">
          <Button
            label={t('auth.pc.backTo', { name: current.name })}
            variant="text"
            onClick={onBack}
            data-testid="switcher.back"
          />
        </div>
      )}
    </AuthLayout>
  );
}

function People({
  users,
  query,
  onQuery,
  pinRows,
  currentId,
  onPick,
}: {
  readonly users: readonly SwitcherUser[];
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly pinRows: Readonly<Record<string, PinAttemptRow | null>>;
  readonly currentId: string | null;
  readonly onPick: (user: SwitcherUser) => void;
}): React.JSX.Element {
  const searchable = users.length >= SWITCHER_SEARCH_MIN;
  const shown = searchable ? filterUsers(users, query) : users;
  return (
    <div className="flex flex-col gap-4">
      {searchable ? (
        <SearchField
          value={query}
          onChange={onQuery}
          placeholder={t('auth.switcher.search')}
          label={t('auth.switcher.search')}
          clearLabel={t('core.action.clearSearch')}
          testId="switcher.search"
        />
      ) : null}
      {shown.length === 0 ? (
        <p className="py-6 text-center text-body text-text-muted">{t('auth.switcher.noMatches')}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 lg:grid-cols-3" data-testid="switcher.people">
          {shown.map((user) => (
            <li key={user.id}>
              <PersonCard
                user={user}
                lockedOut={derivePinAuthState(pinRows[user.id] ?? null) === 'locked_out'}
                current={user.id === currentId}
                onPick={() => onPick(user)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PersonCard({
  user,
  lockedOut,
  current,
  onPick,
}: {
  readonly user: SwitcherUser;
  readonly lockedOut: boolean;
  readonly current: boolean;
  readonly onPick: () => void;
}): React.JSX.Element {
  const role = user.roleKeys.map((key) => translateRoleKey(key)).join(', ');
  return (
    <button
      type="button"
      onClick={onPick}
      data-testid="switcher.person"
      data-user-id={user.id}
      className="flex h-full w-full cursor-pointer items-start gap-3 rounded-sm border border-border bg-surface p-4 text-left transition-colors hover:border-primary hover:bg-info-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <Avatar userId={user.id} name={user.name} size={40} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="break-words text-heading font-semibold text-text">{user.name}</span>
        {role === '' ? null : (
          <span className="break-words text-small text-text-muted">{role}</span>
        )}
        {lockedOut ? (
          <Chip
            label={t('auth.switcher.locked')}
            icon={Lock}
            tone="warning"
            className="self-start"
          />
        ) : user.needsFirstPin ? (
          <Chip label={t('auth.switcher.noPin')} icon={KeyRound} className="self-start" />
        ) : current ? (
          <Chip
            label={t('auth.switcher.current')}
            icon={KeyRound}
            tone="info"
            className="self-start"
          />
        ) : null}
      </span>
    </button>
  );
}
