if (!global.crypto) global.crypto = require('node:crypto');
console.log(`[BOOT] Build ID: ${Date.now()}`);
const crypto = require('node:crypto');
if (!global.crypto) {
    global.crypto = crypto;
    // Some libraries specifically look for webcrypto
    if (!global.crypto.webcrypto) global.crypto.webcrypto = crypto.webcrypto;
}

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers
} = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const bodyParser = require('body-parser');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const dns = require('dns');

// AGGRESSIVE DNS BYPASS CONFIG
const WHATSAPP_HOST = 'web.whatsapp.com';
let resolvedIP = '157.240.1.60'; // Reliable default fallback

// GLOBAL DNS OVERRIDE (The Nuclear Option)
const originalLookup = dns.lookup;
dns.lookup = (hostname, opts, cb) => {
    if (typeof opts === 'function') {
        cb = opts;
        opts = {};
    }
    const isWhatsApp = hostname.includes('whatsapp.com') || hostname.includes('whatsapp.net');
    if (isWhatsApp && resolvedIP) {
        if (opts.all) {
            return cb(null, [{ address: resolvedIP, family: 4 }]);
        }
        return cb(null, resolvedIP, 4);
    }
    return originalLookup(hostname, opts, cb);
};

const app = express();
const port = process.env.PORT || 7860;
const logger = pino({ level: 'info' });

// INFRASTRUCTURE
const TMP_BASE = path.join(__dirname, 'auth_data');
if (!fs.existsSync(TMP_BASE)) fs.mkdirSync(TMP_BASE, { recursive: true });

// --- PERSISTENT MESSAGES STORE ---
const MESSAGES_FILE = path.join(__dirname, 'messages.json');
let messageStore = [];
try {
    if (fs.existsSync(MESSAGES_FILE)) {
        messageStore = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
    }
} catch (e) {
    console.error('Error loading messages.json:', e);
    messageStore = [];
}

function saveMessages() {
    try {
        if (messageStore.length > 2000) messageStore = messageStore.slice(-2000);
        fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messageStore, null, 2), 'utf8');
    } catch (e) {
        console.error('Error saving messages.json:', e);
    }
}

app.use(bodyParser.json());

let sock;
let qrCodeData = null;
let connectionStatus = 'initializing';
let pairingCode = null;
let logs = [];

function addLog(msg) {
    const entry = `[${new Date().toISOString().split('T')[1].split('.')[0]}] ${msg}`;
    console.log(entry);
    logs.push(entry);
    if (logs.length > 50) logs.shift();
}

