import { app, BrowserWindow, ipcMain, shell, session } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerIpcHandlers } from "./ipc.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEVELOPMENT_ICON = path.resolve(HERE, "..", "..", "desktop", "src-tauri", "icons", "icon.png");
let mainWindow;
let mutationLifecycle = {
  hasActiveMutations: () => false,
  whenMutationsIdle: () => Promise.resolve(),
};
let deferredQuit;

function rendererLocation() {
  const productionFile = path.join(HERE, "..", "dist", "index.html");
  const requested = process.env.VITE_DEV_SERVER_URL;
  // An inherited environment variable must never replace packaged renderer
  // code with a page that receives the privileged preload bridge.
  if (app.isPackaged || !requested) {
    return { url: pathToFileURL(productionFile).href, file: productionFile, development: false };
  }
  let parsed;
  try { parsed = new URL(requested); } catch { throw new Error("VITE_DEV_SERVER_URL must be a loopback HTTP URL."); }
  if (
    parsed.protocol !== "http:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    || parsed.username
    || parsed.password
  ) {
    throw new Error("VITE_DEV_SERVER_URL must be a loopback HTTP URL without credentials.");
  }
  return { url: parsed.href, development: true };
}

const RENDERER = rendererLocation();

function appIconPath() {
  return app.isPackaged ? path.join(process.resourcesPath, "icon.png") : DEVELOPMENT_ICON;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: "Codex Router",
    icon: appIconPath(),
    // Keep the platform-managed traffic lights while the renderer supplies
    // the draggable toolbar surface. The renderer never recreates
    // close/minimize/maximize buttons with HTML/CSS.
    frame: process.platform !== "darwin",
    // Codex keeps the native macOS traffic lights while letting its toolbar
    // occupy the titlebar row. Other platforms retain their normal framed
    // window chrome.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 16, y: 16 },
        }
      : {}),
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false,
      webviewTag: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.on("will-redirect", (event) => event.preventDefault());
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  if (RENDERER.development) mainWindow.loadURL(RENDERER.url);
  else mainWindow.loadFile(RENDERER.file);
  return mainWindow;
}

function trustedRendererSender(event) {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) return false;
  try {
    const actual = new URL(event.senderFrame.url);
    const expected = new URL(RENDERER.url);
    return actual.protocol === expected.protocol
      && actual.hostname === expected.hostname
      && actual.port === expected.port
      && actual.pathname === expected.pathname;
  } catch {
    return false;
  }
}

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();

if (primaryInstance) app.whenReady().then(() => {
  if (process.platform === "darwin") app.dock?.setIcon(appIconPath());
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  // Keep the renderer's document policy narrow even when a future component
  // accidentally adds a remote resource.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const scriptPolicy = RENDERER.development
      ? "script-src 'self' 'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='"
      : "script-src 'self'";
    const connectPolicy = RENDERER.development
      ? "connect-src 'self' ws://127.0.0.1:* ws://localhost:* ws://[::1]:*"
      : "connect-src 'self'";
    const policy = `default-src 'self'; ${connectPolicy}; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; ${scriptPolicy}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
    const responseHeaders = { ...details.responseHeaders };
    for (const name of Object.keys(responseHeaders)) {
      if (name.toLowerCase() === "content-security-policy") delete responseHeaders[name];
    }
    callback({ responseHeaders: { ...responseHeaders, "Content-Security-Policy": [policy] } });
  });
  createWindow();
  mutationLifecycle = registerIpcHandlers({
    ipcMain,
    BrowserWindow,
    shell,
    senderGuard: trustedRendererSender,
  });
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

if (primaryInstance) app.on("second-instance", () => {
  if ((!mainWindow || mainWindow.isDestroyed()) && app.isReady()) createWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on("before-quit", (event) => {
  if (!mutationLifecycle.hasActiveMutations()) return;
  event.preventDefault();
  if (!deferredQuit) {
    deferredQuit = mutationLifecycle.whenMutationsIdle().then(() => {
      deferredQuit = undefined;
      app.quit();
    });
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
