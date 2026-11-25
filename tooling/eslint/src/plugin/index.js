import boundaries from './rules/boundaries.js';
import desktopProcesses from './rules/desktop-processes.js';
import noClockInHandlers from './rules/no-clock-in-handlers.js';
import noFloatMoney from './rules/no-float-money.js';
import noHardcodedStrings from './rules/no-hardcoded-strings.js';
import noLegacyUploadApi from './rules/no-legacy-upload-api.js';
import noMediaColumnUpdate from './rules/no-media-column-update.js';
import noOpTableUpdate from './rules/no-op-table-update.js';
import permissionModulePrefix from './rules/permission-module-prefix.js';
import reactOnlyInTsx from './rules/react-only-in-tsx.js';
import runtimeEmissionAllowlist from './rules/runtime-emission-allowlist.js';
const plugin = {
  meta: {
    name: 'eslint-plugin-bolusi',
    version: '0.0.0',
  },
  rules: {
    boundaries,
    'desktop-processes': desktopProcesses,
    'no-float-money': noFloatMoney,
    'no-hardcoded-strings': noHardcodedStrings,
    'no-legacy-upload-api': noLegacyUploadApi,
    'no-media-column-update': noMediaColumnUpdate,
    'no-op-table-update': noOpTableUpdate,
    'permission-module-prefix': permissionModulePrefix,
    'react-only-in-tsx': reactOnlyInTsx,
    'no-clock-in-handlers': noClockInHandlers,
    'runtime-emission-allowlist': runtimeEmissionAllowlist,
  },
};
export default plugin;
