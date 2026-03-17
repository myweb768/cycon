// =================================================================
// GLOBALS
// =================================================================
const socket = io();
let sessionKey = null;
let pc = null;
let dataChannel = null;
let localStream = null;
let isCaller = false;
let currentCallType = null;
let callRinger = null;
let currentVideoConstraint = 'user';
let timerInterval = null;
let secondsElapsed = 0;

const LANG = {
    en: { genKey: "Generate Key", connect: "Connect", leave: "Leave", chat: "Chat 💬", audio: "Audio 🔊", video: "Video 📹", placeholderKey: "Enter key to join", sending: "You: " },
    bn: { genKey: "কি জেনারেট করুন", connect: "সংযুক্ত করুন", leave: "ছেড়ে দিন", chat: "চ্যাট 💬", audio: "অডিও 🔊", video: "ভিডিও 📹", placeholderKey: "যোগদানের জন্য কী লিখুন", sending: "আপনি: " }
};
let curLang = 'en';
function t(k) { return LANG[curLang][k] || k; }

// =================================================================
// UI ELEMENTS
// =================================================================
const genKeyBtn       = document.getElementById('genKey');
const joinBtn         = document.getElementById('joinBtn');
const keyInput        = document.getElementById('keyInput');
const sessionArea     = document.getElementById('sessionArea');
const sessionKeySpan  = document.getElementById('sessionKey');
const btnChat         = document.getElementById('btnChat');
const btnAudio        = document.getElementById('btnAudio');
const btnVideo        = document.getElementById('btnVideo');
const videoCol        = document.querySelector('.video-col');
const remoteVideoContainer = document.getElementById('remoteVideoContainer');
const btnLeave        = document.getElementById('btnLeave');
const chatBox         = document.getElementById('chatBox');
const chatMsg         = document.getElementById('chatMsg');
const sendMsg         = document.getElementById('sendMsg');
const btnReload       = document.getElementById('btnReload');
const localVideo      = document.getElementById('localVideo');
const remoteVideo     = document.getElementById('remoteVideo');
const copyKeyBtn      = document.getElementById('copyKeyBtn');
const callControlArea = document.getElementById('callControlArea');
const callStatusMessage = document.getElementById('callStatusMessage');
const btnReceiveCall  = document.getElementById('btnReceiveCall');
const btnRejectCall   = document.getElementById('btnRejectCall');
const flipCameraButton = document.getElementById('flip-camera-button');
const muteMicButton   = document.getElementById('mute-mic-button');
const endCallButton   = document.getElementById('end-call-button');
const maximizeButton  = document.getElementById('maximize-button');
const callControlsBar = document.getElementById('callControlsBar');
const callTimer       = document.getElementById('callTimer');

// =================================================================
// HELPERS
// =================================================================
function appendSystem(text) {
    if (!chatBox) return;
    const div = document.createElement('div');
    div.className = 'chat-msg system';
    div.style.opacity = '0.6';
    div.style.fontStyle = 'italic';
    div.textContent = '• ' + text;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
    console.log('[System]', text);
}

function appendChat(text, me) {
    if (!chatBox) return;
    const div = document.createElement('div');
    div.className = 'chat-msg' + (me ? ' me' : '');
    div.textContent = (me ? t('sending') : '') + text;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function startTimer() {
    if (timerInterval) return;
    secondsElapsed = 0;
    if (callTimer) callTimer.hidden = false;
    timerInterval = setInterval(() => {
        secondsElapsed++;
        const h = String(Math.floor(secondsElapsed / 3600)).padStart(2, '0');
        const m = String(Math.floor((secondsElapsed % 3600) / 60)).padStart(2, '0');
        const s = String(secondsElapsed % 60).padStart(2, '0');
        if (callTimer) callTimer.textContent = `${h}:${m}:${s}`;
    }, 1000);
}

function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
    if (callTimer) { callTimer.hidden = true; callTimer.textContent = '00:00:00'; }
}

function startRinging() {
    if (callRinger) return;
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const sr = ctx.sampleRate;
        const buf = ctx.createBuffer(1, sr * 2, sr);
        const d = buf.getChannelData(0);
        for (let i = 0; i < buf.length; i++) {
            const t2 = i / sr;
            if (t2 < 1.0) {
                d[i] = ((Math.sin(2*Math.PI*440*t2) + Math.sin(2*Math.PI*480*t2)) / 2)
                     * Math.sin(Math.PI * t2) * 0.3;
            }
        }
        const src = ctx.createBufferSource();
        src.buffer = buf; src.loop = true;
        src.connect(ctx.destination); src.start(0);
        callRinger = { source: src, audioContext: ctx };
    } catch(e) { console.warn('Ring failed:', e); }
}

