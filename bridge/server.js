const WebSocket = require('isomorphic-ws');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { createReadStream, createWriteStream, readFile, rm } = require('fs');
const { Readable } = require('stream');
const { finished } = require('stream/promises');

// This script needs to be run with the project ID and creator token as command-line arguments.
// e.g., node server.js your-project-id-from-url your-creator-secret-token

const BUILDS_DIR = path.join(__dirname, 'builds');

if (!fs.existsSync(BUILDS_DIR)) {
    fs.mkdirSync(BUILDS_DIR);
}

// --- Websim Connection Logic ---
const WEBSIM_PROJECT_ID = process.argv[2];
const WEBSIM_CREATOR_TOKEN = process.argv[3];

if (!WEBSIM_PROJECT_ID || !WEBSIM_CREATOR_TOKEN) {
    console.error("FATAL: Missing project ID or creator token.");
    console.error("Usage: npm start -- <WEBSIM_PROJECT_ID> <WEBSIM_CREATOR_TOKEN>");
    console.error("You can get these from your project's 'Settings' -> 'API Access' tab.");
    process.exit(1);
}

const WEBSIM_WSS_URL = `wss://connect.websim.com/v1/projects/${WEBSIM_PROJECT_ID}`;
let ws;
let clientId;
let creatorId;

function connectToWebsim() {
    console.log(`Connecting to Websim room at ${WEBSIM_WSS_URL}...`);
    ws = new WebSocket(WEBSIM_WSS_URL, {
        headers: { Authorization: `Bearer ${WEBSIM_CREATOR_TOKEN}` }
    });

    ws.onopen = () => {
        console.log("Websim connection established. Bridge is active.");
        setInterval(sendHeartbeat, 10000); // Send a heartbeat every 10 seconds
    };

    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        
        // Capture our own client ID and the creator's ID on connection
        if (message.type === 'connected') {
            clientId = message.clientId;
            creatorId = message.creatorId;
        }

        // Listen for commands from the creator's browser client
        if (message.type === 'message' && message.data.type === 'bridge-command' && message.clientId === creatorId) {
             const request = message.data.payload;
             console.log('Received build request from browser client:', request);
             handleBuildRequest(request);
        }
    };
    
    ws.onclose = (event) => {
        console.warn(`Websim connection closed. Code: ${event.code}, Reason: ${event.reason}`);
        console.log("Attempting to reconnect in 5 seconds...");
        setTimeout(connectToWebsim, 5000);
    };

    ws.onerror = (error) => {
        console.error("Websim WebSocket error:", error.message);
        // The onclose event will fire next, triggering a reconnect attempt.
    };
}

// Function to send a message to the room
function sendToRoom(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const payload = {
            type: 'message',
            data: {
                ...data,
                sender: 'bridge', // Identify that this message is from the bridge
            }
        };
        ws.send(JSON.stringify(payload));
    }
}

// Sends a heartbeat to let the creator's browser know the bridge is alive
function sendHeartbeat() {
    sendToRoom({ type: 'bridge-heartbeat' });
}
// --- End Websim Connection Logic ---


// --- File Upload Logic ---
async function uploadFile(filePath, fileName) {
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const fileStream = createReadStream(filePath);

    const presignResponse = await fetch(`https://websim.com/api/v1/presigned-urls`, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${WEBSIM_CREATOR_TOKEN}`
         },
        body: JSON.stringify({ fileName, fileSize, contentType: 'application/zip' }),
    });

    if (!presignResponse.ok) {
        throw new Error(`Failed to get presigned URL: ${await presignResponse.text()}`);
    }
    const { uploadUrl, fileUrl } = await presignResponse.json();

    const uploadResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Length': fileSize, 'Content-Type': 'application/zip' },
        body: fileStream,
    });
    
    // Duplex stream fix for undici/node-fetch
    // Wait for the stream to finish before checking the response
    await finished(fileStream);

    if (!uploadResponse.ok) {
        throw new Error(`Upload to S3 failed: ${await uploadResponse.text()}`);
    }

    return fileUrl;
}
// --- End File Upload Logic ---

async function handleBuildRequest(request) {
    const { url, platform, appName, fromClientId } = request;
    const sanitizedAppName = appName.replace(/[^a-zA-Z0-9\-]/g, '');
    const outputDir = path.join(BUILDS_DIR, `${sanitizedAppName}-${platform}-${Date.now()}`);

    const sendStatus = (message, level = 'info') => {
        console.log(`[${level.toUpperCase()}] ${message}`);
        sendToRoom({
            type: 'bridge-log',
            message,
            level,
            originalRequest: request
        });
    };
    
    sendStatus(`Starting build for ${appName} on ${platform}...`);

    const nativefierCommand = `npx nativefier "${url}" "${outputDir}" --name "${appName}" --platform "${platform}" --arch "x64" --fast-quit`;

    sendStatus(`Executing: ${nativefierCommand}`);

    exec(nativefierCommand, async (error, stdout, stderr) => {
        if (error) {
            sendStatus(`Nativefier execution failed: ${error.message}`, 'error');
            console.error(`Nativefier stderr: ${stderr}`);
            return;
        }

        console.log(`Nativefier stdout: ${stdout}`);
        sendStatus('Nativefier build successful. Zipping output...', 'success');

        const finalZipPath = path.join(BUILDS_DIR, `${sanitizedAppName}-${platform}.zip`);
        
        try {
            const buildSubDirs = fs.readdirSync(outputDir, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory())
                .map(dirent => dirent.name);

            if (buildSubDirs.length === 0) {
                 sendStatus(`Could not find app directory in ${outputDir}`, 'error');
                 return;
            }
            const appDirName = buildSubDirs[0];
            const appDirPath = path.join(outputDir, appDirName);

            // Zip the directory
            await zipDirectory(appDirPath, finalZipPath);
            sendStatus(`Zipping complete: ${finalZipPath}`, 'success');

            // Upload the file
            sendToRoom({
                type: 'build-upload-start',
                appName: appName,
                fromClientId: fromClientId
            });
            const downloadUrl = await uploadFile(finalZipPath, path.basename(finalZipPath));

            // Notify creator client of completion
            sendToRoom({
                type: 'build-upload-complete',
                downloadUrl: downloadUrl,
                appName: appName,
                fromClientId: fromClientId,
                platform: platform,
            });

        } catch (err) {
            sendStatus(`An error occurred during zipping or uploading: ${err.message}`, 'error');
            console.error(err);
        } finally {
            // Cleanup build artifacts
            rm(outputDir, { recursive: true, force: true }, (rmErr) => {
                if(rmErr) console.error(`Failed to delete build directory: ${outputDir}`, rmErr);
            });
            rm(finalZipPath, { force: true }, (rmErr) => {
                if(rmErr) console.error(`Failed to delete zip file: ${finalZipPath}`, rmErr);
            });
        }
    });
}

function zipDirectory(sourceDir, outPath) {
    const archive = archiver('zip', { zlib: { level: 9 }});
    const stream = createWriteStream(outPath);

    return new Promise((resolve, reject) => {
        archive
            .directory(sourceDir, false)
            .on('error', err => reject(err))
            .pipe(stream);

        stream.on('close', () => resolve());
        archive.finalize();
    });
}

// Start the connection to the Websim room
connectToWebsim();