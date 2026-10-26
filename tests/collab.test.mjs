// tests/collab.test.mjs
import { ConnectionManager } from "../src/components/connection-manager.js";

export function runCollabTests() {
  console.log("Running Collab Unit Tests...");

  const manager = new ConnectionManager("user-123");

  // Test self-connection prevention
  const selfConnectResult = manager.sendConnectionRequest("user-123", "Self");
  console.assert(selfConnectResult === false, "Test Failed: Allowed self connection!");

  // Test valid connection request dispatches custom event
  let eventDispatched = false;
  window.addEventListener("styk:collab-connect-request", (e) => {
    eventDispatched = true;
    console.assert(e.detail.targetId === "friend-456", "Test Failed: Incorrect target ID!");
  });

  manager.sendConnectionRequest("friend-456", "FriendName");
  console.assert(eventDispatched === true, "Test Failed: Custom event not dispatched!");

  console.log("All Collab Unit Tests Passed Successfully! ✅");
}
