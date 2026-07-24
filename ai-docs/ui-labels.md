# UI Labels — v0 Catalog Seed

> **Owns:** every user-facing string for the v0 surfaces (auth, sync, conflicts, media, notes reference module, common actions, all error copy, push notification templates, role display names). The mechanism — key grammar, ICU rules, tone register, fallback — is owned by `07-i18n.md`; rejection-code semantics by `05-operation-log.md §8`; state names by `03-state-machines.md`; push categories and payload rules by `api/04-push.md`.
> **Change control:** change this doc first, then the catalog JSON files. New keys and meaning changes land here before code; pure copyediting of a value may land in JSON with this doc updated in the same PR.

Conventions (from 07-i18n): values are ICU MessageFormat; `id` uses plain `{count}` interpolation (single plural category), `en` uses `{count, plural, …}`; English uses `’` never `'`; `{duration}`, `{relative}`, `{time}` params arrive **pre-formatted** from the `@bolusi/i18n` formatters; register is `kamu`, plain shop vocabulary.

## core — common actions (`core.action.*`)

| Key | id-ID | en |
| --- | ----- | -- |
| `core.action.save` | Simpan | Save |
| `core.action.cancel` | Batal | Cancel |
| `core.action.retry` | Coba Lagi | Try Again |
| `core.action.delete` | Hapus | Delete |
| `core.action.confirm` | Ya, Lanjutkan | Yes, Continue |
| `core.action.back` | Kembali | Back |
| `core.action.close` | Tutup | Close |
| `core.action.edit` | Ubah | Edit |
| `core.action.add` | Tambah | Add |
| `core.action.search` | Cari | Search |
| `core.action.ok` | Oke | OK |
| `core.action.yes` | Ya | Yes |
| `core.action.no` | Tidak | No |

Note: v0 has no hard delete anywhere (05-operation-log §1 — corrections are new operations; entities archive). `core.action.delete` exists only for local-unsigned things (e.g. discarding a not-yet-attached photo).

## core — status (`core.status.*`)

| Key | id-ID | en |
| --- | ----- | -- |
| `core.status.loading` | Memuat… | Loading… |
| `core.status.empty` | Belum ada data | Nothing here yet |
| `core.status.saved` | Tersimpan | Saved |

## core — time (`core.time.*`)

