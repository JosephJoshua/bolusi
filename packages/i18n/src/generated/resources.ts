// AUTO-GENERATED from catalogs; edit the JSON files, then run:
// pnpm --filter @bolusi/i18n i18n:gen

const source = {
  translation: {
    core: {
      action: {
        save: 'Simpan',
        cancel: 'Batal',
        retry: 'Coba Lagi',
        delete: 'Hapus',
        confirm: 'Ya, Lanjutkan',
        back: 'Kembali',
        close: 'Tutup',
        edit: 'Ubah',
        add: 'Tambah',
        search: 'Cari',
        ok: 'Oke',
        yes: 'Ya',
        no: 'Tidak',
        clearSearch: 'Hapus pencarian',
      },
      status: { loading: 'Memuat…', empty: 'Belum ada data', saved: 'Tersimpan' },
      time: {
        justNow: 'baru saja',
        minutesAgo: '{count} menit lalu',
        hoursAgo: '{count} jam lalu',
        daysAgo: '{count} hari lalu',
        durationSeconds: '{count} detik',
        durationMinutes: '{count} menit',
      },
      settings: {
        title: 'Pengaturan',
        security: 'Keamanan',
        notifications: 'Notifikasi',
        device: 'HP ini',
        language: 'Bahasa',
        changePinSummary: 'PIN untuk masuk ke HP ini',
        staffPinsSummary: 'Buka kunci atau buat PIN baru',
        staffPinsLocked: '{count} PIN terkunci',
        notificationsSummary: 'Atur di pengaturan HP',
        notifyConflict: 'Data yang perlu keputusan pemilik',
        notifyDevice: 'Masalah perangkat toko',
        deviceName: 'Nama HP',
        store: 'Toko',
        business: 'Usaha',
        appVersion: 'Versi aplikasi',
        deviceId: 'ID perangkat',
      },
      language: { id: 'Bahasa Indonesia', en: 'English' },
      unauthorized: { askOwner: 'Minta pemilik toko untuk memberi akses.' },
      opType: { unknown: 'Perubahan' },
      errors: {
        INVALID_TRANSITION:
          'Tindakan ini sudah tidak bisa dilakukan karena datanya berubah. Periksa lagi datanya.',
        PERMISSION_DENIED: 'Akun kamu tidak punya izin untuk ini.',
        VALIDATION_FAILED: 'Ada isian yang belum benar. Periksa lagi.',
        ENTITY_NOT_FOUND: 'Data tidak ditemukan.',
        NOT_AUTHENTICATED: 'Masuk dulu untuk melanjutkan.',
        DEVICE_NOT_ENROLLED: 'Perangkat ini belum terdaftar. Daftarkan dulu.',
        USER_DEACTIVATED: 'Akun kamu sudah dinonaktifkan. Hubungi pemilik toko.',
        PIN_RATE_LIMITED: 'Terlalu banyak PIN salah. Tunggu sebentar, lalu coba lagi.',
        PIN_LOCKED: 'PIN terkunci. Minta pemilik toko membukanya atau membuatkan PIN baru.',
        LAST_ADMIN_PROTECTED: 'Tidak bisa. Harus selalu ada minimal satu pemilik utama yang aktif.',
        ROLE_IN_USE:
          'Peran ini masih dipakai pengguna lain, jadi belum bisa dihapus. Lepaskan dulu dari semua pengguna.',
        IDEMPOTENCY_CONFLICT: 'Permintaan ini bentrok dengan permintaan sebelumnya. Coba lagi.',
        RATE_LIMITED: 'Terlalu banyak permintaan. Tunggu sebentar, lalu coba lagi.',
        UNEXPECTED: 'Terjadi kesalahan. Coba lagi.',
        NETWORK: 'Koneksi bermasalah. Perubahan kamu tetap tersimpan di perangkat ini.',
        MEDIA_NOT_FOUND: 'Foto belum ada di server. Aplikasi akan mencoba lagi.',
        MEDIA_IMMUTABLE:
          'Foto yang sudah terkirim tidak bisa diganti. Ambil foto baru kalau perlu koreksi.',
        INIT_MISMATCH: 'Data foto ini tidak cocok dengan yang ada di server. Ambil foto baru.',
        MEDIA_TOO_LARGE: 'Foto ini terlalu besar untuk dikirim. Laporkan masalah ini.',
        CHUNK_TOO_LARGE: 'Foto gagal dikirim karena masalah aplikasi. Laporkan masalah ini.',
        UNSUPPORTED_ENCODING: 'Foto gagal dikirim karena masalah aplikasi. Laporkan masalah ini.',
        MIME_UNSUPPORTED: 'Jenis berkas ini tidak bisa dikirim. Laporkan masalah ini.',
        CHUNK_INDEX_INVALID: 'Foto gagal dikirim karena masalah aplikasi. Laporkan masalah ini.',
        CHUNK_SIZE_INVALID: 'Foto gagal dikirim karena masalah aplikasi. Laporkan masalah ini.',
        CHUNKS_MISSING: 'Sebagian foto belum sampai. Aplikasi akan mengirim sisanya.',
        HASH_MISMATCH: 'Foto rusak saat dikirim. Aplikasi akan mencoba lagi.',
        MIME_MISMATCH: 'Berkas foto tidak cocok dengan jenisnya. Ambil foto baru.',
        STORAGE_ERROR: 'Server gagal menyimpan foto. Aplikasi akan mencoba lagi.',
        LOCAL_CORRUPT: 'Foto ini rusak di perangkat dan tidak bisa dikirim. Ambil foto baru.',
        AUTH_TOKEN_MISSING: 'Masuk lagi untuk melanjutkan pengiriman foto.',
        AUTH_TOKEN_INVALID:
          'Sesi perangkat sudah berakhir. Masuk lagi untuk melanjutkan pengiriman foto.',
      },
      rejection: {
        BAD_SIGNATURE:
          'Perubahan ini gagal diverifikasi dan ditolak server. Laporkan ke pemilik toko.',
        CHAIN_BROKEN:
          'Riwayat perubahan di perangkat ini rusak. Pengiriman dihentikan. Segera hubungi pemilik toko.',
        CHAIN_GAP: 'Ada perubahan yang tertinggal. Dikirim ulang otomatis.',
        CHAIN_HALTED: 'Ditunda karena perubahan sebelumnya bermasalah.',
        DEVICE_REVOKED:
          'Perangkat ini sudah diblokir, jadi perubahan ditolak. Daftarkan ulang perangkat ini.',
        PERMISSION_DENIED:
          'Orang yang membuat perubahan ini tidak punya izin di toko ini, jadi perubahannya tidak disimpan. Minta orang yang berwenang untuk mengulanginya.',
        SCHEMA_INVALID:
          'Format perubahan ini tidak dikenali server. Ini masalah aplikasi — laporkan ke pemilik toko.',
        SCOPE_VIOLATION:
          'Perubahan ini bukan untuk toko atau akun ini, jadi ditolak. Laporkan ke pemilik toko.',
        UNKNOWN_TYPE:
          'Aplikasi di perangkat ini perlu diperbarui supaya perubahan ini bisa dikirim.',
      },
      account: { menu: 'Menu akun', switchUser: 'Ganti pengguna' },
    },
    auth: {
      switcher: {
        title: 'Siapa yang pakai?',
        addUser: 'Tambah Pengguna',
        reenroll: 'Daftarkan Ulang Perangkat',
        emptyUsers:
          'Belum ada pengguna di perangkat ini. Minta pemilik toko untuk mendaftarkannya.',
        idleLocked: 'Layar terkunci karena lama tidak dipakai. Pekerjaanmu aman.',
        search: 'Cari nama',
        noMatches: 'Tidak ada nama yang cocok',
        locked: 'PIN terkunci',
        noPin: 'Belum ada PIN',
        current: 'Sedang dipakai',
      },
      pin: {
        title: 'Masukkan PIN kamu',
        wrong: 'PIN salah.',
        attemptsLeft: 'Masih bisa coba {count} kali lagi.',
        wait: 'Terlalu sering salah. Coba lagi dalam {duration}.',
        lockedOut:
          'PIN-nya terlalu sering salah. Minta pemilik toko membukanya di Pengaturan, bagian PIN karyawan.',
        forgot:
          'Minta pemilik toko membuatkan PIN baru. Pemilik bisa melakukannya di HP ini lewat Pengaturan, bagian PIN karyawan, juga tanpa internet.',
        setup: {
          title: 'Buat PIN baru',
          repeat: 'Ulangi PIN baru',
          mismatch: 'PIN tidak sama. Buat lagi dari awal.',
          screenTitle: 'Buat PIN',
          hint: '6 angka untuk masuk ke HP ini. Jangan pakai tanggal lahir.',
          failed: 'PIN belum bisa dibuat. Coba lagi.',
        },
        change: {
          title: 'Ganti PIN',
          enterCurrent: 'Masukkan PIN lama',
          wrongCurrent: 'PIN lama salah. Coba lagi.',
          done: 'PIN kamu sudah diganti',
          doneBody: 'Mulai sekarang, masuk pakai PIN baru ini.',
        },
        reset: {
          noUsers: 'Belum ada karyawan lain di HP ini.',
          done: 'PIN baru {name} sudah dibuat',
          denied: 'Hanya pemilik utama yang bisa membuat PIN baru untuk pemilik utama lain.',
        },
        unlock: {
          confirm: '{name} bisa langsung masuk lagi dengan PIN lamanya.',
          done: 'PIN {name} sudah dibuka',
          notLocked: 'PIN {name} sudah tidak terkunci',
        },
        manage: {
          unauthorizedTitle: 'Perlu izin pemilik',
          unauthorizedBody:
            'Hanya pemilik toko yang bisa membuka kunci atau membuat PIN baru. Minta pemilik toko.',
        },
        signIn: 'Masuk',
        lockedOutTitle: 'PIN kamu terkunci',
        forgotTitle: 'Lupa PIN?',
        staff: {
          title: 'PIN karyawan',
          resetTitle: 'Buat PIN baru',
          unlock: 'Buka kunci PIN',
          reset: 'Buat PIN baru',
          handedOver: '{name} sudah pegang HP',
          handOverTitle: 'Berikan HP ke {name}',
          handOverBody:
            '{name} yang mengetik PIN barunya sendiri, jadi kamu tidak akan tahu PIN-nya.',
          finish: 'Selesai',
          resetDoneBody: 'Sekarang {name} bisa masuk dengan PIN barunya.',
          unlockDoneBody: '{name} bisa masuk lagi dengan PIN lamanya.',
          failedTitle: 'Belum berhasil',
          unlockConfirmTitle: 'Buka kunci PIN {name}?',
          lockedBody:
            'PIN-nya terlalu sering salah. Buka kuncinya kalau {name} masih ingat PIN-nya, atau buat PIN baru.',
          activeBody: 'PIN-nya tidak terkunci. Kalau {name} lupa PIN, buat PIN baru.',
          lockedUnlockBody:
            'PIN-nya terlalu sering salah. Buka kuncinya kalau {name} masih ingat PIN-nya.',
          lockedResetBody:
            'PIN-nya terlalu sering salah. Buat PIN baru, nanti {name} sendiri yang mengetik.',
          noPinBody:
            '{name} belum punya PIN di HP ini. Buat PIN, nanti {name} sendiri yang mengetik.',
        },
        noPinTitle: 'Belum ada PIN',
        noPinBody:
          'Minta pemilik toko membuatkan PIN di Pengaturan, bagian PIN karyawan. Nanti kamu sendiri yang mengetik PIN-nya.',
      },
      enroll: {
        title: 'Daftarkan HP ini',
        progress: '{step} dari {total}',
        credentialsTitle: 'Masuk dengan akun pemilik',
        instruction: 'Cukup sekali untuk HP ini. Langkah ini butuh koneksi internet.',
        identifierField: 'Nama akun',
        passwordField: 'Kata sandi',
        passwordTooShort: 'Kata sandi minimal {min} karakter.',
        submit: 'Masuk',
        storeTitle: 'Pilih toko untuk HP ini',
        nameTitle: 'Kasih nama HP ini',
        storeLabel: 'Toko',
        account: 'Akun {tenant}',
        deviceNameField: 'Nama HP ini',
        deviceNamePlaceholder: 'Contoh: HP Kasir 1',
        bind: 'Daftarkan ke {store}',
        bindWithoutStore: 'Daftarkan HP ini',
        pickStoreFirst: 'Pilih tokonya dulu.',
        nameDeviceFirst: 'Kasih nama HP ini dulu.',
        needsConnection: 'Pendaftaran HP butuh koneksi internet. Sambungkan dulu, lalu coba lagi.',
        wrongCredentials: 'Nama akun atau kata sandi salah. Coba lagi.',
        notOwner: 'Akun ini tidak bisa mendaftarkan HP. Masuk dengan akun pemilik toko.',
        success: 'HP ini sudah terdaftar',
        successStore: 'Terdaftar di {store}.',
        successNext: 'Sekarang pilih siapa yang pakai HP ini.',
        finish: 'Lanjut',
        discardTitle: 'Batalkan pendaftaran?',
        discardMessage: 'Yang sudah kamu isi akan hilang.',
        discard: 'Batalkan',
        keepEditing: 'Lanjut isi',
      },
      revoked: {
        title: 'Perangkat Diblokir',
        body: 'Perangkat ini sudah diblokir dan tidak bisa dipakai lagi. Hubungi pemilik toko untuk mendaftarkannya ulang.',
      },
      opType: {
        deviceEnrolled: 'Perangkat didaftarkan',
        userSwitched: 'Pengguna diganti',
        sessionEnded: 'Sesi berakhir',
        pinChanged: 'PIN diganti',
        pinReset: 'PIN diatur ulang',
        pinLockedOut: 'PIN terkunci',
        pinLockoutCleared: 'Kunci PIN dibuka',
        permissionDenied: 'Akses ditolak',
      },
    },
    sync: {
      chip: { pending: 'Belum terkirim', rejected: 'Ditolak' },
      status: {
        upToDate: 'Semua perubahan sudah aman di server.',
        syncing: 'Sedang mengirim perubahan ke server.',
        pending: '{count} perubahan belum terkirim',
        pendingMedia: '{count} foto belum terkirim',
        photosPending: 'Perubahan sudah terkirim. Fotonya menyusul.',
        attentionReassurance:
          'Ada perubahan yang ditolak server. Datanya tetap tersimpan di HP ini.',
        offline: 'Perubahan tersimpan di HP ini dan dikirim saat ada koneksi.',
        reconnected: 'Terhubung kembali',
        lastSynced: 'Terakhir terhubung {relative}',
        titleSynced: 'Semua sudah terkirim',
        titlePending: 'Ada yang belum terkirim',
        titleSyncing: 'Sedang mengirim',
        titleOffline: 'Tidak ada koneksi',
        titleAttention: 'Ada yang perlu dicek',
        titlePhotosPending: 'Foto belum terkirim',
        screenTitle: 'Status data',
        savedHere: '{count} perubahan tersimpan di HP ini dan akan dikirim otomatis.',
        changesLabel: 'Perubahan',
        photosLabel: 'Foto',
        waitingCount: '{count} belum terkirim',
      },
      banner: {
        warning: 'Terakhir terhubung {relative}. Data mungkin bukan yang terbaru.',
        stale: 'Sudah lama tidak terhubung. Data di layar ini bisa jauh tertinggal.',
      },
      rejected: {
        banner: '{count} perubahan ditolak server. Ketuk untuk melihat.',
        title: 'Ditolak server ({count})',
        explain:
          'Perubahan ini tidak akan terkirim, tapi tetap tersimpan di HP ini sebagai catatan. Ketuk untuk melihat detailnya.',
        opMeta: '{opType} · {time}',
        technicalDetails: 'Detail teknis',
        kept: 'Perubahan ini tetap tersimpan di HP ini sebagai catatan, tapi tidak akan dikirim lagi.',
        noReason: 'Server tidak mengirim keterangan.',
        more: 'Tampilkan {count} lainnya',
      },
      quarantine: {
        title: 'Perubahan ditahan',
        body: 'Beberapa perubahan dari perangkat lain gagal diverifikasi, jadi belum ditampilkan. Laporkan ke pemilik toko.',
      },
      action: { syncNow: 'Kirim sekarang', pullToRefresh: 'Tarik untuk memperbarui' },
      firstSync: {
        title: 'Menyiapkan data toko',
        progress: 'Riwayat sampai {date} · {percent}%',
        banner: 'Menyiapkan data toko ({percent}%). Kamu tetap bisa bekerja.',
        chip: 'Menyiapkan data toko {percent}%',
        explain:
          'Perangkat baru mengunduh riwayat toko. Bisa dilanjutkan kapan saja; yang sudah terunduh tidak diulang.',
      },
      media: {
        failedTitle: 'Foto gagal dikirim',
        failedBody: '{count} foto belum bisa dikirim. Fotonya aman di HP ini.',
        retry: 'Kirim ulang foto',
      },
    },
    conflict: {
      list: { banner: '{count} data bentrok butuh keputusan', title: 'Data Bentrok' },
      status: {
        surfaced: 'Butuh keputusan',
        autoResolved: 'Digabung otomatis',
        acknowledged: 'Sudah diputuskan',
      },
      detail: { instruction: 'Dua perubahan bentrok. Pilih mana yang benar.' },
      action: { decide: 'Putuskan' },
      decision: { saved: 'Keputusan tersimpan' },
      autoResolved: { toast: 'Dua perubahan digabung otomatis' },
    },
    media: {
      status: {
        pending: 'Menunggu dikirim',
        uploading: 'Mengirim foto…',
        uploaded: 'Foto terkirim',
        failed: 'Gagal mengirim. Ketuk untuk coba lagi.',
        waitingForConnection: 'Menunggu koneksi',
      },
      action: {
        takePhoto: 'Ambil Foto',
        retake: 'Foto Ulang',
        usePhoto: 'Pakai Foto Ini',
        retryUpload: 'Kirim Ulang',
      },
      permission: {
        camera: 'Izinkan aplikasi memakai kamera untuk ambil foto.',
        cameraDeniedTitle: 'Kamera belum diizinkan',
        cameraDeniedBody: 'Buka Pengaturan HP, cari aplikasi ini, lalu nyalakan izin Kamera.',
      },
      storage: {
        lowWarning: 'Penyimpanan mulai menipis. Foto lama yang sudah terkirim akan dibersihkan.',
        lowCritical:
          'Penyimpanan hampir habis. Semua foto yang sudah terkirim dibersihkan sekarang. Foto yang belum terkirim tetap aman.',
      },
      capture: {
        refusedTitle: 'Penyimpanan penuh',
        refusedBody:
          'Tidak bisa ambil foto karena penyimpanan hampir habis. Kosongkan ruang dulu, lalu coba lagi.',
      },
      upload: { persistentFailure: '{count} foto belum sampai ke server.' },
    },
    platform: {
      opType: {
        conflictDetected: 'Data bentrok terdeteksi',
        conflictAcknowledged: 'Data bentrok diputuskan',
        userLocaleChanged: 'Bahasa diubah',
      },
    },
    push: {
      conflict: {
        title: 'Ada data bentrok',
        body: 'Ada data bentrok yang butuh keputusan pemilik toko. Ketuk untuk melihat.',
      },
      device: {
        title: 'Peringatan perangkat',
        body: 'Ada masalah pada salah satu perangkat toko. Ketuk untuk memeriksa.',
      },
      permission: {
        title: 'Nyalakan notifikasi?',
        message:
          'Biar kamu langsung tahu kalau ada data yang perlu dicek atau masalah di perangkat toko, walau aplikasinya sedang ditutup.',
        allow: 'Nyalakan notifikasi',
        later: 'Nanti saja',
      },
    },
    permission: {},
    role: {
      main_owner: { name: 'Pemilik Utama' },
      store_owner: { name: 'Pemilik Toko' },
      staff: { name: 'Staf' },
      cashier: { name: 'Kasir' },
      technician: { name: 'Teknisi' },
    },
  },
};

