// `MediaItem.uploadStatus` (03-state-machines §4) — the FULL transition matrix.
//
// The oracle below is transcribed INDEPENDENTLY from 03 §4's table, not derived from the machine
// (T-5/T-13: a golden built from the code under test only proves the code agrees with itself). If
// this table and MEDIA_UPLOAD_STATUS_MACHINE disagree, read the spec — do not "fix" the oracle to
// match the code.
import { describe, expect, it } from 'vitest';

import { DomainError, MEDIA_UPLOAD_STATUS_MACHINE, runTransition } from '../../src/index.js';
import type { MediaUploadEvent, MediaUploadStatus } from '../../src/index.js';

const STATES: readonly MediaUploadStatus[] = ['pending', 'uploading', 'uploaded', 'failed'];
const EVENTS: readonly MediaUploadEvent[] = [
  'select',
  'chunk_ack',
  'complete',
  'failure',
  'recover',
  'retry',
];

// 03 §4's transition table, transcribed by hand. `null` = INVALID_TRANSITION (no table entry).
const ORACLE: Record<MediaUploadStatus, Record<MediaUploadEvent, MediaUploadStatus | null>> = {
  // "pending | drain loop selects item (device online) | uploading"
  pending: {
    select: 'uploading',
    chunk_ack: null,
    complete: null,
    failure: null,
    recover: null,
    retry: null,
  },
  // "uploading | chunk PUT succeeds | uploading (self)"
  // "uploading | server confirms complete | uploaded"
  // "uploading | chunk/complete failure | failed"
  // "uploading | app restart finds no live upload task | pending"
  uploading: {
    select: null,
    chunk_ack: 'uploading',
    complete: 'uploaded',
    failure: 'failed',
    recover: 'pending',
    retry: null,
  },
  // "Terminal: uploaded." + "Invalid: uploaded → *"
  uploaded: {
    select: null,
    chunk_ack: null,
    complete: null,
    failure: null,
    recover: null,
    retry: null,
  },
  // "failed | nextAttemptAt reached · manual retry · connectivity regained | uploading"
  failed: {
    select: null,
    chunk_ack: null,
    complete: null,
    failure: null,
    recover: null,
    retry: 'uploading',
  },
};

describe('MEDIA_UPLOAD_STATUS_MACHINE shape (03 §4)', () => {
  it('declares exactly 03 §4s four states', () => {
    expect([...MEDIA_UPLOAD_STATUS_MACHINE.states].sort()).toEqual(
      ['failed', 'pending', 'uploaded', 'uploading'].sort(),
    );
  });

  it('is born only at pending — 03 §4 "Birth: pending, at capture-commit"', () => {
    expect(MEDIA_UPLOAD_STATUS_MACHINE.initial).toEqual(['pending']);
  });

  it('declares uploaded terminal — 03 §4 "Terminal: uploaded"', () => {
    expect(MEDIA_UPLOAD_STATUS_MACHINE.terminal).toEqual(['uploaded']);
  });

  it('expresses terminality as an empty row, not as a guard a caller could forget', () => {
    expect(MEDIA_UPLOAD_STATUS_MACHINE.transitions.uploaded).toEqual({});
  });
});

describe('the full 4x6 transition matrix against an independently transcribed 03 §4', () => {
  it('every legal pair reaches the state 03 §4 names', () => {
    let checked = 0;
    for (const from of STATES) {
      for (const event of EVENTS) {
        const expected = ORACLE[from][event];
        if (expected === null) continue;
        const result = runTransition(MEDIA_UPLOAD_STATUS_MACHINE, from, event);
        expect(result.to, `(${from}, ${event})`).toBe(expected);
        checked += 1;
      }
    }
    // Denominator (T-14): the six legal pairs 03 §4's table declares. A machine that lost a
    // transition would make this loop check five and still pass every assertion it ran.
    expect(checked).toBe(6);
  });

  it('every illegal pair throws INVALID_TRANSITION with the machine id and the attempted pair', () => {
    let checked = 0;
    for (const from of STATES) {
      for (const event of EVENTS) {
        if (ORACLE[from][event] !== null) continue;
        let thrown: unknown;
        try {
          runTransition(MEDIA_UPLOAD_STATUS_MACHINE, from, event);
        } catch (error) {
          thrown = error;
        }
        expect(thrown, `(${from}, ${event}) must throw`).toBeInstanceOf(DomainError);
        expect((thrown as DomainError).code).toBe('INVALID_TRANSITION');
        expect((thrown as DomainError).details).toEqual({
          machine: 'media_upload_status',
          from,
          event,
        });
        checked += 1;
      }
    }
    // Denominator (T-14): 24 pairs total, 6 legal ⇒ 18 illegal. Asserting the total is what makes
    // this suite fail loudly if the matrix is ever starved rather than silently checking nothing.
    expect(checked).toBe(18);
    expect(checked + 6).toBe(STATES.length * EVENTS.length);
  });
});

describe('03 §4s named invalid walks', () => {
  // These three are called out BY NAME in 03 §4 ("Invalid: uploaded → *, pending → uploaded,
  // failed → uploaded"). They are covered by the matrix above; they are restated here because a
  // spec that names a case deserves a test whose failure message names it back.
  it('uploaded is terminal — no event escapes it, including a re-enqueue attempt', () => {
    for (const event of EVENTS) {
      expect(() => runTransition(MEDIA_UPLOAD_STATUS_MACHINE, 'uploaded', event)).toThrow(
        DomainError,
      );
    }
  });

  it('pending cannot reach uploaded without passing through uploading', () => {
    expect(() => runTransition(MEDIA_UPLOAD_STATUS_MACHINE, 'pending', 'complete')).toThrow(
      DomainError,
    );
  });

  it('failed cannot reach uploaded directly — it must go back through uploading', () => {
    expect(() => runTransition(MEDIA_UPLOAD_STATUS_MACHINE, 'failed', 'complete')).toThrow(
      DomainError,
    );
    expect(runTransition(MEDIA_UPLOAD_STATUS_MACHINE, 'failed', 'retry').to).toBe('uploading');
  });
});

describe('the walks 03 §4 requires to be legal', () => {
  it('pending -> uploading -> uploaded', () => {
    expect(runTransition(MEDIA_UPLOAD_STATUS_MACHINE, 'pending', 'select').to).toBe('uploading');
    expect(runTransition(MEDIA_UPLOAD_STATUS_MACHINE, 'uploading', 'complete').to).toBe('uploaded');
  });

  it('uploading -> failed -> uploading -> uploaded', () => {
    expect(runTransition(MEDIA_UPLOAD_STATUS_MACHINE, 'uploading', 'failure').to).toBe('failed');
    expect(runTransition(MEDIA_UPLOAD_STATUS_MACHINE, 'failed', 'retry').to).toBe('uploading');
    expect(runTransition(MEDIA_UPLOAD_STATUS_MACHINE, 'uploading', 'complete').to).toBe('uploaded');
  });

  it('the chunk-success self-loop reports changed:false — an idempotent no-op, not a write', () => {
    const result = runTransition(MEDIA_UPLOAD_STATUS_MACHINE, 'uploading', 'chunk_ack');
    expect(result.to).toBe('uploading');
    expect(result.changed).toBe(false);
  });

  it('crash recovery walks uploading back to pending', () => {
    expect(runTransition(MEDIA_UPLOAD_STATUS_MACHINE, 'uploading', 'recover').to).toBe('pending');
  });
});
