const socket = io();
let localStream;
let peerConnections = new Map(); // Map of peerId -> RTCPeerConnection
let myId = null;
let currentRoomId = null;
let pendingCall = null;
let participants = new Set();
let peerConnectionStates = new Map(); // Map of peerId -> connection state

// DOM elements
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
const roomIdDisplay = document.getElementById('roomIdDisplay');
const participantsCountNum = document.getElementById('participantsCountNum');
const createRoomBtn = document.getElementById('createRoomBtn');
const legacyControls = document.getElementById('legacyControls');
const peersList = document.getElementById('peersList');

const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

// Initialize the application
function init() {
  // Get room ID from URL
  const urlParams = new URLSearchParams(window.location.search);
  const roomId = urlParams.get('room');
  
  if (roomId) {
    // Join existing room
    joinRoom(roomId);
  } else {
    // Show create room option
    showCreateRoomOption();
  }
  
  // Initialize media
  initializeMedia();
}

// Initialize media devices
async function initializeMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    updateStatus('Ready to join room', 'status-connected');
  } catch (err) {
    console.error('Error accessing media devices:', err);
    updateStatus('Camera/Audio access denied', 'status-disconnected');
  }
}

// Join a room
function joinRoom(roomId) {
  currentRoomId = roomId;
  roomIdDisplay.textContent = roomId;
  updateStatus('Joining room...', 'status-calling');
  
  socket.emit('joinRoom', { roomId });
  
  // Update URL without reloading
  const newUrl = new URL(window.location);
  newUrl.searchParams.set('room', roomId);
  window.history.pushState({}, '', newUrl);
}

// Create a new room
function createRoom() {
  const roomId = generateRoomId();
  joinRoom(roomId);
}

// Generate a random room ID
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Show create room option
function showCreateRoomOption() {
  roomIdDisplay.textContent = 'No room selected';
  updateStatus('Create or join a room', 'status-disconnected');
}

// Handle socket messages
socket.on('init', ({ id }) => {
  myId = id;
  console.log('My socket ID:', myId);
});

socket.on('roomJoined', ({ roomId, participants: existingParticipants, myId: socketId }) => {
  console.log(`Joined room ${roomId} with ${existingParticipants.length} existing participants`);
  updateStatus(`Connected to room ${roomId}`, 'status-connected');
  
  // Add existing participants
  existingParticipants.forEach(participantId => {
    participants.add(participantId);
    updatePeerConnectionState(participantId, 'connecting');
  });
  
  updateParticipantsCount();
  
  // If we're joining an existing room, we are the initiator and should send offers to all existing participants
  if (existingParticipants.length > 0) {
    console.log('I am the new participant, sending offers to existing participants');
    
    // Ensure local stream is available before creating connections
    if (localStream) {
      existingParticipants.forEach(participantId => {
        if (participantId !== myId) {
          createPeerConnection(participantId);
          // Send offer immediately since we're the initiator
          createAndSendOffer(participantId);
        }
      });
    } else {
      console.warn('Local stream not available yet, waiting...');
      // Wait for local stream to be available
      const checkStream = () => {
        if (localStream) {
          console.log('Local stream now available, creating connections');
          existingParticipants.forEach(participantId => {
            if (participantId !== myId) {
              createPeerConnection(participantId);
              createAndSendOffer(participantId);
            }
          });
        } else {
          setTimeout(checkStream, 100);
        }
      };
      checkStream();
    }
  }
});

socket.on('participantJoined', ({ participantId }) => {
  console.log(`New participant joined: ${participantId}`);
  participants.add(participantId);
  updateParticipantsCount();
  
  // Initialize connection state for new participant
  updatePeerConnectionState(participantId, 'connecting');
  
  // Create peer connection for the new participant (but don't send offer - wait for them to send one)
  if (participantId !== myId) {
    console.log(`Creating peer connection for new participant ${participantId} (waiting for their offer)`);
    
    // Ensure local stream is available
    if (localStream) {
      createPeerConnection(participantId);
    } else {
      console.warn('Local stream not available for new participant, waiting...');
      const checkStream = () => {
        if (localStream) {
          console.log('Local stream now available, creating connection for new participant');
          createPeerConnection(participantId);
        } else {
          setTimeout(checkStream, 100);
        }
      };
      checkStream();
    }
    // Don't send offer - the new participant will send offers to us
  }
});

socket.on('participantLeft', ({ participantId }) => {
  console.log(`Participant left: ${participantId}`);
  participants.delete(participantId);
  peerConnectionStates.delete(participantId);
  updateParticipantsCount();
  
  // Close peer connection
  if (peerConnections.has(participantId)) {
    peerConnections.get(participantId).close();
    peerConnections.delete(participantId);
  }
});

