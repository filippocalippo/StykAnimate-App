// src/components/random-id.js

export class RandomIdManager {
  constructor() {
    this.storageKey = 'styk_user_id';
  }

  // Generate or retrieve a persistent unique random ID upon login
  getOrCreateUserId() {
    let userId = localStorage.getItem(this.storageKey);
    
    if (!userId) {
      userId = 'STYK-' + Math.random().toString(36).substring(2, 8).toUpperCase();
      localStorage.setItem(this.storageKey, userId);
    }
    
    return userId;
  }

  // Inject the ID into any UI element by its ID attribute
  renderUserIdBadge(elementId) {
    const userId = this.getOrCreateUserId();
    const container = document.getElementById(elementId);
    if (container) {
      container.innerText = `Your ID: ${userId}`;
    }
    return userId;
  }
}