| Key | id-ID | en |
| --- | ----- | -- |
| `core.time.justNow` | baru saja | just now |
| `core.time.minutesAgo` | {count} menit lalu | {count, plural, one {# minute ago} other {# minutes ago}} |
| `core.time.hoursAgo` | {count} jam lalu | {count, plural, one {# hour ago} other {# hours ago}} |
| `core.time.daysAgo` | {count} hari lalu | {count, plural, one {# day ago} other {# days ago}} |
| `core.time.durationSeconds` | {count} detik | {count, plural, one {# second} other {# seconds}} |
| `core.time.durationMinutes` | {count} menit | {count, plural, one {# minute} other {# minutes}} |

## core — language (`core.settings.*`, `core.language.*`)

| Key | id-ID | en |
| --- | ----- | -- |
| `core.settings.language` | Bahasa | Language |
| `core.language.id` | Bahasa Indonesia | Bahasa Indonesia |
| `core.language.en` | English | English |

Language names are endonyms — identical in every locale, deliberately.

## core — runtime errors (`core.errors.<CODE>`)

Rendered via `t('core.errors.' + code)` for every `DomainError` (07-i18n §4.2). The canonical code list is the DomainError code registry in 04-module-contract §5.2; every code shipped must have a row here (CI-gated). Unknown codes render `UNEXPECTED`. `IDEMPOTENCY_CONFLICT` and `RATE_LIMITED` are transport error codes (api/00-conventions §8.2 / §11) surfaced through the same derivation.

| Key | id-ID | en |
| --- | ----- | -- |
| `core.errors.INVALID_TRANSITION` | Tindakan ini sudah tidak bisa dilakukan karena datanya berubah. Periksa lagi datanya. | This can’t be done anymore because the record changed. Check the record again. |
| `core.errors.PERMISSION_DENIED` | Akun kamu tidak punya izin untuk ini. | Your account doesn’t have permission to do this. |
| `core.errors.VALIDATION_FAILED` | Ada isian yang belum benar. Periksa lagi. | Something isn’t filled in right. Please check the form. |
| `core.errors.ENTITY_NOT_FOUND` | Data tidak ditemukan. | That record can’t be found. |
| `core.errors.NOT_AUTHENTICATED` | Masuk dulu untuk melanjutkan. | Sign in to continue. |
| `core.errors.DEVICE_NOT_ENROLLED` | Perangkat ini belum terdaftar. Daftarkan dulu. | This device isn’t enrolled yet. Enroll it first. |
| `core.errors.USER_DEACTIVATED` | Akun kamu sudah dinonaktifkan. Hubungi pemilik toko. | Your account has been deactivated. Contact the store owner. |
| `core.errors.PIN_RATE_LIMITED` | Terlalu banyak PIN salah. Tunggu sebentar, lalu coba lagi. | Too many wrong PIN tries. Wait a moment, then try again. |
| `core.errors.PIN_LOCKED` | PIN terkunci. Minta pemilik toko membukanya atau membuatkan PIN baru. | PIN locked. Ask the store owner to unlock it or set a new PIN. |
| `core.errors.LAST_ADMIN_PROTECTED` | Tidak bisa. Harus selalu ada minimal satu pemilik utama yang aktif. | Not allowed. There must always be at least one active main owner. |
| `core.errors.ROLE_IN_USE` | Peran ini masih dipakai pengguna lain, jadi belum bisa dihapus. Lepaskan dulu dari semua pengguna. | This role is still assigned to users, so it can’t be removed yet. Unassign it from everyone first. |
| `core.errors.IDEMPOTENCY_CONFLICT` | Permintaan ini bentrok dengan permintaan sebelumnya. Coba lagi. | This request clashed with an earlier one. Try again. |
| `core.errors.RATE_LIMITED` | Terlalu banyak permintaan. Tunggu sebentar, lalu coba lagi. | Too many requests. Wait a moment, then try again. |
| `core.errors.UNEXPECTED` | Terjadi kesalahan. Coba lagi. | Something went wrong. Try again. |
| `core.errors.NETWORK` | Koneksi bermasalah. Perubahan kamu tetap tersimpan di perangkat ini. | Connection problem. Your changes are still saved on this device. |
| `core.errors.MEDIA_NOT_FOUND` | Foto belum ada di server. Aplikasi akan mencoba lagi. | The photo isn’t on the server yet. The app will try again. |
| `core.errors.MEDIA_IMMUTABLE` | Foto yang sudah terkirim tidak bisa diganti. Ambil foto baru kalau perlu koreksi. | A photo that has been sent can’t be replaced. Take a new photo if a correction is needed. |
| `core.errors.INIT_MISMATCH` | Data foto ini tidak cocok dengan yang ada di server. Ambil foto baru. | This photo’s details don’t match the server’s. Take a new photo. |
| `core.errors.MEDIA_TOO_LARGE` | Foto ini terlalu besar untuk dikirim. Laporkan masalah ini. | This photo is too large to send. Please report this. |
| `core.errors.CHUNK_TOO_LARGE` | Foto gagal dikirim karena masalah aplikasi. Laporkan masalah ini. | The photo couldn’t be sent because of an app problem. Please report this. |
| `core.errors.UNSUPPORTED_ENCODING` | Foto gagal dikirim karena masalah aplikasi. Laporkan masalah ini. | The photo couldn’t be sent because of an app problem. Please report this. |
| `core.errors.MIME_UNSUPPORTED` | Jenis berkas ini tidak bisa dikirim. Laporkan masalah ini. | This file type can’t be sent. Please report this. |
| `core.errors.CHUNK_INDEX_INVALID` | Foto gagal dikirim karena masalah aplikasi. Laporkan masalah ini. | The photo couldn’t be sent because of an app problem. Please report this. |
| `core.errors.CHUNK_SIZE_INVALID` | Foto gagal dikirim karena masalah aplikasi. Laporkan masalah ini. | The photo couldn’t be sent because of an app problem. Please report this. |
| `core.errors.CHUNKS_MISSING` | Sebagian foto belum sampai. Aplikasi akan mengirim sisanya. | Part of the photo hasn’t arrived. The app will send the rest. |
| `core.errors.HASH_MISMATCH` | Foto rusak saat dikirim. Aplikasi akan mencoba lagi. | The photo was damaged while sending. The app will try again. |
| `core.errors.MIME_MISMATCH` | Berkas foto tidak cocok dengan jenisnya. Ambil foto baru. | The photo file doesn’t match its type. Take a new photo. |
| `core.errors.STORAGE_ERROR` | Server gagal menyimpan foto. Aplikasi akan mencoba lagi. | The server couldn’t save the photo. The app will try again. |
| `core.errors.LOCAL_CORRUPT` | Foto ini rusak di perangkat dan tidak bisa dikirim. Ambil foto baru. | This photo is damaged on this device and can’t be sent. Take a new photo. |
| `core.errors.AUTH_TOKEN_MISSING` | Masuk lagi untuk melanjutkan pengiriman foto. | Sign in again to keep sending photos. |
| `core.errors.AUTH_TOKEN_INVALID` | Sesi perangkat sudah berakhir. Masuk lagi untuk melanjutkan pengiriman foto. | This device’s session has ended. Sign in again to keep sending photos. |

## core — sync rejection codes (`core.rejection.<CODE>`)

One row per code in 05-operation-log §8's closed set (which includes `CHAIN_HALTED`). Rendered on the rejected-changes screen (`sync.rejected.*`); the server's `rejectionReason` shows only as collapsed technical detail. Copy follows the "Client behavior" column of 05 §8: state what happened, then what to do.

| Key | id-ID | en |
| --- | ----- | -- |
| `core.rejection.BAD_SIGNATURE` | Perubahan ini gagal diverifikasi dan ditolak server. Laporkan ke pemilik toko. | This change failed verification and was rejected by the server. Report this to the store owner. |
| `core.rejection.CHAIN_BROKEN` | Riwayat perubahan di perangkat ini rusak. Pengiriman dihentikan. Segera hubungi pemilik toko. | This device’s change history is broken. Sending has stopped. Contact the store owner right away. |
| `core.rejection.CHAIN_GAP` | Ada perubahan yang tertinggal. Dikirim ulang otomatis. | Some changes were missing. They’re being resent automatically. |
| `core.rejection.CHAIN_HALTED` | Ditunda karena perubahan sebelumnya bermasalah. | On hold because an earlier change has a problem. |
| `core.rejection.DEVICE_REVOKED` | Perangkat ini sudah diblokir, jadi perubahan ditolak. Daftarkan ulang perangkat ini. | This device has been revoked, so the change was rejected. Enroll this device again. |
| `core.rejection.SCHEMA_INVALID` | Format perubahan ini tidak dikenali server. Ini masalah aplikasi — laporkan ke pemilik toko. | The server didn’t recognize this change’s format. This is an app problem — report it to the store owner. |
| `core.rejection.SCOPE_VIOLATION` | Perubahan ini bukan untuk toko atau akun ini, jadi ditolak. Laporkan ke pemilik toko. | This change doesn’t belong to this store or account, so it was rejected. Report it to the store owner. |
| `core.rejection.UNKNOWN_TYPE` | Aplikasi di perangkat ini perlu diperbarui supaya perubahan ini bisa dikirim. | This device’s app needs an update before this change can be sent. |

`CHAIN_GAP` is normally invisible (the client resends automatically — 05 §8); the label exists for the diagnostics view only.

## auth — user switcher, PIN, enrollment (`auth.*`)

Surfaces per PRD-011 §6 (switcher, PIN pad, idle lock, enrollment, revocation, PIN reset).

| Key | id-ID | en |
| --- | ----- | -- |
| `auth.switcher.title` | Siapa yang pakai? | Who’s using this? |
| `auth.switcher.instruction` | Ketuk nama kamu | Tap your name |
| `auth.switcher.addUser` | Tambah Pengguna | Add User |
| `auth.switcher.emptyUsers` | Belum ada pengguna di perangkat ini. Minta pemilik toko untuk mendaftarkannya. | No users on this device yet. Ask the store owner to enroll this device. |
| `auth.switcher.idleLocked` | Layar terkunci karena lama tidak dipakai. Pekerjaanmu aman. | Locked after sitting idle. Your work is safe. |
| `auth.pin.title` | Masukkan PIN | Enter PIN |
| `auth.pin.wrong` | PIN salah. Coba lagi. | Wrong PIN. Try again. |
| `auth.pin.attemptsLeft` | Sisa {count} kesempatan | {count, plural, one {# try left} other {# tries left}} |
| `auth.pin.wait` | Terlalu banyak salah. Tunggu {duration}. | Too many wrong tries. Wait {duration}. |
| `auth.pin.lockedOut` | PIN terkunci. Minta pemilik toko untuk membukanya. | PIN locked. Ask the store owner to unlock it. |
| `auth.pin.forgot` | Lupa PIN? Minta pemilik toko membuatkan yang baru. | Forgot your PIN? Ask the store owner to set a new one. |
| `auth.pin.setup.title` | Buat PIN Baru | Create a New PIN |
| `auth.pin.setup.repeat` | Ulangi PIN | Repeat the PIN |
| `auth.pin.setup.mismatch` | PIN tidak sama. Coba lagi. | The PINs don’t match. Try again. |
| `auth.enroll.title` | Daftarkan Perangkat Ini | Enroll This Device |
| `auth.enroll.instruction` | Masuk dengan akun kamu. Perangkat ini akan terdaftar untuk toko kamu. | Sign in with your account. This device will be enrolled for your store. |
| `auth.enroll.identifierField` | Nama akun | Account name |
| `auth.enroll.passwordField` | Kata sandi | Password |
| `auth.enroll.submit` | Masuk | Sign In |
| `auth.enroll.needsConnection` | Pendaftaran perangkat butuh koneksi internet. | Enrolling a device needs an internet connection. |
| `auth.enroll.success` | Perangkat berhasil didaftarkan | Device enrolled |
| `auth.revoked.title` | Perangkat Diblokir | Device Revoked |
| `auth.revoked.body` | Perangkat ini sudah diblokir dan tidak bisa dipakai lagi. Hubungi pemilik toko untuk mendaftarkannya ulang. | This device has been revoked and can no longer be used. Contact the store owner to enroll it again. |

**No store-switcher label in v0.** The store switcher (FR-1034) is deferred to v1 (roadmap R22); in v0 a device is enrolled to exactly one store, so the label is never rendered. It is therefore **not seeded here** — this doc owns v0 surfaces (see the ownership note above), and a v1 string in the v0 seed would ship dead copy in the app bundle. It previously sat here as `auth.switchStore`, a 2-segment key that 07-i18n §3.1 forbids; the right `<namespace>.<screen-or-area>.<label>` name depends on the screen the switcher actually lands on, which is not designed yet, so inventing one now would be a guess. The copy (`Ganti Toko` / `Switch Store`) is recorded in roadmap R22 and lands with the feature.

## role — role display names (`role.<roleKey>.name`)

Derived keys per 07-i18n §3.1; `roleKey` is exactly one of the three seeded roles (01-domain-model §4.2, 02-permissions §11).

| Key | id-ID | en |
| --- | ----- | -- |
| `role.main_owner.name` | Pemilik Utama | Main Owner |
| `role.store_owner.name` | Pemilik Toko | Store Owner |
| `role.staff.name` | Staf | Staff |

Permission display strings use the derived keys `permission.<module>.<action>.name` / `permission.<module>.<action>.description` (07-i18n §3.1), one pair per registry entry in 02-permissions §11. The registry's `description` column is the canonical `en` source; the `id` values land in the `permission` catalog in the same PR that touches the registry.

## sync — status, staleness, rejected changes (`sync.*`)

States per `Operation.syncStatus` machine and api/01-sync §6–7. Staleness `{relative}` is computed server-relative (api/01-sync §7), formatted via `core.time.*`. `sync.banner.warning` / `sync.banner.stale` are keyed to the staleness **level names** of 03-state-machines §8 (which owns the thresholds) — never to durations, and the copy stays threshold-agnostic so a threshold change never invalidates a string. `sync.chip.*` are the sync-status chips of design-system §3.5 — the canonical pending/rejected markers on every list row and detail header. `sync.quarantine.*` is the loud surfacing of quarantined operations (pull-side verification failure, api/01-sync §4): those changes are held out of view, not applied. `sync.action.*` are the user-initiated affordances (the sync-now button, the pull-to-refresh hint) — deliberately **not** `sync.banner.*`, which is reserved for the staleness level names above. `sync.status.title*` is one header title per header state for the §8.4 Sync Status screen: the five design-system §8.1 chip states (`synced` / `pending` / `syncing` / `offline` / `attention`), plus `titlePhotosPending` — operations all sent but photos still on their own drain schedule (FR-1138), the one honest state the media-blind chip (§8.1: `pending` counts `local` ops only) cannot carry, so the headline states it while the ambient chip stays `synced` (task 147). The screen's title states the state it is in, so a healthy device is never headed by a problem — and a device with photos still queued is never headed "All Sent" over a counter that says otherwise. `sync.status.photosPending` is that state's tier-1 reassurance line. `sync.status.title*` is deliberately **not** `sync.rejected.title`, which titles the rejected SECTION only — a screen-wide title that says "Rejected Changes" reports a problem that does not exist (task 126).

| Key | id-ID | en |
| --- | ----- | -- |
| `sync.chip.pending` | Belum terkirim | Not sent yet |
| `sync.chip.rejected` | Ditolak | Rejected |
| `sync.status.upToDate` | Semua perubahan terkirim | All changes sent |
| `sync.status.syncing` | Mengirim… | Syncing… |
| `sync.status.pending` | {count} perubahan belum terkirim | {count, plural, one {# change not sent yet} other {# changes not sent yet}} |
| `sync.status.pendingMedia` | {count} foto belum terkirim | {count, plural, one {# photo not sent yet} other {# photos not sent yet}} |
| `sync.status.photosPending` | Perubahan terkirim. Foto belum terkirim. | Changes sent. Photos not sent yet. |
| `sync.status.offline` | Tidak ada koneksi. Perubahan tersimpan di perangkat ini. | No connection. Changes are saved on this device. |
| `sync.status.reconnected` | Terhubung kembali | Back online |
| `sync.status.lastSynced` | Terakhir terhubung {relative} | Last connected {relative} |
| `sync.status.titleSynced` | Semua Terkirim | All Sent |
| `sync.status.titlePending` | Belum Terkirim | Not Sent Yet |
| `sync.status.titleSyncing` | Sedang Mengirim | Sending |
| `sync.status.titleOffline` | Tanpa Koneksi | No Connection |
| `sync.status.titleAttention` | Perlu Diperiksa | Needs Attention |
| `sync.status.titlePhotosPending` | Foto Belum Terkirim | Photos Not Sent Yet |
| `sync.banner.warning` | Terakhir terhubung {relative}. Data mungkin bukan yang terbaru. | Last connected {relative}. This may not be the latest data. |
| `sync.banner.stale` | Sudah lama tidak terhubung. Data di layar ini bisa jauh tertinggal. | No connection for a long time. What you see here could be far behind. |
| `sync.rejected.banner` | {count} perubahan ditolak server. Ketuk untuk melihat. | {count, plural, one {# change was rejected by the server. Tap to view.} other {# changes were rejected by the server. Tap to view.}} |
| `sync.rejected.title` | Perubahan Ditolak | Rejected Changes |
| `sync.rejected.explain` | Perubahan di bawah ini ditolak server dan tidak akan terkirim. Datanya tetap tersimpan di perangkat ini sebagai catatan. | The changes below were rejected by the server and will not be sent. They stay saved on this device as a record. |
| `sync.rejected.technicalDetails` | Detail teknis | Technical details |
| `sync.quarantine.title` | Perubahan Ditahan | Changes On Hold |
| `sync.quarantine.body` | Beberapa perubahan dari perangkat lain gagal diverifikasi, jadi belum ditampilkan. Laporkan ke pemilik toko. | Some changes from another device failed verification, so they aren’t shown yet. Report this to the store owner. |
| `sync.action.syncNow` | Kirim Sekarang | Sync Now |
| `sync.action.pullToRefresh` | Tarik untuk memperbarui | Pull to refresh |

## conflict — surfacing and decisions (`conflict.*`)

States per Conflict machine: `detected → auto_resolved | surfaced; surfaced → acknowledged` (store-owner decision recorded as a new operation). `conflict.list.banner` is the count banner that taps through to the conflict list — the same shape as `sync.rejected.banner`, and keyed to the list it opens rather than to a `banner` area of its own.

| Key | id-ID | en |
| --- | ----- | -- |
| `conflict.list.banner` | {count} data bentrok butuh keputusan | {count, plural, one {# conflict needs a decision} other {# conflicts need a decision}} |
| `conflict.list.title` | Data Bentrok | Conflicts |
| `conflict.status.surfaced` | Butuh keputusan | Needs a decision |
| `conflict.status.autoResolved` | Digabung otomatis | Merged automatically |
| `conflict.status.acknowledged` | Sudah diputuskan | Decided |
| `conflict.detail.instruction` | Dua perubahan bentrok. Pilih mana yang benar. | Two changes clash. Choose which one is right. |
| `conflict.action.decide` | Putuskan | Decide |
| `conflict.decision.saved` | Keputusan tersimpan | Decision saved |
| `conflict.autoResolved.toast` | Dua perubahan digabung otomatis | Two changes were merged automatically |

## media — capture and upload (`media.*`)

States per `MediaItem.uploadStatus` machine: `pending → uploading → uploaded | failed` (`failed` retryable).

| Key | id-ID | en |
| --- | ----- | -- |
| `media.status.pending` | Menunggu dikirim | Waiting to send |
| `media.status.uploading` | Mengirim foto… | Sending photo… |
| `media.status.uploaded` | Foto terkirim | Photo sent |
| `media.status.failed` | Gagal mengirim. Ketuk untuk coba lagi. | Sending failed. Tap to try again. |
| `media.status.waitingForConnection` | Menunggu koneksi | Waiting for connection |
| `media.action.takePhoto` | Ambil Foto | Take Photo |
| `media.action.retake` | Foto Ulang | Retake |
| `media.action.usePhoto` | Pakai Foto Ini | Use This Photo |
| `media.action.retryUpload` | Kirim Ulang | Send Again |
| `media.permission.camera` | Izinkan aplikasi memakai kamera untuk ambil foto. | Allow the app to use the camera to take photos. |
| `media.permission.cameraDeniedTitle` | Kamera belum diizinkan | Camera is not allowed |
| `media.permission.cameraDeniedBody` | Buka Pengaturan HP, cari aplikasi ini, lalu nyalakan izin Kamera. | Open your phone Settings, find this app, then turn on the Camera permission. |
| `media.storage.lowWarning` | Penyimpanan mulai menipis. Foto lama yang sudah terkirim akan dibersihkan. | Storage is getting low. Old photos that have already been sent will be cleaned up. |
| `media.storage.lowCritical` | Penyimpanan hampir habis. Semua foto yang sudah terkirim dibersihkan sekarang. Foto yang belum terkirim tetap aman. | Storage is nearly full. Every photo that has been sent is being cleaned up now. Photos that haven’t been sent yet are kept. |
| `media.capture.refusedTitle` | Penyimpanan penuh | Storage full |
| `media.capture.refusedBody` | Tidak bisa ambil foto karena penyimpanan hampir habis. Kosongkan ruang dulu, lalu coba lagi. | Photos can’t be taken because storage is nearly full. Free up some space, then try again. |
| `media.upload.persistentFailure` | {count} foto belum sampai ke server. | {count, plural, one {# photo hasn’t reached the server.} other {# photos haven’t reached the server.}} |

## notes — reference module (`notes.*`)

Surfaces per 04-module-contract §8 (create / edit body / archive, photo attachment, archived filter). Owned by the notes module package.

| Key | id-ID | en |
| --- | ----- | -- |
| `notes.list.title` | Catatan | Notes |
| `notes.list.empty` | Belum ada catatan. Ketuk “Catatan Baru” untuk mulai. | No notes yet. Tap “New Note” to start. |
| `notes.action.new` | Catatan Baru | New Note |
| `notes.editor.titleField` | Judul | Title |
| `notes.editor.bodyField` | Isi | Body |
| `notes.editor.titleRequired` | Judul belum diisi | Title is required |
| `notes.action.archive` | Arsipkan | Archive |
| `notes.confirm.archive` | Arsipkan catatan ini? Catatan tidak dihapus, hanya dipindah ke arsip. | Archive this note? It isn’t deleted — it moves to the archive. |
| `notes.badge.archived` | Diarsipkan | Archived |
| `notes.filter.showArchived` | Tampilkan arsip | Show archived |
| `notes.action.attachPhoto` | Lampirkan Foto | Attach Photo |

## push — notification templates (`push.*`)

Composed **server-side** per api/04-push.md and 07-i18n §8, in the recipient user's locale preference (fallback `id`). One title/body pair per v0 **notification** category — `conflict` and `device`; the `sync` category is data-only (no title, no body — api/04-push §3) and has no catalog entries. Templates carry no business data values — deep links carry entity ids only — so the copy is generic by design.

| Key | id-ID | en |
| --- | ----- | -- |
| `push.conflict.title` | Ada data bentrok | A conflict needs a decision |
| `push.conflict.body` | Ada data bentrok yang butuh keputusan pemilik toko. Ketuk untuk melihat. | A conflict needs the store owner’s decision. Tap to view. |
| `push.device.title` | Peringatan perangkat | Device alert |
| `push.device.body` | Ada masalah pada salah satu perangkat toko. Ketuk untuk memeriksa. | Something needs attention on one of your store’s devices. Tap to check. |