// Every locale must match the source catalog's shape; values remain ordinary strings.
export const resources = {
  id: source,
  en: {
    translation: {
      core: {
        action: {
          save: 'Save',
          cancel: 'Cancel',
          retry: 'Try Again',
          delete: 'Delete',
          confirm: 'Yes, Continue',
          back: 'Back',
          close: 'Close',
          edit: 'Edit',
          add: 'Add',
          search: 'Search',
          ok: 'OK',
          yes: 'Yes',
          no: 'No',
          clearSearch: 'Clear search',
        },
        status: { loading: 'Loading…', empty: 'Nothing here yet', saved: 'Saved' },
        time: {
          justNow: 'just now',
          minutesAgo: '{count, plural, one {# minute ago} other {# minutes ago}}',
          hoursAgo: '{count, plural, one {# hour ago} other {# hours ago}}',
          daysAgo: '{count, plural, one {# day ago} other {# days ago}}',
          durationSeconds: '{count, plural, one {# second} other {# seconds}}',
          durationMinutes: '{count, plural, one {# minute} other {# minutes}}',
        },
        settings: {
          title: 'Settings',
          security: 'Security',
          notifications: 'Notifications',
          device: 'This phone',
          language: 'Language',
          changePinSummary: 'Your PIN for signing in on this phone',
          staffPinsSummary: 'Unlock or make a new PIN',
          staffPinsLocked: '{count, plural, one {# PIN locked} other {# PINs locked}}',
          notificationsSummary: 'Set in the phone’s settings',
          notifyConflict: 'Data that needs the owner’s decision',
          notifyDevice: 'Problems with store devices',
          deviceName: 'Phone name',
          store: 'Store',
          business: 'Business',
          appVersion: 'App version',
          deviceId: 'Device ID',
        },
        language: { id: 'Bahasa Indonesia', en: 'English' },
        unauthorized: { askOwner: 'Ask your store owner for access.' },
        opType: { unknown: 'Change' },
        errors: {
          INVALID_TRANSITION:
            'This can’t be done anymore because the record changed. Check the record again.',
          PERMISSION_DENIED: 'Your account doesn’t have permission to do this.',
          VALIDATION_FAILED: 'Something isn’t filled in right. Please check the form.',
          ENTITY_NOT_FOUND: 'That record can’t be found.',
          NOT_AUTHENTICATED: 'Sign in to continue.',
          DEVICE_NOT_ENROLLED: 'This device isn’t enrolled yet. Enroll it first.',
          USER_DEACTIVATED: 'Your account has been deactivated. Contact the store owner.',
          PIN_RATE_LIMITED: 'Too many wrong PIN tries. Wait a moment, then try again.',
          PIN_LOCKED: 'PIN locked. Ask the store owner to unlock it or set a new PIN.',
          LAST_ADMIN_PROTECTED: 'Not allowed. There must always be at least one active main owner.',
          ROLE_IN_USE:
            'This role is still assigned to users, so it can’t be removed yet. Unassign it from everyone first.',
          IDEMPOTENCY_CONFLICT: 'This request clashed with an earlier one. Try again.',
          RATE_LIMITED: 'Too many requests. Wait a moment, then try again.',
          UNEXPECTED: 'Something went wrong. Try again.',
          NETWORK: 'Connection problem. Your changes are still saved on this device.',
          MEDIA_NOT_FOUND: 'The photo isn’t on the server yet. The app will try again.',
          MEDIA_IMMUTABLE:
            'A photo that has been sent can’t be replaced. Take a new photo if a correction is needed.',
          INIT_MISMATCH: 'This photo’s details don’t match the server’s. Take a new photo.',
          MEDIA_TOO_LARGE: 'This photo is too large to send. Please report this.',
          CHUNK_TOO_LARGE:
            'The photo couldn’t be sent because of an app problem. Please report this.',
          UNSUPPORTED_ENCODING:
            'The photo couldn’t be sent because of an app problem. Please report this.',
          MIME_UNSUPPORTED: 'This file type can’t be sent. Please report this.',
          CHUNK_INDEX_INVALID:
            'The photo couldn’t be sent because of an app problem. Please report this.',
          CHUNK_SIZE_INVALID:
            'The photo couldn’t be sent because of an app problem. Please report this.',
          CHUNKS_MISSING: 'Part of the photo hasn’t arrived. The app will send the rest.',
          HASH_MISMATCH: 'The photo was damaged while sending. The app will try again.',
          MIME_MISMATCH: 'The photo file doesn’t match its type. Take a new photo.',
          STORAGE_ERROR: 'The server couldn’t save the photo. The app will try again.',
          LOCAL_CORRUPT:
            'This photo is damaged on this device and can’t be sent. Take a new photo.',
          AUTH_TOKEN_MISSING: 'Sign in again to keep sending photos.',
          AUTH_TOKEN_INVALID:
            'This device’s session has ended. Sign in again to keep sending photos.',
        },
        rejection: {
          BAD_SIGNATURE:
            'This change failed verification and was rejected by the server. Report this to the store owner.',
          CHAIN_BROKEN:
            'This device’s change history is broken. Sending has stopped. Contact the store owner right away.',
          CHAIN_GAP: 'Some changes were missing. They’re being resent automatically.',
          CHAIN_HALTED: 'On hold because an earlier change has a problem.',
          DEVICE_REVOKED:
            'This device has been revoked, so the change was rejected. Enroll this device again.',
          PERMISSION_DENIED:
            'The person who made this change isn’t allowed to do it in this store, so it wasn’t saved. Ask someone who is allowed to do it again.',
          SCHEMA_INVALID:
            'The server didn’t recognize this change’s format. This is an app problem — report it to the store owner.',
          SCOPE_VIOLATION:
            'This change doesn’t belong to this store or account, so it was rejected. Report it to the store owner.',
          UNKNOWN_TYPE: 'This device’s app needs an update before this change can be sent.',
        },
        account: { menu: 'Account menu', switchUser: 'Switch user' },
      },
      auth: {
        switcher: {
          title: 'Who’s using this?',
          addUser: 'Add User',
          reenroll: 'Re-enroll Device',
          emptyUsers: 'No users on this device yet. Ask the store owner to enroll this device.',
          idleLocked: 'Locked after sitting idle. Your work is safe.',
          search: 'Search name',
          noMatches: 'No matching names',
          locked: 'PIN locked',
          noPin: 'No PIN yet',
          current: 'Signed in',
        },
        pin: {
          title: 'Enter your PIN',
          wrong: 'Wrong PIN.',
          attemptsLeft: '{count, plural, one {# more try left.} other {# more tries left.}}',
          wait: 'Too many wrong tries. Try again in {duration}.',
          lockedOut:
            'The PIN was wrong too many times. Ask the store owner to unlock it in Settings, under Staff PINs.',
          forgot:
            'Ask the store owner to make you a new PIN. They can do it on this phone in Settings, under Staff PINs, even offline.',
          setup: {
            title: 'Create a new PIN',
            repeat: 'Repeat the new PIN',
            mismatch: 'The PINs don’t match. Start again.',
            screenTitle: 'Create PIN',
            hint: '6 digits to sign in on this phone. Avoid your birthday.',
            failed: 'The PIN couldn’t be saved. Try again.',
          },
          change: {
            title: 'Change PIN',
            enterCurrent: 'Enter your current PIN',
            wrongCurrent: 'That’s not your current PIN. Try again.',
            done: 'Your PIN is changed',
            doneBody: 'From now on, sign in with the new PIN.',
          },
          reset: {
            noUsers: 'There’s no other staff on this phone yet.',
            done: '{name}’s new PIN is set',
            denied: 'Only a main owner can make a new PIN for another main owner.',
          },
          unlock: {
            confirm: '{name} can sign in again right away with their old PIN.',
            done: '{name}’s PIN is unlocked',
            notLocked: '{name}’s PIN is no longer locked',
          },
          manage: {
            unauthorizedTitle: 'Owner permission needed',
            unauthorizedBody: 'Only the store owner can unlock or make PINs. Ask the store owner.',
          },
          signIn: 'Sign in',
          lockedOutTitle: 'Your PIN is locked',
          forgotTitle: 'Forgot your PIN?',
          staff: {
            title: 'Staff PINs',
            resetTitle: 'New PIN',
            unlock: 'Unlock PIN',
            reset: 'Make a new PIN',
            handedOver: '{name} has the phone',
            handOverTitle: 'Hand the phone to {name}',
            handOverBody: '{name} types their own new PIN, so you never see it.',
            finish: 'Done',
            resetDoneBody: '{name} can now sign in with the new PIN.',
            unlockDoneBody: '{name} can sign in again with their old PIN.',
            failedTitle: 'That didn’t work',
            unlockConfirmTitle: 'Unlock {name}’s PIN?',
            lockedBody:
              'The PIN was wrong too many times. Unlock it if {name} still remembers it, or make a new one.',
            activeBody: 'The PIN isn’t locked. If {name} forgot it, make a new one.',
            lockedUnlockBody:
              'The PIN was wrong too many times. Unlock it if {name} still remembers it.',
            lockedResetBody: 'The PIN was wrong too many times. Make a new one, typed by {name}.',
            noPinBody: '{name} has no PIN on this phone yet. Make one, typed by {name}.',
          },
          noPinTitle: 'No PIN yet',
          noPinBody:
            'Ask the store owner to make one in Settings, under Staff PINs. You type the PIN yourself.',
        },
        enroll: {
          title: 'Enroll this phone',
          progress: '{step} of {total}',
          credentialsTitle: 'Sign in with the owner account',
          instruction: 'You only do this once per phone. It needs an internet connection.',
          identifierField: 'Account name',
          passwordField: 'Password',
          passwordTooShort: 'Passwords are at least {min} characters.',
          submit: 'Sign in',
          storeTitle: 'Choose a store for this phone',
          nameTitle: 'Name this phone',
          storeLabel: 'Store',
          account: '{tenant} account',
          deviceNameField: 'Name for this phone',
          deviceNamePlaceholder: 'For example: Counter phone 1',
          bind: 'Enroll in {store}',
          bindWithoutStore: 'Enroll this phone',
          pickStoreFirst: 'Choose a store first.',
          nameDeviceFirst: 'Give this phone a name first.',
          needsConnection:
            'Enrolling a phone needs an internet connection. Connect, then try again.',
          wrongCredentials: 'Wrong account name or password. Try again.',
          notOwner: 'This account can’t enroll phones. Sign in with the store owner’s account.',
          success: 'This phone is enrolled',
          successStore: 'Enrolled in {store}.',
          successNext: 'Next, choose who is using this phone.',
          finish: 'Continue',
          discardTitle: 'Cancel enrollment?',
          discardMessage: 'What you entered will be lost.',
          discard: 'Cancel enrollment',
          keepEditing: 'Keep going',
        },
        revoked: {
          title: 'Device Revoked',
          body: 'This device has been revoked and can no longer be used. Contact the store owner to enroll it again.',
        },
        opType: {
          deviceEnrolled: 'Device enrolled',
          userSwitched: 'User switched',
          sessionEnded: 'Session ended',
          pinChanged: 'PIN changed',
          pinReset: 'PIN reset',
          pinLockedOut: 'PIN locked',
          pinLockoutCleared: 'PIN unlocked',
          permissionDenied: 'Access denied',
        },
      },
      sync: {
        chip: { pending: 'Not sent yet', rejected: 'Rejected' },
        status: {
          upToDate: 'All changes are safe on the server.',
          syncing: 'Sending changes to the server.',
          pending: '{count, plural, one {# change not sent yet} other {# changes not sent yet}}',
          pendingMedia: '{count, plural, one {# photo not sent yet} other {# photos not sent yet}}',
          photosPending: 'Changes are sent. The photos will follow.',
          attentionReassurance:
            'The server refused some changes. They’re still saved on this phone.',
          offline: 'Changes are saved on this phone and sent once you’re connected.',
          reconnected: 'Back online',
          lastSynced: 'Last connected {relative}',
          titleSynced: 'Everything is sent',
          titlePending: 'Some changes aren’t sent yet',
          titleSyncing: 'Sending',
          titleOffline: 'No connection',
          titleAttention: 'Something needs a look',
          titlePhotosPending: 'Photos aren’t sent yet',
          screenTitle: 'Sync status',
          savedHere:
            '{count, plural, one {# change is saved on this phone and will be sent automatically.} other {# changes are saved on this phone and will be sent automatically.}}',
          changesLabel: 'Changes',
          photosLabel: 'Photos',
          waitingCount: '{count} not sent yet',
        },
        banner: {
          warning: 'Last connected {relative}. This may not be the latest data.',
          stale: 'No connection for a long time. What you see here could be far behind.',
        },
        rejected: {
          banner:
            '{count, plural, one {# change was rejected by the server. Tap to view.} other {# changes were rejected by the server. Tap to view.}}',
          title: 'Refused by the server ({count})',
          explain:
            'These changes won’t be sent, but they stay saved on this phone as a record. Tap one for details.',
          opMeta: '{opType} · {time}',
          technicalDetails: 'Technical details',
          kept: 'This change stays saved on this phone as a record, but won’t be sent again.',
          noReason: 'The server sent no details.',
          more: 'Show {count} more',
        },
        quarantine: {
          title: 'Changes on hold',
          body: 'Some changes from another device failed verification, so they aren’t shown yet. Report this to the store owner.',
        },
        action: { syncNow: 'Send now', pullToRefresh: 'Pull to refresh' },
        firstSync: {
          title: 'Setting up store data',
          progress: 'History through {date} · {percent}%',
          banner: 'Setting up store data ({percent}%). You can keep working.',
          chip: 'Setting up store data {percent}%',
          explain:
            'This new device is downloading the store’s history. It can stop and resume at any time; nothing already downloaded is repeated.',
        },
        media: {
          failedTitle: 'Photos didn’t send',
          failedBody:
            '{count, plural, one {# photo couldn’t be sent. It’s safe on this phone.} other {# photos couldn’t be sent. They’re safe on this phone.}}',
          retry: 'Send photos again',
        },
      },
      conflict: {
        list: {
          banner:
            '{count, plural, one {# conflict needs a decision} other {# conflicts need a decision}}',
          title: 'Conflicts',
        },
        status: {
          surfaced: 'Needs a decision',
          autoResolved: 'Merged automatically',
          acknowledged: 'Decided',
        },
        detail: { instruction: 'Two changes clash. Choose which one is right.' },
        action: { decide: 'Decide' },
        decision: { saved: 'Decision saved' },
        autoResolved: { toast: 'Two changes were merged automatically' },
      },
      media: {
        status: {
          pending: 'Waiting to send',
          uploading: 'Sending photo…',
          uploaded: 'Photo sent',
          failed: 'Sending failed. Tap to try again.',
          waitingForConnection: 'Waiting for connection',
        },
        action: {
          takePhoto: 'Take Photo',
          retake: 'Retake',
          usePhoto: 'Use This Photo',
          retryUpload: 'Send Again',
        },
        permission: {
          camera: 'Allow the app to use the camera to take photos.',
          cameraDeniedTitle: 'Camera is not allowed',
          cameraDeniedBody:
            'Open your phone Settings, find this app, then turn on the Camera permission.',
        },
        storage: {
          lowWarning:
            'Storage is getting low. Old photos that have already been sent will be cleaned up.',
          lowCritical:
            'Storage is nearly full. Every photo that has been sent is being cleaned up now. Photos that haven’t been sent yet are kept.',
        },
        capture: {
          refusedTitle: 'Storage full',
          refusedBody:
            'Photos can’t be taken because storage is nearly full. Free up some space, then try again.',
        },
        upload: {
          persistentFailure:
            '{count, plural, one {# photo hasn’t reached the server.} other {# photos haven’t reached the server.}}',
        },
      },
      platform: {
        opType: {
          conflictDetected: 'Conflict detected',
          conflictAcknowledged: 'Conflict decided',
          userLocaleChanged: 'Language changed',
        },
      },
      push: {
        conflict: {
          title: 'A conflict needs a decision',
          body: 'A conflict needs the store owner’s decision. Tap to view.',
        },
        device: {
          title: 'Device alert',
          body: 'Something needs attention on one of your store’s devices. Tap to check.',
        },
        permission: {
          title: 'Turn on notifications?',
          message:
            'So you know right away when data needs checking or a store device has a problem, even when the app is closed.',
          allow: 'Turn on notifications',
          later: 'Not now',
        },
      },
      permission: {},
      role: {
        main_owner: { name: 'Main Owner' },
        store_owner: { name: 'Store Owner' },
        staff: { name: 'Staff' },
        cashier: { name: 'Cashier' },
        technician: { name: 'Technician' },
      },
    },
  },
} satisfies Record<'id' | 'en', typeof source>;
