const socket = io();
let localStream;
let peerConnection;
let myId = null;
let pendingCall = null;

const peerInput = document.getElementById('peerId');
const callBtn = document.getElementById('callBtn');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const incomingCallDiv = document.getElementById('incomingCall');
const callerIdSpan = document.getElementById('callerId');
const acceptBtn = document.getElementById('acceptBtn');
const rejectBtn = document.getElementById('rejectBtn');
const statusIndicator = document.getElementById('statusIndicator');
const noVideoOverlay = document.getElementById('noVideoOverlay');

const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

// Initialize media
navigator.mediaDevices.getUserMedia({ video: true, audio: true })
  .then(stream => {
    localStream = stream;
    localVideo.srcObject = stream;
    updateStatus('Ready to call', 'status-connected');
  })
  .catch(err => {
    console.error('Error accessing media devices:', err);
    updateStatus('Camera/Audio access denied', 'status-disconnected');
  });

// Handle socket messages
socket.on('init', ({ id }) => {
  myId = id;
  console.log('My socket ID:', myId);
  updateStatus(`Connected (ID: ${id.substring(0, 8)}...)`, 'status-connected');
});

socket.on('signal', async ({ from, type, offer, answer, candidate, callAccepted, callRejected }) => {
  switch (type) {
    case 'offer':
      // Show incoming call UI
      pendingCall = { from, offer };
      callerIdSpan.textContent = from.substring(0, 8) + '...';
      incomingCallDiv.style.display = 'block';
      updateStatus('Incoming call...', 'status-calling');
      break;

    case 'answer':
      if (peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      }
      break;

    case 'candidate':
      if (peerConnection) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      }
      break;

    case 'callAccepted':
      console.log('Call accepted by peer');
      updateStatus('Call connected!', 'status-connected');
      noVideoOverlay.style.display = 'none';
      // Set the remote description (answer) from the peer who accepted
      if (peerConnection && answer) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      }
      break;

    case 'callRejected':
      console.log('Call rejected by peer');
      updateStatus('Call rejected', 'status-disconnected');
      if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
      }
      showNotification('Call was rejected', 'error');
      break;
  }
});

// Accept call button
acceptBtn.onclick = async () => {
  if (!pendingCall) return;
  
  const { from, offer } = pendingCall;
  createPeerConnection(from);
  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  const answerDesc = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answerDesc);
  
  // Send acceptance and answer
  socket.emit('signal', { 
    to: from, 
    type: 'callAccepted',
    answer: answerDesc 
  });
  
  // Hide incoming call UI
  incomingCallDiv.style.display = 'none';
  pendingCall = null;
  updateStatus('Call connected!', 'status-connected');
  noVideoOverlay.style.display = 'none';
};

// Reject call button
rejectBtn.onclick = () => {
  if (!pendingCall) return;
  
  const { from } = pendingCall;
  socket.emit('signal', { 
    to: from, 
    type: 'callRejected' 
  });
  
  // Hide incoming call UI
  incomingCallDiv.style.display = 'none';
  pendingCall = null;
  updateStatus('Call rejected', 'status-disconnected');
};

// Button to start call
callBtn.onclick = async () => {
  const peerId = peerInput.value.trim();
  if (!peerId || !localStream) {
    showNotification('Please enter a peer ID and ensure camera access', 'error');
    return;
  }

  updateStatus('Calling...', 'status-calling');
  createPeerConnection(peerId);
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit('signal', { to: peerId, type: 'offer', offer });
};

function createPeerConnection(peerId) {
  if (peerConnection) {
    peerConnection.close();
  }
  
  peerConnection = new RTCPeerConnection(rtcConfig);

  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.emit('signal', { to: peerId, type: 'candidate', candidate });
    }
  };

  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    noVideoOverlay.style.display = 'none';
  };

  peerConnection.onconnectionstatechange = () => {
    console.log('Connection state:', peerConnection.connectionState);
    switch (peerConnection.connectionState) {
      case 'connected':
        updateStatus('Call connected!', 'status-connected');
        noVideoOverlay.style.display = 'none';
        showNotification('Call connected successfully!', 'success');
        break;
      case 'disconnected':
      case 'failed':
        updateStatus('Call ended', 'status-disconnected');
        noVideoOverlay.style.display = 'block';
        showNotification('Call ended', 'info');
        break;
      case 'connecting':
        updateStatus('Connecting...', 'status-calling');
        break;
    }
  };
}

function updateStatus(message, className) {
  statusIndicator.textContent = message;
  statusIndicator.className = `status-indicator ${className}`;
}

function showNotification(message, type) {
  // Create a simple notification
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    padding: 15px 20px;
    border-radius: 8px;
    color: white;
    font-weight: 600;
    z-index: 1001;
    animation: slideInRight 0.3s ease;
    max-width: 300px;
  `;
  
  switch (type) {
    case 'success':
      notification.style.background = '#4CAF50';
      break;
    case 'error':
      notification.style.background = '#f44336';
      break;
    case 'info':
      notification.style.background = '#2196F3';
      break;
  }
  
  notification.textContent = message;
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.animation = 'slideOutRight 0.3s ease';
    setTimeout(() => {
      document.body.removeChild(notification);
    }, 300);
  }, 3000);
}

// Add CSS animations
const style = document.createElement('style');
style.textContent = `
  @keyframes slideInRight {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  @keyframes slideOutRight {
    from { transform: translateX(0); opacity: 1; }
    to { transform: translateX(100%); opacity: 0; }
  }
`;
document.head.appendChild(style);
