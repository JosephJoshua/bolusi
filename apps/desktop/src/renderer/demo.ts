// Demo data for the desktop build, which runs the counter screens over the in-memory repair demo
// before the offline core is wired in. Names here are seeded data, not interface copy.
import { StaffAdminError, type StaffDirectory } from '@bolusi/core';
import type { StaffControls } from '@bolusi/device/bootstrap/staff';
import { demoRepairRuntime, type DemoRepairRole } from '@bolusi/modules/repair/demo';
import type { RepairRuntime } from '@bolusi/modules/repair/desktop';

import type { CapturedMedia } from '@bolusi/modules/screen-kit';
import { SIGNATURE_PX, type DrawnSignature } from '@bolusi/ui-web';

import { compressPhoto, type PcCapture } from './capture.js';
import { desktopPrinting } from './print.js';
import { PRESET_ROLE_ABILITIES, permissionsFor } from '@bolusi/modules/roles';

export const DEMO_STORE_NAME = 'Toko Sorong Kota';

export interface DemoPerson {
  readonly role: DemoRepairRole;
  readonly userId: string;
  readonly name: string;
  /** The role catalog key (`role.<key>.name`) the person holds. */
  readonly roleKey: string;
}

export const DEMO_PEOPLE: readonly DemoPerson[] = [
  { role: 'counter', userId: 'u-siti', name: 'Siti Rahayu', roleKey: 'cashier' },
  { role: 'owner', userId: 'u-andi', name: 'Andi Pratama', roleKey: 'main_owner' },
  { role: 'storeOwner', userId: 'u-yosua', name: 'Yosua Wonda', roleKey: 'store_owner' },
  { role: 'technician', userId: 'u-budi', name: 'Budi Santoso', roleKey: 'technician' },
  { role: 'manager', userId: 'u-maria', name: 'Maria Kogoya', roleKey: 'manager' },
];

// Captures live only in this window's memory: the demo has no media store. The real build hands
// them to the offline core instead.
const captured = new Map<string, string>();

async function keepDemo(
  bytes: Uint8Array<ArrayBuffer>,
  mime: 'image/jpeg' | 'image/png',
  type: 'image' | 'signature',
): Promise<CapturedMedia> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const mediaId = crypto.randomUUID();
  captured.set(mediaId, URL.createObjectURL(new Blob([bytes], { type: mime })));
  return {
    mediaRef: {
      mediaId,
      sha256,
      mime,
      type,
      sizeBytes: bytes.length,
      capturedAt: Date.now(),
      location: null,
      userId: 'u-siti',
      deviceId: 'd-demo',
    },
  };
}

/** The strokes drawn on a white pad, as a PNG; the real build renders them with the phone's code. */
async function signaturePng({ strokes, pad }: DrawnSignature): Promise<Uint8Array<ArrayBuffer>> {
  const canvas = document.createElement('canvas');
  canvas.width = SIGNATURE_PX.width;
  canvas.height = SIGNATURE_PX.height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no canvas');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(canvas.width / pad.width, canvas.height / pad.height);
  context.lineWidth = 4;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const stroke of strokes) {
    context.beginPath();
    for (const [index, { x, y }] of stroke.entries()) {
      if (index === 0) context.moveTo(x, y);
      context.lineTo(x, y);
    }
    context.stroke();
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (blob === null) throw new Error('signature did not render');
  return new Uint8Array(await blob.arrayBuffer());
}

/** A fresh store's worth of servisan for this person; switching people starts over. */
export function demoRuntimeFor(person: DemoPerson, capture: PcCapture): RepairRuntime {
  const runtime = demoRepairRuntime(person.role, { now: Date.now(), volume: 'store' });
  return {
    ...runtime,
    capturePhoto: async (request) => {
      const photo = await capture.photo(request);
      if (photo === null) return null;
      const jpeg = await compressPhoto(photo);
      return keepDemo(jpeg.bytes, jpeg.mime, 'image');
    },
    captureSignature: async (request) => {
      const signature = await capture.signature(request);
      return signature === null
        ? null
        : keepDemo(await signaturePng(signature), 'image/png', 'signature');
    },
    // A photo taken here shows itself; the seeded ones show the demo's placeholders.
    loadThumbnail: (ref) => {
      const url = captured.get(ref.mediaId);
      return url === undefined
        ? runtime.loadThumbnail(ref)
        : Promise.resolve({ kind: 'ready', uri: url });
    },
    printing:
      runtime.printing === undefined
        ? undefined
        : desktopPrinting(runtime.printing, DEMO_STORE_NAME),
  };
}

