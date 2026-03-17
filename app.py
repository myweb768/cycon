import gevent.monkey
gevent.monkey.patch_all()  # MUST be first before any other imports

import os
import random
import string
import time
from flask import Flask, send_from_directory, request
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_cors import CORS

# Flask app setup
app = Flask(__name__, static_folder='.', static_url_path='')
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'neon_secret_123')

# CORS
CORS(app, origins="*")

# SocketIO with gevent
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode='gevent',
    ping_timeout=60,
    ping_interval=25
)

# In-memory session store
sessions = {}

def gen_key(length=6):
    return ''.join(random.choice(string.ascii_uppercase + string.digits) for _ in range(length))

# =================================================================
# ROUTES
# =================================================================

@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

# =================================================================
# SOCKET HANDLERS
# =================================================================

@socketio.on('generate_key')
def handle_generate_key():
    key = gen_key(6)
    while key in sessions:
        key = gen_key(6)
    sessions[key] = {'clients': [], 'created': time.time()}
    emit('key_generated', {'key': key})

@socketio.on('join_key')
def handle_join_key(data):
    key = data.get('key', '').strip().upper()
    sid = request.sid

    if not key or key not in sessions:
        emit('join_error', {'reason': 'invalid_key'})
        return

    clients = sessions[key]['clients']

    if len(clients) >= 2:
        emit('join_error', {'reason': 'room_full'})
        return

    # Avoid duplicate join
    if sid in clients:
        emit('joined', {'key': key, 'peers': len(clients)})
        return

    clients.append(sid)
    join_room(key)
    emit('joined', {'key': key, 'peers': len(clients)})

    if len(clients) == 2:
        # Notify first peer that second peer joined
        socketio.emit('start_call', {'peer_sid': sid}, room=clients[0])
        socketio.emit('peer_joined', {'peer_sid': clients[0]}, room=sid)

@socketio.on('leave_key')
def handle_leave_key(data):
    key = data.get('key')
    sid = request.sid
    if key and key in sessions:
        if sid in sessions[key]['clients']:
            sessions[key]['clients'].remove(sid)
            socketio.emit('peer_left', {'sid': sid}, room=key)
            if not sessions[key]['clients']:
                sessions.pop(key, None)
    leave_room(key)

@socketio.on('offer')
def handle_offer(data):
    socketio.emit('offer', data, room=data.get('key'), include_self=False)

@socketio.on('answer')
def handle_answer(data):
    socketio.emit('answer', data, room=data.get('key'), include_self=False)

@socketio.on('ice')
def handle_ice(data):
    socketio.emit('ice', data, room=data.get('key'), include_self=False)

@socketio.on('incoming_call')
def handle_incoming_call(data):
    socketio.emit('incoming_call', data, room=data.get('key'), include_self=False)

@socketio.on('accept_call')
def handle_accept_call(data):
    socketio.emit('accept_call', data, room=data.get('key'), include_self=False)

@socketio.on('reject_call')
def handle_reject_call(data):
    socketio.emit('reject_call', data, room=data.get('key'), include_self=False)

@socketio.on('end_call_signal')
def handle_end_call_signal(data):
    socketio.emit('end_call_signal', room=data.get('key'), include_self=False)

@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    for key, info in list(sessions.items()):
        if sid in info['clients']:
            info['clients'].remove(sid)
            socketio.emit('peer_left', {'sid': sid}, room=key)
            if not info['clients']:
                sessions.pop(key, None)

# =================================================================
# RUN
# =================================================================

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, host='0.0.0.0', port=port, debug=False)
