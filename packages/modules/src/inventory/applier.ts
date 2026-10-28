// The `inventory` projection appliers and table manifests.
//
// A part's row is keyed to the part entity; each movement is its own entity and row, so stock never
// needs a re-fold of anything but the one movement that arrived late. Appliers stay total: the rules
// refuse what must not be recorded, and whatever the server accepted still folds.
import type { ProjectionApplier, ProjectionOperation, ProjectionTableManifest } from '@bolusi/core';

import {
  INVENTORY_MOVEMENT_ENTITY,
  INVENTORY_PART_ENTITY,
  type MovementKind,
} from './constants.js';
import type { InventoryDatabase } from './schema.js';

type Applier = ProjectionApplier<InventoryDatabase>;

export const inventoryPartsTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    name: 'text',
    code: 'text',
    fits: 'text',
    archived: 'integer',
    created_by: 'text',
    created_at: 'integer',
    updated_by: 'text',
    updated_at: 'integer',
  },
  primaryKey: ['id'],
  entityType: INVENTORY_PART_ENTITY,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

export const inventoryMovementsTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    part_id: 'text',
    kind: 'text',
    qty: 'integer',
    counted: 'integer',
    use_kind: 'text',
    use_id: 'text',
    use_label: 'text',
    note: 'text',
    user_id: 'text',
    at: 'integer',
  },
  primaryKey: ['id'],
  entityType: INVENTORY_MOVEMENT_ENTITY,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

function payloadOf<T>(op: ProjectionOperation): T {
  return op.payload as unknown as T;
}

interface PartDetails {
  readonly name: string;
  readonly code: string | null;
  readonly fits: string | null;
}

export const partAddedApplier: Applier = async (db, op) => {
  const payload = payloadOf<PartDetails>(op);
  await db
    .insertInto('inventoryParts')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      name: payload.name,
      code: payload.code,
      fits: payload.fits,
      archived: 0,
      createdBy: op.userId,
      createdAt: op.timestamp,
      updatedBy: op.userId,
      updatedAt: op.timestamp,
    })
    .execute();
};

export const partEditedApplier: Applier = async (db, op) => {
  const payload = payloadOf<PartDetails & { readonly archived: boolean }>(op);
  await db
    .updateTable('inventoryParts')
    .set({
      name: payload.name,
      code: payload.code,
      fits: payload.fits,
      archived: payload.archived ? 1 : 0,
      updatedBy: op.userId,
      updatedAt: op.timestamp,
    })
    .where('id', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .execute();
};

interface Movement {
  readonly partId: string;
  readonly kind: MovementKind;
  readonly qty: number;
  readonly counted: number | null;
  readonly use: { readonly kind: string; readonly id: string; readonly label: string } | null;
  readonly note: string | null;
}

async function insertMovement(
  db: Parameters<Applier>[0],
  op: ProjectionOperation,
  movement: Movement,
): Promise<void> {
  await db
    .insertInto('inventoryMovements')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      // Movement ops are store-scoped, so the store is always stamped.
      storeId: op.storeId ?? '',
      partId: movement.partId,
      kind: movement.kind,
      qty: movement.qty,
      counted: movement.counted,
      useKind: movement.use?.kind ?? null,
      useId: movement.use?.id ?? null,
      useLabel: movement.use?.label ?? null,
      note: movement.note,
      userId: op.userId,
      at: op.timestamp,
    })
    .execute();
}

export const stockCountedApplier: Applier = async (db, op) => {
  const payload = payloadOf<{
    partId: string;
    counted: number;
    expected: number;
    note: string | null;
  }>(op);
  await insertMovement(db, op, {
    partId: payload.partId,
    kind: 'counted',
    qty: payload.counted - payload.expected,
    counted: payload.counted,
    use: null,
    note: payload.note,
  });
};

interface UsePayload {
  readonly partId: string;
  readonly qty: number;
  readonly use: { readonly kind: string; readonly id: string; readonly label: string };
}

export const partTakenApplier: Applier = async (db, op) => {
  const payload = payloadOf<UsePayload>(op);
  await insertMovement(db, op, {
    partId: payload.partId,
    kind: 'taken',
    qty: -payload.qty,
    counted: null,
    use: payload.use,
    note: null,
  });
};

export const partPutBackApplier: Applier = async (db, op) => {
  const payload = payloadOf<UsePayload>(op);
  await insertMovement(db, op, {
    partId: payload.partId,
    kind: 'put_back',
    qty: payload.qty,
    counted: null,
    use: payload.use,
    note: null,
  });
};
