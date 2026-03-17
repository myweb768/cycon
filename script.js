// frontend/script.js - FULLY FIXED VERSION
// Fixes:
// 1. onicecandidate defined twice (overwrite bug) → merged into one
// 2. Key generation feedback added
// 3. Chat DataChannel readyState check improved
// 4. Timer starts correctly for both audio and video
// 5. accept_call flow fixed (caller gets media before sending offer)
// 6. peer_left cleanup order fixed
// 7. Renegotiation guard added to prevent duplicate offers

// =================================================================
// GLOBALS & LANGUAGE
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
let isNegotiating = false; // FIX: guard against duplicate offers

// Timer Globals
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
const genKeyBtn = document.getElementById('genKey');
const joinBtn = document.getElementById('joinBtn');
const keyInput = document.getElementById('keyInput');
const sessionArea = document.getElementById('sessionArea');
const sessionKeySpan = document.getElementById('sessionKey');
const btnChat = document.getElementById('btnChat');
const btnAudio = document.getElementById('btnAudio');
const btnVideo = document.getElementById('btnVideo');
const videoCol = document.querySelector('.video-col');
const remoteVideoContainer = document.getElementById('remoteVideoContainer');
const btnLeave = document.getElementById('btnLeave');
const chatBox = document.getElementById('chatBox');
const chatMsg = document.getElementById('chatMsg');
const sendMsg = document.getElementById('sendMsg');
const btnReload = document.getElementById('btnReload');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const copyKeyBtn = document.getElementById('copyKeyBtn');
const callControlArea = document.getElementById('callControlArea');
const callStatusMessage = document.getElementById('callStatusMessage');
const btnReceiveCall = document.getElementById('btnReceiveCall');
const btnRejectCall = document.getElementById('btnRejectCall');
const flipCameraButton = document.getElementById('flip-camera-button');
const muteMicButton = document.getElementById('mute-mic-button');
const endCallButton = document.getElementById('end-call-button');
const maximizeButton = document.getElementById('maximize-button');
const callControlsBar = document.getElementById('callControlsBar');
const callTimer = document.getElementById('callTimer');

// =================================================================
// UI & Call Control Helpers
// =================================================================

function startRinging() {
    if (callRinger) return; // already ringing
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const sampleRate = audioContext.sampleRate;
        const ringDuration = 2;
        const buffer = audioContext.createBuffer(1, sampleRate * ringDuration, sampleRate);
        const data = buffer.getChannelData(0);

        for (let i = 0; i < buffer.length; i++) {
            const time = i / sampleRate;
            if (time < 1.0) {
                const tone1 = Math.sin(2 * Math.PI * 440 * time);
                const tone2 = Math.sin(2 * Math.PI * 480 * time);
                const vibrato = Math.sin(2 * Math.PI * 2 * time) * 0.1;
                const envelope = Math.sin(Math.PI * time);
                data[i] = ((tone1 + tone2) / 2) * envelope * (1 + vibrato) * 0.3;
            } else {
                data[i] = 0;
            }
        }

        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.connect(audioContext.destination);
        source.start(0);
        callRinger = { source, audioContext };
    } catch (e) {
        console.warn('Ringing failed:', e);
    }
}

function stopRinging() {
    if (callRinger) {
        try {
            callRinger.source.stop();
            callRinger.audioContext.close();
        } catch (e) { /* ignore */ }
        callRinger = null;
    }
}

function showVideoArea() {
    if (videoCol) videoCol.style.display = 'flex';
    if (callControlsBar) callControlsBar.hidden = false;
}

function hideVideoArea() {
    if (document.fullscreenElement) {
        document.exitFullscreen().catch(e => console.warn('Exit fullscreen failed:', e));
    }
    if (localVideo) localVideo.style.display = 'none';
    if (remoteVideo) remoteVideo.style.display = 'none';
    if (videoCol) {
        videoCol.style.display = 'none';
        videoCol.classList.remove('maximized');
    }
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

function startTimer() {
    if (timerInterval) return; // FIX: don't start if already running
    secondsElapsed = 0;
    if (callTimer) callTimer.hidden = false;

    function updateTimer() {
        secondsElapsed++;
        const h = String(Math.floor(secondsElapsed / 3600)).padStart(2, '0');
        const m = String(Math.floor((secondsElapsed % 3600) / 60)).padStart(2, '0');
        const s = String(secondsElapsed % 60).padStart(2, '0');
        if (callTimer) callTimer.textContent = `${h}:${m}:${s}`;
    }

    timerInterval = setInterval(updateTimer, 1000);
    updateTimer();
}

function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
    if (callTimer) {
        callTimer.hidden = true;
        callTimer.textContent = '00:00:00';
    }
}

