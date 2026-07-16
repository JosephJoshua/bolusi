// The platform-free media engine (06-media-pipeline). Capture, compression and the filesystem
// live in apps/mobile behind `MediaFilePort`/`MediaTransportPort`; everything decidable without a
// device lives here, which is what makes 06 §5/§7 testable under a FakeClock with no camera.
//
// `pendingMediaCount` is NOT re-exported here and is NOT defined here: it already ships at
// `../sync/state.ts` (task 15) and `sync/loop.ts` calls it. 06 §4 says it is "recomputed by the
// sync loop (api/01-sync §6)", so `sync/` is its correct home; a second definition would violate
// CLAUDE.md §2.8. This note exists because task 18's file listed it as this module's to write —
// it was already built (verified against the producer, T-16).
export {
  MEDIA_BACKOFF_SCHEDULE_MS,
  MEDIA_PERSISTENT_FAILURE_ATTEMPTS,
  isPersistentlyFailing,
  mediaBackoffDelayMs,
} from './backoff.js';
export {
  MediaDrainLoop,
  mediaErrorLabelKey,
  missingChunks,
  type MediaDrainOptions,
  type MediaDrainTrigger,
  type MediaSurfacePort,
  type MediaSurfacing,
} from './drain.js';
export {
  fetchAndVerifyMedia,
  type MediaFetchOutcome,
  type VerifiedDownloadOptions,
} from './download.js';
export {
  DRAIN_HALTING_CODES,
  LOCAL_CORRUPT_ERROR_CODE,
  MEDIA_ERROR_CODES,
  MediaTransportError,
  NON_RETRYABLE_CODES,
  isAutoRetryable,
  type MediaChunkResponse,
  type MediaCompleteResponse,
  type MediaFilePort,
  type MediaInitRequest,
  type MediaInitResponse,
  type MediaStatusResponse,
  type MediaTransportPort,
  type MediaWireStatus,
} from './ports.js';
export {
  ORPHAN_RETENTION_MS,
  STORAGE_CAPTURE_REFUSED_BYTES,
  STORAGE_LOUD_BYTES,
  STORAGE_WARNING_BYTES,
  UPLOADED_RETENTION_MS,
  bandFor,
  isCaptureRefused,
  prunePlanFor,
  remoteCacheEvictions,
  retentionWindowMs,
  type PrunableItem,
  type PruneAction,
  type StorageBand,
} from './pruning.js';
export {
  clearBackoffForRetry,
  findMediaItem,
  markFailed,
  markUploaded,
  markUploading,
  recoverInterruptedUploads,
  selectDrainable,
  type MediaQueueItem,
} from './repository.js';
export {
  MEDIA_UPLOAD_STATUS_MACHINE,
  type MediaUploadEvent,
  type MediaUploadStatus,
} from './upload-status.js';
