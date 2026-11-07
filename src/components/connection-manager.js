// src/components/connection-manager.js

export class ConnectionManager {
  constructor(currentUserId) {
    this.currentUserId = currentUserId;
    this.connectedPeerId = null;
    this.status = "DISCONNECTED"; // DISCONNECTED | CONNECTING | CONNECTED
  }

  // Send a connection request to another user's Friend ID
  sendConnectionRequest(targetFriendId, friendName = "Friend") {
    if (!targetFriendId || targetFriendId.trim() === "") {
      console.error("[Collab] Please enter a valid Friend ID.");
      return false;
    }

    if (targetFriendId === this.currentUserId) {
      console.warn("[Collab] You cannot connect to yourself!");
      return false;
    }

    this.status = "CONNECTING";
    console.log(`[Collab] Connecting ${this.currentUserId} -> ${targetFriendId} (${friendName})`);

    // Dispatch a browser-wide event so other UI components can listen in
    const event = new CustomEvent("styk:collab-connect-request", {
      detail: {
        senderId: this.currentUserId,
        targetId: targetFriendId,
        targetName: friendName,
        timestamp: Date.now()
      }
    });
    window.dispatchEvent(event);

    this.logToChatGUI(`System: Sending connection invite to ${friendName} [${targetFriendId}]...`);
    return true;
  }

  logToChatGUI(message) {
    const chatLog = document.getElementById("styk-chat-log");
    if (chatLog) {
      const msgElement = document.createElement("div");
      msgElement.className = "chat-system-msg";
      msgElement.innerText = message;
      chatLog.appendChild(msgElement);
      chatLog.scrollTop = chatLog.scrollHeight;
    }
  }
}