async function disconnectCall(sendSignal = true) {
    stopTimer();
    stopRinging();

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    if (localVideo) localVideo.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;

    currentCallType = null;
    hideVideoArea();

    if (btnAudio) btnAudio.disabled = false;
    if (btnVideo) btnVideo.disabled = false;

    if (sendSignal && sessionKey) {
        socket.emit('end_call_signal', { key: sessionKey });
    }

    appendSystem('Call ended. Chat is still available.');
}

// =================================================================
// ESSENTIAL UI CONTROL FUNCTIONS
// =================================================================

async function flipCamera() {
    if (!pc || !localStream || currentCallType !== 'video') {
        appendSystem('Cannot flip camera: Not in a video call.');
        return;
    }

    currentVideoConstraint = (currentVideoConstraint === 'user') ? 'environment' : 'user';
    appendSystem(`Switching to ${currentVideoConstraint === 'user' ? 'Front' : 'Rear'} camera...`);

    try {
        const newStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: { facingMode: currentVideoConstraint }
        });

        const videoTrack = newStream.getVideoTracks()[0];
        const audioTrack = newStream.getAudioTracks()[0];

        const senders = pc.getSenders();
        const videoSender = senders.find(s => s.track && s.track.kind === 'video');
        const audioSender = senders.find(s => s.track && s.track.kind === 'audio');

        if (videoSender && videoTrack) await videoSender.replaceTrack(videoTrack);
        if (audioSender && audioTrack) {
            const wasMuted = localStream.getAudioTracks()[0]
                ? !localStream.getAudioTracks()[0].enabled
                : false;
            await audioSender.replaceTrack(audioTrack);
            audioTrack.enabled = !wasMuted;
        }

        localStream.getTracks().forEach(track => track.stop());
        localStream = newStream;
        localVideo.srcObject = localStream;
        appendSystem('Camera successfully flipped.');
    } catch (err) {
        appendSystem('Failed to flip camera: ' + err.message);
        currentVideoConstraint = (currentVideoConstraint === 'user') ? 'environment' : 'user';
    }
}

function handleMuteMic() {
    if (!localStream || localStream.getAudioTracks().length === 0) {
        appendSystem('Error: Not currently transmitting audio.');
        return;
    }
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        if (muteMicButton) muteMicButton.textContent = audioTrack.enabled ? 'Mute Mic' : 'Unmute Mic';
        appendSystem(audioTrack.enabled ? 'Microphone Unmuted.' : 'Microphone Muted.');
    }
}

function handleMaximize() {
    if (!remoteVideoContainer) {
        appendSystem('Error: Video container not found.');
        return;
    }
    if (document.fullscreenElement) {
        document.exitFullscreen().catch(err => appendSystem('Failed to exit fullscreen: ' + err.message));
    } else {
        remoteVideoContainer.requestFullscreen()
            .then(() => appendSystem('Video maximized (Fullscreen mode).'))
            .catch(err => appendSystem('Failed to enter Fullscreen: ' + err.message));
    }
}

document.addEventListener('fullscreenchange', () => {
    const isFullscreen = !!document.fullscreenElement;
    if (maximizeButton) maximizeButton.textContent = isFullscreen ? 'Minimize' : 'Maximize';
    if (videoCol) videoCol.classList.toggle('maximized', isFullscreen);
});

if (flipCameraButton) flipCameraButton.onclick = flipCamera;
if (muteMicButton) muteMicButton.onclick = handleMuteMic;
if (maximizeButton) maximizeButton.onclick = handleMaximize;
if (endCallButton) endCallButton.onclick = () => disconnectCall(true);

// =================================================================
// CORE WEB-RTC AND MEDIA LOGIC
// =================================================================