function stopRinging() {
    if (callRinger) {
        try { callRinger.source.stop(); callRinger.audioContext.close(); } catch(e) {}
        callRinger = null;
    }
}

function showVideoArea() {
    if (videoCol) videoCol.style.display = 'flex';
    if (callControlsBar) callControlsBar.hidden = false;
}

function hideVideoArea() {
    if (document.fullscreenElement) document.exitFullscreen().catch(()=>{});
    if (localVideo) localVideo.style.display = 'none';
    if (remoteVideo) remoteVideo.style.display = 'none';
    if (videoCol) { videoCol.style.display = 'none'; videoCol.classList.remove('maximized'); }
    if (callControlsBar) callControlsBar.hidden = true;
    if (muteMicButton) muteMicButton.hidden = true;
    if (endCallButton) endCallButton.hidden = true;
    if (maximizeButton) maximizeButton.hidden = true;
    if (flipCameraButton) flipCameraButton.hidden = true;
}

function showCallControls(message) {
    if (callStatusMessage) callStatusMessage.textContent = message;
    if (callControlArea) callControlArea.hidden = false;
    if (btnAudio) btnAudio.disabled = true;
    if (btnVideo) btnVideo.disabled = true;
}

function hideCallControls() {
    if (callControlArea) callControlArea.hidden = true;
    if (btnAudio) btnAudio.disabled = false;
    if (btnVideo) btnVideo.disabled = false;
}

async function disconnectCall(sendSignal = true) {
    stopTimer(); stopRinging();
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    if (localVideo) localVideo.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;
    currentCallType = null;
    hideVideoArea();
    if (btnAudio) btnAudio.disabled = false;
    if (btnVideo) btnVideo.disabled = false;
    if (sendSignal && sessionKey) socket.emit('end_call_signal', { key: sessionKey });
    appendSystem('Call ended. Chat is still available.');
}

// =================================================================
// PEER CONNECTION
// =================================================================
function createPeerConnection(mode) {
    // Close old PC if exists
    if (pc) { try { pc.close(); } catch(e) {} pc = null; }

    const cfg = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'turn:a.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
            { urls: 'turn:a.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
            { urls: 'turn:a.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
        ],
        iceCandidatePoolSize: 10
    };

    pc = new RTCPeerConnection(cfg);

    // ICE
    pc.onicecandidate = e => {
        if (e.candidate) {
            socket.emit('ice', { key: sessionKey, candidate: e.candidate });
            if (e.candidate.type === 'relay') appendSystem('Using TURN relay.');
        }
    };

    pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState;
        appendSystem('ICE: ' + s);
        if (s === 'connected' || s === 'completed') {
            startTimer();
            appendSystem('Connected!');
        }
        if (s === 'failed') { if (pc.restartIce) pc.restartIce(); }
    };

    // Remote media
    pc.ontrack = e => {
        if (e.streams && e.streams[0]) {
            remoteVideo.srcObject = e.streams[0];
            appendSystem('Remote stream received.');
        }
    };

    // IMPORTANT: disable onnegotiationneeded — we control offer manually
    pc.onnegotiationneeded = () => {
        console.log('[PC] onnegotiationneeded — ignored (manual control)');
    };

    // DataChannel setup
    if (mode === 'caller') {
        dataChannel = pc.createDataChannel('chat', { ordered: true });
        setupDataChannel(dataChannel);
        appendSystem('Data channel created.');
    } else {
        pc.ondatachannel = e => {
            dataChannel = e.channel;
            setupDataChannel(dataChannel);
            appendSystem('Data channel received.');
        };
    }

    return pc;
}

function setupDataChannel(dc) {
    dc.onopen = () => {
        appendSystem('✅ Chat is ready!');
        if (btnChat) btnChat.style.borderColor = '#00ff00';
    };
    dc.onmessage = e => appendChat(e.data, false);
    dc.onerror = e => appendSystem('Chat error: ' + e.message);
    dc.onclose = () => appendSystem('Chat closed.');
}

// =================================================================
// OFFER / ANSWER HELPERS
// =================================================================
async function createAndSendOffer() {
    if (!pc || !sessionKey) return;
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { key: sessionKey, sdp: pc.localDescription });
        appendSystem('Offer sent.');
        console.log('[WebRTC] Offer sent, state:', pc.signalingState);
    } catch(e) {
        console.error('[WebRTC] Offer failed:', e);
        appendSystem('Offer failed: ' + e.message);
    }
}

