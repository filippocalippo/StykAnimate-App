// FriendChat.js - Basic Friend ID & Session Chat Component
export class FriendChat {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.friendId = null;
    this.messages = [];
  }

  // Generate or set unique Friend ID
  initFriendId() {
    this.friendId = "STYK-" + Math.random().toString(36).substring(2, 9).toUpperCase();
    console.log("Your Friend ID:", this.friendId);
    return this.friendId;
  }

  // UI markup for the Chat Panel
  render() {
    if (!this.container) return;
    this.container.innerHTML = `
      <div class="friend-chat-panel">
        <div class="chat-header">
          <h3>Collaborative Chat</h3>
          <p>Your Friend ID: <strong>${this.initFriendId()}</strong></p>
        </div>
        <div class="connect-section">
          <input type="text" id="peer-id-input" placeholder="Enter Friend's ID..." />
          <button id="connect-btn">Connect & Chat</button>
        </div>
        <div class="chat-messages" id="chat-box"></div>
        <div class="chat-input-area">
          <input type="text" id="message-input" placeholder="Type a message..." />
          <button id="send-btn">Send</button>
        </div>
      </div>
    `;
  }
}