async function getLocalMedia(constraints) {
    try {
        const mediaConstraints = constraints.video
            ? { audio: true, video: { facingMode: currentVideoConstraint } }
            : { audio: true, video: false };

        const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
        localStream = stream;
        localVideo.srcObject = stream;

        if (!constraints.video) {
            if (localVideo) localVideo.style.display = 'none';
            if (remoteVideo) remoteVideo.style.display = 'none';
            if (muteMicButton) muteMicButton.hidden = false;
            if (endCallButton) endCallButton.hidden = false;
            if (maximizeButton) maximizeButton.hidden = true;
            if (flipCameraButton) flipCameraButton.hidden = true;
        } else {
            if (localVideo) localVideo.style.display = 'block';
            if (remoteVideo) remoteVideo.style.display = 'block';
            if (muteMicButton) muteMicButton.hidden = false;
            if (endCallButton) endCallButton.hidden = false;
            if (maximizeButton) maximizeButton.hidden = false;
            if (flipCameraButton) flipCameraButton.hidden = false;
        }

        if (muteMicButton) muteMicButton.textContent = 'Mute Mic';
        showVideoArea();
        return true;
    } catch (err) {
        console.error('Media error:', err);
        appendSystem('Media error: ' + err.message);
        hideVideoArea();
        return false;
    }
}

async function createPeerConnection(mode) {
    // FIX: Close existing PC before creating new one
    if (pc) {
        pc.close();
        pc = null;
    }

    const iceConfig = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            {
                urls: 'turn:a.relay.metered.ca:80',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            },
            {
                urls: 'turn:a.relay.metered.ca:80?transport=tcp',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            },
            {
                urls: 'turn:a.relay.metered.ca:443',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            },
            {
                urls: 'turn:a.relay.metered.ca:443?transport=tcp',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            },
            { urls: 'stun:global.stun.twilio.com:3478' }
        ],
        iceCandidatePoolSize: 10
    };

    pc = new RTCPeerConnection(iceConfig);

    // FIX: Single onicecandidate handler (was defined twice before — second overwrote first)
    pc.onicecandidate = e => {
        if (e.candidate) {
            console.log('ICE Candidate Type:', e.candidate.type, '| Protocol:', e.candidate.protocol);
            if (e.candidate.type === 'relay') {
                appendSystem('Using TURN relay server.');
            }
            socket.emit('ice', { key: sessionKey, candidate: e.candidate });
        } else {
            console.log('All ICE candidates sent.');
            appendSystem('Network discovery complete.');
        }
    };

    pc.ontrack = e => {
        console.log('Received remote track:', e.track.kind);
        if (e.streams && e.streams[0]) {
            remoteVideo.srcObject = e.streams[0];
            // FIX: Start timer on first track received regardless of call type
            startTimer();
            appendSystem('Remote stream connected.');
        }
    };

    pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        console.log('ICE Connection State:', state);
        appendSystem('Connection: ' + state);

        if (state === 'failed') {
            appendSystem('Connection failed. Trying ICE restart...');
            if (pc.restartIce) pc.restartIce();
        } else if (state === 'disconnected') {
            appendSystem('Connection lost. Attempting to reconnect...');
        } else if (state === 'connected') {
            appendSystem('Successfully connected!');
            // FIX: Also start timer here for audio calls where ontrack may not fire
            if (currentCallType) startTimer();
        }
    };

    pc.onsignalingstatechange = () => {
        console.log('Signaling State:', pc.signalingState);
    };

    pc.onicegatheringstatechange = () => {
        console.log('ICE Gathering State:', pc.iceGatheringState);
    };

    // FIX: Guard against unexpected renegotiation offers
    pc.onnegotiationneeded = async () => {
        if (!isCaller || isNegotiating) return;
        isNegotiating = true;
        try {
            const offer = await pc.createOffer();
            if (pc.signalingState !== 'stable') return;
            await pc.setLocalDescription(offer);
            socket.emit('offer', { key: sessionKey, sdp: pc.localDescription });
            console.log('Negotiation offer sent');
        } catch (e) {
            console.error('Negotiation failed:', e);
        } finally {
            isNegotiating = false;
        }
    };

    if (mode === 'caller') {
        dataChannel = pc.createDataChannel('chat');
        setupDataChannel();
    } else {
        pc.ondatachannel = e => {
            dataChannel = e.channel;
            setupDataChannel();
        };
    }

    return pc;
}

