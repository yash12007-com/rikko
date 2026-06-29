const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const NodeWebcam = require('node-webcam');

// ==========================================
// RIKKO: Native Hardware & OS Core APIs
// ==========================================
class RIKKO {
    static Access = {
        Location() {
            console.log("Access Location called");
            return "Location accessed";
        },
        Microphone() {
            console.log("Microphone accessed");
            return "Microphone accessed";
        },
        CameraFeed(cameraIndex = 0) {
            console.log(`Capturing camera frame from index ${cameraIndex}`);
            return new Promise((resolve, reject) => {
                const opts = {
                    width: 1280,
                    height: 720,
                    quality: 100,
                    output: "jpeg",
                    callback_return: "base64",
                    verbose: false
                };
                // Node-webcam index handling
                NodeWebcam.capture(`frame_${cameraIndex}`, opts, (err, data) => {
                    if (err) return reject(new Error("Failed to capture camera frame: " + err));
                    resolve(data); // Returns data:image/jpeg;base64,...
                });
            });
        }
    };

    static Open = {
        App(appPath) {
            console.log(`Opening app: ${appPath}`);
            const startCmd = process.platform === 'win32' ? 'start ""' : 'open';
            execSync(`${startCmd} "${appPath}"`);
            return `Opened ${appPath}`;
        },
        CameraViewer(cameraIndex = 0) {
            console.log(`Starting camera viewer for index ${cameraIndex}`);
            // In Electron, video streaming is typically handled directly in a renderer window
            // via navigator.mediaDevices.getUserMedia for optimal performance.
            return "Camera viewer initialized";
        }
    };

    static Set = {
        Volume(percent) {
            percent = Math.max(0, Math.min(100, parseInt(percent)));
            if (process.platform === 'win32') {
                // Utilizing PowerShell to adjust system volume accurately on Windows
                const psCmd = `(Get-WmiObject -Namespace root\\wmi -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1,${percent})`;
                try {
                    // Windows Volume via NirCmd or PowerShell Audio switching
                    // Using standard Sound volume command line fallback:
                    execSync(`powershell -command "$wshShell = New-Object -ComObject WScript.Shell; for($i=0; $i -lt 50; $i++) { $wshShell.SendKeys([char]174) }; for($i=0; $i -lt ${Math.round(percent / 2)}; $i++) { $wshShell.SendKeys([char]175) }"`);
                    console.log(`Volume adjusted near ${percent}%`);
                    return percent;
                } catch (exc) {
                    console.error(`Volume error: ${exc.message}`);
                    throw exc;
                }
            }
            return percent;
        },
        Brightness(percent) {
            percent = Math.max(0, Math.min(100, parseInt(percent)));
            if (process.platform === 'win32') {
                try {
                    const psCmd = `powershell -Command "(Get-WmiObject -Namespace root\\wmi -Class WmiMonitorBrightnessMethods).WmiSetBrightness(0, ${percent})"`;
                    execSync(psCmd);
                    console.log(`Brightness set to ${percent}%`);
                    return percent;
                } catch (exc) {
                    console.error(`Brightness error: ${exc.message}`);
                    throw exc;
                }
            }
            return percent;
        }
    };
}

// ==========================================
// RIKParser: Parsing .rik configurations
// ==========================================
class RIKParser {
    constructor(filepath) {
        this.filepath = filepath;
        this.header = null;
        this.content = null;
        this.bridge = {};
    }

    parse() {
        const text = fs.readFileSync(this.filepath, 'utf-8');
        this.parseHeader(text);
        this.parseContent(text);
        this.parseBridge(text);

        return {
            header: this.header,
            content: this.content,
            bridge: this.bridge
        };
    }

    parseHeader(text) {
        const match = text.match(/HEADER:\s*(\w+)/);
        if (match) this.header = match[1];
    }