async function getLocalMedia(withVideo) {
    try {
        const constraints = withVideo
            ? { audio: true, video: { facingMode: currentVideoConstraint } }
            : { audio: true, video: false };
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        localVideo.srcObject = localStream;

        if (!withVideo) {
            if (localVideo) localVideo.style.display = 'none';
            if (remoteVideo) remoteVideo.style.display = 'none';
            if (flipCameraButton) flipCameraButton.hidden = true;
            if (maximizeButton) maximizeButton.hidden = true;
        } else {
            if (localVideo) localVideo.style.display = 'block';
            if (remoteVideo) remoteVideo.style.display = 'block';
            if (flipCameraButton) flipCameraButton.hidden = false;
            if (maximizeButton) maximizeButton.hidden = false;
        }
        if (muteMicButton) { muteMicButton.hidden = false; muteMicButton.textContent = 'Mute Mic'; }
        if (endCallButton) endCallButton.hidden = false;
        showVideoArea();
        return true;
    } catch(e) {
        appendSystem('Media error: ' + e.message);
        hideVideoArea();
        return false;
    }
}

// =================================================================
// SOCKET — KEY & SESSION
// =================================================================
if (genKeyBtn) {
    genKeyBtn.onclick = () => {
        genKeyBtn.disabled = true;
        genKeyBtn.textContent = 'Generating...';
        socket.emit('generate_key');
        setTimeout(() => { genKeyBtn.disabled = false; genKeyBtn.textContent = t('genKey'); }, 5000);
    };
}

socket.on('key_generated', d => {
    sessionKey = d.key;
    if (sessionKeySpan) sessionKeySpan.textContent = sessionKey;
    if (sessionArea) sessionArea.hidden = false;
    if (genKeyBtn) { genKeyBtn.disabled = false; genKeyBtn.textContent = t('genKey'); }
    socket.emit('join_key', { key: sessionKey });
    appendSystem('Key generated: ' + sessionKey);
});

if (joinBtn) {
    joinBtn.onclick = () => {
        const key = keyInput.value.trim().toUpperCase();
        if (!key) return appendSystem('Please enter a session key.');
        sessionKey = key;
        socket.emit('join_key', { key });
    };
}

if (keyInput) {
    keyInput.addEventListener('input', function() { this.value = this.value.toUpperCase(); });
    keyInput.addEventListener('keydown', e => { if (e.key === 'Enter' && joinBtn) joinBtn.click(); });
}

socket.on('join_error', d => {
    appendSystem('Error: ' + (d.reason === 'invalid_key' ? 'Invalid key.' : d.reason === 'room_full' ? 'Room is full.' : d.reason));
    sessionKey = null;
});

socket.on('joined', d => {
    if (sessionKeySpan) sessionKeySpan.textContent = sessionKey;
    if (sessionArea) sessionArea.hidden = false;
    isCaller = d.peers === 1;

    // Create PC — synchronous now, no await needed
    createPeerConnection(isCaller ? 'caller' : 'receiver');
    appendSystem(isCaller ? 'You are the host. Waiting for peer...' : 'Joined as peer.');
});

socket.on('peer_joined', () => appendSystem('Peer joined.'));

// KEY: start_call only fires for the CALLER
// At this point PC is stable (just created, no offer yet)
socket.on('start_call', async () => {
    appendSystem('Peer connected. Setting up...');
    if (!isCaller || !pc) return;
    // PC was just created → state is 'stable' → safe to offer
    await createAndSendOffer();
});

// =================================================================
// SOCKET — WEBRTC SIGNALING
// =================================================================
socket.on('offer', async d => {
    if (!d.sdp || !pc) return;
    try {
        await pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
        // If we have local media, add tracks before answering
        if (localStream) {
            localStream.getTracks().forEach(track => {
                const exists = pc.getSenders().find(s => s.track && s.track.kind === track.kind);
                if (!exists) pc.addTrack(track, localStream);
            });
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('answer', { key: sessionKey, sdp: pc.localDescription });
        appendSystem('Answer sent.');
        console.log('[WebRTC] Answer sent');
    } catch(e) {
        console.error('[WebRTC] Offer handling failed:', e);
        appendSystem('Error handling offer: ' + e.message);
    }
});

socket.on('answer', async d => {
    if (!d.sdp || !pc) return;
    try {
        if (pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
            appendSystem('Answer received. Connecting...');
            console.log('[WebRTC] Answer set');
        } else {
            console.warn('[WebRTC] Answer ignored, state:', pc.signalingState);
        }
    } catch(e) {
        console.error('[WebRTC] Answer failed:', e);
        appendSystem('Error handling answer: ' + e.message);
    }
});

socket.on('ice', async d => {
    if (!d.candidate || !pc) return;
    try {
        if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(new RTCIceCandidate(d.candidate));
        }
    } catch(e) { console.warn('[ICE] Add failed:', e); }
});