function setupDataChannel() {
    if (!dataChannel) return;

    dataChannel.onopen = () => {
        console.log('Data channel opened');
        appendSystem('Chat ready. You can now send messages.');
        // FIX: Enable chat button when data channel is open
        if (btnChat) btnChat.disabled = false;
    };

    dataChannel.onmessage = ev => {
        appendChat(ev.data, false);
    };

    dataChannel.onerror = e => {
        console.error('Data Channel Error:', e);
        appendSystem('Chat error occurred.');
    };

    dataChannel.onclose = () => {
        console.log('Data channel closed');
        appendSystem('Chat closed.');
    };
}

// =================================================================
// SOCKET HANDLERS
// =================================================================

// FIX: Generate key with user feedback
if (genKeyBtn) {
    genKeyBtn.onclick = () => {
        genKeyBtn.disabled = true;
        genKeyBtn.textContent = 'Generating...';
        socket.emit('generate_key');
        // Re-enable after timeout in case server doesn't respond
        setTimeout(() => {
            genKeyBtn.disabled = false;
            genKeyBtn.textContent = t('genKey');
        }, 5000);
    };
}

socket.on('key_generated', d => {
    sessionKey = d.key;
    if (sessionKeySpan) sessionKeySpan.textContent = sessionKey;
    if (sessionArea) sessionArea.hidden = false;
    if (genKeyBtn) {
        genKeyBtn.disabled = false;
        genKeyBtn.textContent = t('genKey');
    }
    socket.emit('join_key', { key: sessionKey });
    appendSystem('Session key generated: ' + sessionKey);
});

if (joinBtn) {
    joinBtn.onclick = () => {
        const key = keyInput.value.trim().toUpperCase();
        if (!key) return appendSystem('Error: Please enter a session key.');
        sessionKey = key;
        socket.emit('join_key', { key });
    };
}

socket.on('join_error', d => {
    appendSystem('Join error: ' + (d.reason || 'Unknown error. Check the key and try again.'));
    sessionKey = null;
});

socket.on('joined', async d => {
    if (sessionKeySpan) sessionKeySpan.textContent = sessionKey;
    if (sessionArea) sessionArea.hidden = false;
    appendSystem('Connected to session: ' + sessionKey);

    // FIX: Always create a fresh PC on join
    isCaller = d.peers === 1;
    await createPeerConnection(isCaller ? 'caller' : 'receiver');
    appendSystem(isCaller ? 'You are the host. Waiting for peer...' : 'Joined as peer.');
});

socket.on('peer_joined', () => {
    appendSystem('Peer joined the session.');
});

socket.on('start_call', async () => {
    appendSystem('Peer ready. Establishing connection...');

    if (!isCaller || !pc) return;

    await new Promise(resolve => setTimeout(resolve, 500));

    try {
        if (pc.signalingState !== 'stable') {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (pc.signalingState !== 'stable') {
            appendSystem('Cannot create offer: not stable. Please reload.');
            return;
        }
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { key: sessionKey, sdp: pc.localDescription });
        appendSystem('Connection offer sent...');
        console.log('Initial offer sent');
    } catch (e) {
        console.error('Offer creation failed:', e);
        appendSystem('Failed to create offer: ' + e.message);
    }
});

