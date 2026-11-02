/**
 * "Batas wewenang" — the store owner sets how far each limited role (a manager) may go at this store,
 * per servisan: discounts, refunds and Bayar nanti (product-scope.md, "Managers, limits, approvals
 * and roles"). Reached from Settings.
 *
 * ONLINE ONLY, like "Karyawan": each save is a server call, and the screen re-reads this phone's
 * directory afterwards, so it never shows an amount the server refused. With one limited role (the
 * usual store) the form opens straight away; otherwise a list of roles comes first.
 */
import {
  staffAdminFailure,
  type LimitAmounts,
  type StaffActor,
  type StaffAdminFailure,
  type StaffDirectory,
} from '@bolusi/core';
import { formatMoney, t } from '@bolusi/i18n';
import {
  Banner,
  Button,
  ConfirmSheet,
  List,
  ListRow,
  TextInput,
  color,
  space,
  type,
  type ListState,
  Text,
} from '@bolusi/ui';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useLatestCallback } from '../../hooks/useLatestCallback.js';
import type { SurfaceNav } from '../../navigation/surface.js';

import {
  acceptsLimitText,
  LIMIT_FIELDS,
  limitHintKey,
  limitRoles,
  limitsText,
  parseLimit,
  parseLimits,
  sameLimits,
  type LimitRole,
  type LimitsText,
} from '@bolusi/device/models/staff/limits';
import { roleName } from '@bolusi/device/models/staff/roles';
import { StaffShell } from './StaffPages.js';

export interface LimitsScreenProps {
  readonly actor: StaffActor;
  /** Read the roles and their amounts from this phone's directory. */
  readonly load: () => Promise<StaffDirectory>;
  /** Resolves once the server has the amounts and this phone's directory was refreshed; REJECTS
   *  with a `StaffAdminError`. */
  readonly onSave: (roleId: string, limits: LimitAmounts) => Promise<void>;
  readonly onClose: () => void;
  readonly onRegisterSurfaceNav?: ((nav: SurfaceNav | null) => void) | undefined;
}

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly roles: readonly LimitRole[] };

export function LimitsScreen({
  actor,
  load,
  onSave,
  onClose,
  onRegisterSurfaceNav,
}: LimitsScreenProps): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const latestLoad = useLatestCallback(load);
  const reload = useCallback(async (): Promise<void> => {
    try {
      setLoaded({ kind: 'ready', roles: limitRoles(await latestLoad(), actor) });
    } catch {
      setLoaded({ kind: 'error' });
    }
  }, [latestLoad, actor]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const roles = loaded.kind === 'ready' ? loaded.roles : null;
  // One role: its form is the whole screen, so its back leaves.
  const single = roles?.length === 1 ? roles[0]! : null;
  const open = single ?? roles?.find((role) => role.id === openId) ?? null;

  const [formBack, setFormBack] = useState<(() => void) | null>(null);
  const back = (): void => {
    if (formBack !== null) formBack();
    else onClose();
  };
  const latestBack = useLatestCallback(back);
  useEffect(() => {
    if (onRegisterSurfaceNav === undefined) return undefined;
    onRegisterSurfaceNav({
      handleBack: () => {
        latestBack();
        return true;
      },
      requestLeave: (proceed) => proceed(),
    });
    return () => onRegisterSurfaceNav(null);
  }, [onRegisterSurfaceNav, latestBack]);

  if (open !== null) {
    const leave = (): void => {
      setFormBack(null);
      if (single === null) setOpenId(null);
      else onClose();
    };
    return (
      <LimitsForm
        key={open.id}
        role={open}
        notice={single === null ? null : notice}
        onClearNotice={() => setNotice(null)}
        onRegisterBack={setFormBack}
        onLeave={leave}
        onSave={async (limits) => {
          await onSave(open.id, limits);
          await reload();
          setNotice(t('auth.limits.saved', { role: roleName(open) }));
          if (single === null) leave();
        }}
      />
    );
  }

  const listState: ListState<LimitRole> =
    loaded.kind === 'loading'
      ? { kind: 'loading' }
      : loaded.kind === 'error'
        ? {
            kind: 'error',
            error: {
              title: t('core.errors.UNEXPECTED'),
              errorCode: 'UNEXPECTED',
              retryLabel: t('core.action.retry'),
              onRetry: () => void reload(),
            },
          }
        : loaded.roles.length === 0
          ? {
              kind: 'empty',
              empty: { title: t('auth.limits.empty'), hint: t('auth.limits.emptyBody') },
            }
          : { kind: 'ready', items: loaded.roles };

  return (
    <StaffShell
      title={t('auth.limits.title')}
      onBack={back}
      banner={
        notice === null ? undefined : (
          <Banner
            variant="info"
            message={notice}
            onDismiss={() => setNotice(null)}
            testID="limits-notice"
          />
        )
      }
    >
      <View style={styles.list}>
        <List
          state={listState}
          keyExtractor={(role) => role.id}
          renderRow={(role) => (
            <ListRow
              primaryText={roleName(role)}
              secondaryText={limitsSummary(role.limits)}
              onPress={() => {
                setNotice(null);
                setOpenId(role.id);
              }}
              testID={`limits-role-${role.key}`}
            />
          )}
          testID="limits-list"
        />
      </View>
    </StaffShell>
  );
}

