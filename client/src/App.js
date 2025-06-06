import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import './App.css';

//const socket = io('http://localhost:4000');
const socket = io('https://earn.f1stly.com/', {
  path: '/socket.io',
  transports: ['websocket'],
  withCredentials: false
});


const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },      
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' }
  ]
};

function App() {
  const [userId, setUserId] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [status, setStatus] = useState('online');
  const [users, setUsers] = useState({});
  const [currentCall, setCurrentCall] = useState(null);
  const [targetUserId, setTargetUserId] = useState('');
  
  const localVideoRef = useRef();
  const remoteVideoRef = useRef();
  const peerConnection = useRef(null);
  const localStream = useRef(null);
  const iceCandidatesQueue = useRef([]);

  // Function definitions moved inside the component before useEffect
  const setupPeerConnection = async () => {
    try {
      peerConnection.current = new RTCPeerConnection(configuration);
      
      // Add local stream tracks to peer connection
      if (localStream.current) {
        localStream.current.getTracks().forEach(track => {
          peerConnection.current.addTrack(track, localStream.current);
        });
      }

      // Handle incoming streams
      peerConnection.current.ontrack = (event) => {
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = event.streams[0];
        }
      };

      // Handle ICE candidates
      peerConnection.current.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice_candidate', {
            targetUserId: currentCall ? currentCall.with : targetUserId,
            candidate: event.candidate
          });
        }
      };

      // Monitor connection state
      peerConnection.current.onconnectionstatechange = () => {
        if (peerConnection.current && peerConnection.current.connectionState === 'failed') {
          toast.error('Call connection failed');
          cleanupPeerConnection();
          setCurrentCall(null);
        }
      };
    } catch (error) {
      toast.error('Error setting up peer connection: ' + error.message);
      throw error;
    }
  };

  const cleanupPeerConnection = () => {
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    iceCandidatesQueue.current = [];
  };

  useEffect(() => {
    if (!isLoggedIn) return;

    // Add handler for duplicate session
    const handleDuplicateSession = ({ message }) => {
      toast.error(message);
      setIsLoggedIn(false);
      setUserId('');
      if (localStream.current) {
        localStream.current.getTracks().forEach(track => track.stop());
        localStream.current = null;
      }
    };

    const setupMedia = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localStream.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
      } catch (err) {
        toast.error('Error accessing camera/microphone: ' + err.message);
      }
    };
    setupMedia();

    // Initialize user presence
    socket.emit('update_status', {
      userId,
      status: 'online'
    });

    const handlePresenceUpdate = ({ userId: updatedUserId, status: userStatus }) => {
      if (updatedUserId !== userId) { // Don't show own status updates
        setUsers(prev => ({
          ...prev,
          [updatedUserId]: userStatus
        }));
        toast.info(`User ${updatedUserId} is now ${userStatus}`);
      }
    };

    const handleIncomingCall = async ({ callerId, offer }) => {
      // Add check to prevent self-calls
      if (callerId === userId) {
        return; // Silently ignore calls from self
      }

      const accept = window.confirm(`Incoming call from ${callerId}. Accept?`);
      if (accept) {
        await setupPeerConnection();
        try {
          await peerConnection.current.setRemoteDescription(new RTCSessionDescription(offer));
          const answer = await peerConnection.current.createAnswer();
          await peerConnection.current.setLocalDescription(answer);
          
          // Process any queued ICE candidates
          while (iceCandidatesQueue.current.length) {
            const candidate = iceCandidatesQueue.current.shift();
            await peerConnection.current.addIceCandidate(new RTCIceCandidate(candidate));
          }

          socket.emit('call_accepted', { 
            callerId, 
            targetUserId: userId,
            answer
          });
          setCurrentCall({ with: callerId });
        } catch (err) {
          toast.error('Error in call acceptance: ' + err.message);
        }
      } else {
        socket.emit('call_rejected', { callerId, targetUserId: userId });
      }
    };

    const handleCallAccepted = async ({ answer }) => {
      try {
        await peerConnection.current.setRemoteDescription(new RTCSessionDescription(answer));
        
        // Process any queued ICE candidates
        while (iceCandidatesQueue.current.length) {
          const candidate = iceCandidatesQueue.current.shift();
          await peerConnection.current.addIceCandidate(new RTCIceCandidate(candidate));
        }
      } catch (err) {
        toast.error('Error in call acceptance: ' + err.message);
      }
    };

    const handleIceCandidate = async ({ candidate }) => {
      try {
        if (peerConnection.current && peerConnection.current.remoteDescription) {
          await peerConnection.current.addIceCandidate(new RTCIceCandidate(candidate));
        } else {
          // Queue the candidate if remote description is not set yet
          iceCandidatesQueue.current.push(candidate);
        }
      } catch (err) {
        toast.error('Error adding ICE candidate: ' + err.message);
      }
    };

    const handleUserBusy = ({ targetUserId }) => {
      toast.warning(`${targetUserId} is busy on another call`);
      cleanupPeerConnection();
      setCurrentCall(null);
    };

    const handleCallEnded = ({ reason }) => {
      toast.info(`Call ${reason}`);
      cleanupPeerConnection();
      setCurrentCall(null);
    };

    // Add event listeners
    socket.on('presence_update', handlePresenceUpdate);
    socket.on('incoming_call', handleIncomingCall);
    socket.on('call_accepted', handleCallAccepted);
    socket.on('ice_candidate', handleIceCandidate);
    socket.on('user_busy', handleUserBusy);
    socket.on('call_ended', handleCallEnded);

    // Add duplicate session event listener
    socket.on('duplicate_session', handleDuplicateSession);

    // Cleanup function
    return () => {
      socket.off('presence_update', handlePresenceUpdate);
      socket.off('incoming_call', handleIncomingCall);
      socket.off('call_accepted', handleCallAccepted);
      socket.off('ice_candidate', handleIceCandidate);
      socket.off('user_busy', handleUserBusy);
      socket.off('call_ended', handleCallEnded);
      cleanupPeerConnection();
      
      // Stop local media stream
      if (localStream.current) {
        localStream.current.getTracks().forEach(track => track.stop());
      }
    };
  }, [isLoggedIn, userId]); // Added dependencies

  const handleLogin = (e) => {
    e.preventDefault();
    if (!userId.trim()) {
      toast.error('Please enter a user ID');
      return;
    }
    if (socket.disconnected) {
      socket.connect();
    }
    setIsLoggedIn(true);
    toast.success(`Logged in as ${userId}`);
  };

  const updateStatus = (newStatus) => {
    setStatus(newStatus);
    socket.emit('update_status', {
      userId,
      status: newStatus
    });
  };

  const handleLogout = () => {
    socket.emit('update_status', { userId, status: 'offline' });
    if (localStream.current) {
      localStream.current.getTracks().forEach(track => track.stop());
      localStream.current = null;
    }
    cleanupPeerConnection();
    socket.off();
    socket.disconnect();
    setCurrentCall(null);
    setUsers({});
    setStatus('online');
    setIsLoggedIn(false);
    setTargetUserId('');
    setUserId('');
  };

  const initiateCall = async () => {
    if (!targetUserId.trim()) {
      toast.error('Please enter a user ID to call');
      return;
    }

    try {
      await setupPeerConnection();
      const offer = await peerConnection.current.createOffer();
      await peerConnection.current.setLocalDescription(offer);
      
      socket.emit('call_invite', {
        callerId: userId,
        targetUserId,
        offer
      });
      
      setCurrentCall({ with: targetUserId });
    } catch (err) {
      toast.error('Error initiating call: ' + err.message);
      cleanupPeerConnection();
    }
  };

  useEffect(() => {
    if (!isLoggedIn) return;

    const handleUserOffline = ({ targetUserId }) => {
      toast.error(`User ${targetUserId} is offline`);
      cleanupPeerConnection();
      setCurrentCall(null);
    };

    socket.on('user_offline', handleUserOffline);

    return () => {
      socket.off('user_offline', handleUserOffline);
    };
  }, [isLoggedIn, userId]);

  const endCall = () => {
    if (currentCall) {
      socket.emit('end_call', {
        callerId: userId,
        targetUserId: currentCall.with
      });
      cleanupPeerConnection();
      setCurrentCall(null);
    }
  };

  // Login screen
  if (!isLoggedIn) {
    return (
      <div className="login-container">
        <form onSubmit={handleLogin} className="login-form">
          <h2>Enter Your User ID</h2>
          <input
            type="text"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="Enter your user ID"
            required
          />
          <button type="submit">Join</button>
        </form>
        <ToastContainer position="top-right" />
      </div>
    );
  }

  // Main app screen
  return (
    <div className="App">
      <h1>Video Call Demo</h1>
      <div className="user-info">
        <h2>Your ID: {userId}</h2>
        <h3>Status: {status}</h3>
      </div>
      
      <div className="status-controls">
        <button onClick={() => updateStatus('online')}>Online</button>
        <button onClick={() => updateStatus('busy')}>Busy</button>
        <button onClick={() => updateStatus('offline')}>Offline</button>
        <button onClick={handleLogout}>Logout</button>
      </div>

      <div className="call-controls">
        <h2>Make a Call</h2>
        <input
          type="text"
          value={targetUserId}
          onChange={(e) => setTargetUserId(e.target.value)}
          placeholder="Enter user ID to call"
          disabled={currentCall}
        />
        {!currentCall ? (
          <button 
            onClick={initiateCall} 
            disabled={!targetUserId.trim()}
          >Call</button>
        ) : (
          <button onClick={endCall}>End Call</button>
        )}
      </div>

      <div className="video-container">
        {!currentCall ? (
          <div className="video-box">
            <h3>Local Video</h3>
            <video ref={localVideoRef} autoPlay muted playsInline />
          </div>
        ) : (
          <div className="video-box">
            <h3>Remote Video</h3>
            <video ref={remoteVideoRef} autoPlay playsInline />
          </div>
        )}
      </div>

      <div className="users-list">
        <h2>Online Users</h2>
        {Object.entries(users).map(([otherUserId, status]) => (
          <div key={otherUserId} className="user-item">
            {otherUserId}: {status}
          </div>
        ))}
      </div>
      
      <ToastContainer position="top-right" />
    </div>
  );
}

export default App;