socket.on('offer', async d => {
    if (!d.sdp || !pc) return;

    try {
        console.log('Received offer, signaling state:', pc.signalingState);

        // FIX: Handle offer collision
        if (pc.signalingState !== 'stable') {
            appendSystem('Offer received in wrong state, rolling back...');
            await Promise.all([
                pc.setLocalDescription({ type: 'rollback' }),
                pc.setRemoteDescription(new RTCSessionDescription(d.sdp))
            ]);
        } else {
            await pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
        }

        // Add local tracks if a call is in progress
        if (localStream) {
            localStream.getTracks().forEach(track => {
                const exists = pc.getSenders().find(s => s.track && s.track.kind === track.kind);
                if (!exists) {
                    pc.addTrack(track, localStream);
                    console.log('Added', track.kind, 'track to PC');
                }
            });
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('answer', { key: sessionKey, sdp: pc.localDescription });
        console.log('Answer sent');
        isNegotiating = false;
    } catch (e) {
        console.error('Error handling offer:', e);
        appendSystem('Error processing connection offer: ' + e.message);
        isNegotiating = false;
    }
});

socket.on('answer', async d => {
    if (!d.sdp || !pc) return;

    try {
        // FIX: Only set remote description if we're expecting an answer
        if (pc.signalingState !== 'have-local-offer') {
            console.warn('Received answer in wrong state:', pc.signalingState);
            return;
        }
        await pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
        isNegotiating = false;
        appendSystem('Connection established.');
    } catch (e) {
        console.error('Error handling answer:', e);
        appendSystem('Error processing connection answer: ' + e.message);
        isNegotiating = false;
    }
});

socket.on('ice', async d => {
    if (d.candidate && pc) {
        try {
            // FIX: Only add ICE candidate if remote description is set
            if (pc.remoteDescription && pc.remoteDescription.type) {
                await pc.addIceCandidate(new RTCIceCandidate(d.candidate));
                console.log('ICE candidate added');
            } else {
                console.warn('Remote description not set yet, skipping ICE candidate');
            }
        } catch (e) {
            console.warn('ICE candidate error:', e);
        }
    }
});

socket.on('peer_left', () => {
    appendSystem('Peer left the session.');

    // FIX: Disconnect call first, then close PC
    disconnectCall(false);

    setTimeout(() => {
        if (pc) {
            pc.close();
            pc = null;
        }
        dataChannel = null;
        if (sessionArea) sessionArea.hidden = true;
        sessionKey = null;
        isCaller = false;
    }, 300);
});

socket.on('end_call_signal', () => {
    appendSystem('Peer ended the call.');
    stopRinging();
    disconnectCall(false);
});

socket.on('incoming_call', async d => {
    if (localStream) {
        socket.emit('reject_call', { key: sessionKey, reason: 'busy' });
        appendSystem('Auto-rejected: already in a call.');
        return;
    }

    if (!pc) {
        isCaller = false;
        await createPeerConnection('receiver');
    }

    currentCallType = d.callType;
    const message = d.callType === 'video' ? '📹 Incoming Video Call...' : '🔊 Incoming Audio Call...';
    showCallControls(message);
    appendSystem(message);
    startRinging();
});

// FIX: accept_call — caller gets media then sends offer
socket.on('accept_call', async () => {
    appendSystem('Call accepted. Starting media...');
    hideCallControls();
    stopRinging();

    const success = await getLocalMedia({
        audio: true,
        video: currentCallType === 'video'
    });

    if (success && localStream && pc) {
        // Remove existing senders to avoid duplicates
        const existingSenders = pc.getSenders();
        existingSenders.forEach(sender => {
            if (sender.track) pc.removeTrack(sender);
        });

        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
            console.log('Added', track.kind, 'track after call acceptance');
        });

        try {
            if (pc.signalingState !== 'stable') {
                appendSystem('Waiting for stable state...');
                return;
            }
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit('offer', { key: sessionKey, sdp: pc.localDescription });
            console.log('Media offer sent after accept');
            // FIX: Start timer for caller side (audio call)
            if (currentCallType === 'audio') startTimer();
        } catch (e) {
            console.error('Failed to create media offer:', e);
            appendSystem('Failed to establish media connection: ' + e.message);
            disconnectCall(true);
        }
    } else {
        appendSystem('Failed to access camera/microphone.');
        disconnectCall(true);
    }
});

socket.on('reject_call', d => {
    appendSystem(`Call rejected: ${d.reason || 'No reason given'}`);
    hideCallControls();
    if (btnAudio) btnAudio.disabled = false;
    if (btnVideo) btnVideo.disabled = false;
    currentCallType = null;
    stopRinging();
});

// =================================================================
// UI HANDLERS
// =================================================================

if (btnReceiveCall) {
    btnReceiveCall.onclick = async () => {
        if (!currentCallType) return;

        stopRinging();
        appendSystem('Accepting call...');

        const success = await getLocalMedia({
            audio: true,
            video: currentCallType === 'video'
        });

        if (success && localStream && pc) {
            localStream.getTracks().forEach(track => {
                const exists = pc.getSenders().find(s => s.track && s.track.kind === track.kind);
                if (!exists) {
                    pc.addTrack(track, localStream);
                    console.log('Added', track.kind, 'track on receive');
                }
            });
            socket.emit('accept_call', { key: sessionKey });
            hideCallControls();
        } else {
            socket.emit('reject_call', { key: sessionKey, reason: 'media_failure' });
            appendSystem('Failed to access media devices.');
            currentCallType = null;
            hideCallControls();
        }
    };
}

