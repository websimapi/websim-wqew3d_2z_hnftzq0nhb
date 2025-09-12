import JSZip from 'jszip';

const CREATOR_PANEL = document.getElementById('creator-panel');
const REQUESTER_PANEL = document.getElementById('requester-panel');
const LOADING_VIEW = document.getElementById('loading-view');

const PROJECT_INPUT = document.getElementById('project-input');
const PROJECT_LIST = document.getElementById('project-list');
const PLATFORM_SELECT = document.getElementById('platform-select');
const APP_NAME_INPUT = document.getElementById('app-name');
const BUILD_FORM = document.getElementById('build-form');
const SUBMIT_BUTTON = document.getElementById('submit-build');

const BRIDGE_STATUS = document.getElementById('bridge-status');
const CREATOR_LOG = document.getElementById('creator-log');
const REQUESTER_LOG = document.getElementById('requester-log');

let room;
let isCreator = false;
let creatorId = null;
let currentUserId = null;
let userProjects = []; // To store fetched projects
let bridgeHeartbeatTimeout;

function logTo(element, message, level = 'info') {
    const p = document.createElement('p');
    p.innerHTML = `[${new Date().toLocaleTimeString()}] ${message}`;
    p.classList.add(`log-${level}`);
    element.appendChild(p);
    element.scrollTop = element.scrollHeight;
}

async function main() {
    room = new WebsimSocket();
    await room.initialize();
    
    currentUserId = room.clientId;

    const creator = await window.websim.getCreator();
    creatorId = creator.id;
    isCreator = currentUserId === creatorId;
    
    setupUI();
    
    if (isCreator) {
        setupCreator();
    } else {
        await setupRequester();
    }
    
    room.onmessage = handleRoomMessages;
    // For creators, handle presence update requests (build requests)
    room.subscribePresenceUpdateRequests(handlePresenceUpdateRequest);
}

function setupUI() {
    LOADING_VIEW.classList.add('hidden');
    if (isCreator) {
        CREATOR_PANEL.classList.remove('hidden');
        // DOWNLOAD_BRIDGE_BUTTON.classList.remove('hidden');
    } else {
        REQUESTER_PANEL.classList.remove('hidden');
    }
}

async function setupRequester() {
    logTo(REQUESTER_LOG, "Welcome! Select a project to build.");
    try {
        const user = await window.websim.getUser();
        if (!user) {
            logTo(REQUESTER_LOG, "Could not identify user. Manual URL entry is still available.", 'warn');
            PROJECT_INPUT.placeholder = "Please enter a valid Websim URL";
        } else {
             const response = await fetch(`https://websim.com/api/v1/users/${user.username}/sites`);
             const body = await response.json();
    
            if (body.data && body.data.length > 0) {
                userProjects = body.data;
                PROJECT_LIST.innerHTML = ''; // Clear previous
                userProjects.forEach(site => {
                    const option = document.createElement('option');
                    // Value is what's shown and put in the input field
                    option.value = site.title || `Untitled (${site.id})`;
                    PROJECT_LIST.appendChild(option);
                });
            } else {
                logTo(REQUESTER_LOG, "No projects found for your account. You can enter a URL manually.", 'info');
            }
        }
    } catch (error) {
        console.error("Failed to fetch projects", error);
        logTo(REQUESTER_LOG, "Failed to load your projects. You can enter a URL manually.", 'warn');
    }

    PROJECT_INPUT.addEventListener('input', (e) => {
        const selectedProject = userProjects.find(p => (p.title || `Untitled (${p.id})`) === e.target.value);
        if (selectedProject) {
            APP_NAME_INPUT.value = (selectedProject.title || "My-App").replace(/\s+/g, '-');
        }
    });

    BUILD_FORM.addEventListener('submit', handleBuildRequest);
}

function setupCreator() {
    logTo(CREATOR_LOG, "Creator panel initialized. Waiting for bridge heartbeat...");
    // No direct connection needed anymore. We wait for a message from the bridge.
    resetHeartbeatTimer();
}

function resetHeartbeatTimer() {
    clearTimeout(bridgeHeartbeatTimeout);
    bridgeHeartbeatTimeout = setTimeout(() => {
        BRIDGE_STATUS.textContent = "Disconnected. Is it running?";
        BRIDGE_STATUS.style.color = 'var(--error-color)';
        logTo(CREATOR_LOG, "Bridge heartbeat lost. Please ensure the bridge is running.", 'warn');
    }, 12000); // 12 seconds, allowing for some network delay
}

// Creator receives request from another user
function handlePresenceUpdateRequest(updateRequest, fromClientId) {
    if (updateRequest.type === 'build-request') {
        const { url, platform, appName } = updateRequest;
        logTo(CREATOR_LOG, `Received build request from ${fromClientId.substring(0,6)} for ${appName} on ${platform}.`);

        // Forward this request to the local bridge via a room message
        room.send({
            type: 'bridge-command',
            target: 'bridge', // So the bridge knows this message is for it
            payload: { ...updateRequest, fromClientId }
        });
        
        // Notify clients that build has been forwarded to the bridge
        room.send({
            type: 'status-update',
            requesterId: fromClientId,
            message: `Build for '${appName}' on ${platform} forwarded to the creator's bridge...`,
            level: 'info'
        });
    }
}

