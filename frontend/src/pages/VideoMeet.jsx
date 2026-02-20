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
import MeetChatBox from "../components/MeetChatBox";

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

  const lobbyVideoRef = useRef(null);
  const meetingVideoRef = useRef(null);

  const pcsRef = useRef(new Map()); // peerId -> RTCPeerConnection

  const cameraStreamRef = useRef(null);
  const screenStreamRef = useRef(null);

  // remember if camera was ON before starting share
  const prevCamEnabledRef = useRef(true);

  const [mediaReady, setMediaReady] = useState(false);

  const [videoOn, setVideoOn] = useState(true);
  const [audioOn, setAudioOn] = useState(true);
  const [screenOn, setScreenOn] = useState(false);
  const [screenAvailable, setScreenAvailable] = useState(false);

  const [askForUsername, setAskForUsername] = useState(true);
  const [username, setUsername] = useState("");

  // remoteStreams: [{ socketId, camStream, screenStream, audioStream }]
  const [remoteStreams, setRemoteStreams] = useState([]);
  const remoteStreamsRef = useRef([]);
  useEffect(() => {
    remoteStreamsRef.current = remoteStreams;
  }, [remoteStreams]);

  const [showModal, setShowModal] = useState(true);

  // chat
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState("");
  const [newMessages, setNewMessages] = useState(0);

  // ---------- local preview ----------
  const attachLocalPreview = (stream) => {
    const el = askForUsername ? lobbyVideoRef.current : meetingVideoRef.current;
    if (!el) return;
    el.srcObject = stream || null;
  };

  // ---------- init media ----------
  useEffect(() => {
    const init = async () => {
      setScreenAvailable(!!navigator.mediaDevices.getDisplayMedia);

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        cameraStreamRef.current = stream;

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

  // re-attach preview when switching lobby -> meeting
  useEffect(() => {
    const stream = screenOn ? screenStreamRef.current : cameraStreamRef.current;
    if (stream) attachLocalPreview(stream);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askForUsername]);

  // ---------- remote helpers ----------
  const upsertRemoteStream = (socketId, patch) => {
    setRemoteStreams((prev) => {
      const exists = prev.find((v) => v.socketId === socketId);
      if (exists) return prev.map((v) => (v.socketId === socketId ? { ...v, ...patch } : v));
      return [...prev, { socketId, camStream: null, screenStream: null, audioStream: null, ...patch }];
    });
  };

  const removeRemoteStream = (socketId) => {
    setRemoteStreams((prev) => prev.filter((v) => v.socketId !== socketId));
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

    // ✅ video classification:
    // first video track => camera
    // second video track => screen
    pc.ontrack = (e) => {
      const track = e.track;
      if (!track) return;

      if (track.kind === "audio") {
        upsertRemoteStream(peerId, { audioStream: new MediaStream([track]) });
        return;
      }

      if (track.kind === "video") {
        const videoStream = new MediaStream([track]);

        const existing = remoteStreamsRef.current.find((u) => u.socketId === peerId);
        const hasCam = !!existing?.camStream;
        const hasScreen = !!existing?.screenStream;

        const treatAsScreen = hasCam && !hasScreen;

        if (treatAsScreen) {
          upsertRemoteStream(peerId, { screenStream: videoStream });
          track.onended = () => upsertRemoteStream(peerId, { screenStream: null });
        } else {
          upsertRemoteStream(peerId, { camStream: videoStream });
        }
      }
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

  const renegotiateAll = async () => {
    for (const [peerId, pc] of pcsRef.current.entries()) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socketRef.current.emit("signal", peerId, JSON.stringify({ sdp: pc.localDescription }));
      } catch (e) {
        console.log("renegotiate error:", e);
      }
    }
  };

  const notifyPeersScreenEvent = (event) => {
    for (const peerId of pcsRef.current.keys()) {
      try {
        socketRef.current.emit("signal", peerId, JSON.stringify({ screenEvent: event }));
      } catch {}
    }
  };

  const handleSignal = async (fromId, message) => {
    const signal = JSON.parse(message);
    if (fromId === myIdRef.current) return;

    // ✅ custom screen events
    if (signal.screenEvent === "stop") {
      upsertRemoteStream(fromId, { screenStream: null });
      return;
    }
    if (signal.screenEvent === "start") {
      return;
    }

    const pc = createPc(fromId);

    if (signal.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

      if (signal.sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socketRef.current.emit("signal", fromId, JSON.stringify({ sdp: pc.localDescription }));
      }

      // ✅ fallback cleanup: if no second video receiver, clear screen
      try {
        const videoReceivers = pc.getReceivers().filter((r) => r.track && r.track.kind === "video");
        if (videoReceivers.length <= 1) upsertRemoteStream(fromId, { screenStream: null });
      } catch {}
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
        setMessages((prev) => [...prev, { sender, data, socketId: socketIdSender, ts: Date.now() }]);
        if (socketIdSender !== myIdRef.current) setNewMessages((n) => n + 1);
      });

      socketRef.current.on("user-left", (id) => {
        const pc = pcsRef.current.get(id);
        if (pc) {
          try { pc.close(); } catch {}
          pcsRef.current.delete(id);
        }
        removeRemoteStream(id);
      });

      socketRef.current.on("user-joined", async (joinedId, clients) => {
        for (const id of clients) {
          if (id === myIdRef.current) continue;
          createPc(id);
        }

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

  // ✅ screen share: add track (do NOT replace camera)
  const startScreenShare = async () => {
    if (!navigator.mediaDevices.getDisplayMedia) return;

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const screenTrack = screenStream.getVideoTracks()[0];
      if (!screenTrack) return;

      // ✅ turn OFF my camera while presenting (Google Meet behavior)
      const cam = cameraStreamRef.current;
      const camTrack = cam?.getVideoTracks?.()[0];
      prevCamEnabledRef.current = !!camTrack?.enabled;
      if (camTrack) camTrack.enabled = false;
      setVideoOn(false);

      screenStreamRef.current = screenStream;
      setScreenOn(true);

      pcsRef.current.forEach((pc) => {
        const alreadyAdded = pc.getSenders().some((s) => s.track?.id === screenTrack.id);
        if (!alreadyAdded) pc.addTrack(screenTrack, screenStream);
      });

      notifyPeersScreenEvent("start");

      // local preview becomes screen
      attachLocalPreview(screenStream);

      await renegotiateAll();

      screenTrack.onended = () => stopScreenShare();
    } catch (e) {
      console.log("screen share error:", e);
      setScreenOn(false);
    }
  };

  const stopScreenShare = async () => {
    const oldScreenTrack = screenStreamRef.current?.getVideoTracks?.()?.[0] || null;

    try { screenStreamRef.current?.getTracks()?.forEach((t) => t.stop()); } catch {}
    screenStreamRef.current = null;
    setScreenOn(false);

    pcsRef.current.forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track && oldScreenTrack && s.track.id === oldScreenTrack.id);
      if (sender) {
        try { pc.removeTrack(sender); } catch {}
      }
    });

    notifyPeersScreenEvent("stop");

    // ✅ restore my camera state exactly like before presenting
    const cam = cameraStreamRef.current;
    const camTrack = cam?.getVideoTracks?.()[0];
    if (camTrack) camTrack.enabled = !!prevCamEnabledRef.current;
    setVideoOn(!!prevCamEnabledRef.current);

    // restore local preview to camera (if camera exists)
    if (cam) {
      attachLocalPreview(cam);
      if (meetingVideoRef.current) meetingVideoRef.current.srcObject = cam;
    }

    await renegotiateAll();
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
    const stream = cameraStreamRef.current;
    if (stream) attachLocalPreview(stream);
    connectToSocketServer();
  };

  const sendMessage = () => {
    if (!message.trim() || !socketRef.current) return;
    socketRef.current.emit("chat-message", message.trim(), username);
    setMessage("");
  };

  // ---------- PRESENTATION LOGIC (Google Meet style) ----------
  const remotePresenter = remoteStreams.find((u) => u.screenStream);
  const isRemotePresenting = !!remotePresenter?.screenStream;
  const isPresenting = screenOn || isRemotePresenting;

  // stage video: local screen OR remote screen
  const stageStream = screenOn
    ? screenStreamRef.current
    : isRemotePresenting
    ? remotePresenter.screenStream
    : null;

  // ✅ PiP should ALWAYS be MY OWN CAMERA when someone else presents
  // - if I’m presenting: NO PIP
  // - if someone else presents: show MY camera only if my camera is ON
  const myCamTrackEnabled = !!cameraStreamRef.current?.getVideoTracks?.()?.[0]?.enabled;
  const pipStream = screenOn ? null : (myCamTrackEnabled ? cameraStreamRef.current : null);

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
          <MeetChatBox
            open={showModal}
            onClose={() => setShowModal(false)}
            messages={messages}
            mySocketId={myIdRef.current}
            message={message}
            setMessage={setMessage}
            onSend={sendMessage}
          />

          {/* Controls */}
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

            <Badge
  badgeContent={!showModal ? newMessages : 0}
  max={999}
  color="error"
  overlap="circular"
>
  <IconButton
    onClick={() => {
      setShowModal((m) => {
        const next = !m;
        if (next) setNewMessages(0);
        return next;
      });
    }}
    style={{ color: "white" }}
  >
    <ChatIcon />
  </IconButton>
</Badge>
          </div>

          {/* PRESENTING MODE */}
          {isPresenting ? (
            <div className={styles.stageArea} style={{ paddingRight: showModal ? 400 : 0 }}>
              <video
                className={styles.stageVideo}
                ref={(ref) => {
                  if (!ref) return;
                  ref.srcObject = stageStream || null; // clears when stopped
                }}
                autoPlay
                muted
                playsInline
              />

              {/* ✅ PiP is MY camera only (when remote presents) */}
              {pipStream ? (
                <video
                  className={styles.pipVideo}
                  ref={(ref) => {
                    if (!ref) return;
                    ref.srcObject = pipStream || null;
                  }}
                  autoPlay
                  muted
                  playsInline
                />
              ) : null}

              {/* keep remote audio playing */}
              <div style={{ display: "none" }}>
                {remoteStreams.map((u) =>
                  u.audioStream ? (
                    <audio
                      key={`aud-${u.socketId}`}
                      ref={(ref) => {
                        if (!ref) return;
                        ref.srcObject = u.audioStream || null;
                        ref.play?.().catch(() => {});
                      }}
                      autoPlay
                    />
                  ) : null
                )}
              </div>
            </div>
          ) : (
            <>
              {/* NORMAL MODE */}
              <video className={styles.meetUserVideo} ref={meetingVideoRef} autoPlay muted playsInline />

              <div className={styles.conferenceView}>
                {remoteStreams.map((u) => (
                  <div key={u.socketId}>
                    <video
                      data-socket={u.socketId}
                      ref={(ref) => {
                        if (!ref) return;
                        ref.srcObject = u.camStream || null;
                      }}
                      autoPlay
                      playsInline
                    />

                    {u.audioStream ? (
                      <audio
                        ref={(ref) => {
                          if (!ref) return;
                          ref.srcObject = u.audioStream || null;
                          ref.play?.().catch(() => {});
                        }}
                        autoPlay
                        style={{ display: "none" }}
                      />
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}