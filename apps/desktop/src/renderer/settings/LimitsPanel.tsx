// "Batas wewenang" on the PC: the store owner sets how far each limited role (a manager) may go at
// this store, per servisan (product-scope.md, "Managers, limits, approvals and roles"). The phone's
// limits model decides which roles are offered; each save is a server call, so it needs the
// internet and the page shows only what the server took.
import { staffAdminFailure, type LimitAmounts } from '@bolusi/core';
import type { StaffControls } from '@bolusi/device/bootstrap/staff';
import {
  LIMIT_FIELDS,
  limitHintKey,
  limitRoles,
  sameLimits,
  type LimitRole,
} from '@bolusi/device/models/staff/limits';
import { roleName } from '@bolusi/device/models/staff/roles';
import { t } from '@bolusi/i18n';
import { FormFooter, MoneyField, SaveBar } from '@bolusi/modules/repair/desktop';
import { Banner, Button, Card, SettingsPanel, Skeleton, StatePanel } from '@bolusi/ui-web';
import { CircleAlert, Users } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly roles: readonly LimitRole[] };

/** What is typed per role and kind; null while a field is empty. */
type Draft = Readonly<Record<string, Readonly<Record<keyof LimitAmounts, number | null>>>>;

function draftOf(roles: readonly LimitRole[]): Draft {
  return Object.fromEntries(roles.map((role) => [role.id, role.limits]));
}

function complete(values: Draft[string] | undefined): LimitAmounts | null {
  if (values === undefined) return null;
  const { priceDrop, refund, credit } = values;
  return priceDrop === null || refund === null || credit === null
    ? null
    : { priceDrop, refund, credit };
}

export function LimitsPanel({
  controls,
  actorUserId,
  onDirtyChange,
}: {
  readonly controls: StaffControls;
  readonly actorUserId: string;
  readonly onDirtyChange: (dirty: boolean) => void;
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [draft, setDraft] = useState<Draft>({});
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const latest = useRef(controls);
  latest.current = controls;

  /** Re-read the saved amounts; the form starts over from them unless `keepTyped`. */
  const reload = useCallback(
    async (keepTyped = false): Promise<void> => {
      try {
        const directory = await latest.current.load();
        const roles = limitRoles(directory, {
          userId: actorUserId,
          tenantAdmin: latest.current.tenantAdmin,
        });
        setLoaded({ kind: 'ready', roles });
        if (!keepTyped) setDraft(draftOf(roles));
      } catch {
        setLoaded({ kind: 'error' });
      }
    },
    [actorUserId],
  );
  useEffect(() => {
    void reload();
  }, [reload]);

  const roles = loaded.kind === 'ready' ? loaded.roles : [];
  const changed = roles.filter((role) => {
    const values = complete(draft[role.id]);
    return values === null || !sameLimits(values, role.limits);
  });
  const dirty = changed.length > 0;
  const report = useRef(onDirtyChange);
  report.current = onDirtyChange;
  useEffect(() => {
    report.current(dirty);
  }, [dirty]);
  useEffect(() => () => report.current(false), []);

  const save = (): void => {
    if (!dirty || busy) return;
    const pending = changed.map((role) => ({ role, limits: complete(draft[role.id]) }));
    if (pending.some((entry) => entry.limits === null)) {
      setAttempted(true);
      return;
    }
    setBusy(true);
    setFailure(null);
    void (async () => {
      try {
        // One role at a time: each is its own server change, and a refusal stops the rest.
        for (const { role, limits } of pending) {
          await latest.current.onSetLimits(role.id, limits!);
        }
        await reload();
        setAttempted(false);
        setNotice(
          pending.length === 1
            ? t('auth.limits.saved', { role: roleName(pending[0]!.role) })
            : t('auth.staff.saved'),
        );
      } catch (error: unknown) {
        // Roles saved before the refusal read as saved; what was typed stays for a retry.
        await reload(true);
        const reason = staffAdminFailure(error);
        setFailure(
          reason === 'offline'
            ? t('auth.pc.settings.staffOffline')
            : t(`auth.limits.failure.${reason}`),
        );
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <SettingsPanel
      title={t('auth.limits.title')}
      lead={t('auth.limits.intro')}
      testId="desktop.settings.limits"
    >
      {failure === null ? null : <Banner tone="danger" message={failure} />}
      {loaded.kind === 'loading' ? (
        <Skeleton className="h-32" />
      ) : loaded.kind === 'error' ? (
        <StatePanel
          icon={CircleAlert}
          tone="danger"
          title={t('core.errors.UNEXPECTED')}
          action={
            <Button
              label={t('core.action.retry')}
              variant="secondary"
              onClick={() => void reload()}
            />
          }
        />
      ) : roles.length === 0 ? (
        <StatePanel
          icon={Users}
          title={t('auth.limits.empty')}
          hint={t('auth.limits.emptyBody')}
          testId="desktop.settings.limits.empty"
        />
      ) : (
        <div className="flex flex-1 flex-col gap-4">
          {roles.map((role) => (
            <Card key={role.id} testId={`desktop.settings.limits.${role.key}`}>
              <h3 className="pb-3 text-body font-semibold text-text">{roleName(role)}</h3>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
                {LIMIT_FIELDS.map((field) => {
                  const { kind, label } = field;
                  const value = draft[role.id]?.[kind] ?? null;
                  return (
                    <MoneyField
                      key={kind}
                      label={t(label)}
                      hint={t(limitHintKey(field, value))}
                      value={value}
                      onChange={(next) => {
                        setNotice(null);
                        setFailure(null);
                        setDraft((current) => ({
                          ...current,
                          [role.id]: { ...(current[role.id] ?? role.limits), [kind]: next },
                        }));
                      }}
                      error={attempted && value === null ? t('auth.limits.missing') : undefined}
                      disabled={busy}
                      data-testid={`desktop.settings.limits.${role.key}.${kind}`}
                    />
                  );
                })}
              </div>
            </Card>
          ))}
          <FormFooter>
            <SaveBar
              dirty={dirty}
              busy={busy}
              saved={notice}
              onSave={save}
              onDiscard={() => {
                setAttempted(false);
                setFailure(null);
                setDraft(draftOf(roles));
              }}
              saveLabel={t('auth.limits.save')}
              testId="desktop.settings.limits"
            />
          </FormFooter>
        </div>
      )}
    </SettingsPanel>
  );
}
