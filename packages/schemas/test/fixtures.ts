// Shared spec-shaped fixtures (05-operation-log §2.1–2.2, api/01-sync §3–4.1).
// Suites override individual fields inline so each case carries its own
// distinguishing value (testing-guide: unique value per case).

export function validCore() {
  return {
    id: '0197a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b',
    tenantId: '3f8a1c2e-4b5d-4e6f-9a7b-8c9d0e1f2a3b',
    storeId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
    deviceId: 'c3d4e5f6-a7b8-4c9d-8e0f-2a3b4c5d6e7f',
    seq: 7,
    type: 'notes.note_created',
    entityType: 'note',
    entityId: '0197a1b2-c3d4-7abc-9def-223344556677',
    schemaVersion: 1,
    payload: { title: 'Ganti LCD', amountIdr: 250000 },
    timestamp: 1752480000000,
    location: null,
    source: 'ui',
    agentInitiated: false,
    agentConversationId: null,
    previousHash: 'a1'.repeat(32),
  };
}

export function validOp() {
  return {
    ...validCore(),
    hash: 'b2'.repeat(32),
    signature: 'c2lnbmF0dXJl',
  };
}

export function validDeviceInfo() {
  return {
    id: 'd4e5f6a7-b8c9-4d0e-9f1a-3b4c5d6e7f8a',
    storeId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    kind: 'member',
    // Deliberately low-entropy valid base64 — a realistic-looking key here would
    // (rightly) trip the pre-commit secret scan (security-guide SEC-SECRET-02).
    signingKeyPublic: 'QUFBQUFBQUFBQUFBQUFBQQ==',
    status: 'active',
    revokedAt: null,
  };
}
