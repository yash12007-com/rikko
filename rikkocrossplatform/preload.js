const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pywebview', {
    api: {
        // Exposes a universal fallback caller matching PyWebView's exposed JS execution pipeline
        callBridge: async (funcName, ...args) => {
            return await ipcRenderer.invoke('rikko-bridge', { funcName, args });
        }
    }
});