// All clients listen for general room messages
function handleRoomMessages(event) {
    const { data, clientId } = event;

    // --- Creator-specific message handling ---
    if (isCreator && data.sender === 'bridge') {
        switch(data.type) {
            case 'bridge-heartbeat':
                BRIDGE_STATUS.textContent = "Connected";
                BRIDGE_STATUS.style.color = 'var(--success-color)';
                resetHeartbeatTimer();
                break;
            case 'bridge-log':
                logTo(CREATOR_LOG, `Bridge: ${data.message}`, data.level);
                 // Relay status to the requester if applicable
                if (data.originalRequest && data.originalRequest.fromClientId) {
                    room.send({
                        type: 'status-update',
                        requesterId: data.originalRequest.fromClientId,
                        message: data.message,
                        level: data.level
                    });
                }
                break;
            case 'build-upload-complete':
                 logTo(CREATOR_LOG, `Upload complete! URL: ${data.downloadUrl}`, 'success');
                 // Send final link to user
                 room.send({ 
                     type: 'build-complete',
                     requesterId: data.fromClientId,
                     downloadUrl: data.downloadUrl,
                     appName: data.appName
                 });
                break;
             case 'build-upload-start':
                 logTo(CREATOR_LOG, `Received build for '${data.appName}'. Uploading...`, 'info');
                 room.send({
                     type: 'status-update',
                     requesterId: data.fromClientId,
                     message: `Build for '${data.appName}' complete! Uploading file...`
                 });
                 break;
        }
    }
    
    // --- Requester-specific message handling ---
    // Only process messages intended for this client
    if (data.requesterId && data.requesterId !== currentUserId) {
        return; 
    }
    
    switch (data.type) {
        case 'status-update':
            logTo(REQUESTER_LOG, data.message, data.level);
            break;
        case 'build-complete':
            const message = `Build for '${data.appName}' is ready! <a href="${data.downloadUrl}" target="_blank" download>Download here</a>.`;
            logTo(REQUESTER_LOG, message, 'success');
            break;
    }
}

function convertToNativefierUrl(url) {
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname;
        const pathname = urlObj.pathname;

        let username, sitePath;

        if (hostname.endsWith('websim.com') || hostname.endsWith('websim.ai')) {
             // Format: https://websim.com/@username/path
            const match = pathname.match(/^\/@([^/]+)\/(.+)$/);
            if (match) {
                username = match[1];
                sitePath = match[2];
            } else {
                // Format: https://websim.com/sites/site-id
                const siteMatch = pathname.match(/^\/sites\/([^/]+)$/);
                 if (siteMatch) {
                    return url; // It's already in a good format, let nativefier handle it
                 }
                return null;
            }
        } else if(hostname.endsWith('.on.websim.com')) {
            // Already in nativefier format, just return it.
            return url;
        } else {
            return null;
        }

        if (username && sitePath) {
            return `https://` + `${sitePath}--${username}.on.websim.com`;
        }

        return null;
    } catch (e) {
        return null;
    }
}

// User submits the build form
function handleBuildRequest(e) {
    e.preventDefault();
    SUBMIT_BUTTON.disabled = true;
    SUBMIT_BUTTON.textContent = 'Requesting...';

    const inputValue = PROJECT_INPUT.value;
    const platform = PLATFORM_SELECT.value;
    const appName = APP_NAME_INPUT.value;

    if (!inputValue || !platform || !appName) {
        logTo(REQUESTER_LOG, 'Please fill out all fields.', 'error');
        SUBMIT_BUTTON.disabled = false;
        SUBMIT_BUTTON.textContent = 'Request Build';
        return;
    }

    let projectUrl = null;

    // Check if the input value matches a project from the datalist
    const selectedProject = userProjects.find(p => (p.title || `Untitled (${p.id})`) === inputValue);
    if (selectedProject) {
        projectUrl = `https://websim.com/sites/${selectedProject.id}`;
    } else {
        // Otherwise, treat as a manual URL and try to convert it
        projectUrl = convertToNativefierUrl(inputValue);
        if (!projectUrl) {
             projectUrl = `https://websim.com/sites/${inputValue}`; // Fallback for raw site ID
        }
    }
    
    // Final check for a valid URL
    let finalUrl = null;
    try {
        new URL(projectUrl); // test if it's a valid URL string
        finalUrl = projectUrl;
    } catch (error) {
         finalUrl = convertToNativefierUrl(projectUrl);
    }
    
    if (!finalUrl) {
         logTo(REQUESTER_LOG, `Invalid project or URL provided: "${inputValue}"`, 'error');
         SUBMIT_BUTTON.disabled = false;
         SUBMIT_BUTTON.textContent = 'Request Build';
         return;
    }

    logTo(REQUESTER_LOG, `Sending build request for '${appName}' on ${platform}...`);
    
    room.requestPresenceUpdate(creatorId, {
        type: 'build-request',
        url: finalUrl,
        platform,
        appName
    });

    setTimeout(() => {
        SUBMIT_BUTTON.disabled = false;
        SUBMIT_BUTTON.textContent = 'Request Another Build';
    }, 3000);
}

// Generate the bridge.zip file on the fly for download
async function createBridgeZip() {
    const zip = new JSZip();
    const folder = zip.folder('websim-nativefier-bridge');
    
    const packageJsonContent = `{
  "name": "websim-nativefier-bridge",
  "version": "1.3.0",
  "description": "Local bridge to run Nativefier for Websim.",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "archiver": "^7.0.1",
    "isomorphic-ws": "^5.0.0",
    "nativefier": "50.0.1",
    "ws": "^8.17.0"
  }
}`;
    const serverJsContent = await (await fetch('bridge/server.js')).text();
    const readmeContent = await (await fetch('bridge/README.md')).text();

    folder.file('package.json', packageJsonContent);
    folder.file('server.js', serverJsContent);
    folder.file('README.md', readmeContent);

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const zipUrl = URL.createObjectURL(zipBlob);
    
    const downloadLink = document.querySelector('a[href="bridge.zip"]');
    downloadLink.href = zipUrl;
}

main();

// Run zip creation immediately, it doesn't need to wait for main()
createBridgeZip().catch(err => console.error("Failed to create bridge zip:", err));