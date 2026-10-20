// Capacitor shell around packages/web (docs/design/ANDROID.md).
//
// The web client is bundled into the APK from `webDir` at `cap sync` time and
// served from Capacitor's local server at https://flow.localhost — a secure
// context, and the origin the Flow server admits as a bundled client
// (ANDROID_ORIGIN in @flow/shared). Which server the app talks to is not the
// bundle's business: the shell bakes it (build.gradle, -PflowServerUrl) and
// hands it to the page through the host seam (ShellBoot.java).
//
// FLOW_ANDROID_DEV=1 relaxes the WebView for a dev build against a plain-http
// loopback server (mixed content + cleartext + remote inspection). Never for
// a release build: the shipped app talks https only.
import type { CapacitorConfig } from '@capacitor/cli';

const dev = process.env.FLOW_ANDROID_DEV === '1';

const config: CapacitorConfig = {
  appId: 'im.freeflow.app', // same id as the iOS app
  appName: 'Flow',
  webDir: '../../packages/web/dist',
  server: {
    androidScheme: 'https',
    hostname: 'flow.localhost', // ANDROID_ORIGIN in @flow/shared
    cleartext: dev,
  },
  android: {
    allowMixedContent: dev,
    webContentsDebuggingEnabled: dev,
    // targetSdk 35+ is edge-to-edge; let Capacitor pad the WebView under the
    // system bars rather than drawing the composer beneath the nav bar.
    adjustMarginsForEdgeToEdge: 'auto',
  },
};

export default config;