if (btnRejectCall) {
    btnRejectCall.onclick = () => {
        if (currentCallType) {
            socket.emit('reject_call', { key: sessionKey, reason: 'user_rejected' });
            appendSystem('Call rejected.');
            hideCallControls();
            stopRinging();
            currentCallType = null;
        }
    };
}

// Language switching
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

if (btnReload) btnReload.onclick = () => window.location.reload();

if (keyInput) {
    keyInput.addEventListener('input', function () {
        this.value = this.value.toUpperCase();
    });
    // FIX: Allow pressing Enter to join
    keyInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && joinBtn) joinBtn.click();
    });
}

if (copyKeyBtn) {
    copyKeyBtn.onclick = () => {
        if (sessionKey) {
            navigator.clipboard.writeText(sessionKey)
                .then(() => appendSystem('Session key copied to clipboard!'))
                .catch(err => appendSystem('Failed to copy key: ' + err.message));
        }
    };
}

if (btnChat) {
    btnChat.onclick = () => {
        if (!dataChannel || dataChannel.readyState !== 'open') {
            appendSystem('Chat not ready yet. Wait for peer to connect.');
        } else {
            appendSystem('Chat is active and ready.');
        }
    };
}

if (btnAudio) {
    btnAudio.onclick = async () => {
        if (!pc || !sessionKey) return appendSystem('Please join a session first.');
        if (!isCaller) return appendSystem('Only the host can initiate calls.');
        if (localStream) return appendSystem('Call already in progress.');

        currentCallType = 'audio';
        appendSystem('Initiating audio call...');
        socket.emit('incoming_call', { key: sessionKey, callType: 'audio' });
        btnAudio.disabled = true;
        if (btnVideo) btnVideo.disabled = true;
    };
}

if (btnVideo) {
    btnVideo.onclick = async () => {
        if (!pc || !sessionKey) return appendSystem('Please join a session first.');
        if (!isCaller) return appendSystem('Only the host can initiate calls.');
        if (localStream) return appendSystem('Call already in progress.');

        currentCallType = 'video';
        appendSystem('Initiating video call...');
        socket.emit('incoming_call', { key: sessionKey, callType: 'video' });
        if (btnAudio) btnAudio.disabled = true;
        btnVideo.disabled = true;
    };
}

if (btnLeave) {
    btnLeave.onclick = () => {
        disconnectCall(true);

        if (pc) {
            pc.close();
            pc = null;
            dataChannel = null;
        }

        hideVideoArea();
        hideCallControls();
        stopRinging();
        stopTimer();
        currentCallType = null;
        isCaller = false;
        isNegotiating = false;

        if (sessionKey) {
            socket.emit('leave_key', { key: sessionKey });
            sessionKey = null;
            if (sessionArea) sessionArea.hidden = true;
            appendSystem('Left session.');
        }
    };
}

if (sendMsg) {
    sendMsg.onclick = () => {
        const v = chatMsg.value.trim();
        if (!v) return;

        if (!dataChannel || dataChannel.readyState !== 'open') {
            appendSystem('Chat not ready. Data channel is not open.');
            return;
        }

        try {
            dataChannel.send(v);
            appendChat(v, true);
            chatMsg.value = '';
        } catch (e) {
            console.error('Failed to send message:', e);
            appendSystem('Failed to send message: ' + e.message);
        }
    };
}

if (chatMsg) {
    chatMsg.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (sendMsg) sendMsg.click();
        }
    });
}

// =================================================================
// UI HELPER FUNCTIONS
// =================================================================

function appendChat(text, me) {
    if (!chatBox) return;
    const div = document.createElement('div');
    div.className = 'chat-msg' + (me ? ' me' : '');
    div.textContent = (me ? t('sending') : '') + text;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
}

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

// =================================================================
// CLEANUP ON PAGE UNLOAD
// =================================================================

window.addEventListener('beforeunload', () => {
    try {
        if (localStream) localStream.getTracks().forEach(track => track.stop());
        if (sessionKey) socket.emit('leave_key', { key: sessionKey });
        if (pc) pc.close();
        socket.close();
    } catch (e) {
        console.error('Cleanup error:', e);
    }
});