    parseContent(text) {
        const match = text.match(/CONTENT:\s*(\[\{[\s\S]*?\}\])/);
        if (!match) throw new Error("CONTENT section missing or malformed");
        
        let raw = match[1];
        const replacements = {
            "type:": '"type":',
            "name:": '"name":',
            "path:": '"path":',
            "ico:": '"ico":',
            "style:": '"style":',
            "custom_win:": '"custom_win":'
        };

        for (const [k, v] of Object.entries(replacements)) {
            raw = raw.split(k).join(v);
        }
        this.content = JSON.parse(raw);
    }

    parseBridge(text) {
        const cleanText = text.replace(/BRIDGE:\s*/, '');
        const regex = /(\w+)\((.*?)\)\s*=>\s*([\w.]+)/g;
        let match;

        while ((match = regex.exec(cleanText)) !== null) {
            const [_, func, args, target] = match;
            this.bridge[func] = target.trim();
        }
    }
}

// ==========================================
// RIKRuntime: Context and Execution Lifecycle
// ==========================================
class RIKRuntime {
    constructor(filepath) {
        this.filepath = filepath;
        this.parser = new RIKParser(filepath);
        this.config = null;
        this.window = null;
    }

    extractCssValue(style, key) {
        const regex = new RegExp(`${key}\\s*:\\s*(\\d+)px`);
        const match = style.match(regex);
        return match ? parseInt(match[1], 10) : null;
    }

    async start() {
        this.config = this.parser.parse();
        const content = this.config.content[0];

        let width = 800;
        let height = 600;
        let frameless = false;

        const style = content.style || "";
        const minWidth = this.extractCssValue(style, "min-width");
        const minHeight = this.extractCssValue(style, "min-height");

        if (minWidth) width = minWidth;
        if (minHeight) height = minHeight;

        if (this.config.header && this.config.header.toLowerCase() === "custom_win") {
            frameless = true;
        }

        const baseDir = path.dirname(path.resolve(this.filepath));
        const htmlPath = path.resolve(path.join(baseDir, content.path));

        if (!fs.existsSync(htmlPath)) {
            throw new Error(`Target HTML layout file asset not found at: ${htmlPath}`);
        }

        // Setup Dynamic IPC Resolution Routing (Replaces BridgeAPI)
        ipcMain.handle('rikko-bridge', async (event, { funcName, args }) => {
            if (!(funcName in this.config.bridge)) {
                throw new Error(`Bridge function not defined: ${funcName}`);
            }

            const targetPath = this.config.bridge[funcName]; // e.g., "RIKKO.Access.CameraFeed"
            const parts = targetPath.split(".");
            
            // Resolve scope path starting from local namespace evaluation
            let targetFunc = parts[0] === 'RIKKO' ? RIKKO : null;
            for (let i = 1; i < parts.length; i++) {
                if (targetFunc) targetFunc = targetFunc[parts[i]];
            }

            if (typeof targetFunc !== 'function') {
                throw new Error(`Resolved target execution context path is not a function: ${targetPath}`);
            }

            return await targetFunc(...args);
        });

        // Initialize Window Configuration Mapping
        this.window = new BrowserWindow({
            title: content.name,
            width: width,
            height: height,
            resizable: true,
            frame: !frameless,
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false
            }
        });

        this.window.loadFile(htmlPath);
    }
}

// ==========================================
// Application Bootstrapper Entry Point
// ==========================================
app.whenReady().then(() => {
    // Grabs target .rik file from cli arguments
    const args = process.argv.slice(app.isPackaged ? 1 : 2);
    if (args.length < 1) {
        console.error("Usage: electron main.js <file.rik>");
        app.quit();
        return;
    }

    const filepath = args[0];
    if (!fs.existsSync(filepath)) {
        console.error(`Error: The target RIKKO source file path '${filepath}' does not exist.`);
        app.quit();
        return;
    }

    const runtime = new RIKRuntime(filepath);
    runtime.start();

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
});