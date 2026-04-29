const { app, BrowserWindow, shell } = require("electron");

const {
  buildAuthFlowHosts,
  buildAllowedHosts,
  resolveAppUrl,
  shouldKeepNavigationInApp,
} = require("./navigation-policy.cjs");

app.setName("Eidolon");

const appUrl = resolveAppUrl();
const allowedHosts = buildAllowedHosts({ appUrl });
const authFlowHosts = buildAuthFlowHosts();

function openExternal(url) {
  shell.openExternal(url).catch((err) => {
    console.error("Failed to open external URL", err);
  });
}

function handleExternalNavigation(event, url) {
  if (shouldKeepNavigationInApp(url, { allowedHosts, authFlowHosts })) return;

  event.preventDefault();
  openExternal(url);
}

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    title: "Eidolon",
    backgroundColor: "#080c12",
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldKeepNavigationInApp(url, { allowedHosts, authFlowHosts })) {
      mainWindow.loadURL(url).catch((err) => {
        console.error("Failed to load allowed URL", err);
      });
    } else {
      openExternal(url);
    }

    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", handleExternalNavigation);

  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false);
    },
  );

  mainWindow.loadURL(appUrl.toString()).catch((err) => {
    console.error("Failed to load Eidolon", err);
  });

  return mainWindow;
}

app.whenReady().then(() => {
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
