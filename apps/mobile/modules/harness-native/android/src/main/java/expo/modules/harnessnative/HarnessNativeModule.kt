package expo.modules.harnessnative

import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// The on-device harness result emitter (task 27a/175 deliverable #2).
//
// WHY NATIVE, AND WHY THIS EXACT TAG. `scripts/harness-device.mjs` polls the device with
// `adb logcat -d -s BOLUSI_HARNESS_RESULT:I` — a **tag** filterspec. logcat drops every line whose
// TAG is not `BOLUSI_HARNESS_RESULT` before the driver sees a byte of it. A React Native
// `console.log(...)` reaches logcat under the tag `ReactNativeJS`, so the driver's `-s` filter would
// DELETE it even though `extractResultPayload` greps the substring (task 175 leg 2, the tag-vs-substring
// trap recorded at the poll). `android.util.Log.i(tag, message)` is the ONLY path that actually sets
// the logcat TAG to the driver's expected literal — so the JS harness hands the tag + one JSON document
// down here, and this writes it under exactly `BOLUSI_HARNESS_RESULT`. The tag is passed from JS (not
// hardcoded here) so the driver's `HARNESS_RESULT_TAG` and the JS emitter's constant are the single
// source of truth; a tag drift is a visible JS-side break, asserted in the emitter's unit test.
class HarnessNativeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HarnessNative")

    // Emit one line to Android logcat under `tag` at INFO. Returns the byte count android.util.Log
    // reports, purely so the JS side has an observable, non-void result to await on-device.
    Function("logResult") { tag: String, message: String ->
      Log.i(tag, message)
    }
  }
}
