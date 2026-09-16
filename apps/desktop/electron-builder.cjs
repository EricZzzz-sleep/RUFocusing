const development = process.env.RUFOCUSING_DEV_PACKAGE === '1';
module.exports = {
  appId: 'com.rufocusing.desktop', productName: 'RUFocusing',
  directories: { output: 'release', buildResources: 'packaging' },
  files: ['dist/**/*', 'electron/**/*.mjs', '!electron/**/*.node-test.mjs', 'package.json'],
  extraResources: [
    { from: 'build/backend', to: 'backend' },
    { from: 'build/PYTHON-NOTICES.txt', to: 'PYTHON-NOTICES.txt' },
    { from: 'build/JS-NOTICES.txt', to: 'JS-NOTICES.txt' },
    { from: 'packaging/MODEL-NOTICE.txt', to: 'MODEL-NOTICE.txt' },
  ],
  asar: true, npmRebuild: false, forceCodeSigning: !development,
  artifactName: '${productName}-${version}-${os}-${arch}' + (development ? '-dev' : '') + '.${ext}',
  mac: { target: [{ target: 'dmg', arch: ['arm64'] }], category: 'public.app-category.education',
    hardenedRuntime: true, entitlements: development ? 'packaging/entitlements.dev.plist' : 'packaging/entitlements.mac.plist', entitlementsInherit: development ? 'packaging/entitlements.dev.plist' : 'packaging/entitlements.mac.plist',
    notarize: !development, ...(development ? { identity: '-' } : {}),
    extendInfo: { NSCameraUsageDescription: 'RUFocusing analyzes camera images on your device to estimate study periods. Images are never saved or uploaded.' } },
  win: { target: [{ target: 'nsis', arch: ['x64'] }], ...(development ? { signAndEditExecutable: false } : {}) },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false, runAfterFinish: false },
  publish: null,
};