async function forceResolve(host) {
    try {
        addLog(`Querying DoH for ${host}...`);
        const response = await fetch(`https://dns.google/resolve?name=${host}&type=A`);
        const data = await response.json();
        
        if (data.Answer && data.Answer.length > 0) {
            // Find the first A record or CNAME
            for (const ans of data.Answer) {
                if (ans.type === 1) { // A Record (IP)
                    resolvedIP = ans.data;
                    addLog(`Final IP Found: ${host} -> ${resolvedIP}`);
                    return resolvedIP;
                } else if (ans.type === 5) { // CNAME (Alias)
                    addLog(`Following CNAME: ${host} -> ${ans.data}`);
                    return await forceResolve(ans.data);
                }
            }
        }
        addLog(`No suitable record for ${host}. Using fallback.`);
        return resolvedIP;
    } catch (e) {
        addLog(`DoH Error for ${host}: ${e.message}`);
        return resolvedIP;
    }
}
async function connectToWhatsApp() {
    await forceResolve(WHATSAPP_HOST);
    
    const hasExistingAuth = fs.existsSync(path.join(TMP_BASE, 'creds.json'));
    if (hasExistingAuth) {
        addLog('✅ Previous Session Found. Resuming without QR...');
    } else {
        addLog('🔍 No existing session. Generating NEW QR Code...');
    }

    const { state, saveCreds } = await useMultiFileAuthState(TMP_BASE);
    
    let version = [2, 3000, 1015901307]; // Fallback version
    try {
        const { version: latestVersion } = await fetchLatestBaileysVersion();
        version = latestVersion;
        addLog(`WA Version fetched: ${version.join('.')}`);
    } catch (e) {
        addLog(`Failed to fetch WA version, using fallback: ${version.join('.')}`);
    }

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        // RECALLED FIX: Use standard macOS Desktop fingerprint (More stable for QR)
        browser: Browsers.macOS('Desktop'), 
        syncFullHistory: false, // Speed up pairing dramatically
        markOnlineOnConnect: false,
        generateHighQualityLink: true,
        options: {
            lookup: (hostname, opts, cb) => {
                // Intercept WhatsApp hosts
                if (hostname.includes('whatsapp.com') || hostname.includes('whatsapp.net')) {
                    if (resolvedIP) {
                        return cb(null, resolvedIP, 4);
                    }
                }
                dns.lookup(hostname, opts, cb);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeData = await QRCode.toDataURL(qr);
            connectionStatus = 'awaiting_scan';
            addLog('QR Code generated. Waiting for scan...');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            let shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            // SELF-HEALING: If logged out (401), purge and force a new QR
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                addLog('CRITICAL: Session Logged Out (401). Purging auth data to force NEW QR...');
                if (fs.existsSync(TMP_BASE)) fs.rmSync(TMP_BASE, { recursive: true, force: true });
                shouldReconnect = true; // Force reconnect to generate QR
            }

            connectionStatus = 'disconnected';
            addLog(`Connection closed (Status: ${statusCode}). Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000); 
            }
        } else if (connection === 'open') {
            connectionStatus = 'connected';
            qrCodeData = null;
            pairingCode = null;
            addLog('WhatsApp Connection ONLINE (Stable Desktop Fingerprint)');
        }
    });

    sock.ev.on('messages.upsert', async m => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid || '';

        // 🚫 IGNORE GROUPS, BROADCASTS, AND NEWSLETTERS (Strict 1-on-1 private chats only)
        if (remoteJid.endsWith('@g.us') || remoteJid.includes('@broadcast') || remoteJid.endsWith('@newsletter')) {
            return;
        }

        // RESOLVE SENDER: Prioritize Phone Number (senderPn) over LID
        let sender = remoteJid;
        
        // Comprehensive check for Phone JID (90... @s.whatsapp.net)
        const findPhoneJid = (obj) => {
            if (!obj) return null;
            if (typeof obj === 'string' && obj.endsWith('@s.whatsapp.net')) return obj;
            if (typeof obj === 'object') {
                for (let k in obj) {
                    if (k === 'senderPn' && obj[k]) return obj[k];
                    const res = findPhoneJid(obj[k]);
                    if (res) return res;
                }
            }
            return null;
        };

        const realPhone = findPhoneJid(msg);
        if (realPhone) {
            sender = realPhone;
            addLog(`Resolved LID to PN: ${sender}`);
        } else if (msg.key.participant && !remoteJid.endsWith('@g.us')) {
            sender = msg.key.participant;
        }
        
        const isLid = sender.includes('@lid');

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (text) {
            addLog(`${isLid ? 'LID->PN' : 'Incoming'} from ${sender}: ${text.substring(0, 20)}...`);

            // 💾 SAVE INCOMING MESSAGE TO LOCAL DATABASE
            const cleanSender = sender.replace('@s.whatsapp.net', '').replace('@lid', '');
            const newMsg = {
                id: msg.key.id || `msg_${Date.now()}`,
                direction: 'incoming',
                phone: cleanSender,
                jid: sender,
                name: msg.pushName || 'User',
                text: text,
                timestamp: new Date().toISOString(),
                read: false
            };
            messageStore.push(newMsg);
            saveMessages();

            // Forward to n8n
            const hooks = [
                "https://loriadavio.app.n8n.cloud/webhook-test/whatsapp-incoming",
                "https://lorilbjr-dentalai-system.hf.space/whatsapp-incoming"
            ];
            for (const hook of hooks) {
                try {
                    await fetch(hook, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            id: sender, 
                            content: text, 
                            meta: msg.pushName || 'User',
                            version: "v2.2-dual-hook" 
                        })
                    });
                } catch (e) { addLog(`Webhook failed (${hook}): ` + e.message); }
            }
        }
    });
}

// --- ROUTES ---
app.get('/status-v1', (req, res) => {
    res.send(`
        <html>
        <head>
            <title>Lorilbjr Bridge v2.0</title>
            <style>
                body { background: #0b141a; color: white; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                .card { background: #111b21; padding: 30px; border-radius: 15px; border: 1px solid #00a884; text-align: center; max-width: 400px; box-shadow: 0 10px 40px rgba(0,0,0,0.5); }
                #qr-container { background: white; padding: 10px; border-radius: 8px; margin: 20px 0; min-height: 250px; display: flex; align-items: center; justify-content: center; }
                img { width: 280px; display: none; }
                .status { font-size: 0.9em; padding: 5px 12px; border-radius: 20px; background: #202c33; color: #00a884; }
                .code { font-size: 2.5em; font-weight: bold; color: #00a884; letter-spacing: 5px; background: #202c33; padding: 15px; border-radius: 8px; margin: 15px 0; display: none; }
                input { background: #202c33; border: 1px solid #00a884; color: white; padding: 10px; border-radius: 5px; width: 100%; margin: 10px 0; }
                .btn { background: #00a884; color: white; padding: 12px 20px; border-radius: 8px; border: none; cursor: pointer; font-weight: bold; }
            </style>
        </head>
        <body>
            <div class="card">
                <div id="status-badge" class="status">${connectionStatus}</div>
                <h2>WhatsApp Bridge v2.0</h2>
                <div id="qr-container">
                    <div id="spinner">Waiting for QR...</div>
                    <img id="qr-img" src="" />
                </div>
                
                <div id="pair-section">
                    <p style="font-size:0.8em; color:#8696a0">OR Link with Phone Number:</p>
                    <input type="text" id="phone" placeholder="Example: 966500000000" />
                    <button onclick="getPairCode()" class="btn">Get Code</button>
                    <div id="pair-code" class="code"></div>
                </div>

                <div style="margin-top:20px;">
                    <a href="/sys-reset" style="color:#ea0038; font-size:0.7em; text-decoration:none;">Reset System</a>
                </div>
            </div>
            <script>
                async function update() {
                    const res = await fetch('/api-status');
                    const data = await res.json();
                    document.getElementById('status-badge').innerText = data.status;
                    if (data.qr) {
                        document.getElementById('qr-img').src = data.qr;
                        document.getElementById('qr-img').style.display = 'block';
                        document.getElementById('spinner').style.display = 'none';
                    }
                    if (data.pairCode) {
                        document.getElementById('pair-code').innerText = data.pairCode;
                        document.getElementById('pair-code').style.display = 'block';
                    }
                    if (data.status === 'connected') {
                         document.body.innerHTML = '<h1 style="color:#00a884">✅ ONLINE</h1><p>System Linked Successfully.</p>';
                    }
                }
                async function getPairCode() {
                    const phone = document.getElementById('phone').value;
                    const res = await fetch('/get-code?phone=' + phone);
                    const data = await res.json();
                    if(data.code) {
                        document.getElementById('pair-code').innerText = data.code;
                        document.getElementById('pair-code').style.display = 'block';
                    }
                }
                setInterval(update, 5000);
            </script>
        </body>
        </html>
    `);
});

let publicTunnelUrl = 'https://tabby-finite-gender.ngrok-free.dev';

app.get('/api-status', (req, res) => {
    res.json({ status: connectionStatus, qr: qrCodeData, pairCode: pairingCode, tunnel: publicTunnelUrl });
});

// Endpoint for n8n to send messages TO WhatsApp
app.post('/send', async (req, res) => {
    try {
        const { number, message } = req.body;
        if (!number || !message) {
            return res.status(400).json({ status: 'error', message: 'Missing number or message' });
        }
        if (!sock || connectionStatus !== 'connected') {
            return res.status(503).json({ status: 'error', message: 'WhatsApp not connected' });
        }
        
        // Format number to JID (Robust Formatting)
        let cleaned = number.toString().replace(/\D/g, ''); // Remove EVERYTHING except digits
        
        // Intelligent prefixing for Turkish numbers (Example: 5xx -> 905xx)
        if (cleaned.startsWith('5') && cleaned.length === 10) {
            cleaned = '90' + cleaned;
        }

        let jid = cleaned.includes('@') ? cleaned : `${cleaned}@s.whatsapp.net`;

        const sentResult = await sock.sendMessage(jid, { text: message });
        addLog(`Sent to: ${jid} | Msg: ${message.substring(0, 20)}...`);

        // 💾 SAVE OUTGOING MESSAGE TO DATABASE
        const cleanPhone = jid.replace('@s.whatsapp.net', '').replace('@lid', '');
        const outMsg = {
            id: sentResult?.key?.id || `sent_${Date.now()}`,
            direction: 'outgoing',
            phone: cleanPhone,
            jid: jid,
            text: message,
            timestamp: new Date().toISOString(),
            read: true,
            status: 'sent'
        };
        messageStore.push(outMsg);
        saveMessages();

        res.json({ status: 'success', jid: jid, messageId: outMsg.id });
    } catch (e) {
        addLog(`Send API Error: ${e.message}`);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// --- MESSAGES INBOX & CONVERSATION API (For Website / Dental Dashboard) ---

// 1. Fetch messages with filtering (by phone, limit, unreadOnly)
app.get('/messages', (req, res) => {
    const { phone, limit = 100, unreadOnly } = req.query;
    let filtered = messageStore;
    if (phone) {
        const cleanPhone = phone.replace(/\D/g, '');
        filtered = filtered.filter(m => (m.phone || '').includes(cleanPhone));
    }
    if (unreadOnly === 'true') {
        filtered = filtered.filter(m => m.direction === 'incoming' && !m.read);
    }
    res.json({
        total: filtered.length,
        messages: filtered.slice(-parseInt(limit))
    });
});

// 2. Fetch unread messages
app.get('/messages/unread', (req, res) => {
    const unread = messageStore.filter(m => m.direction === 'incoming' && !m.read);
    res.json({
        unreadCount: unread.length,
        messages: unread
    });
});

// 3. Mark messages as read
app.post('/messages/mark-read', (req, res) => {
    const { id, phone, all } = req.body;
    let updated = 0;
    messageStore.forEach(m => {
        if (all || (id && m.id === id) || (phone && (m.phone || '').includes(phone.replace(/\D/g, '')))) {
            if (!m.read) {
                m.read = true;
                updated++;
            }
        }
    });
    if (updated > 0) saveMessages();
    res.json({ status: 'success', markedRead: updated });
});

// 4. Group conversations by patient/phone (Perfect for clinic chat sidebar!)
app.get('/conversations', (req, res) => {
    const convMap = {};
    for (const m of messageStore) {
        const p = m.phone;
        if (!p) continue;
        if (!convMap[p]) {
            convMap[p] = {
                phone: p,
                name: m.name || p,
                lastMessage: m.text,
                lastMessageTime: m.timestamp,
                unreadCount: 0
            };
        } else {
            convMap[p].lastMessage = m.text;
            convMap[p].lastMessageTime = m.timestamp;
            if (m.name && m.name !== 'User') convMap[p].name = m.name;
        }
        if (m.direction === 'incoming' && !m.read) {
            convMap[p].unreadCount++;
        }
    }
    const conversations = Object.values(convMap).sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));
    res.json({ count: conversations.length, conversations });
});

app.get('/get-code', async (req, res) => {
    const { phone } = req.query;
    if (!phone) return res.status(400).send('Phone required');
    try {
        const code = await sock.requestPairingCode(phone);
        pairingCode = code;
        res.json({ code });
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/qr-raw', (req, res) => {
    if (qrCodeData) {
        const base64Data = qrCodeData.replace(/^data:image\/png;base64,/, "");
        res.setHeader('Content-Type', 'image/png');
        res.send(Buffer.from(base64Data, 'base64'));
    } else { res.status(404).send('Not ready'); }
});

app.get('/console', (req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.send(logs.join('\n'));
});

app.get('/sys-reset', (req, res) => {
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
    res.send('Purged. Refreshing...');
    setTimeout(() => process.exit(0), 1000);
});

app.listen(port, () => {
    addLog(`Server active on port ${port}`);
    connectToWhatsApp();
});
