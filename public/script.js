const socket = io();
let localStream;
let peerConnection;
let myId = null;

const peerInput = document.getElementById('peerId');
const callBtn = document.getElementById('callBtn');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');

const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

// Initialize media
navigator.mediaDevices.getUserMedia({ video: true, audio: true })
  .then(stream => {
    localStream = stream;
    localVideo.srcObject = stream;
  });

// Handle socket messages
socket.on('init', ({ id }) => {
  myId = id;
  console.log('My socket ID:', myId);
});

socket.on('signal', async ({ from, type, offer, answer, candidate }) => {
  switch (type) {
    case 'offer':
      createPeerConnection(from);
      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      const answerDesc = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answerDesc);
      socket.emit('signal', { to: from, type: 'answer', answer: answerDesc });
      break;

    case 'answer':
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      break;

    case 'candidate':
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      break;
  }
});

// Button to start call
callBtn.onclick = async () => {
  const peerId = peerInput.value.trim();
  if (!peerId || !localStream) return;

  createPeerConnection(peerId);
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit('signal', { to: peerId, type: 'offer', offer });
};

function createPeerConnection(peerId) {
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
  };
}
