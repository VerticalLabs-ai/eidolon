const path = require("node:path");
const { app, BrowserWindow, Menu, ipcMain, shell } = require("electron");

const {
  buildAuthFlowHosts,
  buildAllowedHosts,
  buildAllowedOrigins,
  isAllowedNavigationUrl,
  resolveAppUrl,
  shouldKeepNavigationInApp,
} = require("./navigation-policy.cjs");
const {
  getLocalRuntimeStatus,
  launchOpenJarvisPreset,
} = require("./local-runtime-companion.cjs");

app.setName("Eidolon");

const appUrl = resolveAppUrl();
const allowedHosts = buildAllowedHosts({ appUrl });
const allowedOrigins = buildAllowedOrigins({ appUrl });
const authFlowHosts = buildAuthFlowHosts();

function buildJarvisRuntimeUrl(currentUrl = appUrl.toString()) {
  const baseUrl = isAllowedNavigationUrl(currentUrl, { allowedHosts, allowedOrigins })
    ? currentUrl
    : appUrl.toString();
  const jarvisUrl = new URL(baseUrl);
  const companyMatch = jarvisUrl.pathname.match(/^\/company\/([^/]+)/);

  jarvisUrl.pathname = companyMatch ? `/company/${companyMatch[1]}/jarvis` : "/";
  jarvisUrl.search = "";
  jarvisUrl.hash = "";

  return jarvisUrl;
}

function assertTrustedAppSender(event) {
  const frameUrl = event.senderFrame?.url;
  if (
    !frameUrl ||
    !isAllowedNavigationUrl(frameUrl, { allowedHosts, allowedOrigins })
  ) {
    throw new Error("Eidolon desktop bridge is only available to trusted app origins");
  }
}

function openExternal(url) {
  shell.openExternal(url).catch((err) => {
    console.error("Failed to open external URL", err);
  });
}

function handleExternalNavigation(event, url) {
  if (shouldKeepNavigationInApp(url, { allowedHosts, allowedOrigins, authFlowHosts })) {
    return;
  }

  event.preventDefault();
  openExternal(url);
}

function installIpcHandlers() {
  ipcMain.handle("eidolon:runtime-status", async (event) => {
    assertTrustedAppSender(event);
    return getLocalRuntimeStatus();
  });
  ipcMain.handle("eidolon:launch-openjarvis-preset", async (event, preset) => {
    assertTrustedAppSender(event);
    return launchOpenJarvisPreset(String(preset));
  });
}

function installApplicationMenu(mainWindow) {
  const template = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
          },
        ]
      : []),
    {
      label: "Jarvis",
      submenu: [
        {
          label: "Open Jarvis Runtime",
          accelerator: "CommandOrControl+Shift+J",
          click: () => {
            const targetUrl = buildJarvisRuntimeUrl(
              mainWindow.webContents.getURL() || appUrl.toString(),
            );
            mainWindow.loadURL(targetUrl.toString()).catch((err) => {
              console.error("Failed to open Jarvis Runtime", err);
            });
          },
        },
        {
          label: "Refresh Local Runtime Status",
          accelerator: "CommandOrControl+Shift+R",
          click: () => {
            mainWindow.webContents.send("eidolon:runtime-status-refresh");
          },
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
      preload: path.join(__dirname, "preload.cjs"),
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldKeepNavigationInApp(url, { allowedHosts, allowedOrigins, authFlowHosts })) {
      mainWindow.loadURL(url).catch((err) => {
        console.error("Failed to load allowed URL", err);
      });
    } else {
      openExternal(url);
    }

    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", handleExternalNavigation);
  installApplicationMenu(mainWindow);

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
  installIpcHandlers();
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