socket.on('roomSignal', async ({ from, type, offer, answer, candidate }) => {
  console.log(`Received room signal from ${from}: ${type}`, { offer: !!offer, answer: !!answer, candidate: !!candidate });
  
  if (!peerConnections.has(from)) {
    console.log(`Creating peer connection for ${from} (received ${type})`);
    
    // Ensure local stream is available before creating connection
    if (localStream) {
      createPeerConnection(from);
    } else {
      console.warn('Local stream not available when receiving signal, waiting...');
      const checkStream = () => {
        if (localStream) {
          console.log('Local stream now available, creating connection for signal');
          createPeerConnection(from);
          // Re-process the signal
          setTimeout(() => {
            socket.emit('roomSignal', { from, type, offer, answer, candidate });
          }, 100);
        } else {
          setTimeout(checkStream, 100);
        }
      };
      checkStream();
      return; // Don't process the signal yet
    }
  }
  
  const peerConnection = peerConnections.get(from);
  
  switch (type) {
    case 'offer':
      try {
        console.log(`Handling offer from ${from}`);
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        const answerDesc = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answerDesc);
        
        console.log(`Sending answer back to ${from}`);
        // Send answer back to the specific participant
        socket.emit('roomSignal', {
          roomId: currentRoomId,
          type: 'answer',
          answer: answerDesc,
          to: from // Add target participant
        });
      } catch (error) {
        console.error('Error handling offer:', error);
      }
      break;
      
    case 'answer':
      try {
        console.log(`Handling answer from ${from}`);
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (error) {
        console.error('Error handling answer:', error);
      }
      break;
      
    case 'candidate':
      try {
        console.log(`Handling candidate from ${from}`);
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.error('Error handling candidate:', error);
      }
      break;
  }
});

// Legacy signaling for direct peer-to-peer calls
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
      if (peerConnections.has(from)) {
        const peerConnection = peerConnections.get(from);
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      }
      break;

    case 'candidate':
      if (peerConnections.has(from)) {
        const peerConnection = peerConnections.get(from);
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      }
      break;

    case 'callAccepted':
      console.log('Call accepted by peer');
      updateStatus('Call connected!', 'status-connected');
      noVideoOverlay.style.display = 'none';
      if (peerConnections.has(from) && answer) {
        const peerConnection = peerConnections.get(from);
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      }
      break;

    case 'callRejected':
      console.log('Call rejected by peer');
      updateStatus('Call rejected', 'status-disconnected');
      if (peerConnections.has(from)) {
        peerConnections.get(from).close();
        peerConnections.delete(from);
      }
      showNotification('Call was rejected', 'error');
      break;
  }
});

// Create peer connection
function createPeerConnection(peerId) {
  if (peerConnections.has(peerId)) {
    peerConnections.get(peerId).close();
  }
  
  const peerConnection = new RTCPeerConnection(rtcConfig);
  peerConnections.set(peerId, peerConnection);

  console.log(`Creating peer connection for ${peerId}, localStream available:`, !!localStream);
  
  if (localStream) {
    console.log(`Adding ${localStream.getTracks().length} tracks to peer connection for ${peerId}`);
    localStream.getTracks().forEach(track => {
      console.log(`Adding track: ${track.kind} to peer ${peerId}`);
      peerConnection.addTrack(track, localStream);
    });
  } else {
    console.warn(`No local stream available when creating peer connection for ${peerId}`);
  }

  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate) {
      console.log(`Generated ICE candidate for ${peerId}:`, candidate);
      if (currentRoomId) {
        console.log(`Sending ICE candidate to ${peerId} in room ${currentRoomId}`);
        socket.emit('roomSignal', { 
          roomId: currentRoomId,
          type: 'candidate', 
          candidate,
          to: peerId // Add target participant
        });
      } else {
        socket.emit('signal', { to: peerId, type: 'candidate', candidate });
      }
    } else {
      console.log(`ICE candidate gathering completed for ${peerId}`);
    }
  };

  peerConnection.ontrack = (event) => {
    console.log(`Received track from ${peerId}:`, event);
    console.log(`Track kind: ${event.track.kind}, Streams:`, event.streams);
    
    if (event.streams && event.streams.length > 0) {
      console.log(`Setting remote video to stream from ${peerId}`);
      remoteVideo.srcObject = event.streams[0];
      noVideoOverlay.style.display = 'none';
      
      // Update status to show which participant we're seeing
      updateStatus(`Connected to ${peerId.substring(0, 8)}...`, 'status-connected');
      showNotification(`Now seeing video from ${peerId.substring(0, 8)}...`, 'success');
    } else {
      console.warn(`No streams in track event from ${peerId}`);
    }
  };

  peerConnection.onconnectionstatechange = () => {
    console.log(`Connection state with ${peerId}:`, peerConnection.connectionState);
    updatePeerConnectionState(peerId, peerConnection.connectionState);
    
    switch (peerConnection.connectionState) {
      case 'connected':
        updateStatus(`Connected to ${peerId.substring(0, 8)}...`, 'status-connected');
        noVideoOverlay.style.display = 'none';
        showNotification(`Connected to ${peerId.substring(0, 8)}...`, 'success');
        break;
      case 'disconnected':
      case 'failed':
        updateStatus(`Disconnected from ${peerId.substring(0, 8)}...`, 'status-disconnected');
        noVideoOverlay.style.display = 'block';
        showNotification(`Disconnected from ${peerId.substring(0, 8)}...`, 'info');
        break;
      case 'connecting':
        updateStatus(`Connecting to ${peerId.substring(0, 8)}...`, 'status-calling');
        break;
    }
  };

  // If we're in a room, create and send offer
  if (currentRoomId && localStream) {
    // Don't automatically send offer - it will be sent explicitly when needed
    // createAndSendOffer(peerId);
  }
}