const DEMO_ROLES: StaffDirectory['roles'] = [
  {
    id: 'r-cashier',
    key: 'cashier',
    custom: false,
    permissionIds: permissionsFor(new Set(PRESET_ROLE_ABILITIES.cashier)),
    ownerRole: false,
    limits: null,
  },
  {
    id: 'r-technician',
    key: 'technician',
    custom: false,
    permissionIds: permissionsFor(new Set(PRESET_ROLE_ABILITIES.technician)),
    ownerRole: false,
    limits: null,
  },
  {
    id: 'r-manager',
    key: 'manager',
    custom: false,
    permissionIds: permissionsFor(new Set(PRESET_ROLE_ABILITIES.manager)),
    ownerRole: false,
    limits: { priceDrop: 50_000, refund: 30_000, credit: 100_000 },
  },
  {
    id: 'r-store_owner',
    key: 'store_owner',
    custom: false,
    permissionIds: [],
    ownerRole: true,
    limits: null,
  },
];

/** The demo store's people over an in-memory server, for an owner's "Karyawan" and limits. */
let demoDirectory: StaffDirectory = {
  roles: DEMO_ROLES,
  members: DEMO_PEOPLE.map((person) => ({
    id: person.userId,
    name: person.name,
    active: true,
    roleKeys: [person.roleKey],
    roleIds: [`r-${person.roleKey}`],
    owner: person.roleKey.endsWith('owner'),
    hasPin: true,
  })),
};

/** Staff controls for the demo's owners; others manage no one. Changes last until reload. */
export function demoStaffFor(person: DemoPerson): StaffControls | undefined {
  if (person.role !== 'owner' && person.role !== 'storeOwner') return undefined;
  const server = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400));
  return {
    tenantAdmin: person.role === 'owner',
    load: () => Promise.resolve(demoDirectory),
    onCreate: async (draft) => {
      await server();
      const id = `u-demo-${String(demoDirectory.members.length)}`;
      demoDirectory = {
        ...demoDirectory,
        members: [
          ...demoDirectory.members,
          {
            id,
            name: draft.name,
            active: true,
            roleKeys: keysOf(draft.roleIds),
            roleIds: draft.roleIds,
            owner: false,
            hasPin: false,
          },
        ],
      };
      return { userId: id };
    },
    onUpdate: async (userId, change) => {
      await server();
      demoDirectory = {
        ...demoDirectory,
        members: demoDirectory.members.map((member) =>
          member.id === userId
            ? {
                ...member,
                ...(change.name === undefined ? {} : { name: change.name }),
                ...(change.roleIds === undefined
                  ? {}
                  : {
                      roleIds: change.roleIds,
                      roleKeys: keysOf(change.roleIds),
                    }),
              }
            : member,
        ),
      };
    },
    onSetActive: async (userId, active) => {
      await server();
      demoDirectory = {
        ...demoDirectory,
        members: demoDirectory.members.map((member) =>
          member.id === userId ? { ...member, active } : member,
        ),
      };
    },
    canSetLimits: true,
    onSetLimits: async (roleId, limits) => {
      await server();
      demoDirectory = {
        ...demoDirectory,
        roles: demoDirectory.roles.map((role) => (role.id === roleId ? { ...role, limits } : role)),
      };
    },
    onCreateRole: async (name, copyFromRoleId) => {
      await server();
      const source = demoDirectory.roles.find((role) => role.id === copyFromRoleId);
      if (source === undefined) throw new StaffAdminError('denied');
      const roleId = `r-made-${String(demoDirectory.roles.length)}`;
      demoDirectory = {
        ...demoDirectory,
        roles: [
          ...demoDirectory.roles,
          {
            ...source,
            id: roleId,
            key: name,
            custom: true,
            limits: source.limits === null ? null : { priceDrop: 0, refund: 0, credit: 0 },
          },
        ],
      };
      return { roleId };
    },
    onUpdateRole: async (roleId, change) => {
      await server();
      demoDirectory = {
        ...demoDirectory,
        roles: demoDirectory.roles.map((role) =>
          role.id !== roleId
            ? role
            : {
                ...role,
                ...(change.name === undefined ? {} : { key: change.name }),
                ...(change.permissionIds === undefined
                  ? {}
                  : { permissionIds: change.permissionIds }),
                ...(change.limited === undefined
                  ? {}
                  : {
                      limits: change.limited
                        ? (role.limits ?? { priceDrop: 0, refund: 0, credit: 0 })
                        : null,
                    }),
              },
        ),
      };
      // A renamed role shows its new name on everyone holding it.
      demoDirectory = {
        ...demoDirectory,
        members: demoDirectory.members.map((member) => ({
          ...member,
          roleKeys: keysOf(member.roleIds),
        })),
      };
    },
    onDeleteRole: async (roleId) => {
      await server();
      demoDirectory = {
        ...demoDirectory,
        roles: demoDirectory.roles.filter((role) => role.id !== roleId),
      };
    },
  };
}

function keysOf(roleIds: readonly string[]): string[] {
  return roleIds.flatMap((id) => demoDirectory.roles.find((role) => role.id === id)?.key ?? []);
}
