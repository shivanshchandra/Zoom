import React, { useEffect, useRef, useState } from "react";
import io from "socket.io-client";
import { Badge, IconButton, TextField, Button } from "@mui/material";
import VideocamIcon from "@mui/icons-material/Videocam";
import VideocamOffIcon from "@mui/icons-material/VideocamOff";
import CallEndIcon from "@mui/icons-material/CallEnd";
import MicIcon from "@mui/icons-material/Mic";
import MicOffIcon from "@mui/icons-material/MicOff";
import ScreenShareIcon from "@mui/icons-material/ScreenShare";
import StopScreenShareIcon from "@mui/icons-material/StopScreenShare";
import ChatIcon from "@mui/icons-material/Chat";
import styles from "../styles/videoComponent.module.css";
import server from "../environment";

const server_url = server;

const pcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function getRoomKey() {
  const url = new URL(window.location.href);
  const qp = url.searchParams.get("room");
  if (qp && qp.trim()) return qp.trim();
  const parts = url.pathname.split("/").filter(Boolean);
  return (parts[parts.length - 1] || "").trim();
}

export default function VideoMeetComponent() {
  const socketRef = useRef(null);
  const myIdRef = useRef(null);

  // IMPORTANT: separate refs for lobby and meeting preview
  const lobbyVideoRef = useRef(null);
  const meetingVideoRef = useRef(null);

  const pcsRef = useRef(new Map()); // peerId -> RTCPeerConnection

  const cameraStreamRef = useRef(null);
  const screenStreamRef = useRef(null);

  const [mediaReady, setMediaReady] = useState(false);

  const [videoOn, setVideoOn] = useState(true);
  const [audioOn, setAudioOn] = useState(true);
  const [screenOn, setScreenOn] = useState(false);
  const [screenAvailable, setScreenAvailable] = useState(false);

  const [askForUsername, setAskForUsername] = useState(true);
  const [username, setUsername] = useState("");

  const [videos, setVideos] = useState([]); // {socketId, stream}
  const [showModal, setShowModal] = useState(true);

  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState("");
  const [newMessages, setNewMessages] = useState(0);

  // Attach local preview to correct video element
  const attachLocalPreview = (stream) => {
    const el = askForUsername ? lobbyVideoRef.current : meetingVideoRef.current;
    if (el && el.srcObject !== stream) el.srcObject = stream;
  };

  // ---------- init media ----------
  useEffect(() => {
    const init = async () => {
      setScreenAvailable(!!navigator.mediaDevices.getDisplayMedia);

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        cameraStreamRef.current = stream;

        // apply toggles
        const vt = stream.getVideoTracks()[0];
        if (vt) vt.enabled = true;
        const at = stream.getAudioTracks()[0];
        if (at) at.enabled = true;

        attachLocalPreview(stream);
        setMediaReady(true);
      } catch (e) {
        console.log("getUserMedia failed:", e);
        setMediaReady(true);
      }
    };

    init();

    return () => {
      try { cameraStreamRef.current?.getTracks()?.forEach((t) => t.stop()); } catch {}
      try { screenStreamRef.current?.getTracks()?.forEach((t) => t.stop()); } catch {}
      try { socketRef.current?.disconnect(); } catch {}
      pcsRef.current.forEach((pc) => { try { pc.close(); } catch {} });
      pcsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ✅ re-attach preview when switching lobby -> meeting
  useEffect(() => {
    const stream = screenOn ? screenStreamRef.current : cameraStreamRef.current;
    if (stream) attachLocalPreview(stream);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askForUsername]);

  // ---------- remote videos ----------
  const upsertRemoteVideo = (socketId, stream) => {
    setVideos((prev) => {
      const exists = prev.find((v) => v.socketId === socketId);
      if (exists) return prev.map((v) => (v.socketId === socketId ? { ...v, stream } : v));
      return [...prev, { socketId, stream }];
    });
  };

  const removeRemoteVideo = (socketId) => {
    setVideos((prev) => prev.filter((v) => v.socketId !== socketId));
  };

  // ---------- WebRTC ----------
  const ensureLocalTracksOnPc = (pc) => {
    const cam = cameraStreamRef.current;
    if (!cam) return;

    const haveVideoSender = pc.getSenders().some((s) => s.track?.kind === "video");
    const haveAudioSender = pc.getSenders().some((s) => s.track?.kind === "audio");

    const vt = cam.getVideoTracks()[0];
    const at = cam.getAudioTracks()[0];

    if (!haveVideoSender && vt) pc.addTrack(vt, cam);
    if (!haveAudioSender && at) pc.addTrack(at, cam);
  };

  const createPc = (peerId) => {
    if (pcsRef.current.has(peerId)) return pcsRef.current.get(peerId);

    const pc = new RTCPeerConnection(pcConfig);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socketRef.current.emit("signal", peerId, JSON.stringify({ ice: e.candidate }));
      }
    };

    pc.ontrack = (e) => {
      const stream = e.streams?.[0];
      if (stream) upsertRemoteVideo(peerId, stream);
    };

    ensureLocalTracksOnPc(pc);

    pcsRef.current.set(peerId, pc);
    return pc;
  };

  const sendOffer = async (peerId) => {
    const pc = createPc(peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socketRef.current.emit("signal", peerId, JSON.stringify({ sdp: pc.localDescription }));
  };

  const handleSignal = async (fromId, message) => {
    const signal = JSON.parse(message);
    if (fromId === myIdRef.current) return;

    const pc = createPc(fromId);

    if (signal.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

      if (signal.sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socketRef.current.emit("signal", fromId, JSON.stringify({ sdp: pc.localDescription }));
      }
    }

    if (signal.ice) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(signal.ice));
      } catch (e) {
        console.log("ICE error:", e);
      }
    }
  };

  // ---------- Socket ----------
  const connectToSocketServer = () => {
    const roomKey = getRoomKey();

    socketRef.current = io(server_url, { transports: ["websocket"] });
    socketRef.current.on("signal", handleSignal);

    socketRef.current.on("connect", () => {
      myIdRef.current = socketRef.current.id;
      socketRef.current.emit("join-call", roomKey);

      socketRef.current.on("chat-message", (data, sender, socketIdSender) => {
        setMessages((prev) => [...prev, { sender, data }]);
        if (socketIdSender !== myIdRef.current) setNewMessages((n) => n + 1);
      });

      socketRef.current.on("user-left", (id) => {
        const pc = pcsRef.current.get(id);
        if (pc) {
          try { pc.close(); } catch {}
          pcsRef.current.delete(id);
        }
        removeRemoteVideo(id);
      });

      socketRef.current.on("user-joined", async (joinedId, clients) => {
        // create pcs for all
        for (const id of clients) {
          if (id === myIdRef.current) continue;
          createPc(id);
        }

        // only new joiner sends offers
        if (joinedId === myIdRef.current) {
          for (const id of clients) {
            if (id === myIdRef.current) continue;
            try { await sendOffer(id); } catch (e) { console.log(e); }
          }
        }
      });
    });
  };

  // ---------- Controls ----------
  const toggleMic = () => {
    const cam = cameraStreamRef.current;
    if (!cam) return;
    const at = cam.getAudioTracks()[0];
    if (!at) return;
    at.enabled = !at.enabled;
    setAudioOn(at.enabled);
  };

  const toggleCamera = () => {
    const cam = cameraStreamRef.current;
    if (!cam) return;
    const vt = cam.getVideoTracks()[0];
    if (!vt) return;
    vt.enabled = !vt.enabled;
    setVideoOn(vt.enabled);
  };

  const startScreenShare = async () => {
    if (!navigator.mediaDevices.getDisplayMedia) return;

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      screenStreamRef.current = screenStream;
      setScreenOn(true);

      const screenTrack = screenStream.getVideoTracks()[0];
      if (!screenTrack) return;

      // replace outgoing video track for each peer
      pcsRef.current.forEach((pc) => {
        const sender = pc.getSenders().find((s) => s.track?.kind === "video");
        if (sender) sender.replaceTrack(screenTrack);
      });

      // local preview becomes screen
      attachLocalPreview(screenStream);

      screenTrack.onended = () => stopScreenShare();
    } catch (e) {
      console.log("screen share error:", e);
      setScreenOn(false);
    }
  };

  const stopScreenShare = async () => {
    try { screenStreamRef.current?.getTracks()?.forEach((t) => t.stop()); } catch {}
    screenStreamRef.current = null;
    setScreenOn(false);

    let cam = cameraStreamRef.current;

    // if camera ended, reacquire
    if (!cam || cam.getTracks().every((t) => t.readyState === "ended")) {
      try {
        cam = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        cameraStreamRef.current = cam;

        // apply toggles
        const vt = cam.getVideoTracks()[0];
        if (vt) vt.enabled = videoOn;
        const at = cam.getAudioTracks()[0];
        if (at) at.enabled = audioOn;
      } catch (e) {
        console.log("restore cam failed:", e);
        return;
      }
    }

    const camTrack = cam.getVideoTracks()[0];
    if (!camTrack) return;

    pcsRef.current.forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender) sender.replaceTrack(camTrack);
    });

    attachLocalPreview(cam);
  };

  const handleScreen = () => {
    if (!screenOn) startScreenShare();
    else stopScreenShare();
  };

  const handleEndCall = () => {
    try { cameraStreamRef.current?.getTracks()?.forEach((t) => t.stop()); } catch {}
    try { screenStreamRef.current?.getTracks()?.forEach((t) => t.stop()); } catch {}
    try { socketRef.current?.disconnect(); } catch {}
    window.location.href = "/";
  };

  const connect = () => {
    setAskForUsername(false);
    // ensure preview is attached to meeting element immediately
    const stream = cameraStreamRef.current;
    if (stream) attachLocalPreview(stream);
    connectToSocketServer();
  };

  const sendMessage = () => {
    if (!message.trim()) return;
    socketRef.current.emit("chat-message", message, username);
    setMessage("");
  };

  // ---------- UI ----------
  return (
    <div>
      {askForUsername ? (
        <div>
          <h2>Enter into Lobby</h2>

          <TextField
            id="outlined-basic"
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            variant="outlined"
          />

          <Button
            variant="contained"
            onClick={connect}
            disabled={!username.trim() || !mediaReady}
            style={{ marginLeft: 10 }}
          >
            CONNECT
          </Button>

          <div style={{ marginTop: 20 }}>
            <video ref={lobbyVideoRef} autoPlay muted playsInline />
          </div>
        </div>
      ) : (
        <div className={styles.meetVideoContainer}>
          {showModal ? (
            <div className={styles.chatRoom}>
              <div className={styles.chatContainer}>
                <h1>Chat</h1>

                <div className={styles.chattingDisplay}>
                  {messages.length ? (
                    messages.map((item, index) => (
                      <div style={{ marginBottom: 20 }} key={index}>
                        <p style={{ fontWeight: "bold" }}>{item.sender}</p>
                        <p>{item.data}</p>
                      </div>
                    ))
                  ) : (
                    <p>No Messages Yet</p>
                  )}
                </div>

                <div className={styles.chattingArea}>
                  <TextField
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    id="outlined-basic"
                    label="Enter Your chat"
                    variant="outlined"
                  />
                  <Button variant="contained" onClick={sendMessage}>
                    Send
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          <div className={styles.buttonContainers}>
            <IconButton onClick={toggleCamera} style={{ color: "white" }}>
              {videoOn ? <VideocamIcon /> : <VideocamOffIcon />}
            </IconButton>

            <IconButton onClick={handleEndCall} style={{ color: "red" }}>
              <CallEndIcon />
            </IconButton>

            <IconButton onClick={toggleMic} style={{ color: "white" }}>
              {audioOn ? <MicIcon /> : <MicOffIcon />}
            </IconButton>

            {screenAvailable ? (
              <IconButton onClick={handleScreen} style={{ color: "white" }}>
                {screenOn ? <ScreenShareIcon /> : <StopScreenShareIcon />}
              </IconButton>
            ) : null}

            <Badge badgeContent={newMessages} max={999} color="orange">
              <IconButton
                onClick={() => {
                  setShowModal((m) => !m);
                  setNewMessages(0);
                }}
                style={{ color: "white" }}
              >
                <ChatIcon />
              </IconButton>
            </Badge>
          </div>

          <video className={styles.meetUserVideo} ref={meetingVideoRef} autoPlay muted playsInline />

          <div className={styles.conferenceView}>
            {videos.map((v) => (
              <div key={v.socketId}>
                <video
                  data-socket={v.socketId}
                  ref={(ref) => {
                    if (ref && v.stream) ref.srcObject = v.stream;
                  }}
                  autoPlay
                  playsInline
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}