// Create and send offer
async function createAndSendOffer(peerId) {
  try {
    console.log(`Creating and sending offer to ${peerId}`);
    const peerConnection = peerConnections.get(peerId);
    if (!peerConnection) {
      console.error(`No peer connection found for ${peerId}`);
      return;
    }
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    
    if (currentRoomId) {
      console.log(`Sending room signal offer to ${peerId} in room ${currentRoomId}`);
      socket.emit('roomSignal', {
        roomId: currentRoomId,
        type: 'offer',
        offer,
        to: peerId // Add target participant
      });
    } else {
      socket.emit('signal', { to: peerId, type: 'offer', offer });
    }
  } catch (error) {
    console.error('Error creating offer:', error);
  }
}

// Update participants count
function updateParticipantsCount() {
  const count = participants.size + 1; // +1 for self
  participantsCountNum.textContent = count;
  updatePeersDisplay();
}

// Update connected peers display
function updatePeersDisplay() {
  if (!peersList) return;
  
  peersList.innerHTML = '';
  
  participants.forEach(participantId => {
    if (participantId !== myId) {
      const peerItem = document.createElement('div');
      peerItem.className = 'peer-item';
      
      const state = peerConnectionStates.get(participantId) || 'disconnected';
      peerItem.classList.add(`peer-${state}`);
      
      const shortId = participantId.substring(0, 8) + '...';
      peerItem.textContent = `${shortId} (${state})`;
      
      peersList.appendChild(peerItem);
    }
  });
}

// Update peer connection state
function updatePeerConnectionState(peerId, state) {
  peerConnectionStates.set(peerId, state);
  updatePeersDisplay();
}

// Event listeners
createRoomBtn.addEventListener('click', createRoom);

// Legacy call button
callBtn.addEventListener('click', async () => {
  const peerId = peerInput.value.trim();
  if (!peerId || !localStream) {
    showNotification('Please enter a peer ID and ensure camera access', 'error');
    return;
  }

  updateStatus('Calling...', 'status-calling');
  createPeerConnection(peerId);
  await createAndSendOffer(peerId);
});

// Accept call button (legacy)
acceptBtn.addEventListener('click', async () => {
  if (!pendingCall) return;
  
  const { from, offer } = pendingCall;
  createPeerConnection(from);
  const peerConnection = peerConnections.get(from);
  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  const answerDesc = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answerDesc);
  
  socket.emit('signal', { 
    to: from, 
    type: 'callAccepted',
    answer: answerDesc 
  });
  
  incomingCallDiv.style.display = 'none';
  pendingCall = null;
  updateStatus('Call connected!', 'status-connected');
  noVideoOverlay.style.display = 'none';
});

// Reject call button (legacy)
rejectBtn.addEventListener('click', () => {
  if (!pendingCall) return;
  
  const { from } = pendingCall;
  socket.emit('signal', { 
    to: from, 
    type: 'callRejected' 
  });
  
  incomingCallDiv.style.display = 'none';
  pendingCall = null;
  updateStatus('Call rejected', 'status-disconnected');
});

// Show legacy controls (for direct peer-to-peer calls)
function showLegacyControls() {
  legacyControls.classList.add('show');
}

// Utility functions
function updateStatus(message, className) {
  statusIndicator.textContent = message;
  statusIndicator.className = `status-indicator ${className}`;
}

function showNotification(message, type) {
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

// Initialize the application
init();
