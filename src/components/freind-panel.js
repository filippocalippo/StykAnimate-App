// src/components/friend-panel.js

export class FriendPanelManager {
  constructor(currentUserId) {
    this.currentUserId = currentUserId;
  }

  // Render the panel into your UI container with two dedicated input fields
  renderPanel(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = `
      <div class="styk-friend-panel">
        <h3>Friend Requests & Collab</h3>
        <div class="my-id-box">
          <span>Your ID: <strong>${this.currentUserId}</strong></span>
        </div>
        
        <div class="friend-search-section">
          <div class="input-group">
            <label for="friend-id-input">Friend ID:</label>
            <input type="text" id="friend-id-input" placeholder="Enter friend's unique ID..." />
          </div>
          
          <div class="input-group">
            <label for="friend-name-input">Friend Name:</label>
            <input type="text" id="friend-name-input" placeholder="Enter friend's name..." />
          </div>

          <button id="send-request-btn">Send Friend Request</button>
        </div>
      </div>
    `;

    // Hook up the button listener to grab values from both search bars
    document.getElementById("send-request-btn").addEventListener("click", () => {
      const friendId = document.getElementById("friend-id-input").value.trim();
      const friendName = document.getElementById("friend-name-input").value.trim();
      
      if (friendId && friendName) {
        this.handleSendRequest(friendId, friendName);
      } else {
        alert("Please fill in both the Friend ID and Friend Name fields.");
      }
    });
  }

  handleSendRequest(friendId, friendName) {
    console.log(`[Collab] Sending request to ${friendName} (ID: ${friendId})`);
    alert(`Friend request sent to ${friendName} [${friendId}]! Waiting for connection...`);
  }
}
