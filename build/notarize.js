'use strict';

exports.default = async function notarize(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (!process.env.APPLE_ID) return; // skip when not configured

  const { notarize } = require('@electron/notarize');
  const appName = context.packager.appInfo.productFilename;
  const appPath = `${context.appOutDir}/${appName}.app`;

  await notarize({
    appPath,
    appleId:          process.env.APPLE_ID,
    appleIdPassword:  process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId:           process.env.APPLE_TEAM_ID,
  });
};
