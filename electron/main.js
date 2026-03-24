const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_PORT = Number(process.env.PORT || '3030');
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}/`;

let mainWindow = null;
let serverProcess = null;
let quitting = false;
let pendingBagToOpen = null;

function appRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app');
  }
  return path.resolve(__dirname, '..');
}

function isBagFile(filePath) {
  return typeof filePath === 'string' && filePath.toLowerCase().endsWith('.bag');
}

function resolveLaunchBagPath(argv = process.argv) {
  for (const arg of argv.slice(1)) {
    if (isBagFile(arg) && fs.existsSync(arg)) {
      return path.resolve(arg);
    }
  }
  return null;
}

function singleViewUrl(bagPath) {
  const url = new URL('single-visualizer.html', SERVER_URL);
  if (bagPath) {
    url.searchParams.set('bag', bagPath);
  }
  return url.toString();
}

function openBagInWindow(bagPath) {
  if (!bagPath) return;
  if (!mainWindow) {
    pendingBagToOpen = bagPath;
    return;
  }
  mainWindow.loadURL(singleViewUrl(bagPath));
  mainWindow.show();
  mainWindow.focus();
}

function waitForServer(port, timeoutMs = 15000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    function attempt() {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        socket.end();
        resolve();
      });

      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for local server on port ${port}`));
          return;
        }
        setTimeout(attempt, 200);
      });
    }

    attempt();
  });
}

function resolveExecutable(commandName) {
  const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidates = [
    ...pathEntries.map((entry) => path.join(entry, commandName)),
    path.join(os.homedir(), '.local', 'bin', commandName),
    path.join(os.homedir(), '.cargo', 'bin', commandName),
    path.join('/opt/homebrew/bin', commandName),
    path.join('/usr/local/bin', commandName),
    path.join('/usr/bin', commandName),
  ];

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_error) {
      // Continue searching known locations.
    }
  }
  return commandName;
}

function startPythonServer() {
  if (serverProcess) return;

  const root = appRoot();
  const uvExecutable = resolveExecutable('uv');

  serverProcess = spawn(uvExecutable, ['run', 'server/server.py'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
    },
    stdio: 'inherit',
  });

  serverProcess.on('error', (error) => {
    console.error('Failed to start local Python server:', error);
    if (!quitting) {
      dialog.showErrorBox(
        'Failed to launch local server',
        [
          `Could not start the Python backend with: ${uvExecutable}`,
          '',
          'Make sure `uv` is installed and available on this Mac.',
        ].join('\n'),
      );
    }
  });

  serverProcess.on('exit', (code, signal) => {
    serverProcess = null;
    if (!quitting) {
      console.error(`Python server exited unexpectedly (code=${code}, signal=${signal})`);
    }
  });
}

function stopPythonServer() {
  if (!serverProcess) return;
  serverProcess.kill();
  serverProcess = null;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(pendingBagToOpen ? singleViewUrl(pendingBagToOpen) : SERVER_URL);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  pendingBagToOpen = null;
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

ipcMain.handle('pick-lane-bag', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select lane bag',
    properties: ['openFile'],
    filters: [
      { name: 'ROS bag files', extensions: ['bag'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });

  if (result.canceled || !result.filePaths.length) {
    return null;
  }

  const laneBagPath = result.filePaths[0];
  return {
    path: laneBagPath,
    name: path.basename(laneBagPath),
  };
});

app.on('second-instance', (_event, argv) => {
  const bagPath = resolveLaunchBagPath(argv);
  if (bagPath) {
    openBagInWindow(bagPath);
    return;
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (!isBagFile(filePath)) return;
  const resolvedPath = path.resolve(filePath);
  if (!app.isReady()) {
    pendingBagToOpen = resolvedPath;
    return;
  }
  openBagInWindow(resolvedPath);
});

app.whenReady().then(async () => {
  pendingBagToOpen = pendingBagToOpen || resolveLaunchBagPath();
  startPythonServer();
  await waitForServer(SERVER_PORT);
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}).catch((error) => {
  console.error(error);
  app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  stopPythonServer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
