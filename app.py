import os 
from flask import Flask, send_from_directory, request
from flask_socketio import SocketIO, emit, join_room, leave_room
import random, string, time

# If your HTML/CSS/JS files are in a folder named 'frontend', change static_folder to 'frontend'
app = Flask(__name__, static_folder='.', static_url_path='')
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'neon_secret_123')

socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

sessions = {}

def gen_key(length=6):
    return ''.join(random.choice(string.ascii_uppercase + string.digits) for _ in range(length))

@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

@socketio.on('generate_key')
def handle_generate_key():
    key = gen_key(6)
    while key in sessions: key = gen_key(6)
    sessions[key] = {'clients': [], 'created': time.time()}
    emit('key_generated', {'key': key})

@socketio.on('join_key')
def handle_join_key(data):
    key = data.get('key')
    sid = request.sid
    if not key or key not in sessions:
        emit('join_error', {'reason': 'invalid_key'})
        return
    clients = sessions[key]['clients']
    if len(clients) >= 2:
        emit('join_error', {'reason': 'room_full'})
        return
    
    clients.append(sid)
    join_room(key)
    emit('joined', {'key': key, 'peers': len(clients)})

    if len(clients) == 2:
        # Give the second client a moment to initialize their JS objects
        socketio.emit('start_call', {'peer_sid': sid}, room=clients[0])
        socketio.emit('peer_joined', {'peer_sid': clients[0]}, room=sid)

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
            if not info['clients']: sessions.pop(key)

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5000, debug=True)
