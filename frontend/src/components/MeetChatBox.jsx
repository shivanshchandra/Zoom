import React, { useEffect, useRef } from "react";
import { Button, IconButton, TextField } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import styles from "../styles/videoComponent.module.css";

function formatHHMM(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export default function MeetChatBox({
  open,
  onClose,
  messages,
  mySocketId,
  message,
  setMessage,
  onSend,
}) {
  const endRef = useRef(null);

  // Auto scroll to latest message
  useEffect(() => {
    if (!open) return;
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  if (!open) return null;

  return (
    <div className={styles.meetChatOverlay}>
      <div className={styles.meetChatPanel}>
        <div className={styles.meetChatHeader}>
          <div className={styles.meetChatTitle}>Chat</div>

          <IconButton onClick={onClose} size="small" className={styles.meetChatCloseBtn}>
            <CloseIcon />
          </IconButton>
        </div>

        <div className={`${styles.meetChatBody} ${styles.hideScrollbar}`}>
          {messages?.length ? (
            messages.map((m, idx) => {
              const mine = m.socketId === mySocketId;
              const time = formatHHMM(m.ts);

              return (
                <div
                  key={`${m.ts || idx}-${idx}`}
                  className={`${styles.msgRow} ${mine ? styles.right : styles.left}`}
                >
                  <div className={`${styles.msgBubble} ${mine ? styles.mine : styles.theirs}`}>
                    <div className={styles.msgMeta}>
                      {!mine && <span className={styles.msgSender}>{m.sender}</span>}
                      <span className={styles.msgTime}>{time}</span>
                    </div>
                    <div className={styles.msgText}>{m.data}</div>
                  </div>
                </div>
              );
            })
          ) : (
            <div className={styles.noMsg}>No messages yet</div>
          )}

          <div ref={endRef} />
        </div>

        <div className={styles.meetChatFooter}>
          <TextField
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Type a message..."
            fullWidth
            size="small"
            onKeyDown={(e) => {
              if (e.key === "Enter") onSend();
            }}
          />

          <Button variant="contained" onClick={onSend} className={styles.sendBtn}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}