// =================================================================
// SOCKET — CALL SIGNALING
// =================================================================
socket.on('incoming_call', async d => {
    if (localStream) {
        socket.emit('reject_call', { key: sessionKey, reason: 'busy' });
        return;
    }
    currentCallType = d.callType;
    showCallControls(d.callType === 'video' ? '📹 Incoming Video Call...' : '🔊 Incoming Audio Call...');
    startRinging();
});

socket.on('accept_call', async () => {
    appendSystem('Call accepted!');
    hideCallControls();
    stopRinging();

    const ok = await getLocalMedia(currentCallType === 'video');
    if (!ok || !pc) { disconnectCall(true); return; }

    // Add tracks to existing PC
    localStream.getTracks().forEach(track => {
        const exists = pc.getSenders().find(s => s.track && s.track.kind === track.kind);
        if (!exists) pc.addTrack(track, localStream);
    });

    // Caller sends new offer with media
    await createAndSendOffer();
});

socket.on('reject_call', d => {
    appendSystem('Call rejected: ' + (d.reason || 'declined'));
    hideCallControls(); stopRinging();
    currentCallType = null;
    if (btnAudio) btnAudio.disabled = false;
    if (btnVideo) btnVideo.disabled = false;
});

socket.on('end_call_signal', () => {
    appendSystem('Peer ended the call.');
    stopRinging(); disconnectCall(false);
});

socket.on('peer_left', () => {
    appendSystem('Peer left.');
    disconnectCall(false);
    if (pc) { try { pc.close(); } catch(e) {} pc = null; }
    dataChannel = null;
    if (sessionArea) sessionArea.hidden = true;
    sessionKey = null; isCaller = false;
});

// =================================================================
// UI — CALL BUTTONS
// =================================================================
if (btnReceiveCall) {
    btnReceiveCall.onclick = async () => {
        if (!currentCallType) return;
        stopRinging();
        const ok = await getLocalMedia(currentCallType === 'video');
        if (ok && pc) {
            localStream.getTracks().forEach(track => {
                const exists = pc.getSenders().find(s => s.track && s.track.kind === track.kind);
                if (!exists) pc.addTrack(track, localStream);
            });
            socket.emit('accept_call', { key: sessionKey });
            hideCallControls();
        } else {
            socket.emit('reject_call', { key: sessionKey, reason: 'media_failure' });
            currentCallType = null; hideCallControls();
        }
    };
}

if (btnRejectCall) {
    btnRejectCall.onclick = () => {
        socket.emit('reject_call', { key: sessionKey, reason: 'user_rejected' });
        hideCallControls(); stopRinging(); currentCallType = null;
    };
}

if (btnAudio) {
    btnAudio.onclick = async () => {
        if (!pc || !sessionKey) return appendSystem('Join a session first.');
        if (!isCaller) return appendSystem('Only the host can start calls.');
        if (localStream) return appendSystem('Call already in progress.');
        currentCallType = 'audio';
        btnAudio.disabled = true; if (btnVideo) btnVideo.disabled = true;

        const ok = await getLocalMedia(false);
        if (!ok) { btnAudio.disabled = false; if (btnVideo) btnVideo.disabled = false; return; }
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
        socket.emit('incoming_call', { key: sessionKey, callType: 'audio' });
        appendSystem('Calling...');
    };
}

if (btnVideo) {
    btnVideo.onclick = async () => {
        if (!pc || !sessionKey) return appendSystem('Join a session first.');
        if (!isCaller) return appendSystem('Only the host can start calls.');
        if (localStream) return appendSystem('Call already in progress.');
        currentCallType = 'video';
        if (btnAudio) btnAudio.disabled = true; btnVideo.disabled = true;

        const ok = await getLocalMedia(true);
        if (!ok) { if (btnAudio) btnAudio.disabled = false; btnVideo.disabled = false; return; }
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
        socket.emit('incoming_call', { key: sessionKey, callType: 'video' });
        appendSystem('Calling...');
    };
}

if (btnLeave) {
    btnLeave.onclick = () => {
        disconnectCall(true);
        if (pc) { try { pc.close(); } catch(e) {} pc = null; }
        dataChannel = null;
        hideVideoArea(); hideCallControls(); stopRinging(); stopTimer();
        currentCallType = null; isCaller = false;
        if (sessionKey) {
            socket.emit('leave_key', { key: sessionKey });
            sessionKey = null;
            if (sessionArea) sessionArea.hidden = true;
            appendSystem('Left session.');
        }
    };
}