/** "Diskon Rp 50.000 · Refund Rp 0 · Bayar nanti Rp 100.000", breaking only between amounts. */
function limitsSummary(limits: LimitAmounts): string {
  return LIMIT_FIELDS.map(({ kind, label }) =>
    `${t(label)} ${formatMoney(limits[kind])}`.replace(/ /g, '\u00a0'),
  ).join(' · ');
}

/** Typed digits as rupiah; an emptied field stays empty rather than snapping back to "Rp 0". */
function moneyText(digits: string): string {
  return digits === '' ? '' : formatMoney(Number(digits));
}

function LimitsForm({
  role,
  notice,
  onClearNotice,
  onRegisterBack,
  onLeave,
  onSave,
}: {
  readonly role: LimitRole;
  readonly notice: string | null;
  readonly onClearNotice: () => void;
  readonly onRegisterBack: (back: (() => void) | null) => void;
  readonly onLeave: () => void;
  readonly onSave: (limits: LimitAmounts) => Promise<void>;
}): React.JSX.Element {
  const [text, setText] = useState<LimitsText>(() => limitsText(role.limits));
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<StaffAdminFailure | null>(null);
  const [discarding, setDiscarding] = useState(false);

  const draft = parseLimits(text);
  // After a save the role re-reads with the new amounts, so the form is clean again.
  const dirty = draft === null || !sameLimits(draft, role.limits);

  const leave = useLatestCallback(() => {
    if (busy) return;
    if (discarding) setDiscarding(false);
    else if (dirty) setDiscarding(true);
    else onLeave();
  });
  useEffect(() => {
    onRegisterBack(() => leave);
    return () => onRegisterBack(null);
  }, [onRegisterBack, leave]);

  const save = (): void => {
    setAttempted(true);
    if (draft === null) return;
    if (!dirty) {
      onLeave();
      return;
    }
    setBusy(true);
    setFailure(null);
    onClearNotice();
    void onSave(draft).then(
      () => setBusy(false),
      (error: unknown) => {
        setBusy(false);
        setFailure(staffAdminFailure(error));
      },
    );
  };

  return (
    <StaffShell
      scrollable
      title={t('auth.limits.formTitle', { role: roleName(role) })}
      onBack={leave}
      banner={
        failure !== null ? (
          <Banner
            variant={failure === 'offline' ? 'warning' : 'danger'}
            message={t(`auth.limits.failure.${failure}`)}
            testID="limits-failure"
          />
        ) : notice !== null ? (
          <Banner
            variant="info"
            message={notice}
            onDismiss={onClearNotice}
            testID="limits-notice"
          />
        ) : undefined
      }
      bottomAction={
        <Button label={t('auth.limits.save')} onPress={save} busy={busy} testID="limits-save" />
      }
      overlay={
        discarding ? (
          <ConfirmSheet
            title={t('auth.staff.discardTitle')}
            message={t('auth.staff.discardMessage')}
            confirmLabel={t('auth.staff.discard')}
            onConfirm={() => {
              setDiscarding(false);
              onLeave();
            }}
            cancelLabel={t('auth.staff.keepEditing')}
            onCancel={() => setDiscarding(false)}
            tone="destructive"
            testID="limits-discard"
          />
        ) : null
      }
    >
      <View style={styles.form} testID={`limits-form-${role.key}`}>
        <Text style={styles.intro}>{t('auth.limits.intro')}</Text>
        <View style={styles.fields}>
          {LIMIT_FIELDS.map((field) => (
            <View key={field.kind}>
              <TextInput
                label={t(field.label)}
                // Shown as money while typing ("Rp 50.000"), so there is nothing to read back.
                value={moneyText(text[field.kind])}
                onChangeText={(next) => {
                  if (busy || !acceptsLimitText(next)) return;
                  setFailure(null);
                  onClearNotice();
                  setText((current) => ({ ...current, [field.kind]: next.replace(/\D/g, '') }));
                }}
                keyboardType="number-pad"
                selectTextOnFocus
                errorMessage={
                  attempted && text[field.kind] === '' ? t('auth.limits.missing') : undefined
                }
                disabled={busy}
                testID={`limits-${field.kind}`}
              />
              <Text style={styles.hint}>
                {t(limitHintKey(field, parseLimit(text[field.kind])))}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </StaffShell>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, marginHorizontal: -space.lg },
  form: { paddingTop: space.md, gap: space.lg },
  intro: { ...type.body, color: color.textMuted },
  fields: { gap: space.lg },
  hint: { ...type.bodySm, color: color.textMuted, marginTop: space.xs },
});