// =================================================================
// UI — CHAT
// =================================================================
if (sendMsg) {
    sendMsg.onclick = () => {
        const v = chatMsg.value.trim();
        if (!v) return;
        if (!dataChannel || dataChannel.readyState !== 'open') {
            appendSystem('Chat not ready yet.');
            return;
        }
        dataChannel.send(v);
        appendChat(v, true);
        chatMsg.value = '';
    };
}

if (chatMsg) {
    chatMsg.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); if (sendMsg) sendMsg.click(); }
    });
}

if (btnChat) {
    btnChat.onclick = () => {
        if (!dataChannel || dataChannel.readyState !== 'open') {
            appendSystem('Chat not ready. Connect first.');
        } else {
            appendSystem('Chat is ready!');
        }
    };
}

// =================================================================
// UI — VIDEO CONTROLS
// =================================================================
async function flipCamera() {
    if (!pc || !localStream || currentCallType !== 'video') return;
    currentVideoConstraint = currentVideoConstraint === 'user' ? 'environment' : 'user';
    try {
        const ns = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: currentVideoConstraint } });
        const vSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        const aSender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
        if (vSender) await vSender.replaceTrack(ns.getVideoTracks()[0]);
        if (aSender) await aSender.replaceTrack(ns.getAudioTracks()[0]);
        localStream.getTracks().forEach(t => t.stop());
        localStream = ns;
        localVideo.srcObject = localStream;
        appendSystem('Camera flipped.');
    } catch(e) {
        appendSystem('Flip failed: ' + e.message);
        currentVideoConstraint = currentVideoConstraint === 'user' ? 'environment' : 'user';
    }
}

function handleMuteMic() {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (track) {
        track.enabled = !track.enabled;
        if (muteMicButton) muteMicButton.textContent = track.enabled ? 'Mute Mic' : 'Unmute Mic';
        appendSystem(track.enabled ? 'Mic unmuted.' : 'Mic muted.');
    }
}

function handleMaximize() {
    if (!remoteVideoContainer) return;
    if (document.fullscreenElement) {
        document.exitFullscreen().catch(e => appendSystem('Fullscreen exit failed.'));
    } else {
        remoteVideoContainer.requestFullscreen().catch(e => appendSystem('Fullscreen failed.'));
    }
}

document.addEventListener('fullscreenchange', () => {
    const fs = !!document.fullscreenElement;
    if (maximizeButton) maximizeButton.textContent = fs ? 'Minimize' : 'Maximize';
    if (videoCol) videoCol.classList.toggle('maximized', fs);
});

if (flipCameraButton) flipCameraButton.onclick = flipCamera;
if (muteMicButton) muteMicButton.onclick = handleMuteMic;
if (maximizeButton) maximizeButton.onclick = handleMaximize;
if (endCallButton) endCallButton.onclick = () => disconnectCall(true);

// =================================================================
// UI — MISC
// =================================================================
if (copyKeyBtn) {
    copyKeyBtn.onclick = () => {
        if (sessionKey) {
            navigator.clipboard.writeText(sessionKey)
                .then(() => appendSystem('Key copied!'))
                .catch(() => appendSystem('Copy failed.'));
        }
    };
}

if (btnReload) btnReload.onclick = () => window.location.reload();

const langEnBtn = document.getElementById('lang-en');
const langBnBtn = document.getElementById('lang-bn');
if (langEnBtn) langEnBtn.onclick = () => switchLang('en');
if (langBnBtn) langBnBtn.onclick = () => switchLang('bn');

function switchLang(l) {
    curLang = l;
    if (langEnBtn) langEnBtn.classList.toggle('active', l === 'en');
    if (langBnBtn) langBnBtn.classList.toggle('active', l === 'bn');
    if (genKeyBtn) genKeyBtn.textContent = t('genKey');
    if (joinBtn) joinBtn.textContent = t('connect');
    if (keyInput) keyInput.placeholder = t('placeholderKey');
    if (btnChat) btnChat.textContent = t('chat');
    if (btnAudio) btnAudio.textContent = t('audio');
    if (btnVideo) btnVideo.textContent = t('video');
    if (btnLeave) btnLeave.textContent = t('leave');
}
switchLang('en');

// =================================================================
// CLEANUP
// =================================================================
window.addEventListener('beforeunload', () => {
    try {
        if (localStream) localStream.getTracks().forEach(t => t.stop());
        if (sessionKey) socket.emit('leave_key', { key: sessionKey });
        if (pc) pc.close();
        socket.close();
    } catch(e) {}
});
